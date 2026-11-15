// Review M1 (H4b engine review): engine patch 0020 (Ieum 0020, 0.9.0 form) starts a paragraph that
// anchors a paper-anchored top-and-bottom box BELOW the box only when the paragraph has no visible
// text (Ieum's Hangul 2024 fixture); a paragraph with text keeps the lines Hangul stored inside the
// band (the roadmap sample, 302 pages = Hancom print). "Visible text" must mean a character that is
// not white space and not a control: an anchor holding only spaces looks empty and must be laid out
// as the empty one, not as a text anchor (it was: 18 → 17 lines on page 2).
// The variants are Ieum's own fixture (vendor/ieumoffice/apps/hwp/tests/fixtures, filler text) with
// ONLY the anchor paragraph's empty run changed; nothing else is touched.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/engine.ts";
import { hwpWasmPath } from "./hwp-resource.ts";

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });

const FIXTURE = resolve("vendor/ieumoffice/apps/hwp/tests/fixtures/paper-topbottom-box-stale-ladder.hwpx");
/** The anchor paragraph (the second one: the paper-anchored TOP_AND_BOTTOM rectangle) ends its run with an empty text. */
async function withAnchorText(text: string | null): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(readFileSync(FIXTURE));
  const xml = await zip.file("Contents/section0.xml")!.async("string");
  const anchor = xml.indexOf('textWrap="TOP_AND_BOTTOM"');
  const empty = xml.indexOf("</hp:rect><hp:t/></hp:run>", anchor) + "</hp:rect>".length;
  expect(anchor).toBeGreaterThan(0);
  expect(xml.indexOf('textWrap="TOP_AND_BOTTOM"', anchor + 1)).toBe(-1);
  // the empty text right after the rectangle, in the anchor paragraph's own run
  expect(empty).toBeGreaterThan(anchor);
  if (text === null) return new Uint8Array(readFileSync(FIXTURE));
  zip.file("Contents/section0.xml", `${xml.slice(0, empty)}<hp:t>${text}</hp:t></hp:run>${xml.slice(empty + "<hp:t/></hp:run>".length)}`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: "application/hwp+zip" });
}

type Node = { type?: string; pi?: number; bbox?: { x: number; y: number; w: number; h: number }; children?: Node[] };
/** Text lines of the body paragraphs after the anchor (pi ≥ 2) on `page`, and the top of the title line (pi 2). */
function lines(doc: HwpDocument, page: number): { count: number; title: number | null; anchor: number | null } {
  let count = 0, title: number | null = null, anchor: number | null = null;
  const walk = (node: Node) => {
    if (node.type === "TextLine" && typeof node.pi === "number" && node.pi < 1_000_000_000) {
      if (node.pi >= 2) count += 1;
      if (node.pi === 2 && title === null) title = Math.round(node.bbox!.y);
      if (node.pi === 1 && anchor === null) anchor = Math.round(node.bbox!.y);
    }
    if (node.type !== "Table") for (const child of node.children ?? []) walk(child);
  };
  walk(JSON.parse(doc.getPageRenderTree(page)) as Node);
  return { count, title, anchor };
}
/** Pages, lines after the anchor on pages 1 and 2, where the title line starts (the anchor's own line, drawn only when it holds characters, is left out). */
async function layout(text: string | null) {
  const doc = new HwpDocument(await withAnchorText(text));
  try {
    const first = lines(doc, 0), second = lines(doc, 1);
    return { pages: doc.pageCount(), first: first.count, second: second.count, title: first.title };
  } finally { doc.free(); }
}
/** The box's bottom on page 1 and the anchor's own drawn line (null: none drawn). */
async function anchorLine(text: string) {
  const doc = new HwpDocument(await withAnchorText(text));
  try {
    const root = JSON.parse(doc.getPageRenderTree(0)) as Node;
    const body = (root.children ?? []).find((child) => child.type === "Body")!.bbox!;
    const box = (root.children ?? []).find((child) => child.type === "Rect" && child.bbox!.w > body.w / 2)!.bbox!;
    return { boxBottom: Math.round(box.y + box.h), anchor: lines(doc, 0).anchor };
  } finally { doc.free(); }
}

describe("M1: an anchor paragraph that only LOOKS empty is laid out as the empty one", () => {
  it("the empty anchor (Ieum's fixture): Hangul 2024's layout, the last 18 filler lines on page 2", async () => {
    expect((await layout(null)).second).toBe(18);
  });

  for (const [name, text] of [["three spaces", "   "], ["a tab", "\t"], ["an ideographic space and a no-break space", "　 "]] as const) {
    it(`an anchor holding only ${name} starts below its box, as the empty one does`, async () => {
      expect(await layout(text)).toEqual(await layout(null));
      const { boxBottom, anchor } = await anchorLine(text);
      // its own (invisible) line, where drawn, sits below the box, not inside its band
      if (anchor !== null) expect(anchor).toBeGreaterThanOrEqual(boxBottom - 1);
    });
  }

  it("an anchor with real text keeps the lines Hangul stored in the band (the roadmap rule): one line more on page 1", async () => {
    const empty = await layout(null), text = await layout("가나다라마");
    expect(text.pages).toBe(2);
    expect(text.second).toBe(empty.second - 1);
    // the text anchor's line keeps Hangul's stored place, above the box
    const { boxBottom, anchor } = await anchorLine("가나다라마");
    expect(anchor).not.toBeNull();
    expect(anchor!).toBeLessThan(boxBottom);
  });
});
