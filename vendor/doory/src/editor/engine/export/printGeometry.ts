/**
 * Where the trim, the bleed and the crop marks of a printed page lie. The same numbers drive the client-side PDF, the
 * preview in the Download dialog and (as constants) the print server in `apps/exports/layout.py`, so what the dialog
 * draws is what the PDF has.
 *
 * All lengths are CSS px (96 per inch) unless the name says otherwise. A printed page ("sheet") is the trim size plus the
 * bleed on every side plus, with crop marks, a slug that carries the marks:
 *
 *   sheet = slug | bleed | trim | bleed | slug
 */
import type { PageSize } from '../docOps'
import { mmToPx } from '../units'

/** The most bleed a request may ask for (the server refuses more). */
export const MAX_BLEED_MM = 10
/** Gap between the bleed edge and the start of a mark. */
export const MARK_GAP_MM = 1
export const MARK_LENGTH_MM = 5
/** Line width of a mark in px (a hairline, 0.13 mm). */
export const MARK_STROKE_PX = 0.5

export interface PrintGeometry {
  /** Trim size: the finished page. */
  width: number
  height: number
  bleed: number
  slug: number
  /** The sheet that is printed: trim plus bleed plus slug on every side. */
  sheetWidth: number
  sheetHeight: number
  /** The artwork: trim plus bleed on every side. It starts `slug` px from the sheet's edges. */
  artWidth: number
  artHeight: number
}

export type Segment = readonly [x1: number, y1: number, x2: number, y2: number]

export function printGeometry(size: PageSize, bleedMm: number, cropMarks: boolean): PrintGeometry {
  const bleed = mmToPx(Math.max(0, bleedMm))
  const slug = cropMarks ? mmToPx(MARK_GAP_MM + MARK_LENGTH_MM) : 0
  const margin = bleed + slug
  return {
    width: size.width,
    height: size.height,
    bleed,
    slug,
    sheetWidth: size.width + 2 * margin,
    sheetHeight: size.height + 2 * margin,
    artWidth: size.width + 2 * bleed,
    artHeight: size.height + 2 * bleed,
  }
}

/**
 * The eight hairlines that mark the trim corners, in sheet coordinates; nothing crosses the artwork. `gap` and `length`
 * are the real ones (1 mm and 5 mm) unless a schematic draws them in its own units.
 */
export function cropMarkSegments(g: PrintGeometry, gap = mmToPx(MARK_GAP_MM), length = mmToPx(MARK_LENGTH_MM)): Segment[] {
  if (g.slug <= 0) return []
  const inner = g.bleed + gap
  const outer = inner + length
  const margin = g.bleed + g.slug
  const segments: Segment[] = []
  for (const [cx, sx] of [[margin, -1], [margin + g.width, 1]] as const) {
    for (const [cy, sy] of [[margin, -1], [margin + g.height, 1]] as const) {
      segments.push([cx + sx * inner, cy, cx + sx * outer, cy])
      segments.push([cx, cy + sy * inner, cx, cy + sy * outer])
    }
  }
  return segments
}
