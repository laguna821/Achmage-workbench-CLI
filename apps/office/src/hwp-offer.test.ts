// What the Hangul AI offers the model on v0.13.0 (apps/office/hwp-offer-patch.ts): no import_attachment
// (one "한글 문서 만들기"), no analyze_picture, no web_search; everything else of upstream's list stays.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { patchHangulOffer } from "../hwp-offer-patch.ts";
import { IEUM_HWP_DIR } from "../../../scripts/ieum-earlier-source.mjs";

const root = resolve(IEUM_HWP_DIR);
const read = (path: string) => { const id = `${root}/${path}`; return { id, code: readFileSync(id, "utf8") }; };

describe("the Hangul AI's offer", () => {
  it("gives the engine no importer and says no connection looks at pictures", () => {
    const { id, code } = read("apps/hwp/src/renderer/ai/AiPanel.tsx");
    expect(code).toContain("importAttachment: async (name, handOver)");
    const patched = patchHangulOffer(code, id, root);
    expect(patched).not.toContain("importAttachment:");
    expect(patched).not.toContain("importAttachmentAsDocument");
    expect(patched).toContain("pictureAnalysisAvailable: () => false,");
    // the other dependencies stay (read_formatting's reader answers politely in hwp.ts)
    expect(patched).toContain("readAttachmentDocument: async (name) => {");
    expect(patched).toContain("imageGenAvailable: () => imageGenAvailableRef.current,");
  });

  it("takes web_search out of the tool list and its section out of the prompt, nothing else", () => {
    const { id, code } = read("apps/hwp/src/renderer/ai/hwp-skill.ts");
    const patched = patchHangulOffer(code, id, root);
    expect(patched).not.toContain("'## Web search',");
    expect(patched).toContain("offered = offered.filter((tool) => tool.name !== 'web_search')");
    // only the two places changed: every other line is upstream's
    const removed = code.split("\n").filter((line) => !patched.includes(line));
    expect(removed).toHaveLength(3);
    // the new Hangul tools upstream added stay offered (H14)
    for (const tool of ["check_layout", "set_page_setup", "set_columns", "set_page_number", "insert_equations", "insert_title_box", "set_page_border", "set_header_footer", "list_pictures"]) {
      expect(patched).toContain(`name: '${tool}'`);
    }
  });

  it("stops loudly when upstream's text moved", () => {
    const { id } = read("apps/hwp/src/renderer/ai/hwp-skill.ts");
    expect(() => patchHangulOffer("nothing", id, root)).toThrow(/Original Hangul AI offer changed/);
    expect(patchHangulOffer("nothing", `${root}/apps/docs/x.ts`, root)).toBe("nothing");
  });
});
