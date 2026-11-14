/**
 * The text a person can see in a Hangul document, counted per kind of container and hashed —
 * never kept. One walk for the studio (its live document), the gateway (the saved bytes) and the
 * corpus check, so every side counts the same way. No layout is needed except for the per-page
 * line breaks (`pageSummary`), which only the corpus check computes.
 *
 * What the engine (rhwp 0.8.7-ieum.12-hop.1) lets us read without laying out, and in this order:
 *  1. body paragraphs, section by section;
 *  2. every table cell and text box the engine's cursor model lists, nested ones included (a cell
 *     in a table in a cell, a text box in a cell), in the engine's order;
 *  3. footnotes and endnotes anchored in body paragraphs;
 *  4. headers and footers, per section (both / even / odd pages) — the FIRST of each kind, which is
 *     the only one the engine's text calls address;
 *  5. memos.
 * What it does not let us read is counted per container as `unread` (a drop is a loss, S2):
 * `caption` (drawing-object captions: a cursor list, no text call), `table-caption` (captions of
 * body-level tables, seen through getTableProperties.hasCaption), `note-in-cell` (notes anchored in
 * cells/boxes), `comment` (hidden comments), `header-extra`/`footer-extra` (a second header or
 * footer of the same kind in a section: getControls lists it, no call reads its text),
 * `header-object`/`footer-object` (any control inside a header/footer paragraph — table, text box,
 * picture, page number…; seen through getHeaderFooterPictureProperties, which tells "no control
 * here" from "a control that is not a picture" but not a table from a box). Not even counted (the
 * engine gives no sign of them): tables/boxes inside notes, captions of tables nested in cells.
 */

export const HWP_TEXT_KINDS = ["body", "cell", "textbox", "footnote", "endnote", "header", "footer", "memo"] as const;
export type HwpTextKind = typeof HWP_TEXT_KINDS[number];
export const HWP_TEXT_LABELS: Record<HwpTextKind, string> = {
  body: "본문", cell: "표 칸", textbox: "글상자", footnote: "각주", endnote: "미주", header: "머리말", footer: "꼬리말", memo: "메모",
};
/**
 * The characters the census leaves out of every count and every hash (T1): those the open document
 * can hold but at least one of the engine's writers does not keep — measured per code point, in body,
 * cell, note, header and memo text, opened and typed, by `apps/host/src/hwp-text-controls.test.ts`
 * (rhwp 0.8.7-ieum.12-hop.1): U+0000–U+0008 and U+000B–U+001F (the HWPX writer drops them; the HWP
 * writer drops them, turns some into a space/NBSP/soft hyphen, or eats up to three characters after
 * them — that loss of VISIBLE characters is still counted and refused), U+FFFC (the HWPX writer drops
 * it from body text) and U+FFFE/U+FFFF (the HWPX writer drops them). Tab, line break, C1 controls and
 * the Unicode format characters are kept by both writers and counted. Derived from that table only:
 * a different engine must re-measure (the table test fails) and change this one line.
 */
export const HWP_UNKEPT = /[\u0000-\u0008\u000b-\u001f\ufffc\ufffe\uffff]/g;
/** A container's text as the census counts and hashes it: without `HWP_UNKEPT`. */
export const hwpCountable = (text: string) => text.replace(HWP_UNKEPT, "");
/** Characters per container kind (UTF-16 units, as the engine counts, without `HWP_UNKEPT`). */
export type HwpTextCounts = Record<HwpTextKind, number>;
export type HwpText = {
  chars: HwpTextCounts;
  /** sha256 (hex) over every container's text in the walking order above, kind and paragraph marks included */
  sha256: string;
  /** sha256 of the sorted per-container hashes: the same when only the engine's container order changed (S4) */
  digest: string;
  /** per kind, the sha256 of that kind's sorted per-container hashes: which kind's text changed */
  kinds: Record<HwpTextKind, string>;
  /** containers the engine holds but gives no text for, by kind (see above) */
  unread: Record<string, number>;
};
/** What each `unread` kind is, for a person. */
export const HWP_UNREAD_LABELS: Record<string, string> = {
  caption: "그리기 개체 캡션", "table-caption": "표 캡션", "note-in-cell": "표·글상자 안 주석", comment: "숨은 설명", unreachable: "닿지 않는 표 칸·글상자",
  "header-extra": "머리말 (같은 종류 둘째부터)", "footer-extra": "꼬리말 (같은 종류 둘째부터)", "header-object": "머리말 안 표·글상자 등", "footer-object": "꼬리말 안 표·글상자 등",
};

