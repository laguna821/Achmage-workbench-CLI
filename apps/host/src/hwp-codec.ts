import type { HwpFormat, HwpSaveMetadata, HwpStructure, MeasuredTab, MemoSnapshot } from "../../../packages/contracts/src/hwp.ts";
import { fieldKindsOf } from "../../../third_party/ieumoffice/hwp/field-kinds.ts";
import { lostMemoCountOf } from "../../../third_party/ieumoffice/hwp/memos.ts";
import { applySaveFixes, type SaveBase } from "../../../third_party/ieumoffice/hwp/save-fixes.ts";
import { bytesMatchFormat } from "../../../third_party/ieumoffice/hwp/save-plan.ts";
import { sectionTailsOf } from "../../../third_party/ieumoffice/hwp/section-tails.ts";
import { newTabsOf } from "../../../third_party/ieumoffice/hwp/tab-widths.ts";
import { hasTrackedChanges, withoutTrackedChanges } from "../../../third_party/ieumoffice/hwp/tracked-changes.ts";
import { hwpMemosOf, hwpToText } from "../../../third_party/ieumoffice/file-parse/hwp.ts";
import { withHwpDocument } from "./hwp-document.ts";
import { assertZipInflatesWithinLimits } from "../../../third_party/ieumoffice/zip-gate/index.ts";
import { HttpError } from "./errors.ts";
import { hwpStructureOf, lostStructure, validStructure } from "./hwp-structure.ts";

