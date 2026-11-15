import { useSyncExternalStore } from "react";
import type { BookmarkAdd, BookmarkImportResult, BookmarkItem, BookmarkNode, Bookmarks, BookmarkSource } from "@workbench/contracts";
import type { Api } from "./api.ts";

// The app's own web bookmarks, as this window holds them (bookmarks unit, 0.5.1): one set for the whole
// app, kept by the gateway. Every web tab, 설정 and the first run read the same copy; a change made here
// is the gateway's answer, and a change made in another window arrives when this one gets the focus
// again (a re-read: the simpler of the two ways the brief allows).

type Requester = Pick<Api, "request">;
const EMPTY: Bookmarks = { showBar: true, items: [] };
const whole = (value: Bookmarks | null | undefined): Bookmarks => value && Array.isArray(value.items) ? { showBar: value.showBar !== false, items: value.items } : EMPTY;

export class BookmarkClient {
  private readonly api: Requester;
  private value: Bookmarks | null = null;
  private readonly listeners = new Set<() => void>();
  private reading: Promise<void> | null = null;
  constructor(api: Requester) { this.api = api; }

  /** Null until the first read has answered. */
  getState = () => this.value;
  subscribe = (listener: () => void) => {
    if (!this.listeners.size) { window.addEventListener("focus", this.refresh); void this.refresh(); }
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); if (!this.listeners.size) window.removeEventListener("focus", this.refresh); };
  };
  private set(next: Bookmarks) { this.value = whole(next); for (const listener of this.listeners) listener(); return this.value; }
  /** A read that fails (the gateway away, a phone joined to another PC) leaves what is shown as it is. */
  refresh = (): Promise<void> => {
    // (async: a connection that cannot ask at all fails the same quiet way)
    this.reading ??= (async () => this.api.request<Bookmarks>("GET", "/api/bookmarks"))().then((next) => { this.set(next); }, () => { if (!this.value) this.set(EMPTY); }).finally(() => { this.reading = null; });
    return this.reading;
  };

  add = async (input: BookmarkAdd) => this.set(await this.api.request<Bookmarks>("POST", "/api/bookmarks", input));
  update = async (id: string, change: { title?: string; url?: string }) => this.set(await this.api.request<Bookmarks>("PATCH", `/api/bookmarks/items/${encodeURIComponent(id)}`, change));
  move = async (id: string, parentId: string | null, index: number) => this.set(await this.api.request<Bookmarks>("POST", `/api/bookmarks/items/${encodeURIComponent(id)}/move`, { parentId, index }));
  remove = async (id: string) => this.set(await this.api.request<Bookmarks>("DELETE", `/api/bookmarks/items/${encodeURIComponent(id)}`));
  clear = async () => this.set(await this.api.request<Bookmarks>("DELETE", "/api/bookmarks"));
  showBar = async (show: boolean) => this.set(await this.api.request<Bookmarks>("PUT", "/api/bookmarks/bar", { show }));
  /** The browsers found on this PC (their names only); nothing of a bookmark is read by this. */
  sources = async () => { const found = await this.api.request<BookmarkSource[]>("GET", "/api/bookmarks/sources"); return Array.isArray(found) ? found : []; };
  importFrom = async (source: string, profile?: string): Promise<BookmarkImportResult> => {
    const result = await this.api.request<BookmarkImportResult>("POST", "/api/bookmarks/import", { source, profile });
    this.set(result.bookmarks);
    return result;
  };
}

const clients = new WeakMap<object, BookmarkClient>();
/** One client per gateway connection, shared by every view of this window. */
export function bookmarksOf(api: Requester): BookmarkClient {
  let client = clients.get(api);
  if (!client) { client = new BookmarkClient(api); clients.set(api, client); }
  return client;
}

export function useBookmarks(api: Requester): [Bookmarks | null, BookmarkClient] {
  const client = bookmarksOf(api);
  return [useSyncExternalStore(client.subscribe, client.getState, client.getState), client];
}

/** The bookmark of this address, wherever it is (the first, in the bar's order). */
export function findBookmark(nodes: BookmarkNode[], url: string): BookmarkItem | null {
  for (const node of nodes) {
    if (node.kind === "item") { if (node.url === url) return node; }
    else { const inner = findBookmark(node.children, url); if (inner) return inner; }
  }
  return null;
}

export function countBookmarks(nodes: BookmarkNode[]): { items: number; folders: number } {
  let items = 0, folders = 0;
  for (const node of nodes) {
    if (node.kind === "item") items++;
    else { const inner = countBookmarks(node.children); folders += 1 + inner.folders; items += inner.items; }
  }
  return { items, folders };
}

/** A name as a bar item shows it: at most `max` characters, the cut said with an ellipsis. */
export function shortTitle(title: string, max = 18): string {
  const chars = Array.from(title);
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : title;
}

/** The letter a bookmark without a site icon is marked with: its name's first letter or digit. */
export function bookmarkLetter(title: string): string {
  const first = Array.from(title.trim()).find((char) => /[\p{L}\p{N}]/u.test(char));
  return (first ?? "•").toUpperCase();
}

/** How many of the bar's items fit: `rights` are their right edges inside a row `width` wide. */
export function fitCount(rights: number[], width: number): number {
  let fit = 0;
  while (fit < rights.length && rights[fit]! <= width) fit++;
  return fit;
}

/** An address as typed in 주소 고치기: one without a scheme is taken as https. */
export const typedAddress = (value: string) => { const text = value.trim(); return !text || /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`; };
