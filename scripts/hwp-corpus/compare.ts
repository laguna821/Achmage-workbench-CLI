// The corpus check's data and its baseline-vs-candidate comparison (no engine here: unit-tested).
import { isAbsolute, join, normalize } from "node:path";
import type { HwpStructure } from "../../apps/host/src/hwp-structure.ts";
import { HWP_UNREAD_LABELS, textCountDifferences, textHashDifferences, type HwpText } from "../../packages/contracts/src/hwp-text.ts";
import type { FirstGlyphs } from "./layout.ts";

export type ManifestEntry = {
  id: string;
  /** "repo": relative to the repository; "corpus": relative to HWP_CORPUS_ROOT */
  root: "repo" | "corpus";
  path: string;
  sha256: string;
  size: number;
  format: "hwp" | "hwpx";
  covers: string[];
  /** what the repository engine found in it when the manifest was written */
  contains?: string[];
  source: string;
  licence: string;
};
export type Manifest = { schema: 1; documents: ManifestEntry[] };

export type SaveResult = {
  status: "ok" | "refused" | "failed";
  ms: number;
  code?: string;
  message?: string;
  pages?: number;
  /** the reopened file's text census: characters per container kind, the walking-order hash, the order-free digest and per-kind hashes (no text) */
  text?: Pick<HwpText, "chars" | "sha256" | "digest" | "kinds">;
  /** the reopened file's line breaks, per page (as `DocResult.breaks`) */
  breaks?: string[];
  /** reopened saved bytes against the document that was saved: structure, text per kind, text hash, line breaks */
  differences: string[];
};
export type DocResult = {
  id: string;
  path: string;
  format: "hwp" | "hwpx";
  status: "ok" | "failed" | "skipped";
  reason?: string;
  ms?: number;
  pages?: number;
  /** per page: text lines (distinct run tops, 1px apart) and paragraphs with text on the page */
  lines?: number[];
  paragraphs?: number[];
  /** per page: hash of every paragraph's line-start offsets (layout.ts) — a re-wrapped line changes it */
  breaks?: string[];
  structure?: HwpStructure;
  /** characters per container kind (body, cells, boxes, notes, headers, footers, memos), one hash over all of it, and what the engine cannot read */
  text?: HwpText;
  /** page 1, first characters of the text layout: x/y in CSS px (0.1px) and one sha256 of the characters salted with `text.sha256` — no text */
  firstGlyphs?: FirstGlyphs;
  renderErrors?: number;
  renderError?: string;
  /** one result per save path (SAVE_PATHS) */
  save?: Record<string, SaveResult>;
};
/**
 * The save round trips, each through the gateway's save code (hwp-codec.ts) and reopened; what is
 * compared against the live document that was saved: the structure census, the characters of every
 * container kind, the whole-text hash and every page's line breaks (check.ts `roundTripDifferences`).
 */
export const SAVE_PATHS: Record<string, string> = {
  none: "그대로 저장",      // same format, unedited, no structure report (the studio today)
  append: "한 글자 저장",   // same format, one character appended, no report
  other: "다른 형식 저장",  // HWP → HWPX or HWPX → HWP (Save As in the other format), unedited, no report
  // the same three with the editor's structure report (H9 fingerprint compares the saved bytes with it)
  noneReport: "그대로 저장·보고",
  appendReport: "한 글자 저장·보고",
  otherReport: "다른 형식 저장·보고",
};
/** 5: the census leaves out the characters a writer does not keep (T1, round 4); 4 and older count them. */
export const RESULT_SCHEMA = 5;
export type CorpusResult = {
  schema: number;
  engine: { dir: string; wasmSha256: string; version: string };
  /** the engine the gateway's save code (hwp-codec.ts) parses with */
  codecWasmSha256: string;
  startedAt: string;
  node: string;
  ms: number;
  peakRssMb: number;
  corpus: { manifestSha256: string; corpusRoot: boolean; documents: number; skipped: number };
  docs: DocResult[];
};
export type Row = { id: string; status: "same" | "different" | "failed" | "skipped"; details: string[] };

