import { PDFDocument } from "../../../vendor/ieumoffice/node_modules/pdf-lib";
import { addPdfInternalLinks, type PdfInternalLink } from "../../../third_party/ieumoffice/pdf-links.ts";
import { preparePrintHtml } from "./print-html.ts";
import { cancelOutput, commitOutput, prepareOutput, renderHtmlPdf } from "./output.ts";
import { stampPdfLinks } from "./pdf-output-links.ts";

const buffer = (bytes: Uint8Array) => Uint8Array.from(bytes).buffer;
function base64(bytes: ArrayBuffer) {
  const data = new Uint8Array(bytes); let text = "";
  for (let i = 0; i < data.length; i += 32768) text += String.fromCharCode(...data.subarray(i, i + 32768));
  return btoa(text);
}

/** Preserve the original live pagination DOM, print CSS and group-selection
 * classes. Canvas bitmaps are the only DOM nodes that do not clone their data. */
async function capture(widthTwips: number, heightTwips: number, scale = 1) {
  const links = [...document.querySelectorAll<HTMLElement>(".pv-page:not(.pv-print-skip)")].map(page => {
    const box = page.getBoundingClientRect();
    if (!box.width || !box.height) return [];
    return [...page.querySelectorAll<HTMLAnchorElement>("a[href]")].flatMap(anchor => {
      const href = anchor.getAttribute("href") ?? "";
      if (!href || href.startsWith("#")) return [];
      return [...anchor.getClientRects()].map(rect => ({ href, x: (rect.x - box.x) / box.width, y: (rect.y - box.y) / box.height, w: rect.width / box.width, h: rect.height / box.height }));
    });
  });
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  const canvases = [...clone.querySelectorAll("canvas")];
  for (const [index, canvas] of [...document.querySelectorAll("canvas")].entries()) {
    if (!canvas.width || !canvas.height) continue;
    const image = document.createElement("img");
    for (const attr of canvas.attributes) image.setAttribute(attr.name, attr.value);
    image.src = canvas.toDataURL(); canvases[index]?.replaceWith(image);
  }
  const job = await preparePrintHtml(`<!doctype html>${clone.outerHTML}`, { widthIn: widthTwips / 1440, heightIn: heightTwips / 1440, margin: 0 });
  return { job: { ...job, scale }, links };
}

export function createDocsOutput(revision: () => number) {
  const render = async (width: number, height: number, scale = 1) => {
    const captured = await capture(width, height, scale);
    return stampPdfLinks(await renderHtmlPdf(revision(), captured.job), captured.links);
  };
  const save = async (bytes: ArrayBuffer, links?: PdfInternalLink[]) => {
    const plan = await prepareOutput(revision(), "pdf");
    if (!plan) return { ok: false };
    try {
      if (links?.length) {
        const pdf = await PDFDocument.load(bytes);
        if (addPdfInternalLinks(pdf, links)) bytes = buffer(await pdf.save());
      }
      return { ok: true, path: (await commitOutput(plan.id, bytes)).path };
    } catch (error) { await cancelOutput(plan.id); return { ok: false, error: String(error) }; }
  };
  return {
    exportHtml: async (_name: string, html: string, _out?: string) => {
      const plan = await prepareOutput(revision(), "html");
      if (!plan) return { ok: false };
      try { return { ok: true, path: (await commitOutput(plan.id, new TextEncoder().encode(html).buffer)).path }; }
      catch (error) { await cancelOutput(plan.id); return { ok: false, error: String(error) }; }
    },
    exportPdf: async (_name: string, width: number, height: number, _out?: string, scale = 1, links?: PdfInternalLink[]) => {
      // Original file-actions responds by opening its own pagination preview
      // and resuming this export. Use those laid-out pages on every WebView;
      // continuous Chromium print fragmentation is not portable to WebKit.
      if (!document.querySelector(".pv-page")) return { ok: false, error: "원본 페이지 미리보기를 준비해야 합니다." };
      try { return await save(await render(width, height, scale), links); }
      catch (error) { return { ok: false, error: String(error) }; }
    },
    printPdfBuffer: async (width: number, height: number, scale = 1) => {
      try { return { ok: true, base64: base64(await render(width, height, scale)) }; }
      catch (error) { return { ok: false, error: String(error) }; }
    },
    saveMergedPdf: async (_name: string, parts: string[], _out?: string, links?: PdfInternalLink[]) => {
      try {
        const merged = await PDFDocument.create();
        for (const part of parts) {
          const pdf = await PDFDocument.load(Uint8Array.from(atob(part), c => c.charCodeAt(0)));
          for (const page of await merged.copyPages(pdf, pdf.getPageIndices())) merged.addPage(page);
        }
        return await save(buffer(await merged.save()), links);
      } catch (error) { return { ok: false, error: String(error) }; }
    },
  };
}
