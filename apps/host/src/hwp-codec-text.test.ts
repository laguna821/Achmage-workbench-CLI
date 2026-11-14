import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";
import { encodeHwpSave } from "../../../packages/contracts/src/hwp.ts";
import { buildHwpx, endnote, footnote, header, lineBreak, para, tab, table, text, withControlCharacters } from "./hwp-census-fixture.ts";
import { hwpWasmPath } from "./hwp-resource.ts";

// The save step can be made to lose content (the real fixes only add, so no real document shows
// it): `fixes.bytes`, when set, is what the save fixes return instead of their input.
const fixes = vi.hoisted(() => ({ bytes: null as Uint8Array | null }));
vi.mock("../../../third_party/ieumoffice/hwp/save-fixes.ts", async (actual) => {
  const real = await actual<typeof import("../../../third_party/ieumoffice/hwp/save-fixes.ts")>();
  return { ...real, applySaveFixes: (...args: Parameters<typeof real.applySaveFixes>) => (fixes.bytes ? { bytes: fixes.bytes, tailsSkipped: false } : real.applySaveFixes(...args)) };
});
const { decodeHwpSave, prepareHwpSave } = await import("./hwp-codec.ts");
const { hwpStructureOf, validStructure } = await import("./hwp-structure.ts");

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });

// A form: every cell filled, a header and a footnote.
const CELLS = ["성명 홍길동", "소속 가나다라학과"];
const form = (cells = CELLS, note = "각주 글자") => buildHwpx(text("신청서") + header(para(text("머리말"))), [
  para(text("본문") + footnote(para(text(note)))),
  para(table(cells.map((cell) => para(text(cell))))),
]);
const reportOf = (bytes: Uint8Array) => { const doc = new HwpDocument(bytes); try { return hwpStructureOf(doc); } finally { doc.free(); } };
const asHwp = (bytes: Uint8Array) => { const doc = new HwpDocument(bytes); try { return doc.exportHwp(); } finally { doc.free(); } };

