// Adapted from IeumOffice apps/slides/src/main/pdf-export.ts @ 30ff4f051f067fcb2baf1ab416c40718c802ca35.
// Apache-2.0; see LICENSE and NOTICE. Only pure HTML/geometry helpers retained; Electron I/O removed.
export type ExportPdfLink = { x: number; y: number; w: number; h: number; href: string };
export type ExportPdfPage = { svg: string } | { png: string };
export type ExportPdfOp = { filePath: string; pages: ExportPdfPage[]; widthPx: number; heightPx: number; links?: ExportPdfLink[][]; fontCss?: string };
export type PrintSlidesOp = { pngsBase64: string[]; widthPx: number; heightPx: number; layout?: "full" | "handout2" | "handout3" | "handout6" | "notes"; notes?: string[]; orientation?: "portrait" | "landscape"; frame?: boolean };

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Fraction (0..1) → CSS percentage; NaN/Infinity would corrupt the markup, so reject the rect. */
function pct(v: number): string | null {
  return Number.isFinite(v) ? `${Math.round(v * 100000) / 1000}%` : null
}

/**
 * Transparent <a> boxes over the page: printToPDF converts them to PDF
 * link annotations (URI actions for URLs, in-document destinations for the
 * "#pgN" page anchors — pages carry matching ids), keeping element and text
 * hyperlinks clickable in the exported PDF like a PowerPoint export.
 */
export function buildPdfLinkOverlays(links: ExportPdfLink[] | undefined): string {
  if (!links?.length) return ''
  return links
    .map((l) => {
      const [x, y, w, h] = [pct(l.x), pct(l.y), pct(l.w), pct(l.h)]
      if (x == null || y == null || w == null || h == null || !l.href) return ''
      return `<a href="${escapeAttr(l.href)}" style="left:${x};top:${y};width:${w};height:${h}"></a>`
    })
    .join('')
}

/** A `</style>` inside the font CSS would end the block early; it cannot occur in valid rules. */
function safeCss(css: string | undefined): string {
  return css ? css.replace(/<\/style/gi, '') : ''
}

function pageMarkup(page: ExportPdfPage): string {
  return 'svg' in page ? page.svg : `<img src="data:image/png;base64,${page.png}">`
}

export function buildPdfExportHtml(
  pages: ExportPdfPage[],
  widthIn: number,
  heightIn: number,
  links?: ExportPdfLink[][],
  fontCss?: string,
): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${safeCss(fontCss)}
@page { size: ${widthIn}in ${heightIn}in; margin: 0; }
html, body { margin: 0; padding: 0; }
.page { position: relative; width: ${widthIn}in; height: ${heightIn}in; overflow: hidden; page-break-after: always; }
.page:last-child { page-break-after: auto; }
.page img, .page > svg { display: block; width: 100%; height: 100%; }
.page a { position: absolute; display: block; }
</style></head><body>${pages
    .map(
      (page, i) =>
        `<div class="page" id="pg${i + 1}">${pageMarkup(page)}${buildPdfLinkOverlays(links?.[i])}</div>`,
    )
    .join('')}</body></html>`
}

export const PDF_EXPORT_HEIGHT_IN = 7.5

export function exportPageWidthIn(widthPx: number, heightPx: number): number {
  const ratio =
    Number.isFinite(widthPx) && Number.isFinite(heightPx) && heightPx > 0
      ? widthPx / heightPx
      : 16 / 9
  const safe = Number.isFinite(ratio) && ratio > 0 ? Math.min(Math.max(ratio, 0.2), 5) : 16 / 9
  return Math.round(safe * PDF_EXPORT_HEIGHT_IN * 1000) / 1000
}
