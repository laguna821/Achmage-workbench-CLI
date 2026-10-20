/**
 * What the contextual strip's number fields accept. The engine stays permissive (`engine/numbers.ts` guards
 * against NaN and absurd values only); these are the ranges the toolbar enforces, which the
 * chrome applies and shows: a value outside is clamped when the field is committed, and the range is the field's
 * tooltip and accessible description.
 */
import { CHAR_SPACING_RANGE } from '../engine/numbers'
import { pxToUnit, unitDecimals } from '../engine/units'
import { t } from '../strings'
import { type DocUnit, MAX_DIMENSION_PX } from '@/types/document'

export interface Limit {
  readonly min: number
  readonly max: number
  readonly step: number
  /** Digits kept after the decimal point. */
  readonly decimals: number
}

export const FONT_SIZE: Limit = { min: 8, max: 200, step: 1, decimals: 0 }
export const LINE_HEIGHT: Limit = { min: 0.5, max: 3, step: 0.1, decimals: 1 }
/** In thousandths of an em, the unit Fabric stores. This is what the engine accepts. */
export const LETTER_SPACING: Limit = { min: CHAR_SPACING_RANGE[0], max: CHAR_SPACING_RANGE[1], step: 10, decimals: 0 }
export const STROKE_WIDTH: Limit = { min: 0, max: 20, step: 1, decimals: 0 }
/** A line has no stroke-less state: at 0 it would vanish. */
export const LINE_WIDTH: Limit = { min: 1, max: 20, step: 1, decimals: 0 }
/** The shape's own half-side caps it further (a larger radius changes nothing): see `capLimit`. */
export const CORNER_RADIUS: Limit = { min: 0, max: 100, step: 1, decimals: 0 }
export const POLYGON_SIDES: Limit = { min: 3, max: 12, step: 1, decimals: 0 }
export const STAR_POINTS: Limit = { min: 3, max: 16, step: 1, decimals: 0 }
/** Percent of the outer radius. */
export const STAR_INNER_RATIO: Limit = { min: 10, max: 90, step: 1, decimals: 0 }

/** `limit` with its maximum lowered to `max` (never below its minimum). */
export function capLimit(limit: Limit, max: number): Limit {
  return { ...limit, max: Math.max(limit.min, Math.min(limit.max, max)) }
}

/** `n` limited to the range and rounded to the limit's digits. */
export function clampTo(limit: Limit, n: number): number {
  return Number(Math.min(limit.max, Math.max(limit.min, n)).toFixed(limit.decimals))
}

export function rangeHint(limit: Limit, unit?: string): string {
  return t.limits.range(limit.min, limit.max, unit)
}

/**
 * Width and height of the canvas, in px. Doory keeps the document
 * format's own bounds because print sizes (an A3 page at 300 dpi is 3508 x 4961 px) and designs created from the
 * dashboard's custom size need them, and a 4000 px cap would mark those designs invalid.
 */
export const CANVAS_SIDE_PX = { min: 1, max: MAX_DIMENSION_PX } as const

/** The canvas side range as it reads in `unit`, rounded inwards so that both ends are values the field accepts. */
export function canvasSideRange(unit: DocUnit): Limit {
  const decimals = unitDecimals(unit)
  const scale = 10 ** decimals
  return {
    min: Math.ceil(pxToUnit(CANVAS_SIDE_PX.min, unit) * scale) / scale,
    max: Math.floor(pxToUnit(CANVAS_SIDE_PX.max, unit) * scale) / scale,
    step: unit === 'px' ? 1 : 0.1,
    decimals,
  }
}
