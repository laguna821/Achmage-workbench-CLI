// The corpus check's per-document work: open, lay out, save on every path and reopen (hwp-corpus-check.ts runs it).
import { openHwpBytes, prepareHwpSave } from "../../apps/host/src/hwp-codec.ts";
import { hwpStructureOf, type HwpStructure } from "../../apps/host/src/hwp-structure.ts";
import { engineJson, HwpCensusError, hwpTextOf, textCountDifferences, textHashDifferences, type HwpText, type HwpTextSource } from "../../packages/contracts/src/hwp-text.ts";
import { breakDifferences, SAVE_PATHS, structureDifferences, unreadDifferences, type DocResult, type SaveResult } from "./compare.ts";
import { readFileSync } from "node:fs";
import { firstGlyphs, pageSummary, type FirstGlyphs, type LayoutRun } from "./layout.ts";

/** A gateway refusal's own message: built by the gateway from counts and labels (hwp-codec.ts), never from document text. */
const refusal = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
/**
 * Any other failure: the step and the error's kind only (m3-4). An engine's or JSON.parse's own
 * message may quote the document (V8 quotes the JSON it could not read), and a regenerated
 * baseline must never hold document text. The census's own error already names step and kind.
 */
export const failureOf = (step: string, error: unknown) =>
  error instanceof HwpCensusError ? error.message : `${step} (${error instanceof Error ? error.name : typeof error})`;
const elapsed = (start: number) => Math.round(performance.now() - start);

export type Engine = { HwpDocument: new (bytes: Uint8Array) => EngineDoc };
export type EngineDoc = Parameters<typeof hwpStructureOf>[0] & HwpTextSource & {
  pageCount(): number; getPageTextLayout(page: number): string; renderPageSvg(page: number): string;
  exportHwp(): Uint8Array; exportHwpx(): Uint8Array; insertText(section: number, paragraph: number, offset: number, text: string): string; free(): void;
};

const runsOf = (doc: EngineDoc, page: number) => engineJson<{ runs?: LayoutRun[] }>(doc.getPageTextLayout(page)).runs ?? [];
/** Per page, the hash of where every paragraph's lines start (no text). */
export function pageBreaks(doc: EngineDoc) {
  return Array.from({ length: doc.pageCount() }, (_, page) => pageSummary(runsOf(doc, page)).breaks);
}
/** What a save must keep: the structure census, the text census and the line breaks of every page. */
export type Live = { structure: HwpStructure; text: HwpText; breaks: string[] };
export const liveOf = (doc: EngineDoc, breaks = pageBreaks(doc)): Live => ({ structure: hwpStructureOf(doc), text: hwpTextOf(doc), breaks });

/** Everything the reopened save lost or changed against the live document, by kind and page. */
export function roundTripDifferences(live: Live, back: Live) {
  return [
    ...structureDifferences(live.structure, back.structure),
    ...textCountDifferences(live.text.chars, back.text.chars),
    ...textHashDifferences(live.text, back.text),
    ...unreadDifferences(live.text.unread, back.text.unread),
    ...(live.breaks.length !== back.breaks.length ? [`쪽 ${live.breaks.length}→${back.breaks.length}`] : []),
    ...breakDifferences(live.breaks, back.breaks),
  ];
}

/**
 * Through the gateway's own save code (as the studio sends it: bytes + live memo list), then
 * reopened with the engine under test and its census compared with the live document's.
 * `exportedBytes` stands in for the editor's export (tests: an export that lost something).
 */
