// Thin host for the unchanged, pinned Ieum headless editor. The original renderer skill and
// plugin define these operations; Workbench does not maintain a second operation language.
import { hwpWasmPath } from './hwp-resource.ts';
import { openHwpBytes, hwpFormat, prepareHwpSave } from './hwp-codec.ts';

const upstream = () => import('../../../vendor/ieumoffice/packages/cli/src/formats/hwp-edit.ts');
export async function hwpCatalog() { return (await upstream()).hwpCatalog(); }

// Ieum's plugin singleton keeps activation listeners. Never overlap documents in this process.
let tail = Promise.resolve();
export function editHwp(bytes, format, ops, options = {}) {
  const run = tail.then(async () => {
    if (!Array.isArray(ops) || !ops.length || ops.length > 1000) throw new Error('Expected 1–1000 document operations.');
    const opened = await openHwpBytes(bytes, hwpFormat(format));
    if (opened.saveBlocked) throw new Error('Tracked changes cannot be preserved; the file was not changed.');
    process.env.GENOFFICE_RHWP_WASM = hwpWasmPath();
    const mod = await upstream(), session = await mod.openHwpForEdit(opened.bytes);
    try {
      const outcome = await mod.applyHwpOps(session, ops, options.mode ?? 'atomic');
      if (options.dryRun || !outcome.results.some((item) => item.changed)) return { ...outcome, bytes, changed: false, trackingDropped: opened.trackingDropped };
      const saved = await mod.saveHwpSession(session, format);
      if (saved.tailsLost || saved.memosLost) throw new Error('Master pages or memos would be lost; the file was not changed.');
      const memos = JSON.parse(session.doc.getMemoList());
      const checked = await prepareHwpSave(bytes, saved.bytes, format, { memos });
      return { ...outcome, bytes: checked, changed: true, trackingDropped: opened.trackingDropped };
    } finally { mod.closeHwpSession(session); }
  });
  tail = run.then(() => undefined, () => undefined);
  return run;
}
