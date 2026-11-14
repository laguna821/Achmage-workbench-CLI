import { readFileSync } from "node:fs";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";
import { buildHwpx, para, table, text } from "./hwp-census-fixture.ts";
import { hwpWasmPath } from "./hwp-resource.ts";

// T3 (m3-3): the structure census fails on the editor's EXPORT only (the saved bytes count). The
// export comparison cannot run, so the answer must not say the structure (or the text) was checked.
// The save step is made to change the bytes (`fixes.bytes`), so the export is counted at all; the
// census is made to fail on its n-th call (1: the saved bytes, 2: the export). Everything else is real.
const fixes = vi.hoisted(() => ({ bytes: null as Uint8Array | null }));
const failing = vi.hoisted(() => ({ call: 0, on: 0 }));
vi.mock("../../../third_party/ieumoffice/hwp/save-fixes.ts", async (actual) => {
  const real = await actual<typeof import("../../../third_party/ieumoffice/hwp/save-fixes.ts")>();
  return { ...real, applySaveFixes: (...args: Parameters<typeof real.applySaveFixes>) => (fixes.bytes ? { bytes: fixes.bytes, tailsSkipped: false } : real.applySaveFixes(...args)) };
});
vi.mock("./hwp-structure.ts", async (actual) => {
  const real = await actual<typeof import("./hwp-structure.ts")>();
  return {
    ...real,
    hwpStructureOf: (doc: Parameters<typeof real.hwpStructureOf>[0]) => {
      if (++failing.call === failing.on) throw new SyntaxError("Unexpected token in JSON: \"비밀 문장\"");
      return real.hwpStructureOf(doc);
    },
  };
});
const { prepareHwpSave } = await import("./hwp-codec.ts");
const { hwpStructureOf } = await import("./hwp-structure.ts");

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });
afterEach(() => { fixes.bytes = null; failing.call = 0; failing.on = 0; vi.restoreAllMocks(); });

const form = (cells = ["성명 홍길동"]) => buildHwpx(text("신청서"), [para(text("본문")), para(table(cells.map((cell) => para(text(cell)))))]);
const reportOf = (bytes: Uint8Array) => { const doc = new HwpDocument(bytes); try { return hwpStructureOf(doc); } finally { doc.free(); } };

it("says unchecked, not checked, when only the export's structure census fails", async () => {
  const original = await form();
  const report = reportOf(original);
  // the save step returns other (equal) bytes, so the export is opened and counted after the saved bytes
  const again = new HwpDocument(original);
  try { fixes.bytes = again.exportHwpx(); } finally { again.free(); }
  expect(Buffer.from(fixes.bytes).equals(Buffer.from(original))).toBe(false);
  failing.call = 0; failing.on = 2;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const check: { text?: "checked" | "unchecked"; structure?: "checked" | "unchecked" } = {};
  expect(await prepareHwpSave(original, original, "hwpx", { memos: [], structure: report }, "save", "hwpx", { check })).toBeInstanceOf(Buffer);
  expect(failing.call).toBe(2);
  expect(check).toEqual({ structure: "unchecked", text: "unchecked" });
  expect(warn.mock.calls.flat().join(" ")).toMatch(/export/);
  expect(warn.mock.calls.flat().join(" ")).toContain("(SyntaxError)");
  expect(warn.mock.calls.flat().join(" ")).not.toMatch(/비밀|홍길동/);
  // the comparison with the editor's report still ran: a lost cell is still refused
  fixes.bytes = await form([""]);
  failing.call = 0; failing.on = 2;
  await expect(prepareHwpSave(original, original, "hwpx", { memos: [], structure: report }, "save", "hwpx", {})).rejects.toMatchObject({ code: "hwp_content_loss" });
});

it("says checked when every side was counted", async () => {
  const original = await form();
  const again = new HwpDocument(original);
  try { fixes.bytes = again.exportHwpx(); } finally { again.free(); }
  const check: { text?: "checked" | "unchecked"; structure?: "checked" | "unchecked" } = {};
  expect(await prepareHwpSave(original, original, "hwpx", { memos: [], structure: reportOf(original) }, "save", "hwpx", { check })).toBeInstanceOf(Buffer);
  expect(check).toEqual({ structure: "checked", text: "checked" });
});