/**
 * A character moved when either coordinate changed by more than 1 CSS px: float noise between
 * builds is far below that, and any change a reader can see (a re-wrapped line, a changed tab,
 * indent or spacing) moves a glyph by at least a pixel at 100% zoom.
 */
export const MOVE_TOLERANCE_PX = 1;

export function locateDocuments(manifest: Manifest, roots: { repoRoot: string; corpusRoot: string | undefined; corpusMissing?: string }) {
  return manifest.documents.map((entry) => {
    const relative = normalize(entry.path);
    if (isAbsolute(relative) || relative.startsWith("..")) throw new Error(`manifest path leaves its root: ${entry.path}`);
    if (entry.root === "repo") return { entry, file: join(roots.repoRoot, relative), skip: null };
    if (!roots.corpusRoot) return { entry, file: null, skip: roots.corpusMissing ?? "HWP_CORPUS_ROOT is not set" };
    return { entry, file: join(roots.corpusRoot, relative), skip: null };
  });
}

const sameList = (a: readonly unknown[] = [], b: readonly unknown[] = []) => a.length === b.length && a.every((item, index) => item === b[index]);
function perPage(label: string, a: number[] = [], b: number[] = []) {
  const out: string[] = [];
  for (let page = 0; page < Math.max(a.length, b.length) && out.length < 3; page++) {
    if (a[page] !== b[page]) out.push(`${page + 1}쪽 ${label} ${a[page] ?? "-"}→${b[page] ?? "-"}`);
  }
  return out;
}
const label = (kind: string) => ({ tbl: "표", "gso:그림": "그림", eqed: "수식", head: "머리말", foot: "꼬리말", fn: "각주", en: "미주", secd: "구역 정의", cold: "단 설정", pgnp: "쪽 번호 위치", "?": "이름 없는 컨트롤" } as Record<string, string>)[kind] ?? kind;
export function structureDifferences(a?: HwpStructure, b?: HwpStructure): string[] {
  if (!a || !b) return a === b ? [] : ["구조 정보 없음"];
  const out: string[] = [];
  if (a.sections !== b.sections) out.push(`구역 ${a.sections}→${b.sections}`);
  else if (!sameList(a.paragraphs, b.paragraphs)) out.push(`구역별 문단 ${a.paragraphs.join("/")}→${b.paragraphs.join("/")}`);
  for (const group of ["objects", "fields"] as const) {
    for (const kind of [...new Set([...Object.keys(a[group]), ...Object.keys(b[group])])].sort()) {
      if ((a[group][kind] ?? 0) !== (b[group][kind] ?? 0)) out.push(`${label(kind)} ${a[group][kind] ?? 0}→${b[group][kind] ?? 0}`);
    }
  }
  if (a.memos !== b.memos) out.push(`메모 ${a.memos}→${b.memos}`);
  if (a.numberings !== b.numberings) out.push(`문단 번호 정의 ${a.numberings}→${b.numberings}`);
  if (a.styles !== b.styles) out.push(`스타일 ${a.styles}→${b.styles}`);
  if (!sameList(a.fonts, b.fonts)) out.push(`글꼴 [${a.fonts.join(", ")}]→[${b.fonts.join(", ")}]`);
  return out;
}
/** Line-break data for a different number of pages (an empty list where the baseline has pages included, m2-5). */
const breakCount = (a?: string[], b?: string[]) => a && b && a.length !== b.length ? [`줄 나눔 정보 ${a.length}→${b.length}쪽`] : [];
/** Pages whose line breaks differ (the first three), by page number. */
export function breakDifferences(a: string[], b: string[]) {
  const out: string[] = [];
  for (let page = 0; page < Math.min(a.length, b.length) && out.length < 3; page++) if (a[page] !== b[page]) out.push(`${page + 1}쪽 줄 나눔 바뀜`);
  return out;
}
/** A field the baseline has and the candidate lacks is a difference, never "same". */
function missing<T extends object>(where: string, a: T, b: T, fields: Record<string, string>) {
  return Object.entries(fields).filter(([field]) => (a as Record<string, unknown>)[field] !== undefined && (b as Record<string, unknown>)[field] === undefined).map(([, name]) => `${where}${name} 없음`);
}
/** Every change of what the engine cannot read, both ways (the save fingerprint refuses only a drop). */
export function unreadDifferences(a: Record<string, number> = {}, b: Record<string, number> = {}) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter((kind) => (a[kind] ?? 0) !== (b[kind] ?? 0)).map((kind) => `읽지 못하는 개체: ${HWP_UNREAD_LABELS[kind] ?? kind} ${a[kind] ?? 0}→${b[kind] ?? 0}`);
}
function textDifferences(a?: Partial<HwpText> & Pick<HwpText, "chars" | "sha256">, b?: Partial<HwpText> & Pick<HwpText, "chars" | "sha256">) {
  if (!a || !b) return [];
  return [...textCountDifferences(a.chars, b.chars), ...textHashDifferences(a as HwpText, b as HwpText), ...unreadDifferences(a.unread, b.unread)];
}
function glyphDifferences(a?: FirstGlyphs, b?: FirstGlyphs) {
  if (!a || !b) return a === b ? [] : ["1쪽 첫 글자 정보 없음"];
  if (a.count !== b.count) return [`1쪽 첫 글자 수 ${a.count}→${b.count}`];
  if (a.sha256 !== b.sha256) return ["1쪽 첫 글자가 바뀜"];
  for (let index = 0; index < a.xy.length; index++) {
    const [xa, ya] = a.xy[index]!, [xb, yb] = b.xy[index] ?? [NaN, NaN];
    const dx = xb - xa, dy = yb - ya;
    if (!(Math.abs(dx) <= MOVE_TOLERANCE_PX && Math.abs(dy) <= MOVE_TOLERANCE_PX)) return [`1쪽 ${index + 1}번째 글자 이동 (${dx.toFixed(1)}, ${dy.toFixed(1)})px`];
  }
  return [];
}
function saveDifferences(name: string, a?: SaveResult, b?: SaveResult) {
  if (!a || !b) return a === b ? [] : [`${name}: 결과 없음`];
  const out: string[] = [];
  if (a.status !== b.status) out.push(`${name}: ${a.status}→${b.status}${b.message ? ` (${b.message})` : ""}`);
  if (!sameList(a.differences, b.differences)) out.push(`${name}: 왕복 차이 [${a.differences.join("; ")}]→[${b.differences.join("; ")}]`);
  if (a.pages !== b.pages) out.push(`${name}: 다시 연 쪽 ${a.pages ?? "-"}→${b.pages ?? "-"}`);
  out.push(...missing(`${name}: `, a, b, { text: "다시 연 글자 정보", breaks: "다시 연 줄 나눔 정보" }));
  if (a.text && b.text) out.push(...textDifferences(a.text, b.text).map((line) => `${name}: 다시 연 ${line}`));
  if (a.breaks && b.breaks) out.push(...[...breakCount(a.breaks, b.breaks), ...breakDifferences(a.breaks, b.breaks)].map((line) => `${name}: 다시 연 ${line}`));
  return out;
}

