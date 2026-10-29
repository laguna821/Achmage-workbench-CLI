import { runSave as save, type SaveEditorPort } from "../../../third_party/ieumoffice/hwp/save-flow.ts";

export type { SaveEditorPort } from "../../../third_party/ieumoffice/hwp/save-flow.ts";

/** Ieum lists live memos for HWPX. Workbench also needs them when Save As targets HWP,
 * so an intentional deletion is distinguishable from an export that lost a memo.
 * Keep upstream verification, locking failure behavior, tab repair and notifications.
 */
export async function runSave(...[editor, api, mode, automatic]: Parameters<typeof save>) {
  let snapshot: Awaited<ReturnType<SaveEditorPort["listMemos"]>> | undefined;
  return save({
    ...editor,
    async exportHwp() {
      let locked = false;
      try { await editor.setMemoLock(true); locked = true; } catch { /* no trusted snapshot */ }
      if (!locked) { snapshot = null; return editor.exportHwp(); }
      try {
        snapshot = await editor.listMemos().catch(() => null);
        return await editor.exportHwp();
      } finally { await editor.setMemoLock(false).catch(() => {}); }
    },
  }, {
    ...api,
    commitSave: (bytes, tabs, options) => api.commitSave(bytes, tabs, snapshot === undefined ? options : { ...options, memos: snapshot }),
  }, mode, automatic);
}
