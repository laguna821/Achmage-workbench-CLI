/** Small pure geometry helpers shared by snapping, alignment and layout code. */

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export const rectRight = (r: Rect): number => r.left + r.width
export const rectBottom = (r: Rect): number => r.top + r.height
export const rectCenterX = (r: Rect): number => r.left + r.width / 2
export const rectCenterY = (r: Rect): number => r.top + r.height / 2

export function unionRect(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { left: 0, top: 0, width: 0, height: 0 }
  let l = Infinity
  let t = Infinity
  let r = -Infinity
  let b = -Infinity
  for (const rect of rects) {
    l = Math.min(l, rect.left)
    t = Math.min(t, rect.top)
    r = Math.max(r, rectRight(rect))
    b = Math.max(b, rectBottom(rect))
  }
  return { left: l, top: t, width: r - l, height: b - t }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left < rectRight(b) && rectRight(a) > b.left && a.top < rectBottom(b) && rectBottom(a) > b.top
}

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

export const round = (n: number, decimals = 2): number => {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

/** Bounding rect of a (possibly rotated) box given by its centre, size and angle in degrees. */
export function rotatedBounds(cx: number, cy: number, w: number, h: number, angleDeg: number): Rect {
  const a = (angleDeg * Math.PI) / 180
  const cos = Math.abs(Math.cos(a))
  const sin = Math.abs(Math.sin(a))
  const bw = w * cos + h * sin
  const bh = w * sin + h * cos
  return { left: cx - bw / 2, top: cy - bh / 2, width: bw, height: bh }
}

/** Normalises an angle to [0, 360). */
export function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/** Largest scale at which `inner` fits inside `outer` (contain) or covers it (cover). */
export function fitScale(inner: { width: number; height: number }, outer: { width: number; height: number }, mode: 'contain' | 'cover'): number {
  if (inner.width <= 0 || inner.height <= 0) return 1
  const sx = outer.width / inner.width
  const sy = outer.height / inner.height
  return mode === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy)
}
