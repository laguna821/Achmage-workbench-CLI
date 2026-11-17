import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { BookmarkAdd, BookmarkFolder, BookmarkIcon, BookmarkIconsResult, BookmarkImportResult, BookmarkItem, BookmarkNode, Bookmarks } from "@workbench/contracts";
import { writeAtomic } from "./atomic-write.ts";
import type { BookmarkIcons } from "./bookmark-icons.ts";
import { bookmarkTitle, bookmarkUrl, findBookmarkSources, readBrowserBookmarks, type BrowserPlaces, type ImportedBookmarks, type ImportedNode } from "./bookmark-import.ts";
import { HttpError } from "./errors.ts";
import { readBody, sendJson } from "./http.ts";

// The app's own web bookmarks (bookmarks unit, 0.5.1): one set for the whole app, the same in every
// project — items (name, address) and folders, in order — kept as one small JSON file in the gateway's
// data, written whole (atomic-write.ts). No table and no migration: a missing file is an empty set, a
// damaged one is set aside. A person changes them (the bar, 설정, the first run); no AI tool reads them.

const MAX_TOTAL = 20_000;
const OTHER = "기타 즐겨찾기";
/** 아이콘 가져오기 asks at most this many sites per press. */
const ICONS_PER_PRESS = 200;
const missing = () => new HttpError(404, "bookmark_missing", "그 즐겨찾기를 찾지 못했습니다. 이미 지웠을 수 있습니다.");
const badUrl = () => new HttpError(400, "bookmark_url", "http 또는 https로 시작하는 웹 주소만 즐겨찾기에 넣을 수 있습니다.");

type Saved = { version: 1; showBar: boolean; items: BookmarkNode[] };

/** What a file holds, as bookmarks: anything that is not a well-formed node is dropped. */
function sane(nodes: unknown, depth = 0): BookmarkNode[] {
  if (!Array.isArray(nodes) || depth > 32) return [];
  return nodes.flatMap((node): BookmarkNode[] => {
    if (!node || typeof node !== "object") return [];
    const entry = node as Record<string, unknown>;
    if (typeof entry.id !== "string" || !entry.id) return [];
    if (entry.kind === "folder") return [{ id: entry.id, kind: "folder", title: bookmarkTitle(entry.title) || "이름 없는 폴더", children: sane(entry.children, depth + 1) }];
    const url = entry.kind === "item" ? bookmarkUrl(entry.url) : null;
    return url ? [{ id: entry.id, kind: "item", title: bookmarkTitle(entry.title, url), url }] : [];
  });
}

const count = (nodes: BookmarkNode[]): number => nodes.reduce((sum, node) => sum + 1 + (node.kind === "folder" ? count(node.children) : 0), 0);

export class BookmarkStore {
  private readonly file: string;
  private state: Saved;
  /** A file that could not be read is copied aside before the first write replaces it. */
  private damaged = false;