export const HWP_MAX_BYTES = 200_000_000;
const bad = (message: string) => new HttpError(422, "invalid_hwp", message);
export function hwpFormat(value: string): HwpFormat {
  if (value !== "hwp" && value !== "hwpx") throw new HttpError(415, "not_hangul", "한글 문서가 아닙니다.");
  return value;
}
async function checkContainer(data: Uint8Array, format: HwpFormat) {
  if (!data.length || data.length > HWP_MAX_BYTES || !bytesMatchFormat(data, format)) throw bad("한글 파일 형식이나 크기가 올바르지 않습니다.");
  if (format === "hwpx") {
    try { await assertZipInflatesWithinLimits(data); }
    catch (error) { throw bad(`한글 압축 파일을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
/** Opening and saving use the same source-side repairs as Ieum; the original revision stays intact. */
export async function openHwpBytes(data: Uint8Array, format: HwpFormat) {
  await checkContainer(data, format);
  let bytes = data, trackingDropped = false, saveBlocked = false;
  if (format === "hwp" && hasTrackedChanges(bytes)) {
    const current = withoutTrackedChanges(bytes);
    if (current) { bytes = current; trackingDropped = true; } else saveBlocked = true;
  }
  const base: SaveBase = format === "hwp" ? { tails: sectionTailsOf(bytes) ?? undefined, kinds: fieldKindsOf(bytes) ?? undefined } : {};
  return { bytes, trackingDropped, saveBlocked, base };
}
export async function hwpTabs(data: Uint8Array, format: HwpFormat) {
  await checkContainer(data, format);
  return newTabsOf(data, format);
}

const integer = (value: unknown, min = 0) => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= 0x7fffffff;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function validTab(value: unknown): value is MeasuredTab {
  if (!object(value) || ![value.sec, value.para, value.tab, value.tabs, value.width, value.type, value.fill].every((item) => integer(item))) return false;
  return (value.width as number) > 0 && (value.type as number) <= 3 && (value.fill as number) <= 255 && Array.isArray(value.cells) && value.cells.length <= 64 && value.cells.every((cell) => object(cell) && [cell.table, cell.cell, cell.para].every((item) => integer(item)));
}
function validMemo(value: unknown): value is MemoSnapshot {
  if (!object(value) || ![value.author, value.text, value.place].every((item) => typeof item === "string") || (value.date !== null && typeof value.date !== "string")) return false;
  if (![value.sectionIndex, value.paraIndex, value.startCharIdx, value.endCharIdx].every((item) => item === null || integer(item))) return false;
  return value.path === null || Array.isArray(value.path) && value.path.length <= 64 && value.path.every((part) => object(part) && (part.type === "cell" || part.type === "textbox") && integer(part.controlIndex) && (part.cellIndex === undefined || integer(part.cellIndex)) && (part.paraIndex === undefined || integer(part.paraIndex)));
}
export function decodeHwpSave(body: Buffer): { metadata: HwpSaveMetadata; bytes: Buffer } {
  if (body.length < 5) throw bad("한글 저장 요청이 비어 있습니다.");
  const length = body.readUInt32BE(0);
  if (length > 1_000_000 || length + 4 >= body.length || body.length - length - 4 > HWP_MAX_BYTES) throw bad("한글 저장 요청 크기가 올바르지 않습니다.");
  let value: unknown;
  try { value = JSON.parse(body.subarray(4, 4 + length).toString("utf8")); } catch { throw bad("한글 저장 정보를 읽지 못했습니다."); }
  if (!object(value) || (value.tabs !== undefined && (!Array.isArray(value.tabs) || value.tabs.length > 5000 || !value.tabs.every(validTab))) || (value.memos !== undefined && value.memos !== null && (!Array.isArray(value.memos) || value.memos.length > 5000 || !value.memos.every(validMemo)))) throw bad("탭 간격이나 메모 정보가 올바르지 않습니다.");
  if (value.structure !== undefined && value.structure !== null && !validStructure(value.structure)) throw bad("한글 저장 정보의 문서 구조 정보가 올바르지 않습니다.");
  return { metadata: value as HwpSaveMetadata, bytes: body.subarray(4 + length) };
}

/**
 * How a structural loss found by the fingerprint is handled: refused (the default, and always for
 * the original file), or — for Save As to a new file, the person's way out — passed to `warn`.
 */
export type HwpLossPolicy = {
  warn?: (lost: string[]) => void;
  /**
   * Filled in by a save (not a recovery draft): whether the text of every container could be
   * compared ("checked") or a text census could not be computed on some side ("unchecked") — the
   * save then went on with the structure counts and the export comparison only (S1). `structure`:
   * "unchecked" when even the structure of the saved bytes, or of the editor's export it is compared
   * with, could not be counted (then `text` is "unchecked" too) — a failure of our
   * own counting is not a loss, so the save went on with the checks that ran before it (the
   * container, Ieum's reader, memos, tracked changes); the log says why.
   */
  check?: { text?: "checked" | "unchecked"; structure?: "checked" | "unchecked" };
};

/** No file is written here. The caller rechecks the writer/revision/disk CAS after these awaits. */
export async function prepareHwpSave(original: Uint8Array, data: Uint8Array, format: HwpFormat, metadata: HwpSaveMetadata, purpose: "save" | "recovery" = "save", originalFormat: HwpFormat = format, policy: HwpLossPolicy = {}) {
  await checkContainer(data, format);
  const opened = await openHwpBytes(original, originalFormat);
  if (opened.saveBlocked) throw bad("이 문서의 변경 추적을 보존할 수 없어 저장하지 않았습니다.");
  const fixed = applySaveFixes(data, format, metadata.tabs, opened.base);
  if (fixed.tailsSkipped) throw new HttpError(422, "hwp_content_loss", "마스터 페이지나 메모를 보존할 수 없어 저장하지 않았습니다. 원본과 편집 내용은 유지됩니다.");
  // Validate both the document and memo model before considering the output a new revision
  // (Ieum's reader, as generated); the fingerprint below counts the same bytes in its own opening.
  await hwpToText(fixed.bytes);
  const held = purpose === "save" ? await withHwpDocument(fixed.bytes, census) : null;
  if (purpose === "save" && policy.check) {
    policy.check.structure = held ? "checked" : "unchecked";
    if (!held) policy.check.text = "unchecked";
  }
  if ((format === "hwpx" || format !== originalFormat) && purpose === "save") {
    await hwpMemosOf(fixed.bytes);
    const originalMemos = await hwpMemosOf(original);
    // If the UI could not list its live memos, preserve every original memo. An intentional
    // deletion must provide the actual (possibly empty) snapshot, never an absent list.
    const wanted = metadata.memos ?? originalMemos.map((memo): MemoSnapshot => ({ author: memo.author ?? "", date: memo.date ?? null, text: memo.text ?? "", place: memo.place ?? "", sectionIndex: null, paraIndex: null, startCharIdx: null, endCharIdx: null, path: null }));
    const lost = await lostMemoCountOf({ saved: fixed.bytes, original, memos: wanted });
    if (lost > 0) throw new HttpError(422, "hwp_content_loss", `메모 ${lost}개를 보존할 수 없어 저장하지 않았습니다. 원본과 편집 내용은 유지됩니다.`);
  }
  if (held) await checkFingerprint(held, fixed.bytes, data, metadata.structure ?? null, policy);
  return Buffer.from(fixed.bytes.buffer, fixed.bytes.byteOffset, fixed.bytes.byteLength);
}

/**
 * An engine whose STRUCTURE calls fail (a renamed call after an upgrade): the census is absent
 * (null), never a refusal and never a 500 — a failure of our own counting is not a loss (S1, also
 * for the structure). The save goes on unchecked and says so (`structure: "unchecked"`); the log
 * names the kind of error only (an error's message can quote document text). The corpus tool and
 * the studio build check are where such an engine is caught loudly. A text census that fails does
 * not get here: hwpStructureOf returns the structure with `textUnchecked`.
 */
function census(doc: Parameters<typeof hwpStructureOf>[0]) {
  try { return hwpStructureOf(doc); }
  catch (error) {
    console.warn(`[hwp] the structure of a document could not be counted (${error instanceof Error ? error.name : "error"}): the save fingerprint is skipped for it`);
    return null;
  }
}
export const HWP_LOSS_REFUSED = "보존할 수 없는 내용이 있어 저장하지 않았습니다";
const lossList = (lost: string[]) => `${lost.slice(0, 4).join(", ")}${lost.length > 4 ? ` 외 ${lost.length - 4}가지` : ""}`;
/** The Save As warning: what the new file lacks against the editor's document. */
export const hwpLossWarning = (lost: string[]) => `새 파일에 저장했지만 저장본에 빠진 내용이 있습니다 (${lossList(lost)}). 원본 파일은 그대로입니다.`;

/**
 * The save fingerprint: the bytes about to be written are opened again with the same engine and
 * compared with what the editor reports its live document holds (a deliberate deletion is already
 * in that report) — structure and the characters of every container kind. They are also compared
 * with the editor's own export whenever the save fixes changed the bytes, so the save step itself
 * loses nothing even if a report under-counts. Both must pass. Recovery drafts are never refused
 * (they are not written over the file). A changed whole-text hash is not a refusal reason.
 */
async function checkFingerprint(saved: HwpStructure, savedBytes: Uint8Array, exported: Uint8Array, reported: HwpStructure | null, policy: HwpLossPolicy) {
  // Unchanged by the save fixes: the export is what was already opened and counted.
  const unchanged = Buffer.from(savedBytes.buffer, savedBytes.byteOffset, savedBytes.byteLength).equals(exported);
  const counted = [saved, reported, unchanged ? null : await withHwpDocument(exported, census)];
  const lost = new Set(reported ? lostStructure(reported, saved) : []);
  if (counted[2]) for (const item of lostStructure(counted[2], saved)) lost.add(item);
  // A text census that could not be computed (the editor's, the saved bytes' or the export's) is
  // not a loss: the comparisons above ran without the text; the answer says so, the log says why.
  const unchecked = [...new Set(counted.flatMap((item, index) => item?.textUnchecked ? [`${["saved", "editor", "export"][index]}: ${item.textUnchecked}`] : []))];
  // The export's STRUCTURE census failed (`census` logged its error kind): the export comparison did
  // not run, so neither the structure nor the text was checked on every side (T3, m3-3).
  const exportUncounted = !unchanged && !counted[2];
  if (exportUncounted) unchecked.push("export: 구조 검사 못함");
  if (unchecked.length) console.warn(`[hwp] save fingerprint without the text comparison (${unchecked.join("; ")})`);
  if (policy.check) {
    policy.check.text = unchecked.length ? "unchecked" : "checked";
    if (exportUncounted) policy.check.structure = "unchecked";
  }
  if (!lost.size) return;
  if (policy.warn) return policy.warn([...lost]);
  throw new HwpLossError([...lost]);
}
/** The fingerprint's refusal; `lost` lets a caller (the document AI) say it in its own words. */
export class HwpLossError extends HttpError {
  readonly lost: string[];
  constructor(lost: string[]) {
    super(422, "hwp_content_loss", `${HWP_LOSS_REFUSED} (${lossList(lost)}). 원본 파일은 그대로입니다. 편집한 내용은 이 창에 남아 있으니 다른 이름으로 저장해 새 파일로 남길 수 있습니다.`);
    this.lost = lost;
  }
}
