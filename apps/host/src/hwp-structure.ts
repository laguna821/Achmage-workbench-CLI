/**
 * What a Hangul document holds, counted from an open engine document with calls that do not lay
 * anything out: the save fingerprint (H9) and the structural half of the corpus check (H5). The
 * characters of every container kind come from the shared text census (packages/contracts/src/hwp-text.ts).
 */
import type { HwpStructure } from "../../../packages/contracts/src/hwp.ts";
import { HWP_TEXT_KINDS, lostText, lostUnread } from "../../../packages/contracts/src/hwp-text.ts";

export type { HwpStructure };
export { FONT_NAME_MAX, FONT_NAMES_MAX, hwpStructureOf, type HwpStructureSource } from "../../../packages/contracts/src/hwp-structure.ts";
import { FONT_NAME_MAX, FONT_NAMES_MAX } from "../../../packages/contracts/src/hwp-structure.ts";

const LABELS: Record<string, string> = {
  tbl: "표", "gso:그림": "그림", eqed: "수식", head: "머리말", foot: "꼬리말", fn: "각주", en: "미주", secd: "구역 정의", cold: "단 설정",
  pgnp: "쪽 번호", pghd: "감추기", atno: "자동 번호", nwno: "새 번호", bokm: "책갈피", tcmt: "숨은 설명", tdut: "덧말", "?": "양식·필드 개체",
};
export const structureLabel = (kind: string) => LABELS[kind] ?? (kind.startsWith("gso:") ? kind.slice(4) || "그리기 개체" : kind);
const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, count) => sum + count, 0);

/**
 * What `saved` lost against `expected`, one short Korean phrase each ("표 3→2"). More is never a
 * loss (an edit may add anything). Fields count as one total: the save fixes restore field kinds.
 */
export function lostStructure(expected: HwpStructure, saved: HwpStructure): string[] {
  const lost: string[] = [];
  if (saved.sections < expected.sections) lost.push(`구역 ${expected.sections}→${saved.sections}`);
  expected.paragraphs.forEach((count, section) => {
    const now = saved.paragraphs[section] ?? 0;
    if (now < count) lost.push(`${section + 1}구역 문단 ${count}→${now}`);
  });
  for (const [kind, count] of Object.entries(expected.objects)) {
    const now = saved.objects[kind] ?? 0;
    if (now < count) lost.push(`${structureLabel(kind)} ${count}→${now}`);
  }
  if (total(saved.fields) < total(expected.fields)) lost.push(`필드 ${total(expected.fields)}→${total(saved.fields)}`);
  if (saved.memos < expected.memos) lost.push(`메모 ${expected.memos}→${saved.memos}`);
  if (saved.numberings < expected.numberings) lost.push(`문단 번호 ${expected.numberings}→${saved.numberings}`);
  if (saved.styles < expected.styles) lost.push(`스타일 ${expected.styles}→${saved.styles}`);
  const fonts = new Set(saved.fonts), missing = expected.fonts.filter((name) => !fonts.has(name));
  if (missing.length) lost.push(`글꼴 ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` 외 ${missing.length - 3}개` : ""}`);
  // a text loss needs both censuses: one that could not be computed establishes nothing
  if (expected.chars && saved.chars) lost.push(...lostText(expected.chars, saved.chars));
  // what the census cannot read, counted per container: a drop is refused like a loss (S2), a rise never
  if (expected.unread && saved.unread) lost.push(...lostUnread(expected.unread, saved.unread));
  return lost;
}

const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const counts = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 500
  && Object.entries(value).every(([key, item]) => key.length <= 100 && count(item));
/** A structure from a save request: bounded, so a request cannot make the gateway compare without end. */
export function validStructure(value: unknown): value is HwpStructure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return [item.sections, item.memos, item.numberings, item.styles].every(count)
    && (item.textUnchecked === undefined
      ? !!item.chars && typeof item.chars === "object" && HWP_TEXT_KINDS.every((kind) => count((item.chars as Record<string, unknown>)[kind])) && Object.keys(item.chars).length === HWP_TEXT_KINDS.length
        && typeof item.textSha256 === "string" && /^[0-9a-f]{64}$/.test(item.textSha256) && counts(item.unread)
      : typeof item.textUnchecked === "string" && item.textUnchecked.length <= 200 && item.chars === undefined && item.textSha256 === undefined && item.unread === undefined)
    && Array.isArray(item.paragraphs) && item.paragraphs.length <= 10_000 && item.paragraphs.every(count)
    && counts(item.objects) && counts(item.fields)
    && Array.isArray(item.fonts) && item.fonts.length <= FONT_NAMES_MAX && item.fonts.every((name) => typeof name === "string" && name.length <= FONT_NAME_MAX);
}
