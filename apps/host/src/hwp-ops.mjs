// Thin host for the unchanged, pinned Ieum headless editor. The original renderer skill and
// plugin define these operations; Workbench does not maintain a second operation language.
import { hwpWasmPath } from './hwp-resource.ts';
import { openHwpBytes, hwpFormat, prepareHwpSave, HwpLossError } from './hwp-codec.ts';
import { hwpStructureOf } from './hwp-structure.ts';

const upstream = () => import('@ieum-hwp/packages/cli/src/formats/hwp-edit.ts');
// Upstream's headless list (v0.13.0) keeps analyze_picture, which asks the app's window for a picture
// reader: there is none here, and Workbench does not offer picture reading to the Hangul AI (unit hwp13).
export const HWP_OPS_NOT_OFFERED = new Set(['analyze_picture']);
export async function hwpCatalog() {
  const mod = await upstream(), catalog = await mod.hwpCatalog();
  const offered = (name) => !HWP_OPS_NOT_OFFERED.has(name);
  const { fingerprint } = await import('@ieum-hwp/packages/cli/src/op-catalog.ts');
  const rest = { domain: catalog.domain, groups: catalog.groups.map((group) => ({ ...group, ops: group.ops.filter(offered) })).filter((group) => group.ops.length > 0), ops: catalog.ops.filter((entry) => offered(entry.op)) };
  return { domain: rest.domain, fingerprint: fingerprint(rest), groups: rest.groups, ops: rest.ops };
}

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
    const refused = ops.find((item) => HWP_OPS_NOT_OFFERED.has(item?.op));
    if (refused) throw new Error(`${refused.op} is not available here: nothing can look at a picture of the document. Ask the user what the picture shows.`);
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

/**
 * 내보내기 › HWP (hangul-convert.ts): an HWPX opened by the same headless session and saved as .hwp —
 * the engine's own read-back check (exportHwpVerify: the written .hwp opens again with the same page
 * count) and then the save checks every Save As passes (prepareHwpSave: container, Ieum's reader,
 * memos and the structure/text fingerprint against the session). No second writer; nothing written
 * here — the caller writes the returned bytes to a new file. Refused (thrown) when a check fails.
 */
export function hwpxToHwp(bytes) {
  const run = tail.then(async () => {
    const opened = await openHwpBytes(bytes, 'hwpx');
    process.env.GENOFFICE_RHWP_WASM = hwpWasmPath();
    const mod = await upstream(), session = await mod.openHwpForEdit(opened.bytes);
    try {
      const saved = await mod.saveHwpSession(session, 'hwp');
      if (saved.tailsLost || saved.memosLost) throw new Error('Master pages or memos would be lost; no HWP was written.');
      const structure = sessionStructure(session.doc);
      const check = {};
      const checked = await prepareHwpSave(bytes, saved.bytes, 'hwp', { memos: JSON.parse(session.doc.getMemoList()), structure: structure ?? undefined }, 'save', 'hwpx', { check });
      return { bytes: checked, structure: !structure || check.structure !== 'checked' ? 'unchecked' : 'checked', text: !structure || check.text !== 'checked' ? 'unchecked' : 'checked' };
    } finally { mod.closeHwpSession(session); }
  });
  tail = run.then(() => undefined, () => undefined);
  return run;
}
