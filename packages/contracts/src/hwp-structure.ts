/**
 * What a Hangul document holds, counted from an open engine document with calls that do not lay
 * anything out. One function for both sides of the save fingerprint: the studio counts its live
 * document with it (apps/office/src/hwp-structure-report.ts), the gateway counts the saved bytes
 * (apps/host/src/hwp-structure.ts), and the corpus check uses it too. The characters of every
 * container kind and the whole-text hash come from the shared text census (./hwp-text.ts).
 */
import type { HwpStructure } from "./hwp.ts";
import { engineJson, HwpCensusError, hwpTextOf, type HwpText, type HwpTextSource } from "./hwp-text.ts";

/** The engine methods used; both the gateway's engine and the studio's document have them. */
export interface HwpStructureSource extends HwpTextSource {
  getSectionCount(): number;
  getParagraphCount(section: number): number;
  getParagraphLength(section: number, paragraph: number): number;
  getControls(): string;
  getFieldList(): string;
  getMemoList(): string;
  getDocumentInfo(): string;
  getNumberingList(): string;
  getStyleList(): string;
}

/** Drawing objects by what they are (picture, rectangle, OLE…); controls the engine does not name (form objects, field marks) as "?". */
const kindOf = (control: { ctrlId?: unknown; userDesc?: unknown }) =>
  control.ctrlId === "gso" ? `gso:${typeof control.userDesc === "string" ? control.userDesc : ""}` : typeof control.ctrlId === "string" && control.ctrlId ? control.ctrlId : "?";
const tally = (keys: string[]) => {
  const out: Record<string, number> = {};
  for (const key of keys) if (key) out[key] = (out[key] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};
const list = (json: string): Record<string, unknown>[] => { const value = engineJson(json); return Array.isArray(value) ? value : []; };
/**
 * Settings, not content: a page-number position applies from its paragraph on, and repeats in one
 * paragraph change nothing. HWP keeps such repeats (memo-source.hwp: 8 in one paragraph); the
 * HWPX writer keeps one. Counted once per paragraph that holds one, so the counts mean the same
 * in both formats; a paragraph that loses its setting altogether is still a loss.
 */
const ONE_PER_PARAGRAPH = new Set(["pgnp"]);
function controlKinds(controls: Record<string, unknown>[]) {
  const places = new Set<string>();
  return controls.flatMap((control) => {
    const kind = kindOf(control);
    if (!ONE_PER_PARAGRAPH.has(kind)) return [kind];
    const place = JSON.stringify([kind, control.list, control.para]);
    if (places.has(place)) return [];
    places.add(place);
    return [kind];
  });
}

/** Font names come from the document: trimmed and capped the same way on every side, so a report never exceeds what a save request may carry. */
export const FONT_NAME_MAX = 200, FONT_NAMES_MAX = 1000;
export function hwpStructureOf(doc: HwpStructureSource): HwpStructure {
  const sections = doc.getSectionCount(), paragraphs: number[] = [];
  for (let section = 0; section < sections; section++) paragraphs.push(doc.getParagraphCount(section));
  const info = engineJson<{ fontsUsed?: unknown }>(doc.getDocumentInfo());
  const fonts = Array.isArray(info.fontsUsed)
    ? [...new Set(info.fontsUsed.filter((name): name is string => typeof name === "string").map((name) => name.slice(0, FONT_NAME_MAX)))].sort().slice(0, FONT_NAMES_MAX) : [];
  // A failure of our own counting is not a loss: the structure counts still run, the text is marked unchecked (S1).
  let text: HwpText | null = null, textUnchecked: string | undefined;
  try { text = hwpTextOf(doc); }
  catch (error) { textUnchecked = error instanceof HwpCensusError ? error.message : new HwpCensusError("?", error).message; }
  return {
    sections, paragraphs,
    objects: tally(controlKinds(list(doc.getControls()))),
    fields: tally(list(doc.getFieldList()).map((field) => typeof field.fieldType === "string" && field.fieldType !== "memo" ? field.fieldType : "")),
    memos: list(doc.getMemoList()).length,
    numberings: list(doc.getNumberingList()).length,
    styles: list(doc.getStyleList()).length,
    fonts, ...(text ? { chars: text.chars, textSha256: text.sha256, unread: text.unread } : { textUnchecked }),
  };
}