export function compareDoc(a: DocResult, b: DocResult | undefined): Row {
  if (!b) return { id: a.id, status: "failed", details: ["후보 결과에 없음"] };
  if (b.status === "skipped" || a.status === "skipped") return { id: a.id, status: "skipped", details: [b.reason ?? a.reason ?? "건너뜀"] };
  if (b.status === "failed") {
    return a.status === "failed" && a.reason === b.reason
      ? { id: a.id, status: "same", details: [`둘 다 열지 못함: ${b.reason}`] }
      : { id: a.id, status: "failed", details: [b.reason ?? "실패"] };
  }
  if (a.status === "failed") return { id: a.id, status: "different", details: [`기준에서는 열지 못했음: ${a.reason}`] };
  const details = [
    ...(a.pages !== b.pages ? [`쪽 ${a.pages}→${b.pages}`] : []),
    ...perPage("줄", a.lines, b.lines),
    ...perPage("문단", a.paragraphs, b.paragraphs),
    ...missing("", a, b, { pages: "쪽 수", lines: "줄 수", paragraphs: "문단 수", breaks: "줄 나눔 정보", structure: "구조 정보", text: "글자 정보", firstGlyphs: "1쪽 첫 글자 정보", save: "저장 결과" }),
    ...breakCount(a.breaks, b.breaks),
    ...(a.breaks && b.breaks ? breakDifferences(a.breaks, b.breaks) : []),
    ...(a.structure && b.structure ? structureDifferences(a.structure, b.structure) : []),
    ...textDifferences(a.text, b.text),
    ...(a.firstGlyphs && b.firstGlyphs ? glyphDifferences(a.firstGlyphs, b.firstGlyphs) : []),
    ...((a.renderErrors ?? 0) !== (b.renderErrors ?? 0) ? [`그리기 오류 ${a.renderErrors ?? 0}→${b.renderErrors ?? 0}${b.renderError ? ` (${b.renderError})` : ""}`] : []),
    ...[...new Set([...Object.keys(a.save ?? {}), ...Object.keys(b.save ?? {})])].flatMap((path) => saveDifferences(SAVE_PATHS[path] ?? path, a.save?.[path], b.save?.[path])),
  ];
  return { id: a.id, status: details.length ? "different" : "same", details };
}

