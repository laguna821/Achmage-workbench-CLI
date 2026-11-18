import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { collectImageReferences, imageDisplaySize, inspectImage, resolveMarkdownImages, rewriteMarkdownForResolvedImages } from "./imageAssets.ts";

// Ported from HanMark tests/imageAssets.test.ts: the reference scanner as it is. The BinData/preview cases
// test hydrateKordocImages, which is not ported (the core's generate embeds and sizes pictures itself).
describe("image assets", () => {
  it("finds Markdown and HTML images outside fenced code and deduplicates sources", () => {
    const complex =
      "01.%20핵심연구(기본연구A)%20신규과제%20연구계획서%20작성%20서식(대표업적%20포함)-image_001.bmp";
    const references = collectImageReferences(`![첫째](a.png)\n<img src="b.jpg" alt="둘째">\n![반복](a.png)\n![공백](<attachments/my photo.png>)\n![가져온 한글 이미지](${complex})\n\n\`\`\`md\n![코드](ignored.png)\n\`\`\``);
    assert.deepEqual(references, [
      { source: "a.png", alt: "첫째", occurrences: 2 },
      { source: "b.jpg", alt: "둘째", occurrences: 1 },
      { source: "attachments/my photo.png", alt: "공백", occurrences: 1 },
      { source: complex, alt: "가져온 한글 이미지", occurrences: 1 }
    ]);
  });

  it("reads PNG/GIF/BMP sizes, caps the display width and refuses what is not a picture", () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000007d0000001f40806000000", "hex");
    assert.deepEqual(inspectImage(png), { mimeType: "image/png", extension: "png", width: 2000, height: 500 });
    assert.equal(imageDisplaySize(2000, 500).widthHu, 42_520);
    assert.throws(() => inspectImage(Buffer.from("not a picture")));
  });

  it("names resolved pictures by order and writes a visible placeholder for a missing one", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000a0000000a0806000000", "hex");
    const markdown = "![가](a.png)\n\n![나](없음.png)\n\n![가 다시](a.png)";
    const resolved = await resolveMarkdownImages(markdown, { loader: async (source) => { if (source !== "a.png") throw new Error("없음"); return { data: png }; } });
    assert.deepEqual(resolved.assets.map((asset) => [asset.source, asset.safeName, asset.occurrences]), [["a.png", "hanmark_image_001.png", 2]]);
    const rewritten = rewriteMarkdownForResolvedImages(markdown, resolved.assets, new Set(resolved.failures.map((failure) => failure.source)));
    assert.equal(rewritten, "![가](hanmark_image_001.png)\n\n[이미지 누락: 나]\n\n![가 다시](hanmark_image_001.png)");
  });
});
