/** Ieum's Word editor remembers 보기 › 어둡게 보기 here (vendor docs dark-page-pref.ts DARK_PAGE_KEY). */
const DARK_PAGE_KEY = "aidocs.darkPage";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/**
 * A Word page is white paper in both themes (skin 2): in the dark theme the canvas around it goes dark, the
 * page does not. Ieum's editor darkens the page by default in the dark theme while nothing is stored; this
 * stores "off" once, before the editor starts. A person who turns 어둡게 보기 on (or did before) keeps it:
 * a stored choice is never changed. Only how the page is shown changes, never the document.
 */
export function keepPaperWhite(storage: Storage): void {
  try { if (storage.getItem(DARK_PAGE_KEY) === null) storage.setItem(DARK_PAGE_KEY, "0"); } catch { /* storage unavailable: the editor's default */ }
}