/** 0: every baseline document compared and the same; 1: something differs or failed; 2: something was skipped; 64: results of different shapes. */
export function compareResults(base: CorpusResult, candidate: CorpusResult) {
  if (base.schema !== RESULT_SCHEMA || candidate.schema !== RESULT_SCHEMA) {
    return { rows: [{ id: "(schema)", status: "failed" as const, details: [`결과 형식 ${base.schema}/${candidate.schema}, 이 도구는 ${RESULT_SCHEMA} — 같은 도구로 다시 만드세요`] }], exitCode: 64 };
  }
  const byId = new Map(candidate.docs.map((doc) => [doc.id, doc]));
  const rows = base.docs.map((doc) => compareDoc(doc, byId.get(doc.id)));
  const exitCode = rows.some((row) => row.status === "different" || row.status === "failed") ? 1 : rows.some((row) => row.status === "skipped") || !rows.length ? 2 : 0;
  return { rows, exitCode };
}

/** run: 1 if any document or any of its save paths failed, else 2 if any was skipped (nothing proven for it), else 0. */
export function runExitCode(docs: DocResult[]) {
  return docs.some((doc) => doc.status === "failed" || Object.values(doc.save ?? {}).some((save) => save.status === "failed")) ? 1 : docs.some((doc) => doc.status === "skipped") || !docs.length ? 2 : 0;
}

/** Which builds were compared, so two runs of the same engine are never read as a pass of a new one. */
export function describeEngines(base: CorpusResult, candidate: CorpusResult): string[] {
  const line = (name: string, result: CorpusResult) => `${name}: ${result.engine.dir} wasm ${result.engine.wasmSha256} (${result.engine.version})`;
  const out = [line("기준", base), line("후보", candidate)];
  if (base.engine.wasmSha256 === candidate.engine.wasmSha256) out.push("경고: 기준과 후보가 같은 엔진 빌드입니다 — 새 엔진을 비교한 것이 아닙니다.");
  if (candidate.codecWasmSha256 !== candidate.engine.wasmSha256) out.push(`경고: 후보의 저장 단계(hwp-codec.ts)는 다른 엔진(${candidate.codecWasmSha256})으로 검사했습니다.`);
  return out;
}

export function formatTable(rows: Row[]): string {
  const width = Math.max(8, ...rows.map((row) => row.id.length));
  const lines = rows.map((row) => `${row.id.padEnd(width)}  ${row.status.padEnd(9)}  ${row.details.join("; ")}`);
  const count = (status: Row["status"]) => rows.filter((row) => row.status === status).length;
  return [`${"document".padEnd(width)}  ${"status".padEnd(9)}  what`, ...lines,
    `same ${count("same")}, different ${count("different")}, failed ${count("failed")}, skipped ${count("skipped")}`].join("\n");
}