/** The engine calls used; the gateway's engine and the studio's document (same build) both have them. */
export interface HwpTextSource {
  getSectionCount(): number;
  getParagraphCount(section: number): number;
  getParagraphLength(section: number, paragraph: number): number;
  getTextRange(section: number, paragraph: number, offset: number, count: number): string;
  getCursorModel(): string;
  getCellParagraphLengthByPath(section: number, parentParagraph: number, path: string): number;
  getTextInCellByPath(section: number, parentParagraph: number, path: string, offset: number, count: number): string;
  getControls(): string;
  getFootnoteInfo(section: number, paragraph: number, control: number): string;
  getHeaderFooter(section: number, isHeader: boolean, applyTo: number): string;
  getHeaderFooterPictureProperties(section: number, outerParagraph: number, outerControl: number, innerParagraph: number, innerControl: number): string;
  getTableProperties(section: number, paragraph: number, control: number): string;
  getMemoList(): string;
}

type CursorList = { listId: number; isCell: boolean; hostListId: number; sectionIndex: number; hostPara: number; controlIndex: number; cellIndex: number; paraCount: number };
type PathStep = { controlIndex: number; cellIndex: number; cellParaIndex: number };
/**
 * Every answer the census reads from the engine goes through here. Some engine answers put text
 * into a JSON string escaping only `\\` and `"` (rhwp `get_footnote_info_native`, 0.8.7 and 0.9.0),
 * so a tab or a line break (Shift+Enter) in a note arrives as a raw control character, which
 * JSON.parse refuses. Raw U+0000–U+001F inside string literals are escaped first; everything else
 * (proper escapes, lone surrogates) is passed through unchanged.
 */
export function engineJson<T = unknown>(json: string): T {
  let out = "", from = 0, inString = false;
  for (let index = 0; index < json.length; index++) {
    const code = json.charCodeAt(index);
    if (inString) {
      if (code === 0x5c) { index++; continue; }
      if (code === 0x22) inString = false;
      else if (code < 0x20) { out += `${json.slice(from, index)}\\u${code.toString(16).padStart(4, "0")}`; from = index + 1; }
    } else if (code === 0x22) inString = true;
  }
  return JSON.parse(from ? out + json.slice(from) : json) as T;
}
const array = (json: string): Record<string, unknown>[] => { const value = engineJson(json); return Array.isArray(value) ? value : []; };
const int = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) ? value : -1;

export function emptyTextCounts(): HwpTextCounts {
  return Object.fromEntries(HWP_TEXT_KINDS.map((kind) => [kind, 0])) as HwpTextCounts;
}

/**
 * The census could not be computed. Its message names the step and the error's kind only: an
 * engine's or JSON.parse's own message may quote document text, so it is never passed on.
 */
export class HwpCensusError extends Error {
  readonly step: string;
  constructor(step: string, cause: unknown) {
    super(`글자 검사 못함 (${step}: ${cause instanceof Error ? cause.name : typeof cause})`);
    this.name = "HwpCensusError";
    this.step = step;
  }
}
export const HWP_CENSUS_STEPS = { body: "본문", lists: "표 칸·글상자", notes: "각주·미주", headers: "머리말·꼬리말", memos: "메모" } as const;

export function hwpTextOf(doc: HwpTextSource): HwpText {
  let step: string = HWP_CENSUS_STEPS.body;
  try { return walk(doc, (now) => { step = now; }); }
  catch (error) { throw error instanceof HwpCensusError ? error : new HwpCensusError(step, error); }
}

