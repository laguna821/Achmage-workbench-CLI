import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as rhwp from "../../third_party/hop/rhwp-core/rhwp.js";
import { hwpWasmPath } from "../../apps/host/src/hwp-resource.ts";
import { buildHwpx, endnote, footnote, header, lineBreak, para, tab, table, text, withControlCharacters } from "../../apps/host/src/hwp-census-fixture.ts";
import { checkDocument, failureOf, liveOf, saveRoundTrip, type Engine, type EngineDoc } from "./check.ts";

const engine = rhwp as unknown as Engine;
beforeAll(async () => { await rhwp.default({ module_or_path: readFileSync(hwpWasmPath()) }); });

// A small form: a title, a table of filled cells, and a paragraph long enough to wrap.
const LONG = "줄이 여러 번 나뉘는 긴 문단입니다. ".repeat(12);
const form = (cells: [string, string, string]) => buildHwpx(text("신청서"), [
  para(table([para(text(cells[0])), para(text(cells[1]))])),
  para(table([para(text(cells[2]))])),
  para(text(LONG)),
]);
const FILLED: [string, string, string] = ["성명 홍길동", "소속 가나다라학과", "연락처 010"];
const open = (bytes: Uint8Array) => new engine.HwpDocument(bytes) as EngineDoc;
async function exportOf(bytes: Uint8Array, format: "hwp" | "hwpx", change: (doc: EngineDoc & Record<string, Function>) => void = () => {}) {
  const doc = open(bytes) as EngineDoc & Record<string, Function>;
  try { change(doc); return format === "hwpx" ? doc.exportHwpx() : doc.exportHwp(); } finally { doc.free(); }
}

describe("corpus save round trip compares the text and the line breaks", () => {
  it("reports a save that empties every table cell, in the same format and in the other", async () => {
    const original = await form(FILLED), emptied = await form(["", "", ""]);
    for (const format of ["hwpx", "hwp"] as const) {
      const doc = open(original);
      try {
        const result = await saveRoundTrip(engine, doc, original, "hwpx", format, liveOf(doc), await exportOf(emptied, format));
        expect(result.status).toBe("ok");
        expect(result.differences).toContain(`표 칸 글자 ${FILLED.join("").length}→0`);
        expect(result.differences).toContain("글자 내용 바뀜 (표 칸)");
      } finally { doc.free(); }
    }
  });

  it("reports three characters replaced by three others, with every count the same", async () => {
    const original = await form(FILLED), swapped = await form([FILLED[0], "소속 마바사라학과", FILLED[2]]);
    const doc = open(original);
    try {
      const result = await saveRoundTrip(engine, doc, original, "hwpx", "hwpx", liveOf(doc), await exportOf(swapped, "hwpx"));
      expect(result.differences).toEqual(["글자 내용 바뀜 (표 칸)"]);
    } finally { doc.free(); }
  });

  it("reports a character size change that re-wraps lines, with the text unchanged", async () => {
    const original = await form(FILLED);
    const bigger = await exportOf(original, "hwpx", (doc) => doc.applyCharFormat(0, 3, 0, LONG.length, JSON.stringify({ fontSize: 1600 })));
    const doc = open(original);
    try {
      const result = await saveRoundTrip(engine, doc, original, "hwpx", "hwpx", liveOf(doc), bigger);
      expect(result.differences.some((line) => /^\d+쪽 줄 나눔 바뀜$/.test(line))).toBe(true);
      expect(result.differences.filter((line) => line.startsWith("글자 내용 바뀜"))).toEqual([]);
    } finally { doc.free(); }
  });

  it("finds nothing when the save keeps everything, and records what the reopened file holds", async () => {
    const original = await form(FILLED);
    const doc = open(original);
    try {
      const result = await saveRoundTrip(engine, doc, original, "hwpx", "hwpx", liveOf(doc));
      expect(result.differences).toEqual([]);
      expect(result.text?.chars.cell).toBe(FILLED.join("").length);
      expect(result.text?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.breaks?.length).toBe(result.pages);
    } finally { doc.free(); }
  });

  it("saves a document with a tab and a line break in a footnote and an endnote on every path, and still sees an emptied cell", async () => {
    const noted = (cell: string) => buildHwpx(text("본문"), [
      para(text("둘") + footnote(para(text("각주") + tab + text("끝") + lineBreak + text("다음"))) + endnote(para(text("미주") + lineBreak + text("끝") + tab))),
      para(table([para(text(cell))])),
    ]);
    const original = await noted("성명 홍길동"), emptied = await noted("");
    for (const format of ["hwpx", "hwp"] as const) {
      const doc = open(original);
      try {
        const live = liveOf(doc);
        expect(live.text.chars).toMatchObject({ footnote: "각주\t끝\n다음".length, endnote: "미주\n끝\t".length });
        const kept = await saveRoundTrip(engine, doc, original, "hwpx", format, live);
        expect(kept.status).toBe("ok");
        expect(kept.differences.filter((line) => !/줄 나눔 바뀜$/.test(line))).toEqual([]);
        const lost = await saveRoundTrip(engine, doc, original, "hwpx", format, live, await exportOf(emptied, format));
        expect(lost.differences).toContain(`표 칸 글자 ${"성명 홍길동".length}→0`);
      } finally { doc.free(); }
    }
  });

  it("reports a save that drops a table from a header, or a second header of the same kind", async () => {
    const headed = (headerTable: boolean, second: boolean) => buildHwpx(text("본문") + header(para(text("머리말") + (headerTable ? table([para(text("결재"))]) : ""))), [
      para(text("둘째") + (second ? header(para(text("둘째 머리말"))) : "")),
    ]);
    const original = await headed(true, true);
    const doc = open(original);
    try {
      const result = await saveRoundTrip(engine, doc, original, "hwpx", "hwpx", liveOf(doc), await headed(false, false));
      expect(result.differences).toEqual(expect.arrayContaining(["읽지 못하는 개체: 머리말 (같은 종류 둘째부터) 1→0", "읽지 못하는 개체: 머리말 안 표·글상자 등 1→0"]));
    } finally { doc.free(); }
  });
  it("saves an HWPX holding carriage returns as character references unchanged, still sees an emptied cell, and sees what the HWP writer eats (T1)", async () => {
    const original = await withControlCharacters(), emptied = await withControlCharacters("");
    const doc = open(original);
    try {
      const live = liveOf(doc);
      // the carriage returns and the vertical tab are left out of the counts (neither writer keeps them)
      expect(live.text.chars).toMatchObject({ body: "본문가나다셋".length, footnote: "각주끝".length, header: "머리말".length, memo: "메모글".length });
      const kept = await saveRoundTrip(engine, doc, original, "hwpx", "hwpx", live);
      expect(kept.status).toBe("ok");
      expect(kept.differences.filter((line) => !/줄 나눔 바뀜$/.test(line))).toEqual([]);
      const lost = await saveRoundTrip(engine, doc, original, "hwpx", "hwpx", live, await exportOf(emptied, "hwpx"));
      expect(lost.differences).toContain(`표 칸 글자 ${"성명 홍길동".length}→0`);
      // the HWP writer eats the characters after a carriage return: a real loss, still reported
      const hwp = await saveRoundTrip(engine, doc, original, "hwpx", "hwp", live);
      expect(hwp.differences).toEqual(expect.arrayContaining([expect.stringMatching(/^본문 글자 6→\d$/), expect.stringMatching(/^각주 글자 3→\d$/)]));
    } finally { doc.free(); }
  });
});

