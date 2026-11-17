// The app's own web bookmarks (0.5.1): one set for the whole app, the same in every project. A person
// adds them, or brings them in from a browser of this PC; an AI neither reads nor changes them.

/** `icon`: the hash of its site's icon, when the gateway keeps one (GET /api/bookmarks/icons/<hash>). */
export type BookmarkItem = { id: string; kind: "item"; title: string; url: string; icon?: string };
export type BookmarkFolder = { id: string; kind: "folder"; title: string; children: BookmarkNode[] };
export type BookmarkNode = BookmarkItem | BookmarkFolder;

/** `items` is the bar under a web tab's address, in order; `showBar` is 즐겨찾기 줄 보이기. */
export type Bookmarks = { showBar: boolean; items: BookmarkNode[] };

export type BookmarkBrowser = "chrome" | "edge" | "chromium" | "brave" | "whale" | "firefox";

/** A browser found on this PC, and its profiles that have bookmarks (never a path: ids only). */
export type BookmarkSource = { id: BookmarkBrowser; label: string; profiles: { id: string; name: string }[] };

export type BookmarkAdd = { kind: "item" | "folder"; title: string; url?: string; parentId?: string | null; index?: number };

/** What came in, said in one line (`message`). */
export type BookmarkImportResult = { bookmarks: Bookmarks; items: number; folders: number; message: string };

/** 아이콘 가져오기: how many sites gave an icon, how many had none (`message` says it in one line). */
export type BookmarkIconsResult = { bookmarks: Bookmarks; fetched: number; failed: number; message: string };

/** One kept site icon, as the app's screen shows it (a raster image only). */
export type BookmarkIcon = { type: "image/png" | "image/x-icon" | "image/gif" | "image/jpeg" | "image/webp"; data: string };
