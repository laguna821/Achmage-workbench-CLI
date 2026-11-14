import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";
import { engineJson, HwpCensusError, hwpTextOf, lostText, lostUnread, Sha256, sha256Hex, textHashDifferences } from "../../../packages/contracts/src/hwp-text.ts";
import { buildHwpx, caption, endnote, footer, footnote, header, hiddenComment, memo, notesWithBreaks, para, table, text, textBox } from "./hwp-census-fixture.ts";
import { hwpWasmPath } from "./hwp-resource.ts";

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });

/** One document with text in every kind of container; each piece's length is known. */
const everything = (cell = "칸글자") => buildHwpx(text("본문하나") + header(para(text("머리말"))) + footer(para(text("꼬리말글"))), [
  para(text("본문둘") + footnote(para(text("각주글자"))) + endnote(para(text("미주"))) + hiddenComment(para(text("숨은설명")))),
  para(table([para(text(cell)), para(text("옆칸") + table([para(text("안쪽표칸"))]))], { caption: caption(para(text("표캡션"))) })),
  para(textBox(para(text("글상자글")), { caption: caption(para(text("상자캡션"))) })),
  para(memo("메모글자", "본문셋")),
  para(table([para(text("칸안") + textBox(para(text("칸안상자"))) + footnote(para(text("칸각주"))))])),
], [{ first: text("둘째구역"), body: [para(text("구역본문") + endnote(para(text("구역미주")))), para(table([para(text("구역칸"))]))] }]);
const census = (bytes: Uint8Array) => { const doc = new HwpDocument(bytes); try { return hwpTextOf(doc); } finally { doc.free(); } };

describe("Hangul text census", () => {
  it("hashes like sha256 at every block boundary", () => {
    for (const value of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "가나다".repeat(100)]) {
      expect(sha256Hex(value)).toBe(createHash("sha256").update(value).digest("hex"));
    }
  });

  it("counts the characters of every container kind the engine lets it read, nested ones included", async () => {
    const counted = census(await everything());
    expect(counted.chars).toEqual({
      body: "본문하나본문둘본문셋둘째구역구역본문".length,
      cell: "칸글자옆칸안쪽표칸칸안구역칸".length,
      textbox: "글상자글칸안상자".length,
      footnote: "각주글자".length,
      endnote: "미주구역미주".length,
      header: "머리말".length, footer: "꼬리말글".length, memo: "메모글자".length,
    });
    // what the engine holds but gives no text for is named, not silently dropped
    expect(counted.unread).toEqual({ caption: 1, comment: 1, "note-in-cell": 1, "table-caption": 1 });
    expect(counted.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads the same document the same way after an HWP or HWPX save", async () => {
    const bytes = await everything(), counted = census(bytes);
    const doc = new HwpDocument(bytes);
    try {
      expect(census(doc.exportHwp())).toEqual(counted);
      expect(census(doc.exportHwpx())).toEqual(counted);
    } finally { doc.free(); }
  });

  it("changes the hash, not the counts, when three characters are replaced by three others", async () => {
    const before = census(await everything("칸글자")), after = census(await everything("다른자"));
    expect(after.chars).toEqual(before.chars);
    expect(after.sha256).not.toBe(before.sha256);
  });

  it("names a loss per kind and never a gain", () => {
    const base = { body: 10, cell: 838, textbox: 0, footnote: 2, endnote: 0, header: 3, footer: 0, memo: 1 };
    expect(lostText(base, { ...base, cell: 0, header: 1, body: 11 })).toEqual(["표 칸 글자 838→0", "머리말 글자 3→1"]);
    expect(lostText(base, { ...base, textbox: 5 })).toEqual([]);
  });

  it("reads notes, headers and memos that hold a tab or a line break (Shift+Enter), the same after HWP and HWPX saves", async () => {
    const bytes = await notesWithBreaks();
    const counted = census(bytes);
    expect(counted.chars).toMatchObject({ footnote: "각주\t끝\n다음".length, endnote: "미주\n끝\t".length, header: "머리\t말".length, memo: "메모\t글".length });
    const doc = new HwpDocument(bytes);
    try {
      expect(census(doc.exportHwp())).toEqual(counted);
      expect(census(doc.exportHwpx())).toEqual(counted);
    } finally { doc.free(); }
  });
});