// m3-4: a failure line names the step and the error's kind only — an engine's or JSON.parse's message may quote the document
describe("corpus failure messages", () => {
  const SECRET = "비밀 문장";
  const quoting = () => { try { JSON.parse(`${SECRET} 끝`); } catch (error) { return error; } return null; };
  it("never carry the error's own message", () => {
    expect(String((quoting() as Error).message)).toContain(SECRET);
    expect(failureOf("다시 열기", quoting())).toBe("다시 열기 (SyntaxError)");
    expect(failureOf("열기", `엔진: ${SECRET}`)).toBe("열기 (string)");
    expect(failureOf("검사", new Error(SECRET))).toBe("검사 (Error)");
  });

  it("keep document text out of every failed document, save path and drawing error", async () => {
    const original = await form(FILLED);
    const dir = mkdtempSync(join(tmpdir(), "zz-hwp-corpus-")), file = join(dir, "form.hwpx");
    try {
      writeFileSync(file, original);
      const fail = () => () => { throw quoting(); };
      const broken = (names: string[]): Engine => ({ HwpDocument: class { constructor(bytes: Uint8Array) {
        const doc = new engine.HwpDocument(bytes) as unknown as Record<string, unknown>;
        return new Proxy(doc, { get: (target, name) => names.includes(name as string) ? fail() : typeof target[name as string] === "function" ? (target[name as string] as Function).bind(target) : target[name as string] });
      } } as unknown as Engine["HwpDocument"] });
      const base = { id: "form", path: "form.hwpx", format: "hwpx" as const, status: "skipped" as const };
      const results = [
        await checkDocument(broken(["getPageTextLayout"]), file, base, 8),
        await checkDocument(broken(["renderPageSvg"]), file, base, 8),
        await checkDocument(broken(["getMemoList"]), file, base, 8),
        await checkDocument({ HwpDocument: class { constructor() { throw quoting(); } } } as unknown as Engine, file, base, 8),
      ];
      expect(results.map((result) => result.status)).toEqual(["failed", "ok", "failed", "failed"]);
      expect(results[1]!.renderError).toBe("1쪽 그리기 (SyntaxError)");
      expect(results.map((result) => result.reason)).toEqual(["검사 중 오류: 검사 (SyntaxError)", undefined, "검사 중 오류: 글자 검사 못함 (메모: SyntaxError)", "열지 못함: 열기 (SyntaxError)"]);
      expect(JSON.stringify(results)).not.toContain(SECRET);
      // a save path whose reopening fails
      const doc = open(original);
      try {
        const reopenBroken = { HwpDocument: class { constructor() { throw quoting(); } } } as unknown as Engine;
        const saved = await saveRoundTrip(reopenBroken, doc, original, "hwpx", "hwpx", liveOf(doc));
        expect(saved).toMatchObject({ status: "failed", message: "다시 열지 못함: 다시 열기 (SyntaxError)" });
      } finally { doc.free(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