  constructor(file: string) {
    this.file = file;
    this.state = { version: 1, showBar: true, items: [] };
    if (!existsSync(file)) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved> | null;
      if (!saved || typeof saved !== "object" || !Array.isArray(saved.items)) throw new Error("not a bookmark file");
      this.state = { version: 1, showBar: saved.showBar !== false, items: sane(saved.items) };
    } catch { this.damaged = true; }
  }

  view(): Bookmarks { return { showBar: this.state.showBar, items: structuredClone(this.state.items) }; }

  private save(): Bookmarks {
    mkdirSync(dirname(this.file), { recursive: true });
    if (this.damaged) { try { copyFileSync(this.file, `${this.file}.damaged`); } catch { /* The new set is still written. */ } this.damaged = false; }
    writeAtomic(this.file, `${JSON.stringify(this.state)}\n`);
    return this.view();
  }

  /** The list a node lives in and its place there. */
  private locate(id: string, nodes = this.state.items): { list: BookmarkNode[]; index: number } | null {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      if (node.id === id) return { list: nodes, index };
      if (node.kind === "folder") { const inner = this.locate(id, node.children); if (inner) return inner; }
    }
    return null;
  }

  /** The children of a folder (`null`: the bar itself). */
  private listOf(parentId: string | null | undefined): BookmarkNode[] {
    if (parentId === null || parentId === undefined) return this.state.items;
    const at = this.locate(parentId), folder = at?.list[at.index];
    if (!folder || folder.kind !== "folder") throw missing();
    return folder.children;
  }

  add(input: BookmarkAdd): Bookmarks {
    let node: BookmarkNode;
    if (input.kind === "folder") {
      const title = bookmarkTitle(input.title);
      if (!title) throw new HttpError(400, "bookmark_title", "폴더 이름을 적어 주세요.");
      node = { id: randomUUID(), kind: "folder", title, children: [] };
    } else {
      const url = bookmarkUrl(input.url);
      if (!url) throw badUrl();
      node = { id: randomUUID(), kind: "item", title: bookmarkTitle(input.title, url), url };
    }
    const list = this.listOf(input.parentId);
    if (count(this.state.items) >= MAX_TOTAL) throw new HttpError(409, "bookmark_full", "즐겨찾기가 너무 많습니다. 쓰지 않는 것을 지운 뒤 다시 해 주세요.");
    const index = Number.isInteger(input.index) ? Math.max(0, Math.min(list.length, input.index!)) : list.length;
    list.splice(index, 0, node);
    return this.save();
  }

  update(id: string, change: { title?: unknown; url?: unknown }): Bookmarks {
    const at = this.locate(id), node = at?.list[at.index];
    if (!node) throw missing();
    if (change.url !== undefined) {
      const url = node.kind === "item" ? bookmarkUrl(change.url) : null;
      if (!url || node.kind !== "item") throw badUrl();
      node.url = url;
    }
    if (change.title !== undefined) {
      const title = bookmarkTitle(change.title, node.kind === "item" ? node.url : undefined);
      if (!title) throw new HttpError(400, "bookmark_title", "이름을 적어 주세요.");
      node.title = title;
    }
    return this.save();
  }

  /** `index` is the place in the destination once the node has left where it was. */
  move(id: string, parentId: string | null, index: number): Bookmarks {
    const at = this.locate(id), node = at?.list[at.index];
    if (!at || !node) throw missing();
    if (parentId !== null) {
      const inside = (nodes: BookmarkNode[]): boolean => nodes.some((entry) => entry.id === parentId || (entry.kind === "folder" && inside(entry.children)));
      if (parentId === id || (node.kind === "folder" && inside(node.children))) throw new HttpError(400, "bookmark_move", "폴더를 자기 안으로 옮길 수 없습니다.");
    }
    const target = this.listOf(parentId);
    at.list.splice(at.index, 1);
    target.splice(Math.max(0, Math.min(target.length, Number.isInteger(index) ? index : target.length)), 0, node);
    return this.save();
  }

  remove(id: string): Bookmarks {
    const at = this.locate(id);
    if (!at) throw missing();
    at.list.splice(at.index, 1);
    return this.save();
  }

  /**
   * 되돌리기 after a removal: the node (a folder with everything in it) back in its folder at its place —
   * on the bar's end when that folder is gone meanwhile. Ids already in use are given new ones.
   */
  restore(input: unknown, parentId: string | null, index: number): Bookmarks {
    const [node] = sane([input]);
    if (!node) throw new HttpError(400, "bookmark_restore", "되돌릴 즐겨찾기가 올바르지 않습니다.");
    const used = new Set<string>();
    const collect = (nodes: BookmarkNode[]) => { for (const entry of nodes) { used.add(entry.id); if (entry.kind === "folder") collect(entry.children); } };
    collect(this.state.items);
    const fresh = (entry: BookmarkNode): BookmarkNode => {
      const id = used.has(entry.id) ? randomUUID() : entry.id; used.add(id);
      return entry.kind === "folder" ? { ...entry, id, children: entry.children.map(fresh) } : { ...entry, id };
    };
    const restored = fresh(node);
    if (count(this.state.items) + count([restored]) > MAX_TOTAL) throw new HttpError(409, "bookmark_full", "즐겨찾기가 너무 많습니다. 쓰지 않는 것을 지운 뒤 다시 해 주세요.");
    let list: BookmarkNode[];
    try { list = this.listOf(parentId); } catch { list = this.state.items; index = list.length; }
    list.splice(Math.max(0, Math.min(list.length, Number.isInteger(index) ? index : list.length)), 0, restored);
    return this.save();
  }

  /** Every item, in the bar's order (folders opened). */
  allItems(nodes = this.state.items): BookmarkItem[] {
    return nodes.flatMap((node) => node.kind === "folder" ? this.allItems(node.children) : [node]);
  }

  clear(): Bookmarks { this.state.items = []; return this.save(); }
  showBar(show: boolean): Bookmarks { this.state.showBar = show; return this.save(); }

  /**
   * A browser's bookmarks come in without overwriting anything. An empty bar becomes the browser's bar
   * (folders kept) and its other bookmarks go into "기타 즐겨찾기"; a bar that already has items takes
   * the whole import in ONE folder named after the browser. The same address already in the same place
   * is not added twice (a folder of the same name there is added to, not doubled).
   */
  import(label: string, source: ImportedBookmarks): BookmarkImportResult {
    if (!source.bar.length && !source.other.length) return { bookmarks: this.view(), items: 0, folders: 0, message: `${label}에 즐겨찾기가 없습니다.` };
    const added = { items: 0, folders: 0 };
    let room = MAX_TOTAL - count(this.state.items);
    const merge = (target: BookmarkNode[], incoming: ImportedNode[]) => {
      for (const node of incoming) {
        if (room <= 0) return;
        if (node.kind === "item") {
          if (target.some((entry) => entry.kind === "item" && entry.url === node.url)) continue;
          target.push({ id: randomUUID(), kind: "item", title: node.title, url: node.url }); added.items++; room--;
        } else {
          let folder = target.find((entry): entry is BookmarkFolder => entry.kind === "folder" && entry.title === node.title);
          if (!folder) { folder = { id: randomUUID(), kind: "folder", title: node.title, children: [] }; target.push(folder); added.folders++; room--; }
          merge(folder.children, node.children);
        }
      }
    };
    /** The folder of that name in `target` (made when missing; it is ours, so it is not counted). */
    const container = (target: BookmarkNode[], title: string) => {
      let folder = target.find((entry): entry is BookmarkFolder => entry.kind === "folder" && entry.title === title);
      if (!folder) { folder = { id: randomUUID(), kind: "folder", title, children: [] }; target.push(folder); }
      return folder;
    };
    const before = structuredClone(this.state.items);
    const intoFolder = this.state.items.length > 0;
    const place = `${label}에서 가져옴`;
    const root = intoFolder ? container(this.state.items, place).children : this.state.items;
    merge(root, source.bar);
    if (source.other.length) merge(container(root, OTHER).children, source.other);
    if (!added.items && !added.folders) {
      // Nothing new: no empty folder of ours is left behind either.
      this.state.items = before;
      return { bookmarks: this.view(), items: 0, folders: 0, message: "새로 가져올 즐겨찾기가 없습니다. 이미 모두 들어 있습니다." };
    }
    const said = `즐겨찾기 ${added.items}개${added.folders ? `, 폴더 ${added.folders}개` : ""}를 가져왔습니다.`;
    return { bookmarks: this.save(), ...added, message: intoFolder ? `${said} 즐겨찾기 줄의 「${place}」 폴더에 있습니다.` : said };
  }
}

