import { readFileSync } from "node:fs";
import { beforeAll, expect, it, vi } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";
import { hwpWasmPath } from "./hwp-resource.ts";

// Without a report (an editor that sends none, recovery aside) the gateway compares what it is
// about to write with the editor's own export. Proven with save fixes that lose a table — the
// real fixes only add, so no real document can show it; without this, "never compare" passes.
const lossy = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array }));
vi.mock("../../../third_party/ieumoffice/hwp/save-fixes.ts", () => ({ applySaveFixes: () => ({ bytes: lossy.bytes, tailsSkipped: false }) }));
const { prepareHwpSave } = await import("./hwp-codec.ts");

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });
it("compares the bytes to be written with the editor's export when the editor reports nothing", async () => {
  const withTable = HwpDocument.createEmpty(), without = HwpDocument.createEmpty();
  try {
    withTable.createBlankDocument(); withTable.insertText(0, 0, 0, "보고 없는 저장"); withTable.createTable(0, 0, 0, 2, 2);
    without.createBlankDocument(); without.insertText(0, 0, 0, "보고 없는 저장");
    const exported = withTable.exportHwpx();
    lossy.bytes = without.exportHwpx();
    await expect(prepareHwpSave(exported, exported, "hwpx", { memos: [] })).rejects.toMatchObject({ code: "hwp_content_loss", message: expect.stringMatching(/표 1→0/) });
    lossy.bytes = exported;
    await expect(prepareHwpSave(exported, exported, "hwpx", { memos: [] })).resolves.toBeInstanceOf(Buffer);
  } finally { withTable.free(); without.free(); }
});
