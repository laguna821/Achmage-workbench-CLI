// Messages between the slides editor page and its worker (worker.ts), which runs IeumOffice's
// slides editing code (pptx parsing, layout, edits, saving) off the page's thread.

export type WorkerRequest =
  | { type: "init"; token: string }
  /** Open a document (its bytes) as the page's view. */
  | { type: "open"; name: string; bytes: ArrayBuffer }
  /** `ipcRenderer.invoke` of IeumOffice's renderer. */
  | { type: "invoke"; channel: string; args: unknown[] }
  /** `ipcRenderer.send`. */
  | { type: "send"; channel: string; args: unknown[] }
  /** The working copy as the last save wrote it. */
  | { type: "saved-bytes" }
  /** The deck as it is now, unsaved edits included (a recovery copy; nothing is marked saved). */
  | { type: "snapshot" }
  | { type: "dirty" }
  /** A save was not taken as a revision: the deck counts as unsaved again. */
  | { type: "mark-dirty" };

export type WorkerCall = WorkerRequest & { id: number };

export type WorkerMessage =
  | { type: "reply"; id: number; ok: true; value: unknown; unhandled?: boolean }
  | { type: "reply"; id: number; ok: false; error: string }
  /** `webContents.send` to the page. */
  | { type: "send"; channel: string; args: unknown[] }
  /** Something the user should be told (an editor message box). */
  | { type: "notice"; message: string };
