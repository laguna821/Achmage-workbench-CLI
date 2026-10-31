import { PDFArray, PDFDocument, PDFName, PDFString } from "../../../vendor/ieumoffice/node_modules/pdf-lib";
import type { ExportPdfLink } from "../../../third_party/ieumoffice/slides-print.ts";

/** WebKitGTK's PDF backend omits HTML anchor annotations. Use the original
 * renderer's per-page link rectangles so vector and bitmap pages retain links. */
export async function stampPdfLinks(bytes: ArrayBuffer, links: ExportPdfLink[][]): Promise<ArrayBuffer> {
  if (!links.some(page => page.length)) return bytes;
  const pdf = await PDFDocument.load(bytes), pages = pdf.getPages();
  for (const [index, page] of pages.entries()) for (const link of links[index] ?? []) {
    if (![link.x, link.y, link.w, link.h].every(Number.isFinite) || link.w <= 0 || link.h <= 0 || !link.href) continue;
    const target = /^#pg(\d+)$/.exec(link.href), width = page.getWidth(), height = page.getHeight();
    const action = target && pages[Number(target[1]) - 1]
      ? { Dest: [pages[Number(target[1]) - 1]!.ref, "Fit"] }
      : link.href.startsWith("#") ? null : { A: { S: "URI", URI: PDFString.of(link.href) } };
    if (!action) continue;
    const annotation = pdf.context.obj({ Type: "Annot", Subtype: "Link", Border: [0, 0, 0],
      Rect: [Math.max(0, link.x) * width, Math.max(0, 1 - link.y - link.h) * height,
        Math.min(1, link.x + link.w) * width, Math.min(1, 1 - link.y) * height], ...action });
    let annotations = page.node.lookup(PDFName.of("Annots"));
    if (!(annotations instanceof PDFArray)) { annotations = pdf.context.obj([]); page.node.set(PDFName.of("Annots"), annotations); }
    (annotations as PDFArray).push(pdf.context.register(annotation));
  }
  return Uint8Array.from(await pdf.save()).buffer;
}
