import { readFileSync } from "node:fs";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";
import { buildHwpx, para, table, text } from "./hwp-census-fixture.ts";
import { hwpWasmPath } from "./hwp-resource.ts";

// T3 (m3-2): the document AI's save path follows the same rule as Save and Save As (a33a8e7f) — a
// STRUCTURE census that throws (an engine whose call was renamed) is not a refusal; the answer and
// the log say the save was unchecked, the log with the error kind only. The census fails on chosen
// calls: 1 is the editing session's own census, the rest are the gateway's. Everything else is real.
const exported = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array }));
const failing = vi.hoisted(() => ({ call: 0, on: (_call: number): boolean => false }));
vi.mock("../../../vendor/ieumoffice/packages/cli/src/formats/hwp-edit.ts", () => ({
  hwpCatalog: () => [],
  openHwpForEdit: async (bytes: Uint8Array) => ({ doc: new HwpDocument(new Uint8Array(bytes)) }),
  applyHwpOps: async () => ({ results: [{ changed: true }] }),
  saveHwpSession: async () => ({ bytes: exported.bytes, tailsLost: false, memosLost: 0 }),
  closeHwpSession: (session: { doc: HwpDocument }) => session.doc.free(),
}));
vi.mock("./hwp-structure.ts", async (actual) => {
  const real = await actual<typeof import("./hwp-structure.ts")>();
  return {
    ...real,
    hwpStructureOf: (doc: Parameters<typeof real.hwpStructureOf>[0]) => {
      if (failing.on(++failing.call)) throw new TypeError("doc.getControls is not a function \"비밀 문장\"");
      return real.hwpStructureOf(doc);
    },
  };
});
const { editHwp } = await import("./hwp-ops.mjs");

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });
afterEach(() => { failing.call = 0; failing.on = () => false; vi.restoreAllMocks(); });
const document = (cell: string) => buildHwpx(text("신청서"), [para(text("문서 AI 편집")), para(table([para(text(cell))]))]);

it("saves an AI edit when the session's structure census throws, and says it was unchecked (log: error kind only)", async () => {
  exported.bytes = await document("성명 홍길동");
  failing.on = (call) => call === 1;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(editHwp(await document("성명 홍길동"), "hwpx", [{ op: "noop" }])).resolves.toMatchObject({ changed: true, structure: "unchecked", text: "unchecked" });
  const logged = warn.mock.calls.flat().join(" ");
  expect(logged).toMatch(/\[hwp\] document AI save .*\(TypeError\)/);
  expect(logged).not.toMatch(/비밀|getControls|홍길동/);
});

it("saves an AI edit when every structure census throws, and says it was unchecked", async () => {
  exported.bytes = await document("성명 홍길동");
  failing.on = () => true;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(editHwp(await document("성명 홍길동"), "hwpx", [{ op: "noop" }])).resolves.toMatchObject({ changed: true, structure: "unchecked", text: "unchecked" });
});

it("says checked when every census ran, and still refuses an emptied cell", async () => {
  exported.bytes = await document("성명 홍길동");
  await expect(editHwp(await document("성명 홍길동"), "hwpx", [{ op: "noop" }])).resolves.toMatchObject({ changed: true, structure: "checked", text: "checked" });
  exported.bytes = await document("");
  const refused = await editHwp(await document("성명 홍길동"), "hwpx", [{ op: "noop" }]).then(() => null, (error: unknown) => error as Error & { detail?: unknown });
  expect(refused?.detail).toMatchObject({ code: "hwp_content_loss" });
});
