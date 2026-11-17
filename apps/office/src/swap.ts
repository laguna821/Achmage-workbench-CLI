/**
 * The editor pool, the page's side (0.5.4; the window's side: apps/web/src/editor-pool.ts, OfficeEditor.tsx). One running
 * editor serves the documents of its kind that are on screen one after another: the window asks
 *
 * 1. `office:park` — the document shown now gives the frame away: its unsaved edits are written as the editor's own
 *    serialised copy (the recovery copy, the same one the crash path restores) and the page answers `office:parked`;
 *    `ok: false` when anything is running (a 문서 AI turn, a copy, an output) or the copy could not be written — then the
 *    frame stays with that document;
 * 2. `office:swap` — open THIS document in place: answered FIRST by `office:swapped` (so the window can tell what the
 *    page says about which document), then `init` is re-pointed at the new document (its token, its conversation, its
 *    view place, recover: its kept copy), the document is opened through the editor's own open path, and the page says
 *    `office:opened` etc. as on a first open.
 *
 * While a swap runs the page says nothing about dirtiness, writes no recovery copy and saves nothing: the editor still
 * shows the old document until the new one is in, and those would name the new one.
 */
import { listen, pageRest, post, type Gateway, type Init } from "./bridge.ts";

export type SwapEditor = {
  /** Unsaved edits now (the editor's own check). */
  dirty(): Promise<boolean>;
  /**
   * What the editor last said about unsaved edits without asking it again (null: not known). A parked page is hidden and
   * rests, so asking takes a frame it does not get soon; clean as last said is taken as clean — nothing can be typed
   * into a page off screen, and leaving it asked afresh (its leave-save).
   */
  lastDirty?(): boolean | null;
  /** Write the recovery copy of the unsaved edits now; true once it is written. */
  keep(): Promise<boolean>;
  /** Something of this page would be cut by a swap (a copy, an output, a save on its way). */
  busy(): boolean;
  /** Open the document `init` names now, in place (its kept copy when there is one); resolves once it is shown. */
  open(): Promise<void>;
};
type SwapAi = { swap(next: string | null): boolean; busy(): boolean };

let swapping = false;
/** A swap is on its way: the page's dirty reports, recovery writes and saves wait. */
export const swapInProgress = () => swapping;
let settled: (() => void)[] = [];
/** Resolves once no swap is on its way (at once when none is). */
export function afterSwap(): Promise<void> {
  return swapping ? new Promise((resolve) => settled.push(resolve)) : Promise.resolve();
}
const swapEnded = () => { const waiting = settled; settled = []; for (const resolve of waiting) resolve(); };

export function installSwap(init: Init, gateway: Gateway, ai: SwapAi, editor: SwapEditor, after: () => void = () => {}) {
  let parking = false;
  const stop = listen((message) => {
    if (message.type === "office:park") {
      if (parking) return;
      parking = true;
      // A hidden page rests (page-rest.ts): writing the copy must not wait for it to be shown.
      const release = pageRest.hold("park");
      void (async () => {
        try {
          if (swapping || ai.busy() || editor.busy()) return false;
          if (editor.lastDirty?.() === false || !(await editor.dirty())) return true;
          return await editor.keep();
        } catch { return false; }
      })().then((ok) => { parking = false; release(); post({ type: "office:parked", ok }); });
    }
    if (message.type === "office:swap") {
      if (swapping || parking || ai.busy() || editor.busy()) { post({ type: "office:swapped", epoch: message.epoch, ok: false }); return; }
      const { type: _type, epoch, ...next } = message;
      post({ type: "office:swapped", epoch, ok: true });
      swapping = true;
      const release = pageRest.hold("swap");
      // Every field the new document does not name (its view place) is cleared, not left from the old one.
      Object.assign(init, { view: undefined }, next);
      gateway.setToken(next.token);
      // The AI panel starts afresh on the new document's conversation (nothing of it runs: checked above, same task).
      ai.swap(next.sessionId);
      void editor.open().then(() => true, () => false).then((opened) => {
        release();
        // Not opened in place: the page may still show the document before — it stays "swapping" (saying, writing and
        // saving nothing) and the window opens the page again for this one.
        if (!opened) { post({ type: "office:swap-failed" }); return; }
        swapping = false; swapEnded();
        // What the window learns on a first open: it may take revisions in place, and swap again.
        post({ type: "office:replace-ready" });
        post({ type: "office:swap-ready" });
        (window as { workbenchEditorDock?: { again(): void } }).workbenchEditorDock?.again();
        after();
      });
    }
  });
  post({ type: "office:swap-ready" });
  return stop;
}