function walk(doc: HwpTextSource, at: (step: string) => void): HwpText {
  const chars = emptyTextCounts(), unread: Record<string, number> = {}, hash = new Sha256();
  // one container (a section's body, a cell, a box, a note, a header, a memo) at a time, for the order-free digest
  const containers: { kind: HwpTextKind; hash: string }[] = [];
  let open: { kind: HwpTextKind; hash: Sha256 } | null = null;
  const begin = (kind: HwpTextKind) => { end(); open = { kind, hash: new Sha256() }; };
  const end = () => { if (open) containers.push({ kind: open.kind, hash: open.hash.hex() }); open = null; };
  const add = (kind: HwpTextKind, raw: string) => {
    const text = hwpCountable(raw);
    chars[kind] += text.length;
    const piece = `${kind}\u0001${text}\u0002`;
    hash.update(piece); open!.hash.update(piece);
  };
  const skip = (kind: string) => { unread[kind] = (unread[kind] ?? 0) + 1; };

  // 1. body; root paragraphs are numbered across sections in the engine's control list
  const sections = doc.getSectionCount(), firstOf: number[] = [];
  let global = 0;
  for (let section = 0; section < sections; section++) {
    const count = doc.getParagraphCount(section);
    firstOf.push(global); global += count;
    begin("body");
    for (let paragraph = 0; paragraph < count; paragraph++) {
      const length = doc.getParagraphLength(section, paragraph);
      add("body", length > 0 ? doc.getTextRange(section, paragraph, 0, length) : "");
    }
  }
  const local = (paragraph: number) => {
    for (let section = sections - 1; section >= 0; section--) if (paragraph >= firstOf[section]!) return { section, paragraph: paragraph - firstOf[section]! };
    return { section: 0, paragraph };
  };

  // 2. cells and text boxes, nested ones through their host list
  at(HWP_CENSUS_STEPS.lists);
  const model = engineJson<{ lists?: CursorList[] }>(doc.getCursorModel());
  const lists = new Map((model.lists ?? []).map((list) => [list.listId, list]));
  const pathOf = (list: CursorList, steps: PathStep[] = []): { section: number; parent: number; steps: PathStep[] } | null => {
    if (steps.length > 64) return null;
    if (list.hostListId === 0) return { section: list.sectionIndex, parent: list.hostPara, steps };
    const host = lists.get(list.hostListId);
    return host ? pathOf(host, [{ controlIndex: host.controlIndex, cellIndex: host.cellIndex, cellParaIndex: list.hostPara }, ...steps]) : null;
  };
  for (const list of lists.values()) {
    const kind: HwpTextKind | null = list.isCell ? "cell" : list.cellIndex === 0 ? "textbox" : null;
    const where = kind && pathOf(list);
    if (!kind || !where) { skip(kind ? "unreachable" : "caption"); continue; }
    begin(kind);
    for (let paragraph = 0; paragraph < list.paraCount; paragraph++) {
      const path = JSON.stringify([...where.steps, { controlIndex: list.controlIndex, cellIndex: list.cellIndex, cellParaIndex: paragraph }]);
      const length = doc.getCellParagraphLengthByPath(where.section, where.parent, path);
      add(kind, length > 0 ? doc.getTextInCellByPath(where.section, where.parent, path, 0, length) : "");
    }
  }

  // 3. notes in body paragraphs; others are counted as unread. Body tables' captions are counted too.
  at(HWP_CENSUS_STEPS.notes);
  const controls = array(doc.getControls());
  for (const control of controls) {
    if (control.ctrlId === "tcmt") skip("comment");
    if (control.ctrlId === "tbl" && control.list === 0) {
      const at = local(int(control.para));
      if (engineJson<{ hasCaption?: unknown }>(doc.getTableProperties(at.section, at.paragraph, int(control.controlIndex))).hasCaption === true) skip("table-caption");
    }
    if (control.ctrlId !== "fn" && control.ctrlId !== "en") continue;
    if (control.list !== 0) { skip("note-in-cell"); continue; }
    const at = local(int(control.para));
    const info = engineJson<{ texts?: unknown }>(doc.getFootnoteInfo(at.section, at.paragraph, int(control.controlIndex)));
    const kind = control.ctrlId === "fn" ? "footnote" : "endnote";
    begin(kind);
    for (const text of Array.isArray(info.texts) ? info.texts : []) add(kind, String(text));
  }

  // 4. headers and footers: both / even / odd pages of each section (the first of each kind), then
  //    every header/footer control: one the text calls cannot reach, and whatever is inside each, is unread
  at(HWP_CENSUS_STEPS.headers);
  const read = new Set<string>();
  for (let section = 0; section < sections; section++) {
    for (const isHeader of [true, false]) {
      for (let applyTo = 0; applyTo < 3; applyTo++) {
        const item = engineJson<{ exists?: boolean; text?: unknown; paraIndex?: unknown; controlIndex?: unknown }>(doc.getHeaderFooter(section, isHeader, applyTo));
        if (!item.exists) continue;
        const kind = isHeader ? "header" : "footer";
        begin(kind); add(kind, String(item.text ?? ""));
        read.add(`${section}:${int(item.paraIndex)}:${int(item.controlIndex)}`);
      }
    }
  }
  for (const control of controls) {
    if ((control.ctrlId !== "head" && control.ctrlId !== "foot") || control.list !== 0) continue;
    const side = control.ctrlId === "head" ? "header" : "footer", where = local(int(control.para)), index = int(control.controlIndex);
    if (!read.has(`${where.section}:${where.paragraph}:${index}`)) skip(`${side}-extra`);
    for (let count = 0; count < insideOf(doc, where.section, where.paragraph, index); count++) skip(`${side}-object`);
  }

  // 5. memos
  at(HWP_CENSUS_STEPS.memos);
  for (const memo of array(doc.getMemoList())) { begin("memo"); add("memo", String(memo.text ?? "")); }
  end();
  const sorted = containers.map((item) => `${item.kind}:${item.hash}`).sort();
  const kinds = Object.fromEntries(HWP_TEXT_KINDS.map((kind) => [kind, sha256Hex(sorted.filter((item) => item.startsWith(`${kind}:`)).join("\n"))])) as Record<HwpTextKind, string>;
  return {
    chars, sha256: hash.hex(), digest: sha256Hex(sorted.join("\n")), kinds,
    unread: Object.fromEntries(Object.entries(unread).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/**
 * How many controls the header/footer at (section, paragraph, control) holds in its paragraphs.
 * getHeaderFooterPictureProperties is the one call that addresses a header by its place (not by
 * its kind) and looks inside: it answers for a picture, refuses "not a picture" for any other
 * control, and refuses "out of range" past the last control or paragraph. Any other answer means
 * this engine behaves differently: the census then fails (loudly) rather than guess.
 */
const INSIDE_MAX = 10_000;
function insideOf(doc: HwpTextSource, section: number, paragraph: number, control: number) {
  let count = 0;
  for (let inner = 0, index = 0, probes = 0; probes < INSIDE_MAX; probes++) {
    let answer: string;
    try { doc.getHeaderFooterPictureProperties(section, paragraph, control, inner, index); answer = "picture"; }
    catch (error) { answer = String(error instanceof Error ? error.message : error); }
    if (answer === "picture" || /그림이 아닙니다/.test(answer)) { count++; index++; }
    else if (/내부 컨트롤 인덱스 \d+ 범위 초과/.test(answer)) { inner++; index = 0; }
    else if (/내부 문단 인덱스 \d+ 범위 초과/.test(answer)) return count;
    else throw new Error("getHeaderFooterPictureProperties: an answer this census does not know");
  }
  throw new Error("getHeaderFooterPictureProperties: more controls than the census reads");
}

/** Drops of what the census cannot read, one short phrase each; a rise is never a loss. */
export function lostUnread(expected: Record<string, number>, saved: Record<string, number>): string[] {
  return Object.keys(expected).sort().filter((kind) => (saved[kind] ?? 0) < (expected[kind] ?? 0))
    .map((kind) => `읽지 못하는 개체: ${HWP_UNREAD_LABELS[kind] ?? kind} ${expected[kind]}→${saved[kind] ?? 0}`);
}
/**
 * "Order only" (T2, N3-2) is a difference to explain, never a pass: the digest is a sorted multiset
 * of per-container hashes, so it is the same when the engine lists containers in another order AND
 * when text moved between two containers of one kind (two cells' texts swapped, a merged-cell
 * regression that puts text into the wrong cell). Explain it document by document with page pictures.
 */
export const HWP_ORDER_ONLY = "글자 순서만 바뀜 — 바뀐 이유를 문서별로 확인";
/** Text changed but no count did: only the containers' order (`HWP_ORDER_ONLY`), or the content, by kind. */
export function textHashDifferences(a: Pick<HwpText, "sha256" | "digest" | "kinds">, b: Pick<HwpText, "sha256" | "digest" | "kinds">): string[] {
  if (a.sha256 === b.sha256) return [];
  if (a.digest === b.digest) return [HWP_ORDER_ONLY];
  const changed = HWP_TEXT_KINDS.filter((kind) => a.kinds?.[kind] !== b.kinds?.[kind]);
  return changed.length ? changed.map((kind) => `글자 내용 바뀜 (${HWP_TEXT_LABELS[kind]})`) : ["글자 내용 바뀜"];
}

/** Losses per kind, one short Korean phrase each ("표 칸 글자 838→0"). More is never a loss. */
export function lostText(expected: HwpTextCounts, saved: HwpTextCounts): string[] {
  return HWP_TEXT_KINDS.filter((kind) => (saved[kind] ?? 0) < (expected[kind] ?? 0)).map((kind) => `${HWP_TEXT_LABELS[kind]} 글자 ${expected[kind]}→${saved[kind] ?? 0}`);
}
/** Every per-kind change, both ways (the corpus check). */
export function textCountDifferences(a: HwpTextCounts, b: HwpTextCounts): string[] {
  return HWP_TEXT_KINDS.filter((kind) => (a[kind] ?? 0) !== (b[kind] ?? 0)).map((kind) => `${HWP_TEXT_LABELS[kind]} 글자 ${a[kind] ?? 0}→${b[kind] ?? 0}`);
}

// ---- per-page line breaks and page 1's first characters (from getPageTextLayout runs) ----

/** One run of `getPageTextLayout(page).runs`. */
export type LayoutRun = {
  text: string; x: number; y: number; charX?: number[]; charStart?: number;
  secIdx?: number; paraIdx?: number; parentParaIdx?: number; controlIdx?: number; cellIdx?: number; cellParaIdx?: number; cellPath?: unknown;
};
export type FirstGlyphs = { count: number; sha256: string; xy: [number, number][] };
const round = (value: number) => Math.round(value * 10) / 10;
/** The paragraph a run belongs to, in body text, cells, boxes and captions alike. */
const paragraphOf = (run: LayoutRun) => JSON.stringify([run.secIdx, run.paraIdx, run.parentParaIdx, run.controlIdx, run.cellIdx, run.cellParaIdx, run.cellPath]);

/**
 * Lines: distinct tops of text runs more than 1px apart (side-by-side cells and columns share a
 * line). Breaks: a hash of every paragraph's line-start offsets in reading order, so a line that
 * breaks one word earlier changes it even when no line count changes. No text goes into it.
 */
export function pageSummary(all: LayoutRun[]) {
  const runs = all.filter((run) => run.text);
  const tops = runs.map((run) => run.y).sort((a, b) => a - b);
  let lines = 0, last = -Infinity;
  for (const top of tops) { if (top - last > 1) lines++; last = top; }
  const starts = new Map<string, { y: number; offsets: number[] }>();
  for (const run of runs) {
    const key = paragraphOf(run), seen = starts.get(key);
    if (!seen) starts.set(key, { y: run.y, offsets: [run.charStart ?? 0] });
    else if (Math.abs(run.y - seen.y) > 1) { seen.y = run.y; seen.offsets.push(run.charStart ?? 0); }
  }
  const breaks = sha256Hex(JSON.stringify([...starts].map(([key, { offsets }]) => [key, offsets]))).slice(0, 16);
  return { lines, paragraphs: new Set(runs.map((run) => `${run.secIdx}:${run.paraIdx}`)).size, breaks };
}

/**
 * The first `count` characters' positions (0.1px) and one hash of the characters, salted with the
 * document's whole-text hash so that a short first line cannot be found by trying candidates.
 */
export function firstGlyphs(runs: LayoutRun[], count: number, salt: string): FirstGlyphs {
  const chars: string[] = [], xy: [number, number][] = [];
  for (const run of runs) {
    [...run.text].forEach((char, index) => { if (chars.length < count) { chars.push(char); xy.push([round(run.x + (run.charX?.[index] ?? 0)), round(run.y)]); } });
    if (chars.length >= count) break;
  }
  return { count: chars.length, sha256: sha256Hex(`${salt}\u0000${chars.join("")}`), xy };
}

// ---- sha256 without node:crypto or WebCrypto (synchronous, for the studio page as well) ----

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const encoder = new TextEncoder();
/** Incremental SHA-256 over UTF-8 text. */
export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private block = new Uint8Array(64);
  private used = 0;
  private length = 0;
  private w = new Uint32Array(64);
  update(text: string) { this.bytes(encoder.encode(text)); return this; }
  bytes(data: Uint8Array) {
    this.length += data.length;
    let offset = 0;
    while (offset < data.length) {
      const take = Math.min(64 - this.used, data.length - offset);
      this.block.set(data.subarray(offset, offset + take), this.used);
      this.used += take; offset += take;
      if (this.used === 64) { this.compress(); this.used = 0; }
    }
    return this;
  }
  private done: string | null = null;
  /** Finalises once; later calls return the same value. */
  hex() {
    if (this.done) return this.done;
    const bits = this.length * 8;
    const tail = new Uint8Array(((this.used < 56 ? 56 : 120) - this.used) + 8);
    tail[0] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bits / 2 ** 32));
    view.setUint32(tail.length - 4, bits >>> 0);
    this.bytes(tail);
    return (this.done = Array.from(this.h, (word) => word.toString(16).padStart(8, "0")).join(""));
  }
  private compress() {
    const w = this.w, b = this.block, h = this.h;
    for (let i = 0; i < 16; i++) w[i] = (b[i * 4]! << 24) | (b[i * 4 + 1]! << 16) | (b[i * 4 + 2]! << 8) | b[i * 4 + 3]!;
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!, y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h[0]!, bb = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + bb) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0; h[5] = (h[5]! + f) | 0; h[6] = (h[6]! + g) | 0; h[7] = (h[7]! + hh) | 0;
  }
}
export const sha256Hex = (text: string) => new Sha256().update(text).hex();
