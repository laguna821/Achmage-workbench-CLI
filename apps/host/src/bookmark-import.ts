import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BookmarkBrowser, BookmarkSource } from "@workbench/contracts";
import { HttpError } from "./errors.ts";

// Bringing bookmarks in from a browser of this PC (bookmarks unit, 0.5.1).
//
// READ-ONLY and narrow. Finding a browser looks only at whether its folders and its bookmark file are
// there (and Firefox's profiles.ini, which names its profiles); nothing of a bookmark is read until a
// person presses the key that names the browser. Then exactly one thing is read: a Chromium profile's
// `Bookmarks` JSON, or the bookmark tables (moz_bookmarks joined with moz_places) of a COPY of a Firefox
// profile's places.sqlite — the copy is removed at once. Never cookies, passwords, history, sessions or
// any other file of a profile (not even Chromium's `Local State`, which would give the profiles' own
// names: a profile is named by its folder). Nothing leaves the PC, and no path is logged or answered.

export type ImportedNode = { kind: "item"; title: string; url: string } | { kind: "folder"; title: string; children: ImportedNode[] };
/** `bar`: the browser's bookmark bar; `other`: everything else it keeps (other, mobile; menu, unfiled). */
export type ImportedBookmarks = { bar: ImportedNode[]; other: ImportedNode[] };

/** Where browsers keep their data: the real PC in the gateway, a fixture folder in every test. */
export type BrowserPlaces = { platform: NodeJS.Platform; home: string; env: Record<string, string | undefined> };
export const thisPc = (): BrowserPlaces => ({ platform: process.platform, home: homedir(), env: process.env });

const MAX_FILE = 64 * 1024 * 1024, MAX_NODES = 20_000, MAX_DEPTH = 24, MAX_TITLE = 300, MAX_URL = 8192;
const unreadable = () => new HttpError(422, "bookmark_file", "즐겨찾기 파일을 읽지 못했습니다. 브라우저를 한 번 닫았다가 다시 해 보세요.");
const notFound = () => new HttpError(404, "bookmark_source", "그 브라우저의 즐겨찾기를 찾지 못했습니다.");

/** An address a web tab can open (http or https, no login in it), whole; null for anything else. */
export function bookmarkUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_URL) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname) return null;
  return url.href;
}

/** A bookmark's name: trimmed and cut; an item with none is named by its site. */
export function bookmarkTitle(value: unknown, url?: string): string {
  const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "";
  if (title || !url) return title;
  try { return new URL(url).hostname; } catch { return url; }
}

/** One list of a browser's nodes as ours: odd entries left out, and one address once in one folder. */
function collect<T>(nodes: T[], read: (node: T) => { kind: "item"; title: unknown; url: unknown } | { kind: "folder"; title: unknown; children: T[] } | null, budget: { left: number }, depth = 0): ImportedNode[] {
  const out: ImportedNode[] = [], seen = new Set<string>();
  for (const node of nodes) {
    if (budget.left <= 0) break;
    const entry = read(node);
    if (!entry) continue;
    if (entry.kind === "folder") {
      if (depth >= MAX_DEPTH) continue;
      budget.left--;
      out.push({ kind: "folder", title: bookmarkTitle(entry.title) || "이름 없는 폴더", children: collect(entry.children, read, budget, depth + 1) });
    } else {
      const url = bookmarkUrl(entry.url);
      if (!url || seen.has(url)) continue;
      seen.add(url); budget.left--;
      out.push({ kind: "item", title: bookmarkTitle(entry.title, url), url });
    }
  }
  return out;
}

// ── Chromium (Chrome, Edge, Chromium, Brave, Whale): the profile's `Bookmarks` JSON ─────────────

type ChromiumNode = { type?: unknown; name?: unknown; url?: unknown; children?: unknown };

export function parseChromiumBookmarks(text: string): ImportedBookmarks {
  let roots: Record<string, ChromiumNode | undefined>;
  try {
    const file = JSON.parse(text) as { roots?: unknown };
    if (!file || typeof file !== "object" || !file.roots || typeof file.roots !== "object") throw new Error("no roots");
    roots = file.roots as Record<string, ChromiumNode | undefined>;
  } catch { throw unreadable(); }
  const budget = { left: MAX_NODES };
  const children = (node: ChromiumNode | undefined): ChromiumNode[] => Array.isArray(node?.children) ? node.children as ChromiumNode[] : [];
  const read = (node: ChromiumNode) => {
    if (!node || typeof node !== "object") return null;
    if (node.type === "folder") return { kind: "folder" as const, title: node.name, children: children(node) };
    if (node.type === "url") return { kind: "item" as const, title: node.name, url: node.url };
    return null;
  };
  return { bar: collect(children(roots.bookmark_bar), read, budget), other: collect([...children(roots.other), ...children(roots.synced)], read, budget) };
}

