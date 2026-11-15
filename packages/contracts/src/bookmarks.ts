// The app's own web bookmarks (0.5.1): one set for the whole app, the same in every project. A person
// adds them, or brings them in from a browser of this PC; an AI neither reads nor changes them.

export type BookmarkItem = { id: string; kind: "item"; title: string; url: string };
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
