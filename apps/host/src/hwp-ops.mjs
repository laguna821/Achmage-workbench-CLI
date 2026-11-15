// Thin host for the unchanged, pinned Ieum headless editor. The original renderer skill and
// plugin define these operations; Workbench does not maintain a second operation language.
import { hwpWasmPath } from './hwp-resource.ts';
import { openHwpBytes, hwpFormat, prepareHwpSave, HwpLossError } from './hwp-codec.ts';
import { hwpStructureOf } from './hwp-structure.ts';

const upstream = () => import('../../../vendor/ieumoffice/packages/cli/src/formats/hwp-edit.ts');
export async function hwpCatalog() { return (await upstream()).hwpCatalog(); }

/** The session's structure, or null when the census throws (logged with the error kind only: a message can quote document text). */
function sessionStructure(doc) {
  try { return hwpStructureOf(doc); }
  catch (error) {
    console.warn(`[hwp] document AI save without the session's structure census (${error instanceof Error ? error.name : 'error'}): saved unchecked`);
    return null;
  }
}

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
      // What the session holds after the operations: its deliberate deletions are not losses.
      // A census of OUR counting that throws is not a loss (the rule of Save and Save As, T3): the save
      // goes on without the session's structure, and the answer and the log say it was unchecked.
      const structure = sessionStructure(session.doc);
      const check = {};
      const checked = await prepareHwpSave(bytes, saved.bytes, format, { memos, structure: structure ?? undefined }, 'save', format, { check }).catch((error) => {
        if (!(error instanceof HwpLossError)) throw error;
        // The engine's own words: the person's message ("편집 내용은 유지됩니다") is not true for a headless session.
        throw Object.assign(new Error(`Not saved: the saved document would lose ${error.lost.join(', ')}. Nothing was written and the editing session was discarded. Do not retry or change the file another way; tell the user what would be lost.`), { detail: { code: 'hwp_content_loss', lost: error.lost } });
      });
      const unchecked = !structure || check.structure !== 'checked';
      return { ...outcome, bytes: checked, changed: true, trackingDropped: opened.trackingDropped, structure: unchecked ? 'unchecked' : 'checked', text: unchecked || check.text !== 'checked' ? 'unchecked' : 'checked' };
    } finally { mod.closeHwpSession(session); }
  });
  tail = run.then(() => undefined, () => undefined);
  return run;
}
