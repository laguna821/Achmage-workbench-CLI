import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from '../../../vendor/ieumoffice/node_modules/pdf-lib/cjs/index.js';
import { chainPdfium, loadPdfium, saveDoc, withDocument } from '../../../vendor/ieumoffice/apps/pdf/src/main/text-edit.ts';
import { flattenAnnotsBytes } from '../../../vendor/ieumoffice/apps/pdf/src/main/annot-flatten.ts';
import { HttpError } from './errors.ts';

/** PDFium's flatten skips annotations without /AP, even when a viewer draws
 * them from their geometry. Rendering constructs CPDF_Annot and generates the
 * missing appearances. Only their vector streams are saved, never this bitmap. */
async function missingAppearances(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false }), missing = [];
  for (const [pageIndex, page] of doc.getPages().entries()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    for (const ref of annots?.asArray() ?? []) {
      const annot = doc.context.lookup(ref, PDFDict), type = annot.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
      const flags = doc.context.lookup(annot.get(PDFName.of('F')))?.asNumber?.() ?? 0;
      if (flags & (1 | 2 | 32) || type === 'Popup') continue; // Invisible, Hidden, NoView.
      // Borderless links have no normal visible appearance to bake. Their
      // interaction is intentionally lost by flatten, as in the original app.
      if (type === 'Link') {
        const border = annot.lookupMaybe(PDFName.of('Border'), PDFArray), style = annot.lookupMaybe(PDFName.of('BS'), PDFDict);
        const width = doc.context.lookup(style?.get(PDFName.of('W')) ?? border?.get(2))?.asNumber?.() ?? 1;
        if (width === 0) continue;
      }
      const ap = annot.lookupMaybe(PDFName.of('AP'), PDFDict);
      let normal = doc.context.lookup(ap?.get(PDFName.of('N')));
      if (normal instanceof PDFDict) {
        const state = annot.get(PDFName.of('AS')) ?? annot.get(PDFName.of('V')) ?? annot.lookupMaybe(PDFName.of('Parent'), PDFDict)?.get(PDFName.of('V'));
        normal = doc.context.lookup(normal.get(state instanceof PDFName ? state : PDFName.of('Off')));
      }
      if (!(normal instanceof PDFStream)) missing.push({ pageIndex, type: type ?? 'Unknown' });
    }
  }
  return missing;
}

export async function flattenPdfCopy(bytes) {
  const missing = await missingAppearances(bytes);
  if (missing.length) {
    bytes = await chainPdfium(async () => {
      const m = await loadPdfium();
      return withDocument(m, bytes, async (doc) => {
        const buffer = m._malloc(4), bitmap = m._FPDFBitmap_CreateEx(1, 1, 4 /* BGRA */, buffer, 4);
        try {
          if (!bitmap) throw new Error('Could not prepare PDF annotation appearances');
          for (const pageIndex of new Set(missing.map((item) => item.pageIndex))) {
            const page = m._FPDF_LoadPage(doc, pageIndex);
            if (!page) throw new Error(`Could not load PDF page ${pageIndex + 1}`);
            try { m._FPDF_RenderPageBitmap(bitmap, page, 0, 0, 1, 1, 0, 1 /* FPDF_ANNOT */); }
            finally { m._FPDF_ClosePage(page); }
          }
          return saveDoc(m, doc);
        } finally { if (bitmap) m._FPDFBitmap_Destroy(bitmap); m._free(buffer); }
      });
    });
    const unresolved = await missingAppearances(bytes);
    if (unresolved.length) {
      const first = unresolved[0];
      throw new HttpError(422, 'pdf_flatten_unsupported', `${first.pageIndex + 1}페이지 ${first.type} 주석의 표시를 보존하지 못해 평탄화하지 않았습니다. 주석 유지로 사본을 저장해 주세요.`);
    }
  }
  return flattenAnnotsBytes(bytes);
}