async function body(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, limit);
  if (!bytes.length) return {};
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch { throw new HttpError(400, "invalid_json", "JSON 형식이 아닙니다."); }
}

/** `/api/bookmarks…`; false when the path is not one of these routes. `places` and `tempDir`: where a browser is looked for, and where a Firefox copy is put. */
export async function handleBookmarks(deps: { store: BookmarkStore; places: BrowserPlaces; tempDir: string; icons?: BookmarkIcons }, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? "GET", path = url.pathname, { store, icons } = deps;
  // Every answer that carries the bookmarks carries each item's site icon (by hash) with it.
  const withIcons = (view: Bookmarks) => icons ? icons.decorate(view) : view;
  const answer = (value: unknown) => {
    const shaped = value && typeof value === "object" && Array.isArray((value as Bookmarks).items) ? withIcons(value as Bookmarks)
      : value && typeof value === "object" && (value as { bookmarks?: Bookmarks }).bookmarks ? { ...(value as object), bookmarks: withIcons((value as { bookmarks: Bookmarks }).bookmarks) } : value;
    sendJson(res, 200, shaped); return true;
  };
  if (path === "/api/bookmarks") {
    if (method === "GET") return answer(store.view());
    if (method === "DELETE") return answer(store.clear());
    if (method === "POST") {
      const input = await body(req);
      return answer(store.add({ kind: input.kind === "folder" ? "folder" : "item", title: typeof input.title === "string" ? input.title : "", url: typeof input.url === "string" ? input.url : undefined,
        parentId: typeof input.parentId === "string" ? input.parentId : null, index: typeof input.index === "number" ? input.index : undefined }));
    }
    return false;
  }
  if (path === "/api/bookmarks/bar" && method === "PUT") return answer(store.showBar((await body(req)).show !== false));
  if (path === "/api/bookmarks/sources" && method === "GET") return answer(findBookmarkSources(deps.places));
  if (path === "/api/bookmarks/import" && method === "POST") {
    const input = await body(req);
    const { label, parsed } = readBrowserBookmarks(deps.places, String(input.source ?? ""), typeof input.profile === "string" ? input.profile : undefined, deps.tempDir);
    return answer(store.import(label, parsed));
  }
  if (path === "/api/bookmarks/restore" && method === "POST") {
    // A removed folder can hold a whole browser's import.
    const input = await body(req, 8 * 1024 * 1024);
    return answer(store.restore(input.node, typeof input.parentId === "string" ? input.parentId : null, typeof input.index === "number" ? input.index : Number.NaN));
  }
  // Site icons: fetched only for an address that is a bookmark — when it is opened, or on 아이콘 가져오기.
  if (path === "/api/bookmarks/icons/fetch" && method === "POST" && icons) {
    const address = String((await body(req)).url ?? "");
    if (!store.allItems().some((entry) => entry.url === address)) throw missing();
    await icons.ensure(address);
    return answer(store.view());
  }
  if (path === "/api/bookmarks/icons/fetch-all" && method === "POST" && icons) {
    // One request per site that has no icon yet (sites, not bookmarks: many bookmarks share one), three at a time.
    const sites = new Map<string, string>();
    for (const entry of store.allItems()) { try { const origin = new URL(entry.url).origin; if (!sites.has(origin) && !icons.iconOf(entry.url)) sites.set(origin, entry.url); } catch { /* Not an address. */ } }
    const queue = [...sites.values()].slice(0, ICONS_PER_PRESS), left = sites.size - queue.length;
    let fetched = 0, failed = 0;
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) { if (await icons.ensure(next, true)) fetched++; else failed++; }
    }));
    const message = !sites.size ? "모든 즐겨찾기에 아이콘이 있습니다." : `사이트 아이콘 ${fetched}개를 가져왔습니다.${failed ? ` ${failed}곳은 아이콘을 찾지 못했습니다.` : ""}${left ? ` 남은 ${left}곳은 한 번 더 누르면 가져옵니다.` : ""}`;
    return answer({ bookmarks: store.view(), fetched, failed, message } satisfies BookmarkIconsResult);
  }
  const icon = /^\/api\/bookmarks\/icons\/([a-f0-9]{64})$/.exec(path);
  if (icon && method === "GET" && icons) {
    const kept = icons.read(icon[1]!);
    if (!kept) throw new HttpError(404, "bookmark_icon", "그 아이콘이 없습니다.");
    return answer({ type: kept.type, data: kept.bytes.toString("base64") } satisfies BookmarkIcon);
  }
  const item = /^\/api\/bookmarks\/items\/([^/]+)(\/move)?$/.exec(path);
  if (!item) return false;
  const id = decodeURIComponent(item[1]!);
  if (item[2]) {
    if (method !== "POST") return false;
    const input = await body(req);
    return answer(store.move(id, typeof input.parentId === "string" ? input.parentId : null, typeof input.index === "number" ? input.index : Number.NaN));
  }
  if (method === "PATCH") { const input = await body(req); return answer(store.update(id, { title: input.title, url: input.url })); }
  if (method === "DELETE") return answer(store.remove(id));
  return false;
}
