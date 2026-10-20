/**
 * Seamless background patterns as small SVG tiles. A pattern is two colours and a tile size; the page repeats the
 * tile as an image background (`fit: 'tile'`), so it works in every export.
 */

export type PatternId = 'dots' | 'grid' | 'stripes' | 'checks' | 'zigzag' | 'plus'
export const PATTERN_IDS: readonly PatternId[] = ['dots', 'grid', 'stripes', 'checks', 'zigzag', 'plus']

const HEX = /^#[0-9a-f]{6}$/i

/** The tile edge for a page: about 1/18 of the shorter side, within sane limits. */
export function tileSize(pageWidth: number, pageHeight: number): number {
  return Math.min(160, Math.max(16, Math.round(Math.min(pageWidth, pageHeight) / 18)))
}

function shapes(id: PatternId, s: number, fg: string): string {
  const h = s / 2
  const line = Math.max(1, Math.round(s / 14))
  switch (id) {
    case 'dots':
      return `<circle cx="${h}" cy="${h}" r="${Math.max(1.5, s / 9)}" fill="${fg}"/>`
    case 'grid':
      return `<path d="M${s} 0V${s}M0 ${s}H${s}" fill="none" stroke="${fg}" stroke-width="${line}"/>`
    case 'stripes':
      return `<path d="M${-s / 4} ${s / 4}L${s / 4} ${-s / 4}M0 ${s}L${s} 0M${(3 * s) / 4} ${(5 * s) / 4}L${(5 * s) / 4} ${(3 * s) / 4}" fill="none" stroke="${fg}" stroke-width="${line * 2}"/>`
    case 'checks':
      return `<rect width="${h}" height="${h}" fill="${fg}"/><rect x="${h}" y="${h}" width="${h}" height="${h}" fill="${fg}"/>`
    case 'zigzag':
      return `<path d="M0 ${s * 0.7}L${h} ${s * 0.3}L${s} ${s * 0.7}" fill="none" stroke="${fg}" stroke-width="${line * 1.5}" stroke-linejoin="round" stroke-linecap="round"/>`
    case 'plus': {
      const arm = s / 6
      return `<path d="M${h - arm} ${h}H${h + arm}M${h} ${h - arm}V${h + arm}" fill="none" stroke="${fg}" stroke-width="${line * 1.5}" stroke-linecap="round"/>`
    }
  }
}

/** SVG markup of one tile; colours must be `#rrggbb` (anything else falls back to the defaults). */
export function patternSvg(id: PatternId, fg: string, bg: string, size: number): string {
  const s = Math.max(8, Math.round(size))
  const front = HEX.test(fg) ? fg : '#7a64e0'
  const back = HEX.test(bg) ? bg : '#ffffff'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><rect width="${s}" height="${s}" fill="${back}"/>${shapes(id, s, front)}</svg>`
}

/** `data:` URL of a tile, for page backgrounds and swatch previews. */
export function patternUrl(id: PatternId, fg: string, bg: string, size: number): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(patternSvg(id, fg, bg, size))}`
}
