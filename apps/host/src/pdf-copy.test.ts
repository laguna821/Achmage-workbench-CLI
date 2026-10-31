import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { copyPdf, editPdf, queryPdf } from "./pdf-ops.mjs";
const require = createRequire(new URL("../../../vendor/ieumoffice/package.json", import.meta.url));
const { PDFDocument, PDFArray, PDFName, PDFString } = require("pdf-lib");
const { PNG } = require("pngjs");

async function fixture() {
  const doc = await PDFDocument.create(), page = doc.addPage([400, 600]);
  page.drawText("SECRET COPY TEXT", { x: 30, y: 550, size: 18 });
  page.drawText("Public content stays", { x: 30, y: 500, size: 18 });
  page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(doc.context.obj({
    Type: "Annot", Subtype: "Link", Rect: [20, 20, 100, 40], Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of("https://example.com") },
  }))]));
  return (await editPdf(Buffer.from(await doc.save()), {
    drawings: [{ kind: "note", pageIndex: 0, color: [1, 1, 0], at: [60, 400], contents: "Keep the original note", author: "GenOffice" }],
    markups: [{ type: "highlight", pageIndex: 0, color: [1, 1, 0], quads: [[40, 220, 140, 220, 40, 200, 140, 200]] }],
    formFields: [{ kind: "text", name: "Reader", pageIndex: 0, rect: [30, 300, 180, 325], value: "Ada" }],
  })).bytes;
}
const subtypes = (doc: any) => (doc.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? []).map((ref: any) => doc.context.lookup(ref).get(PDFName.of("Subtype")).toString());
const text = async (bytes: Buffer) => (await queryPdf(bytes, "text", {}) as { pages: { text: string }[] }).pages.map((p) => p.text).join("\n");
async function pixel(bytes: Buffer, clip = { x: 40, y: 380, width: 100, height: 20 }) {
  const result = await queryPdf(bytes, "preview-png", { pageIndex: 0, excludeRects: [], clip, pxWidth: 100, rotate: 0 }) as { png: string };
  const png = PNG.sync.read(Buffer.from(result.png, "base64"));
  const offset = (Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4;
  return [...png.data.subarray(offset, offset + 4)];
}
describe("original PDF copy renderer", () => {
  it("preserves clean bytes and keeps pending edits, note authors, links and form values", async () => {
    const source = await fixture();
    expect((await copyPdf(source, { copyOnly: true })).bytes).toEqual(source);
    const kept = await copyPdf(source, { textInserts: [{ pageIndex: 0, origin: [30, 450], text: "Unsaved copy", fontSize: 16, color: [0, 0, 0] }] });
    expect(await text(kept.bytes)).toContain("Unsaved copy");
    const doc = await PDFDocument.load(kept.bytes);
    expect(subtypes(doc)).toEqual(expect.arrayContaining(["/Text", "/Highlight", "/Link", "/Widget"]));
    expect(doc.getForm().getTextField("Reader").getText()).toBe("Ada");
    const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray).asArray().map((ref: any) => doc.context.lookup(ref));
    expect(annots.find((a: any) => a.get(PDFName.of("Subtype")).toString() === "/Text").lookup(PDFName.of("T")).decodeText()).toBe("GenOffice");
    expect(await text(source)).not.toContain("Unsaved copy");
  });
  it("strips only comments and flattens their visible appearance into actual page content", async () => {
    const source = await fixture(), before = Buffer.from(source);
    const stripped = await copyPdf(source, { annotations: "strip" }), flat = await copyPdf(source, { annotations: "flatten" });
    const doc = await PDFDocument.load(stripped.bytes);
    expect(subtypes(doc).sort()).toEqual(["/Link", "/Widget"]);
    expect(doc.getForm().getTextField("Reader").getText()).toBe("Ada");
    expect(subtypes(await PDFDocument.load(flat.bytes))).not.toContain("/Highlight");
    expect(subtypes(await PDFDocument.load(flat.bytes))).not.toContain("/Text");
    expect(await pixel(stripped.bytes)).toEqual([255, 255, 255, 255]);
    expect(await pixel(flat.bytes)).toEqual([255, 255, 0, 255]);
    expect(await text(flat.bytes)).toContain("Public content stays"); expect(source).toEqual(before);
  });
  it("permanently removes selected text only in the explicit redaction copy and rejects mixed edits", async () => {
    const source = await fixture(), before = Buffer.from(source), redactions = [{ pageIndex: 0, rect: [25, 540, 250, 580] }];
    const result = await copyPdf(source, { redactions }, true);
    expect(await text(result.bytes)).not.toContain("SECRET"); expect(await text(result.bytes)).toContain("Public content stays");
    expect(await pixel(result.bytes, { x: 30, y: 25, width: 100, height: 25 })).toEqual([0, 0, 0, 255]);
    expect(source).toEqual(before); expect(await text(source)).toContain("SECRET COPY TEXT");
    await expect(copyPdf(source, { redactions })).rejects.toThrow("별도 사본");
    await expect(editPdf(source, { redactions })).rejects.toThrow("별도 사본");
    for (const extra of [{ annotations: "strip" }, { copyOnly: true }, { formFields: [{ kind: "text", pageIndex: 0 }] }, { metadata: {} }]) await expect(copyPdf(source, { redactions, ...extra }, true)).rejects.toThrow();
    for (const regions of [[], [{ pageIndex: 2, rect: [0, 0, 1, 1] }], [{ pageIndex: 0, rect: [0, 0, 0, 1] }], Array(501).fill(redactions[0])]) await expect(copyPdf(source, { redactions: regions }, true)).rejects.toThrow();
  });
  it("rejects arbitrary output paths, invalid options and edits on encryption-marked files", async () => {
    const source = await fixture();
    for (const request of [{ targetPath: "/tmp/unauthorized.pdf" }, { annotations: "delete" }, { copyOnly: "yes" }, { copyOnly: true, rotations: [{ pageIndex: 0, delta: 90 }] }]) await expect(copyPdf(source, request)).rejects.toThrow();
    // This exercises the encryption gate, not password/decryption support.
    const doc = await PDFDocument.load(source); doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: "Standard", V: 1, R: 2, Length: 40, O: PDFString.of("0".repeat(32)), U: PDFString.of("0".repeat(32)), P: -4 }));
    const encrypted = Buffer.from(await doc.save({ useObjectStreams: false }));
    expect((await copyPdf(encrypted, { copyOnly: true })).bytes).toEqual(encrypted);
    await expect(copyPdf(encrypted, { annotations: "strip" })).rejects.toThrow("암호화");
  });
  it("generates missing external annotation appearances before flattening, and refuses unsupported visible annotations", async () => {
    const doc = await PDFDocument.create(), page = doc.addPage([400, 600]);
    page.drawText("Still searchable", { x: 20, y: 500, size: 18 });
    const annotations = [
      doc.context.obj({ Type: "Annot", Subtype: "Highlight", Rect: [40, 200, 140, 220], QuadPoints: [40, 220, 140, 220, 40, 200, 140, 200], C: [1, 1, 0] }),
      doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [40, 300, 60, 320], Contents: PDFString.of("External note"), C: [1, 1, 0] }),
    ];
    page.node.set(PDFName.of("Annots"), doc.context.obj(annotations.map((annot) => doc.context.register(annot))));
    const source = Buffer.from(await doc.save({ useObjectStreams: false }));
    const flat = await copyPdf(source, { annotations: "flatten" });
    expect(await pixel(flat.bytes)).toEqual([255, 255, 0, 255]);
    expect(await text(flat.bytes)).toContain("Still searchable");
    expect(subtypes(await PDFDocument.load(flat.bytes))).toEqual([]);
    expect(annotations.every((annot) => !annot.has(PDFName.of("AP")))).toBe(true);
    page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "RichMedia", Rect: [40, 200, 140, 220] }))]));
    const unsupported = Buffer.from(await doc.save());
    await expect(copyPdf(unsupported, { annotations: "flatten" })).rejects.toMatchObject({ code: "pdf_flatten_unsupported" });
    expect((await copyPdf(unsupported, { copyOnly: true })).bytes).toEqual(unsupported);
  });
});
