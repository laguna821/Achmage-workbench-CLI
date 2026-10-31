import { PDFDocument } from "../../../vendor/ieumoffice/node_modules/pdf-lib";
import { cancelOutput, commitOutput, prepareOutput, renderHtmlPdf } from "./output.ts";
import { preparePrintHtml } from "./print-html.ts";
import { templateFaces } from "./slides/template-fonts.ts";

/** The original spreadsheet renderer has already paginated the workbook and
 * placed its headers, footers, pictures and scaled cells in paper-sized boxes.
 * Only replace Electron's printing of those boxes; preserve mixed paper sizes. */
export async function exportSheetsPdf(request: { html: string }, revision: number) {
  const plan = await prepareOutput(revision, "pdf");
  if (!plan) return { canceled: true };
  try {
    const document = new DOMParser().parseFromString(request.html, "text/html");
    const fonts = document.createElement("style");
    fonts.textContent = templateFaces.filter(face => request.html.includes(face.family)).map(face =>
      `@font-face{font-family:${JSON.stringify(face.family)};font-weight:${face.weight};src:url(${JSON.stringify(face.url)})}`,
    ).join("\n");
    document.head.append(fonts);
    const pages = [...document.querySelectorAll<HTMLElement>("body > .page")];
    if (!pages.length) throw new Error("원본 Excel 편집기에서 출력할 페이지를 만들지 못했습니다.");
    const groups: { from: number; to: number; width: number; height: number }[] = [];
    for (const [index, page] of pages.entries()) {
      const inch = (value: string) => /^\d+(?:\.\d+)?in$/.test(value) ? Number.parseFloat(value) : 0;
      const width = inch(page.style.width), height = inch(page.style.height);
      if (!(width > 0 && height > 0 && width <= 64 && height <= 64)) throw new Error("출력 페이지의 용지 크기를 확인해 주세요.");
      const last = groups.at(-1);
      if (last && last.width === width && last.height === height && index - last.from < 10) last.to = index;
      else groups.push({ from: index, to: index, width, height });
    }
    const merged = await PDFDocument.create();
    for (const group of groups) {
      const part = document.cloneNode(true) as Document;
      [...part.querySelectorAll("body > .page")].forEach((page, index) => { if (index < group.from || index > group.to) page.remove(); });
      const style = part.createElement("style");
      style.textContent = `@page{size:${group.width}in ${group.height}in;margin:0} .page{height:calc(${group.height}in - 2px)!important}`;
      part.head.append(style);
      const job = await preparePrintHtml(`<!doctype html>${part.documentElement.outerHTML}`, { widthIn: group.width, heightIn: group.height, margin: 0 });
      const pdf = await PDFDocument.load(await renderHtmlPdf(revision, job));
      if (pdf.getPageCount() !== group.to - group.from + 1) throw new Error("Excel 출력의 쪽 수가 원본 인쇄 미리보기와 다릅니다.");
      for (const page of await merged.copyPages(pdf, pdf.getPageIndices())) merged.addPage(page);
    }
    const result = await commitOutput(plan.id, Uint8Array.from(await merged.save()).buffer);
    return { canceled: false, path: result.path };
  } catch (error) { await cancelOutput(plan.id); throw error; }
}
