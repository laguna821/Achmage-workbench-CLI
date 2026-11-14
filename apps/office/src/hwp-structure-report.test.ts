import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";
import { hwpStructureOf } from "../../../packages/contracts/src/hwp-structure.ts";
import { studioReport, studioStructure } from "./hwp-structure-report.ts";

beforeAll(async () => { await init({ module_or_path: readFileSync("third_party/hop/rhwp-core/rhwp_bg.wasm") }); });
// The studio frame as the built rhwp-studio exposes it: rhwpStudio.automation → its command
// dispatcher's services → the WasmBridge, whose `doc` is the engine document the editor shows.
const frame = (doc: unknown) => ({ contentWindow: { rhwpStudio: { automation: { options: { dispatcher: { services: { wasm: { doc } } } } } } } }) as unknown as HTMLIFrameElement;

describe("the studio's structure report", () => {
  it("counts the live document the editor holds, after the person's edits", () => {
    const doc = HwpDocument.createEmpty(); doc.createBlankDocument(); doc.insertText(0, 0, 0, "살아 있는 문서");
    try {
      doc.createTable(0, 0, 0, 2, 2);
      const report = studioStructure(frame(doc));
      expect(report).toEqual(hwpStructureOf(doc));
      expect(report!.objects.tbl).toBe(1);
      const table = (JSON.parse(doc.getControls()) as { ctrlId: string; para: number; controlIndex: number }[]).find((control) => control.ctrlId === "tbl")!;
      doc.deleteTableControl(0, table.para, table.controlIndex);
      expect(studioStructure(frame(doc))!.objects.tbl ?? 0).toBe(0);
    } finally { doc.free(); }
  });

  it("reports nothing when the studio does not expose its document (the gateway then compares as before)", () => {
    expect(studioStructure(null)).toBeNull();
    expect(studioStructure({ contentWindow: {} } as unknown as HTMLIFrameElement)).toBeNull();
    expect(studioStructure(frame(null))).toBeNull();
    expect(studioStructure(frame({ getSectionCount: () => { throw new Error("freed"); } }))).toBeNull();
  });

  it("says what happened when the studio's document is there but cannot be counted (not 'not reachable')", () => {
    const report = studioReport(frame({ getSectionCount: () => { throw new TypeError("freed"); } }));
    expect(report).toEqual({ why: "the studio's document could not be counted (TypeError)" });
    expect(studioReport(frame(null))).toEqual({ why: "the studio's document is not reachable" });
  });

  it("reports the structure with the text unchecked when only the text census fails (S1), never the engine's words", () => {
    const doc = HwpDocument.createEmpty(); doc.createBlankDocument(); doc.insertText(0, 0, 0, "본문");
    try {
      doc.insertFootnote(0, 0, 1);
      const broken = new Proxy(doc, { get: (target, name) => name === "getFootnoteInfo" ? () => '{"texts":["비밀' : (target as never)[name] });
      const report = studioReport(frame(broken));
      expect("structure" in report && report.structure.textUnchecked).toBe("글자 검사 못함 (각주·미주: SyntaxError)");
      expect(JSON.stringify(report)).not.toMatch(/비밀/);
    } finally { doc.free(); }
  });
});

