import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Api } from "./api.ts";

// PDF pages drawn as images outside the PDF view (home "문서" thumbnails, "읽기"). PDF.js loads
// only when a PDF is first drawn this way; revisions never change, so documents are kept.

let library: Promise<typeof import("pdfjs-dist")> | null = null;
const documents = new Map<string, Promise<PDFDocumentProxy>>();

function pdfjs() {
  library ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([module, worker]) => {
    module.GlobalWorkerOptions.workerSrc = worker.default;
    return module;
  });
  return library;
}

export function pdfDocument(api: Api, artifactId: string, revision: number): Promise<PDFDocumentProxy> {
  const key = `${artifactId}@${revision}`;
  let loaded = documents.get(key);
  if (!loaded) {
    loaded = Promise.all([pdfjs(), api.raw(artifactId, revision)]).then(([module, data]) => module.getDocument({ data: new Uint8Array(data) }).promise);
    loaded.catch(() => documents.delete(key));
    documents.set(key, loaded);
    // A few open documents are enough; older ones are let go.
    if (documents.size > 6) {
      const oldest = documents.keys().next().value!;
      void documents.get(oldest)?.then((pdf) => pdf.loadingTask.destroy()).catch(() => undefined);
      documents.delete(oldest);
    }
  }
  return loaded;
}

/** One page as a PNG data URL, `width` CSS pixels wide (sharp on high-density screens). */
export async function pdfPageImage(pdf: PDFDocumentProxy, number: number, width: number): Promise<string> {
  const page = await pdf.getPage(number);
  const base = page.getViewport({ scale: 1 });
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const viewport = page.getViewport({ scale: (width / base.width) * ratio });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return canvas.toDataURL("image/png");
}
