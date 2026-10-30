import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { editPdf, inspectPdf, queryPdf, transformPdf } from "./pdf-ops.mjs";
const require = createRequire(new URL("../../../vendor/ieumoffice/package.json", import.meta.url));
const { PDFDocument, PDFArray, PDFName, PDFString, PDFNumber } = require("pdf-lib");
const { PNG } = require("pngjs");
const jpeg = createRequire(import.meta.url)("jpeg-js");

async function fixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 600]); page.drawText("Original searchable text", { x: 30, y: 550, size: 18 });
  doc.addPage([500, 700]).drawText("Second page", { x: 30, y: 600, size: 16 });
  doc.setTitle("Preserve metadata");
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
describe("original PDF engine on Node", () => {
  it("preserves a no-op byte for byte and writes original annotations/author/forms/page order", async () => {
    const source = await fixture();
    expect((await editPdf(source, {})).bytes).toEqual(source);
    const first = await editPdf(source, {
      drawings: [{ kind: "note", pageIndex: 0, color: [1, 1, 0], at: [60, 500], contents: "Keep this author", author: "GenOffice" }],
      markups: [{ type: "highlight", pageIndex: 0, color: [1, 1, 0], quads: [[30, 570, 150, 570, 30, 545, 150, 545]], subject: "Verified subject" }],
      formFields: [{ kind: "text", name: "Reader", pageIndex: 0, rect: [30, 400, 180, 425], value: "Ada" }],
      rotations: [{ pageIndex: 1, delta: 90 }], pageOrder: [1, 0],
    });
    const loaded = await PDFDocument.load(first.bytes);
    expect(loaded.getTitle()).toBe("Preserve metadata");
    expect(loaded.getPages().map((p: any) => p.getRotation().angle)).toEqual([90, 0]);
    expect(loaded.getForm().getTextField("Reader").getText()).toBe("Ada");
    const annots = loaded.getPage(1).node.lookup(PDFName.of("Annots"), PDFArray);
    const notes = annots.asArray().map((ref: any) => loaded.context.lookup(ref)).filter((a: any) => a.get(PDFName.of("Subtype"))?.toString() === "/Text");
    expect(notes[0].lookup(PDFName.of("T")).decodeText()).toBe("GenOffice");
    expect(await queryPdf(first.bytes, "subjects", {})).toEqual([expect.objectContaining({ pageIndex: 1, subj: "Verified subject" })]);
    const deleted = await editPdf(first.bytes, { deletedPages: [0], pageOrder: [1] });
    expect((await inspectPdf(deleted.bytes)).pages).toBe(1);
  });

  it("inserts real searchable text, validates replacement, embeds a translucent image and renders through PDFium", async () => {
    const source = await fixture();
    const png = PNG.sync.write({ width: 2, height: 1, data: Buffer.from([255, 0, 0, 128, 0, 0, 255, 255]) });
    const result = await editPdf(source, {
      textInserts: [{ pageIndex: 0, origin: [30, 320], text: "Workbench native text", fontSize: 18, color: [0, 0, 0] }],
      imageEdits: [{ kind: "insertImage", pageIndex: 0, rect: [30, 200, 130, 250], image: png.toString("base64"), layer: "aboveText" }],
    });
    expect(result.skippedTextInserts).toEqual([]); expect(result.skippedImageEdits).toEqual([]);
    const read = await queryPdf(result.bytes, "text", {}) as { pages: { text: string }[] };
    expect(read.pages[0]!.text).toContain("Workbench native text");
    expect(read.pages[0]!.text).toContain("Original searchable text");
    const images = await queryPdf(result.bytes, "images", {}) as { pageIndex: number; rect: number[] }[];
    expect(images).toHaveLength(1);
    const preview = await queryPdf(result.bytes, "preview-png", { pageIndex: 0, excludeRects: [], clip: { x: 30, y: 350, width: 100, height: 50 }, pxWidth: 100, rotate: 0 }) as { png: string };
    const rendered = PNG.sync.read(Buffer.from(preview.png, "base64"));
    const pixel = (x: number, y: number) => Array.from(rendered.data.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 4));
    expect(pixel(10, 25)).toEqual([255, 127, 127, 255]);
    expect(pixel(90, 25)).toEqual([0, 0, 255, 255]);
    expect(await queryPdf(result.bytes, "validate-text", { edits: [{ pageIndex: 0, rect: [25, 310, 270, 345], oldText: "Workbench native text", newText: "Edited", fontSize: 18 }] })).toEqual([expect.objectContaining({ reason: null })]);
  }, 30000);

  it("retains blank-page dimensions, applies crop/resize and blocks destructive or unbounded requests", async () => {
    const source = await fixture();
    const blank = await transformPdf(source, "blank-page", { afterPageIndex: 0 });
    expect((await inspectPdf(blank)).pages).toBe(3);
    const sized = await transformPdf(blank, "page-size", { width: 612, height: 792 });
    const cropped = await transformPdf(sized, "crop", { pages: [0], rect: { l: 0.1, t: 0.1, r: 0.9, b: 0.9 } });
    const doc = await PDFDocument.load(cropped);
    expect(doc.getPage(0).getCropBox().width).toBeCloseTo(489.6);
    await expect(editPdf(source, { targetPath: "/tmp/foreign.pdf" })).rejects.toThrow("별도 저장");
    await expect(editPdf(source, { redactions: [{ pageIndex: 0, rect: [0, 0, 20, 20] }] })).rejects.toThrow("영구 가림");
    await expect(editPdf(source, { deletedPages: [0, 1] })).rejects.toThrow("남은 페이지");
    await expect(editPdf(source, { pageOrder: [0, 0] })).rejects.toThrow("한 번씩");
    await expect(queryPdf(source, "preview-png", { pageIndex: 0, excludeRects: [], clip: { x: 0, y: 0, width: 0.01, height: 14000 }, pxWidth: 4096, rotate: 0 })).rejects.toThrow("크기 한도");
    await expect(inspectPdf(Buffer.from("not a PDF"))).rejects.toThrow();
    const encrypted = await PDFDocument.load(source);
    const dictionary = encrypted.context.obj({ Filter: PDFName.of("Standard"), V: PDFNumber.of(1), R: PDFNumber.of(2), Length: PDFNumber.of(40), O: PDFString.of("0".repeat(32)), U: PDFString.of("0".repeat(32)), P: PDFNumber.of(-4) });
    encrypted.context.trailerInfo.Encrypt = encrypted.context.register(dictionary);
    await expect(editPdf(Buffer.from(await encrypted.save({ useObjectStreams: false })), {})).rejects.toThrow("암호화");
  });

  it("decodes JPEG pixels without Electron and reports unmatched text edits instead of claiming they applied", async () => {
    const source = await fixture();
    const jpegBytes = jpeg.encode({ width: 2, height: 1, data: Buffer.from([255, 0, 0, 255, 255, 0, 0, 255]) }, 100).data;
    const edited = await editPdf(source, { imageEdits: [{ kind: "insertImage", pageIndex: 0, rect: [30, 200, 130, 250], image: jpegBytes.toString("base64"), layer: "aboveText" }] });
    expect(edited.skippedImageEdits).toEqual([]);
    expect(await queryPdf(edited.bytes, "images", {})).toHaveLength(1);
    const unmatched = await editPdf(source, { textEdits: [{ pageIndex: 0, rect: [20, 200, 300, 230], oldText: "Never present", newText: "Must not appear", fontSize: 18 }] });
    expect(unmatched.skippedTextEdits).toHaveLength(1);
    const text = await queryPdf(unmatched.bytes, "text", {}) as { pages: { text: string }[] };
    expect(text.pages[0]!.text).toContain("Original searchable text");
    expect(text.pages[0]!.text).not.toContain("Must not appear");
  });
});
