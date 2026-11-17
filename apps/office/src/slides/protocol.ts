// Messages between the slides editor page and its worker (worker.ts), which runs IeumOffice's
// slides editing code (pptx parsing, layout, edits, saving) off the page's thread.

export type WorkerRequest =
  | { type: "mcp"; command: "ready" | "read_deck" | "apply_slide_ops" | "deck_withholds"; payload?: unknown }
  | { type: "init"; token: string }
  /** The editor pool opened another document in this page: its token reads the fonts from now on. */
  | { type: "token"; token: string }
  /** The editor pool: the deck before is gone from this page (its working copy is let go). */
  | { type: "close-previous" }
  /** Open a document (its bytes) as the page's view. */
  /** `generation`: a later revision opened in the same page (in place) gets its own path, so nothing of the earlier deck is reused. */
  | { type: "open"; name: string; bytes: ArrayBuffer; generation?: number }
  /** `ipcRenderer.invoke` of IeumOffice's renderer. */
  | { type: "invoke"; channel: string; args: unknown[]; authorName?: string }
  /** `ipcRenderer.send`. */
  | { type: "send"; channel: string; args: unknown[] }
  /** The working copy as the last save wrote it. */
  | { type: "saved-bytes" }
  /** The deck as it is now, unsaved edits included (a recovery copy; nothing is marked saved). */
  | { type: "snapshot" }
  | { type: "dirty" }
  /** A save was not taken as a revision: the deck counts as unsaved again. */
  | { type: "mark-dirty" }
  /** What another app copied (a PNG and/or text), seen by the page in a paste: the editor's clipboard now holds it. */
  | { type: "clipboard"; text?: string; png?: ArrayBuffer };

export type WorkerCall = WorkerRequest & { id: number };

/** A bundled template face layout has just measured with: the page registers it before the message that carries that layout is handled. */
export type FontFaceBytes = { id: string; family: string; bold: boolean; italic: boolean; weight?: string; bytes: ArrayBuffer };

export type WorkerMessage =
  | { type: "reply"; id: number; ok: true; value: unknown; unhandled?: boolean; fonts?: FontFaceBytes[] }
  | { type: "reply"; id: number; ok: false; error: string; fonts?: FontFaceBytes[] }
  /** `webContents.send` to the page. */
  | { type: "send"; channel: string; args: unknown[]; fonts?: FontFaceBytes[] }
  /** Something the user should be told (an editor message box). */
  | { type: "notice"; message: string };
