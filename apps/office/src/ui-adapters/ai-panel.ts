/**
 * Where each editor remembers whether its own "AI 도우미" panel was open (the vendored editors call
 * `aiPanelInitiallyOpen(key)`; nothing stored = open). The Hangul studio is not here: its dock is the
 * head's 문서 AI and already starts closed (hwp-ai-dock.ts).
 */
export const EDITOR_AI_PANEL_KEYS = ["aidocs.showAi", "ai-slides-show-ai", "ai-sheets-show-ai", "mdapp.showAi", "htmlapp.showAi", "genoffice-pdf-show-ai"] as const;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/**
 * A new person meets ONE AI on a document: the head's 문서 AI (design review I7). The editor's own
 * panel, which edits the open document live and can do what 문서 AI cannot, starts closed; its rail
 * key beside the page stays the way in. Stores "closed" once, where nothing is stored; a person who
 * opened or closed it keeps that (a stored choice is never changed).
 */
export function keepEditorAiPanelClosed(storage: Storage): void {
  for (const key of EDITOR_AI_PANEL_KEYS) {
    try { if (storage.getItem(key) === null) storage.setItem(key, "0"); } catch { /* storage unavailable: the editor's default */ }
  }
}
