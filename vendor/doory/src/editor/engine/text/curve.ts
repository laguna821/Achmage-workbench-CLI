/**
 * Curved-text geometry. The model is the signed `curveAmount`: negative bends the baseline up
 * (an arch), positive bends it down (a valley), the magnitude is the arc angle. The arc length
 * always equals the text width, so the bend feels identical for short and long strings and the
 * glyphs keep their size.
 */

/** Slider range: ±CURVE_MAX maps to a half circle. */
export const CURVE_MAX = 400
const CURVE_THETA_MAX = Math.PI
/** The arc is slightly longer than the text so first/last glyphs never wrap past the path ends. */
const CURVE_ARC_MARGIN = 1.03
export const CURVE_DEFAULT_AMOUNT = 200

export interface CurveGeometry {
  radius: number
  /** Arc angle in radians (0..π). */
  theta: number
  /** SVG path data of the arc, starting at the left end. */
  path: string
  /** Width of the chord (what the text box should be). */
  chord: number
  /** Height of the arc (apex to chord). */
  sagitta: number
}

export function clampCurve(amount: number): number {
  return Math.max(-CURVE_MAX, Math.min(CURVE_MAX, amount))
}

/** Builds the arc a text of `textWidth` px rides for the given signed amount. `amount === 0` yields a straight path. */
export function curveGeometry(textWidth: number, amount: number): CurveGeometry {
  const width = Math.max(1, textWidth)
  const amt = clampCurve(amount)
  if (amt === 0) {
    return { radius: Infinity, theta: 0, path: `M 0,0 L ${width},0`, chord: width, sagitta: 0 }
  }
  const theta = Math.max((Math.abs(amt) / CURVE_MAX) * CURVE_THETA_MAX, 1e-4)
  const radius = (width * CURVE_ARC_MARGIN) / theta
  const half = theta / 2
  const dx = radius * Math.sin(half)
  const dy = radius * (1 - Math.cos(half))
  const up = amt < 0
  const yEnd = up ? -dy : dy
  const sweep = up ? 1 : 0
  const r = round(radius)
  const path = `M ${round(radius - dx)},${round(yEnd)} A ${r},${r} 0 0,${sweep} ${round(radius + dx)},${round(yEnd)}`
  return { radius, theta, path, chord: 2 * dx, sagitta: dy }
}

const round = (n: number): number => Math.round(n * 1000) / 1000