export async function saveRoundTrip(engine: Engine, doc: EngineDoc, original: Uint8Array, originalFormat: "hwp" | "hwpx", format: "hwp" | "hwpx", live: Live, exportedBytes?: Uint8Array, report = false): Promise<SaveResult> {
  const start = performance.now();
  let saved: Uint8Array;
  const check: { text?: "checked" | "unchecked" } = {};
  try {
    const exported = exportedBytes ?? (format === "hwpx" ? doc.exportHwpx() : doc.exportHwp());
    saved = await prepareHwpSave(original, exported, format, { memos: engineJson(doc.getMemoList()), ...(report ? { structure: live.structure } : {}) }, "save", originalFormat, { check });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code.startsWith("hwp_")
      ? { status: "refused", ms: elapsed(start), code, message: refusal(error), differences: [] }
      : { status: "failed", ms: elapsed(start), message: failureOf("저장", error), differences: [] };
  }
  // The product saves with the text unchecked (S1); the corpus must stay loud: a failure.
  if (check.text !== "checked") return { status: "failed", ms: elapsed(start), code: "text_unchecked", message: "글자 검사 못함 (저장 단계의 글자 검사를 계산하지 못함)", differences: [] };
  let back: EngineDoc | undefined;
  try {
    back = new engine.HwpDocument((await openHwpBytes(saved, format)).bytes);
    const reopened = liveOf(back);
    return {
      status: "ok", ms: elapsed(start), pages: back.pageCount(), text: { chars: reopened.text.chars, sha256: reopened.text.sha256, digest: reopened.text.digest, kinds: reopened.text.kinds }, breaks: reopened.breaks,
      differences: roundTripDifferences(live, reopened),
    };
  } catch (error) {
    return { status: "failed", ms: elapsed(start), message: `다시 열지 못함: ${failureOf("다시 열기", error)}`, differences: [] };
  } finally { back?.free(); }
}

export async function checkDocument(engine: Engine, file: string, base: DocResult, chars: number): Promise<DocResult> {
  const start = performance.now();
  const bytes = readFileSync(file);
  let doc: EngineDoc | undefined;
  try {
    doc = new engine.HwpDocument((await openHwpBytes(bytes, base.format)).bytes);
  } catch (error) { return { ...base, status: "failed", reason: `열지 못함: ${failureOf("열기", error)}`, ms: elapsed(start) }; }
  try {
    const pages = doc.pageCount(), lines: number[] = [], paragraphs: number[] = [], breaks: string[] = [];
    let first: FirstGlyphs | undefined, renderErrors = 0, renderError: string | undefined;
    const text = hwpTextOf(doc);
    for (let page = 0; page < pages; page++) {
      const runs = runsOf(doc, page);
      const summary = pageSummary(runs);
      lines.push(summary.lines); paragraphs.push(summary.paragraphs); breaks.push(summary.breaks);
      if (page === 0) first = firstGlyphs(runs, chars, text.sha256);
      try { doc.renderPageSvg(page); } catch (error) { renderErrors++; renderError ??= `${page + 1}쪽 ${failureOf("그리기", error)}`; }
    }
    const live: Live = { structure: hwpStructureOf(doc), text, breaks }, other = base.format === "hwp" ? "hwpx" : "hwp";
    const save: Record<keyof typeof SAVE_PATHS, SaveResult> = {};
    for (const report of [false, true]) {
      const key = (path: string) => (report ? `${path}Report` : path);
      save[key("none")] = await saveRoundTrip(engine, doc, bytes, base.format, base.format, live, undefined, report);
      save[key("other")] = await saveRoundTrip(engine, doc, bytes, base.format, other, live, undefined, report);
    }
    doc.insertText(0, 0, doc.getParagraphLength(0, 0), "가");
    const edited = liveOf(doc);
    save.append = await saveRoundTrip(engine, doc, bytes, base.format, base.format, edited);
    save.appendReport = await saveRoundTrip(engine, doc, bytes, base.format, base.format, edited, undefined, true);
    return { ...base, status: "ok", ms: elapsed(start), pages, lines, paragraphs, breaks, structure: live.structure, text, firstGlyphs: first, renderErrors, ...(renderError ? { renderError } : {}), save };
  } catch (error) {
    return { ...base, status: "failed", reason: `검사 중 오류: ${failureOf("검사", error)}`, ms: elapsed(start) };
  } finally { doc.free(); }
}