// S2: everything of a kind is read, and what cannot be read is at least counted.
const headed = (options: { second?: string | null; headerTable?: boolean; footerBox?: boolean } = {}) => buildHwpx(
  text("본문") + header(para(text("머리말") + (options.headerTable === false ? "" : table([para(text("기관 결재란"))])))) + footer(para(text("꼬리") + (options.footerBox ? textBox(para(text("꼬리상자"))) : ""))),
  [para(text("둘째 쪽 본문") + (options.second === null ? "" : header(para(text(options.second ?? "둘째 머리말")))))],
);
describe("headers and footers: every one, and what is inside them", () => {
  it("counts a second header of the same kind later in the section, and tables and boxes inside headers and footers, as unread", async () => {
    const counted = census(await headed({ footerBox: true }));
    expect(counted.unread).toEqual({ "header-extra": 1, "header-object": 1, "footer-object": 1 });
    expect(counted.chars.header).toBe("머리말".length);
    const doc = new HwpDocument(await headed({ footerBox: true }));
    try {
      expect(census(doc.exportHwp()).unread).toEqual(counted.unread);
      expect(census(doc.exportHwpx()).unread).toEqual(counted.unread);
    } finally { doc.free(); }
    expect(census(await headed({ second: null, headerTable: false })).unread).toEqual({});
  });

  it("names a drop of what it cannot read, and never a rise", () => {
    expect(lostUnread({ "header-extra": 1, "header-object": 2, caption: 1 }, { "header-object": 1, caption: 3 }))
      .toEqual(["읽지 못하는 개체: 머리말 (같은 종류 둘째부터) 1→0", "읽지 못하는 개체: 머리말 안 표·글상자 등 2→1"]);
    expect(lostUnread({}, { "footer-object": 1 })).toEqual([]);
  });
});

// S4: order and content can be told apart.
describe("text order and text content", () => {
  it("gives an order-independent digest and one hash per kind beside the hash in walking order", async () => {
    const bytes = await everything(), counted = census(bytes);
    expect(counted.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(counted.kinds).sort()).toEqual(["body", "cell", "endnote", "footer", "footnote", "header", "memo", "textbox"]);
    // the engine lists the same containers in another order: the walking hash changes, nothing else
    const doc = new HwpDocument(bytes);
    try {
      const reordered = new Proxy(doc, { get: (target, name) => name === "getCursorModel" ? () => { const model = JSON.parse(target.getCursorModel()); model.lists.reverse(); return JSON.stringify(model); } : (target as never)[name] });
      const other = hwpTextOf(reordered as never);
      expect(other.sha256).not.toBe(counted.sha256);
      expect(other.digest).toBe(counted.digest);
      expect(other.kinds).toEqual(counted.kinds);
      expect(textHashDifferences(counted, other)).toEqual(["글자 순서만 바뀜 — 바뀐 이유를 문서별로 확인"]);
    } finally { doc.free(); }
    // three characters of one cell replaced: the cell kind's hash changes, the others do not
    const swapped = census(await everything("다른자"));
    expect(textHashDifferences(counted, swapped)).toEqual(["글자 내용 바뀜 (표 칸)"]);
    expect(textHashDifferences(counted, counted)).toEqual([]);
  });

  it("finalises a sha256 once: a second hex() gives the same value", () => {
    const hash = new Sha256().update("abc");
    expect(hash.hex()).toBe(hash.hex());
    expect(hash.hex()).toBe(createHash("sha256").update("abc").digest("hex"));
  });
});

describe("a census that cannot be computed", () => {
  it("names the step and the kind of error, never the engine's message (it may quote the document)", async () => {
    const doc = new HwpDocument(await notesWithBreaks());
    try {
      const broken = new Proxy(doc, { get: (target, name) => name === "getFootnoteInfo" ? () => '{"texts":["비밀 문장' : (target as never)[name] });
      const thrown = (() => { try { hwpTextOf(broken as never); return null; } catch (error) { return error; } })();
      expect(thrown).toBeInstanceOf(HwpCensusError);
      expect((thrown as Error).message).toBe("글자 검사 못함 (각주·미주: SyntaxError)");
      expect((thrown as Error).message).not.toMatch(/비밀/);
    } finally { doc.free(); }
  });
});

describe("engine JSON", () => {
  // The engine escapes only \\ and " in some answers (rhwp get_footnote_info_native): every other
  // character of the text goes into the JSON string as it is.
  const engineStyle = (texts: string[]) => `{"ok":true,"paraCount":${texts.length},"texts":[${texts.map((t) => `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}]}`;
  it("reads strings holding every control character, quotes, backslashes and lone surrogates", () => {
    const every = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join("");
    const cases = [every, `"인용"\\경로\\`, "\ud800 혼자 \udfff", "\\u0041 그대로", `끝\\`, "", "\u007f\u2028\u2029"];
    for (const texts of [cases, [cases.join("")]]) expect(engineJson<{ texts: string[] }>(engineStyle(texts)).texts).toEqual(texts);
    // random: 300 strings of control characters, quotes, backslashes, surrogates, CJK
    const alphabet = [...every, "\"", "\\", "\ud800", "\udc00", "가", "a", "{", "}", "[", "]", ",", ":"];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 300; round++) {
      const texts = Array.from({ length: 1 + Math.floor(next() * 4) }, () => Array.from({ length: Math.floor(next() * 40) }, () => alphabet[Math.floor(next() * alphabet.length)]).join(""));
      expect(engineJson<{ texts: string[] }>(engineStyle(texts)).texts).toEqual(texts);
    }
  });
  it("reads properly escaped JSON exactly as JSON.parse does", () => {
    const value = { a: "탭\t줄\n\u0000", b: [1, -2.5e3, true, null], c: { "키\"": "\\" } };
    expect(engineJson(JSON.stringify(value))).toEqual(value);
  });
});

