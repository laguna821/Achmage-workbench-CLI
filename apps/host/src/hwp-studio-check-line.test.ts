import { describe, expect, it } from "vitest";
import { studioReport } from "../../office/src/hwp-structure-report.ts";
import { noReportLine } from "../../../scripts/hwp-studio-harness.ts";

// T3 (m3-5): the office build check's line when the built studio gives no report says what happened —
// the document not reachable (renamed internals) or reachable but its census failing (an engine call).
const frameWith = (doc: unknown) => ({ contentWindow: { rhwpStudio: { automation: { options: { dispatcher: { services: { wasm: { doc } } } } } } } }) as unknown as HTMLIFrameElement;

describe("the studio build check's line when there is no report", () => {
  it("says the studio's document is not reachable when it is not", () => {
    const report = studioReport({ contentWindow: { rhwpStudio: { automation: {} } } } as unknown as HTMLIFrameElement);
    expect("why" in report && noReportLine("/s", report.why)).toMatch(/^the built studio \(\/s\) gives the office page no live document at rhwpStudio\.automation\.options\.dispatcher\.services\.wasm\.doc .*hwp-structure-report\.ts/);
  });

  it("says the document was reached and its census failed, with the error kind, when it was", () => {
    const report = studioReport(frameWith({ getSectionCount: () => { throw new TypeError("doc.getSectionCount is not a function \"비밀\""); } }));
    const line = "why" in report ? noReportLine("/s", report.why) : "";
    expect(line).toMatch(/^the built studio \(\/s\) gives the office page its live document, but counting it failed \(TypeError\)/);
    expect(line).toMatch(/hwp-structure\.ts/);
    expect(line).not.toMatch(/no live document|비밀/);
  });
});
