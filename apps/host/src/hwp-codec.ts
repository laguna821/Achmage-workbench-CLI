import type { HwpFormat, HwpSaveMetadata, MeasuredTab, MemoSnapshot } from "../../../packages/contracts/src/hwp.ts";
import { fieldKindsOf } from "../../../third_party/ieumoffice/hwp/field-kinds.ts";
import { lostMemoCountOf } from "../../../third_party/ieumoffice/hwp/memos.ts";
import { applySaveFixes, type SaveBase } from "../../../third_party/ieumoffice/hwp/save-fixes.ts";
import { bytesMatchFormat } from "../../../third_party/ieumoffice/hwp/save-plan.ts";
import { sectionTailsOf } from "../../../third_party/ieumoffice/hwp/section-tails.ts";
import { newTabsOf } from "../../../third_party/ieumoffice/hwp/tab-widths.ts";
import { hasTrackedChanges, withoutTrackedChanges } from "../../../third_party/ieumoffice/hwp/tracked-changes.ts";
import { hwpMemosOf, hwpToText } from "../../../third_party/ieumoffice/file-parse/hwp.ts";
import { assertZipInflatesWithinLimits } from "../../../third_party/ieumoffice/zip-gate/index.ts";
import { HttpError } from "./errors.ts";

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
  return { metadata: value as HwpSaveMetadata, bytes: body.subarray(4 + length) };
}

/** No file is written here. The caller rechecks the writer/revision/disk CAS after these awaits. */
export async function prepareHwpSave(original: Uint8Array, data: Uint8Array, format: HwpFormat, metadata: HwpSaveMetadata, purpose: "save" | "recovery" = "save") {
  await checkContainer(data, format);
  const opened = await openHwpBytes(original, format);
  if (opened.saveBlocked) throw bad("이 문서의 변경 추적을 보존할 수 없어 저장하지 않았습니다.");
  const fixed = applySaveFixes(data, format, metadata.tabs, opened.base);
  if (fixed.tailsSkipped) throw new HttpError(422, "hwp_content_loss", "마스터 페이지나 메모를 보존할 수 없어 저장하지 않았습니다. 원본과 편집 내용은 유지됩니다.");
  // Validate both the document and memo model before considering the output a new revision.
  await hwpToText(fixed.bytes);
  if (format === "hwpx" && purpose === "save") {
    await hwpMemosOf(fixed.bytes);
    const originalMemos = await hwpMemosOf(original);
    // If the UI could not list its live memos, preserve every original memo. An intentional
    // deletion must provide the actual (possibly empty) snapshot, never an absent list.
    const wanted = metadata.memos ?? originalMemos.map((memo): MemoSnapshot => ({ author: memo.author ?? "", date: memo.date ?? null, text: memo.text ?? "", place: memo.place ?? "", sectionIndex: null, paraIndex: null, startCharIdx: null, endCharIdx: null, path: null }));
    const lost = await lostMemoCountOf({ saved: fixed.bytes, original, memos: wanted });
    if (lost > 0) throw new HttpError(422, "hwp_content_loss", `메모 ${lost}개를 보존할 수 없어 저장하지 않았습니다. 원본과 편집 내용은 유지됩니다.`);
  }
  return Buffer.from(fixed.bytes.buffer, fixed.bytes.byteOffset, fixed.bytes.byteLength);
}