describe("the save fingerprint guards the text of every container", () => {
  it("refuses a save whose cells were emptied while the editor still holds them, naming the kind", async () => {
    const original = await form(), emptied = await form(["", ""]);
    await expect(prepareHwpSave(original, emptied, "hwpx", { memos: [], structure: reportOf(original) }))
      .rejects.toMatchObject({ code: "hwp_content_loss", message: expect.stringMatching(new RegExp(`표 칸 글자 ${CELLS.join("").length}→0`)) });
    // Save As in the other format: the same loss, the same refusal
    await expect(prepareHwpSave(original, asHwp(emptied), "hwp", { memos: [], structure: reportOf(original) }, "save", "hwpx"))
      .rejects.toThrow(/표 칸 글자 \d+→0/);
  });

  it("refuses a lost footnote text and names it", async () => {
    const original = await form(), shorter = await form(CELLS, "");
    await expect(prepareHwpSave(original, shorter, "hwpx", { memos: [], structure: reportOf(original) })).rejects.toThrow(/각주 글자 5→0/);
  });

  it("saves cells the person emptied on purpose, and text replaced by other text of the same length", async () => {
    const original = await form(), emptied = await form(["", ""]), swapped = await form(["성명 김길동", CELLS[1]!]);
    expect(await prepareHwpSave(original, emptied, "hwpx", { memos: [], structure: reportOf(emptied) })).toBeInstanceOf(Buffer);
    // replaced, not lost: the whole-text hash is not a refusal reason in this round
    expect(await prepareHwpSave(original, swapped, "hwpx", { memos: [], structure: reportOf(original) })).toBeInstanceOf(Buffer);
  });

  it("also compares the export with what is written when a report is sent, so an under-counting report hides nothing", async () => {
    const original = await form(), emptied = await form(["", ""]);
    fixes.bytes = emptied;
    try {
      // the report under-counts (says the cells are empty); the export holds them; the save step drops them
      await expect(prepareHwpSave(original, original, "hwpx", { memos: [], structure: reportOf(emptied) })).rejects.toThrow(/표 칸 글자 \d+→0/);
    } finally { fixes.bytes = null; }
  });

  it("bounds font names by trimming, so a document with many long font names still saves", async () => {
    const names = Array.from({ length: 500 }, (_, index) => `${"글꼴".repeat(99)}${String(index).padStart(2, "0")}`.slice(0, 200));
    const report = { ...reportOf(await form()), fonts: names.sort() };
    expect(validStructure(report)).toBe(true);
    expect(decodeHwpSave(Buffer.from(encodeHwpSave({ structure: report }, new Uint8Array([1, 2, 3])))).metadata.structure?.fonts).toHaveLength(500);
    // more and longer names than any bound: the census trims them the same way on both sides
    const many = Array.from({ length: 1500 }, (_, index) => `${index}`.padEnd(300, "가"));
    const doc = new HwpDocument(await form());
    try {
      const counted = hwpStructureOf(Object.assign(Object.create(Object.getPrototypeOf(doc)), doc, {
        getDocumentInfo: () => JSON.stringify({ fontsUsed: many }),
      }));
      expect(validStructure(counted)).toBe(true);
      expect(counted.fonts.every((name) => name.length <= 200)).toBe(true);
    } finally { doc.free(); }
  });

  // N2-1: a tab or a line break (Shift+Enter) in a footnote or an endnote made every save impossible.
  it("saves a document with a tab and a line break in its notes, same format and the other, and still refuses an emptied cell", async () => {
    const noted = (cell: string) => buildHwpx(text("본문") + header(para(text("머리") + tab + text("말"))), [
      para(text("둘") + footnote(para(text("각주") + tab + text("끝") + lineBreak + text("다음"))) + endnote(para(text("미주") + lineBreak + text("끝") + tab))),
      para(table([para(text(cell))])),
    ]);
    const original = await noted("성명 홍길동"), emptied = await noted("");
    const report = reportOf(original);
    expect(report.textUnchecked).toBeUndefined();
    for (const [format, bytes] of [["hwpx", original], ["hwp", asHwp(original)]] as const) {
      const check: { text?: "checked" | "unchecked" } = {};
      expect(await prepareHwpSave(original, bytes, format, { memos: [], structure: report }, "save", "hwpx", { check })).toBeInstanceOf(Buffer);
      expect(check.text).toBe("checked");
      expect(await prepareHwpSave(original, bytes, format, { memos: [] }, "save", "hwpx")).toBeInstanceOf(Buffer);
      await expect(prepareHwpSave(original, format === "hwp" ? asHwp(emptied) : emptied, format, { memos: [], structure: report }, "save", "hwpx"))
        .rejects.toThrow(new RegExp(`표 칸 글자 ${"성명 홍길동".length}→0`));
    }
  });

  // S2: what the census cannot read is at least counted, and a drop is refused like a loss.
  it("refuses a save that drops a table from a header or a second header of the same kind; saves when the person removed them", async () => {
    const headed = (headerTable: boolean, second: boolean) => buildHwpx(text("본문") + header(para(text("머리말") + (headerTable ? table([para(text("기관 결재란"))]) : ""))), [
      para(text("둘째 쪽") + (second ? header(para(text("둘째 머리말"))) : "")),
    ]);
    const original = await headed(true, true), noTable = await headed(false, true), noSecond = await headed(true, false);
    await expect(prepareHwpSave(original, noTable, "hwpx", { memos: [], structure: reportOf(original) }))
      .rejects.toMatchObject({ code: "hwp_content_loss", message: expect.stringMatching(/읽지 못하는 개체: 머리말 안 표·글상자 등 1→0/) });
    await expect(prepareHwpSave(original, asHwp(noSecond), "hwp", { memos: [], structure: reportOf(original) }, "save", "hwpx"))
      .rejects.toThrow(/읽지 못하는 개체: 머리말 \(같은 종류 둘째부터\) 1→0/);
    // removed in the editor on purpose: the live report already lacks them
    expect(await prepareHwpSave(original, noTable, "hwpx", { memos: [], structure: reportOf(noTable) })).toBeInstanceOf(Buffer);
    expect(await prepareHwpSave(original, noSecond, "hwpx", { memos: [], structure: reportOf(noSecond) })).toBeInstanceOf(Buffer);
    // a rise is never a loss
    expect(await prepareHwpSave(noTable, original, "hwpx", { memos: [], structure: reportOf(noTable) })).toBeInstanceOf(Buffer);
  });
  // N3-1 / T1: an HWPX holding carriage returns written as character references (generated files)
  // was refused when saved unchanged with the editor's report: the HWPX writer drops them.
  it("saves an unchanged HWPX holding carriage returns with the editor's report, still refuses an emptied cell, and refuses what the HWP writer eats", async () => {
    const original = await withControlCharacters(), emptied = await withControlCharacters("");
    const doc = new HwpDocument(original);
    let exported: Uint8Array, report: ReturnType<typeof reportOf>;
    try { report = hwpStructureOf(doc); exported = doc.exportHwpx(); } finally { doc.free(); }
    expect(report.textUnchecked).toBeUndefined();
    const check: { text?: "checked" | "unchecked" } = {};
    expect(await prepareHwpSave(original, exported, "hwpx", { memos: [], structure: report }, "save", "hwpx", { check })).toBeInstanceOf(Buffer);
    expect(check.text).toBe("checked");
    expect(await prepareHwpSave(original, exported, "hwpx", { memos: [] })).toBeInstanceOf(Buffer);
    await expect(prepareHwpSave(original, emptied, "hwpx", { memos: [], structure: report }))
      .rejects.toMatchObject({ code: "hwp_content_loss", message: expect.stringMatching(new RegExp(`표 칸 글자 ${"성명 홍길동".length}→0`)) });
    // HWP: the writer eats the characters after each carriage return — a real loss, refused as before
    await expect(prepareHwpSave(original, asHwp(original), "hwp", { memos: [], structure: report }, "save", "hwpx"))
      .rejects.toMatchObject({ code: "hwp_content_loss", message: expect.stringMatching(/본문 글자 6→\d/) });
  });
});
