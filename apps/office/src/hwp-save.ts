import type { HwpStructure } from "../../../packages/contracts/src/hwp.ts";
import { runSave as save, type SaveEditorPort } from "../../../third_party/ieumoffice/hwp/save-flow.ts";
import { studioReport, type StudioReport } from "./hwp-structure-report.ts";

export type { SaveEditorPort } from "../../../third_party/ieumoffice/hwp/save-flow.ts";

/** Ieum lists live memos for HWPX. Workbench also needs them when Save As targets HWP,
 * so an intentional deletion is distinguishable from an export that lost a memo.
 * Keep upstream verification, locking failure behavior, tab repair and notifications.
 * With the memos goes the live document's structure (the save fingerprint compares the saved
 * bytes with it), counted under the same lock right before the export, never without it.
 */
const told = new Set<string>();
/** Once per page and reason: a save went without the live report (the gateway then compares with the export only). */
function noReport(why: string) {
  if (told.has(why)) return;
  told.add(why);
  console.warn(`Hangul save without the studio's structure report (${why}); the gateway compares the saved bytes with the editor's export only.`);
}

/** Once per page and reason: the report went, but the studio could not count its text (S1); the gateway compares the text where it can. */
function textUnchecked(why: string) {
  if (told.has(`text:${why}`)) return;
  told.add(`text:${why}`);
  console.warn(`Hangul save with the studio's structure report but without its text census (${why}); the gateway compares structure, and the text only where it can count both sides.`);
}

export function runSaveWith(report: () => StudioReport) {
  return async function runSave(...[editor, api, mode, automatic]: Parameters<typeof save>) {
    let snapshot: Awaited<ReturnType<SaveEditorPort["listMemos"]>> | undefined;
    let structure: HwpStructure | null = null, locked = false;
    const counted = () => {
      structure = null;
      if (!locked) return noReport("the memo lock was not taken");
      const taken = report();
      if ("why" in taken) return noReport(taken.why);
      structure = taken.structure;
      if (structure.textUnchecked) textUnchecked(structure.textUnchecked);
    };
    return save({
      ...editor,
      async setMemoLock(lock) {
        const result = await editor.setMemoLock(lock);
        locked = lock;
        return result;
      },
      async exportHwpx() { counted(); return editor.exportHwpx(); },
      async exportHwp() {
        try { await editor.setMemoLock(true); locked = true; } catch { /* no trusted snapshot */ }
        if (!locked) { snapshot = null; structure = null; noReport("the memo lock was not taken"); return editor.exportHwp(); }
        try {
          snapshot = await editor.listMemos().catch(() => null);
          counted();
          return await editor.exportHwp();
        } finally { locked = false; await editor.setMemoLock(false).catch(() => {}); }
      },
    }, {
      ...api,
      commitSave: (bytes, tabs, options) => api.commitSave(bytes, tabs, {
        ...(snapshot === undefined ? options : { ...options, memos: snapshot }),
        ...(structure ? { structure } : {}),
      }),
    }, mode, automatic);
  };
}

export const runSave = (...args: Parameters<typeof save>) => runSaveWith(studioReport)(...args);