// ── Firefox: moz_bookmarks ⨝ moz_places, from a copy of places.sqlite ───────────────────────────

type FirefoxRow = { id: number; type: number; parent: number; title: string | null; guid: string | null; url: string | null };

/**
 * Firefox locks places.sqlite while it runs: the file (and its -wal, where the newest changes are)
 * is copied into `tempDir`, the COPY is opened read-only, the bookmark tables are read, and the copy is
 * removed — also when reading fails.
 */
export function readFirefoxBookmarks(placesFile: string, tempDir: string): ImportedBookmarks {
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(tempDir, "workbench-bookmarks-"));
  try {
    const copy = join(dir, "places.sqlite");
    let rows: FirefoxRow[];
    try {
      if (statSync(placesFile).size > MAX_FILE * 8) throw new Error("too large");
      copyFileSync(placesFile, copy);
      if (existsSync(`${placesFile}-wal`)) copyFileSync(`${placesFile}-wal`, `${copy}-wal`);
      const db = new DatabaseSync(copy, { readOnly: true });
      try {
        rows = db.prepare("SELECT b.id AS id, b.type AS type, b.parent AS parent, b.title AS title, b.guid AS guid, p.url AS url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position, b.id").all() as unknown as FirefoxRow[];
      } finally { db.close(); }
    } catch { throw unreadable(); }
    const byParent = new Map<number, FirefoxRow[]>();
    for (const row of rows) { const list = byParent.get(row.parent); if (list) list.push(row); else byParent.set(row.parent, [row]); }
    const root = (guid: string) => { const row = rows.find((entry) => entry.guid === guid); return row ? byParent.get(row.id) ?? [] : []; };
    const budget = { left: MAX_NODES };
    // type 1: a bookmark, 2: a folder, 3: a separator. A `place:` address is a saved query, not a page.
    const read = (row: FirefoxRow) => row.type === 2 ? { kind: "folder" as const, title: row.title, children: byParent.get(row.id) ?? [] }
      : row.type === 1 && row.url && !row.url.startsWith("place:") ? { kind: "item" as const, title: row.title, url: row.url } : null;
    return { bar: collect(root("toolbar_____"), read, budget), other: collect([...root("menu________"), ...root("unfiled_____")], read, budget) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── The browsers on this PC ──────────────────────────────────────────────────────────────────────

const CHROMIUM: { id: Exclude<BookmarkBrowser, "firefox">; label: string; linux: string[]; win: string; mac: string }[] = [
  { id: "chrome", label: "Chrome", linux: [".config/google-chrome"], win: "Google/Chrome/User Data", mac: "Google/Chrome" },
  { id: "edge", label: "Edge", linux: [".config/microsoft-edge"], win: "Microsoft/Edge/User Data", mac: "Microsoft Edge" },
  { id: "chromium", label: "Chromium", linux: [".config/chromium", "snap/chromium/common/chromium"], win: "Chromium/User Data", mac: "Chromium" },
  { id: "brave", label: "Brave", linux: [".config/BraveSoftware/Brave-Browser"], win: "BraveSoftware/Brave-Browser/User Data", mac: "BraveSoftware/Brave-Browser" },
  { id: "whale", label: "Whale", linux: [".config/naver-whale"], win: "Naver/Naver Whale/User Data", mac: "Naver/Whale" },
];

type FoundProfile = { id: string; name: string; file: string };
type Found = { id: BookmarkBrowser; label: string; kind: "chromium" | "firefox"; profiles: FoundProfile[] };
const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };

function chromiumRoots(places: BrowserPlaces, browser: (typeof CHROMIUM)[number]): string[] {
  if (places.platform === "win32") return places.env.LOCALAPPDATA ? [join(places.env.LOCALAPPDATA, ...browser.win.split("/"))] : [];
  if (places.platform === "darwin") return [join(places.home, "Library", "Application Support", ...browser.mac.split("/"))];
  return browser.linux.map((path) => join(places.home, ...path.split("/")));
}

function firefoxRoots(places: BrowserPlaces): string[] {
  if (places.platform === "win32") return places.env.APPDATA ? [join(places.env.APPDATA, "Mozilla", "Firefox")] : [];
  if (places.platform === "darwin") return [join(places.home, "Library", "Application Support", "Firefox")];
  return [".mozilla/firefox", ".config/mozilla/firefox", "snap/firefox/common/.mozilla/firefox", ".var/app/org.mozilla.firefox/.mozilla/firefox"].map((path) => join(places.home, ...path.split("/")));
}

/** A Chromium profile is named by its folder (`Default`, `Profile 2`); other folders are not profiles. */
function chromiumProfiles(root: string): FoundProfile[] {
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  return names.filter((name) => /^(Default|Profile \d+)$/.test(name) && isFile(join(root, name, "Bookmarks")))
    .sort((a, b) => (a === "Default" ? 0 : Number(a.slice(8))) - (b === "Default" ? 0 : Number(b.slice(8))))
    .map((name) => ({ id: name, name: name === "Default" ? "기본 프로필" : `프로필 ${name.slice(8)}`, file: join(root, name, "Bookmarks") }));
}

/** Firefox's profiles, as profiles.ini names them; only those that have a places.sqlite. */
function firefoxProfiles(root: string, rootIndex: number): FoundProfile[] {
  let text: string;
  try {
    const ini = join(root, "profiles.ini");
    if (statSync(ini).size > 1024 * 1024) return [];
    text = readFileSync(ini, "utf8");
  } catch { return []; }
  const out: FoundProfile[] = [];
  let section = "", values: Record<string, string> = {};
  const close = () => {
    if (!/^Profile\d+$/.test(section) || !values.Path) return;
    const dir = values.IsRelative === "0" || isAbsolute(values.Path) ? values.Path : join(root, ...values.Path.split(/[\\/]/));
    const file = join(dir, "places.sqlite");
    if (isFile(file)) out.push({ id: `${rootIndex}:${section}`, name: bookmarkTitle(values.Name) || section, file });
  };
  for (const line of text.split(/\r?\n/)) {
    const head = /^\[(.+)\]\s*$/.exec(line);
    if (head) { close(); section = head[1]!; values = {}; continue; }
    const at = line.indexOf("=");
    if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  close();
  return out.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function find(places: BrowserPlaces): Found[] {
  const found: Found[] = [];
  for (const browser of CHROMIUM) {
    const profiles = chromiumRoots(places, browser).flatMap(chromiumProfiles);
    // The same profile name under two installs (a package and a snap): the first stands.
    const unique = profiles.filter((profile, at) => profiles.findIndex((entry) => entry.id === profile.id) === at);
    if (unique.length) found.push({ id: browser.id, label: browser.label, kind: "chromium", profiles: unique });
  }
  const firefox = firefoxRoots(places).flatMap(firefoxProfiles);
  if (firefox.length) found.push({ id: "firefox", label: "Firefox", kind: "firefox", profiles: firefox });
  return found;
}

/** The browsers that have bookmarks on this PC, by name; ids only, never a path. */
export function findBookmarkSources(places: BrowserPlaces): BookmarkSource[] {
  return find(places).map(({ id, label, profiles }) => ({ id, label, profiles: profiles.map((profile) => ({ id: profile.id, name: profile.name })) }));
}

/**
 * Reads one browser's bookmarks, by the ids `findBookmarkSources` gave (a path never comes from the
 * caller). With several profiles and none named, the first (the browser's default) is read.
 */
export function readBrowserBookmarks(places: BrowserPlaces, sourceId: string, profileId: string | undefined, tempDir: string): { label: string; parsed: ImportedBookmarks } {
  const source = find(places).find((entry) => entry.id === sourceId);
  const profile = source ? profileId === undefined ? source.profiles[0] : source.profiles.find((entry) => entry.id === profileId) : undefined;
  if (!source || !profile) throw notFound();
  if (source.kind === "firefox") return { label: source.label, parsed: readFirefoxBookmarks(profile.file, tempDir) };
  let text: string;
  try {
    if (statSync(profile.file).size > MAX_FILE) throw new Error("too large");
    text = readFileSync(profile.file, "utf8");
  } catch { throw unreadable(); }
  return { label: source.label, parsed: parseChromiumBookmarks(text) };
}
