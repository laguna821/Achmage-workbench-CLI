import { readFileSync } from "node:fs";
import { beforeAll, expect, it, vi } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";
import { hwpWasmPath } from "./hwp-resource.ts";

// An engine whose counting call changed (a renamed method after an upgrade): a failure of our own
// counting is not a loss — the save goes on and says it was not checked; never a 500, never a
// refusal, and the log names the kind of error only.
vi.mock("./hwp-structure.ts", async (actual) => ({
  ...(await actual<typeof import("./hwp-structure.ts")>()),
  hwpStructureOf: () => { throw new TypeError("doc.getControls is not a function\n    at hwpStructureOf (hwp-structure.ts:44)"); },
}));
const { prepareHwpSave } = await import("./hwp-codec.ts");

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });
it("saves what it cannot count, says it was unchecked, and leaves recovery drafts alone", async () => {
  const doc = HwpDocument.createEmpty(); doc.createBlankDocument(); doc.insertText(0, 0, 0, "검사");
  try {
    const bytes = doc.exportHwpx();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const check: { text?: "checked" | "unchecked"; structure?: "checked" | "unchecked" } = {};
    await expect(prepareHwpSave(bytes, bytes, "hwpx", { memos: [] }, "save", "hwpx", { check })).resolves.toBeInstanceOf(Buffer);
    expect(check).toEqual({ structure: "unchecked", text: "unchecked" });
    expect(warned.mock.calls.flat().join(" ")).toContain("(TypeError)");
    expect(warned.mock.calls.flat().join(" ")).not.toContain("getControls");
    warned.mockRestore();
    await expect(prepareHwpSave(bytes, bytes, "hwpx", {}, "recovery")).resolves.toBeInstanceOf(Buffer);
  } finally { doc.free(); }
});
