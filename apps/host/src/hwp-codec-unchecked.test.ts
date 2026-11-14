import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";
import { encodeHwpSave } from "../../../packages/contracts/src/hwp.ts";
import { buildHwpx, para, table, text } from "./hwp-census-fixture.ts";
import { hwpWasmPath } from "./hwp-resource.ts";

// S1(b): a failure of OUR counting is not a loss. The text census is made to fail (as an engine
// answer it cannot read would make it) on chosen documents; everything else is the real code.
const failing = vi.hoisted(() => ({ when: (_doc: unknown): boolean => false }));
vi.mock("../../../packages/contracts/src/hwp-text.ts", async (actual) => {
  const real = await actual<typeof import("../../../packages/contracts/src/hwp-text.ts")>();
  return {
    ...real,
    hwpTextOf: (doc: Parameters<typeof real.hwpTextOf>[0]) => {
      if (failing.when(doc)) throw new real.HwpCensusError("각주·미주", new SyntaxError("Unexpected token in JSON: \"비밀 문장\""));
      return real.hwpTextOf(doc);
    },
  };
});
const { decodeHwpSave, prepareHwpSave } = await import("./hwp-codec.ts");
const { hwpStructureOf, validStructure } = await import("./hwp-structure.ts");
const { liveOf, saveRoundTrip } = await import("../../../scripts/hwp-corpus/check.ts");
const rhwp = await import("../../../third_party/hop/rhwp-core/rhwp.js");

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });
afterEach(() => { failing.when = () => false; vi.restoreAllMocks(); });

const CELLS = ["성명 홍길동", "소속 가나다라학과"];
const form = (cells = CELLS, tables = 1) => buildHwpx(text("신청서"), [
  para(text("본문")),
  ...Array.from({ length: tables }, () => para(table(cells.map((cell) => para(text(cell)))))),
]);
const reportOf = (bytes: Uint8Array) => { const doc = new HwpDocument(bytes); try { return hwpStructureOf(doc); } finally { doc.free(); } };
const always = () => true;

describe("a text census that cannot be computed never refuses a save by itself", () => {
  it("reports the text as unchecked in the structure, with the reason and no document text", async () => {
    failing.when = always;
    const report = reportOf(await form());
    expect(report.textUnchecked).toBe("글자 검사 못함 (각주·미주: SyntaxError)");
    expect(report.chars).toBeUndefined();
    expect(report.textSha256).toBeUndefined();
    expect(report.objects.tbl).toBe(1);
    // such a report is a valid save request; one with neither the text nor the reason is not
    expect(validStructure(report)).toBe(true);
    expect(validStructure({ ...report, textUnchecked: undefined })).toBe(false);
    expect(validStructure({ ...report, textUnchecked: "x".repeat(201) })).toBe(false);
    expect(decodeHwpSave(Buffer.from(encodeHwpSave({ structure: report }, new Uint8Array([1, 2, 3])))).metadata.structure?.textUnchecked).toBe(report.textUnchecked);
  });

  it("saves when the census fails on the saved bytes, says the text was unchecked, and logs why without document text", async () => {
    const original = await form(), emptied = await form(["", ""]);
    const report = reportOf(original);
    failing.when = always;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const check: { text?: "checked" | "unchecked" } = {};
    // the cells WERE emptied, but with no census of the saved bytes no loss is established
    expect(await prepareHwpSave(original, emptied, "hwpx", { memos: [], structure: report }, "save", "hwpx", { check })).toBeInstanceOf(Buffer);
    expect(check.text).toBe("unchecked");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/글자 검사 못함 \(각주·미주: SyntaxError\)/));
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/비밀|홍길동/);
  });

  it("still refuses a lost table: the structure counts keep running when the text census cannot", async () => {
    const original = await form(CELLS, 2), fewer = await form(CELLS, 1);
    failing.when = always;
    await expect(prepareHwpSave(original, fewer, "hwpx", { memos: [], structure: reportOf(original) })).rejects.toMatchObject({ code: "hwp_content_loss", message: expect.stringMatching(/표 2→1/) });
  });

  it("saves when the census fails on the live document only (the report), and compares the text when it can", async () => {
    const original = await form(), emptied = await form(["", ""]);
    failing.when = always;
    const report = reportOf(original);
    failing.when = () => false;
    const check: { text?: "checked" | "unchecked" } = {};
    expect(await prepareHwpSave(original, emptied, "hwpx", { memos: [], structure: report }, "save", "hwpx", { check })).toBeInstanceOf(Buffer);
    expect(check.text).toBe("unchecked");
    // both computed and a count lower: refused, as before
    await expect(prepareHwpSave(original, emptied, "hwpx", { memos: [], structure: reportOf(original) }, "save", "hwpx", { check })).rejects.toThrow(/표 칸 글자 \d+→0/);
    const kept: { text?: "checked" | "unchecked" } = {};
    expect(await prepareHwpSave(original, original, "hwpx", { memos: [], structure: reportOf(original) }, "save", "hwpx", { check: kept })).toBeInstanceOf(Buffer);
    expect(kept.text).toBe("checked");
  });

  it("is a failure in the corpus check, where the product saves", async () => {
    const original = await form(), doc = new HwpDocument(original);
    try {
      const live = liveOf(doc as never);
      failing.when = always;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await saveRoundTrip(rhwp as never, doc as never, original, "hwpx", "hwpx", live, undefined, true);
      expect(result).toMatchObject({ status: "failed", code: "text_unchecked" });
    } finally { doc.free(); }
  });
});

