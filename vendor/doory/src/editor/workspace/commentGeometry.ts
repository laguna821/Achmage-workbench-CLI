/**
 * The maths of comment pins that is not about finding a page on the screen (that is `editor.view.pageRect`,
 * `clientToPage`, `pageToClient` and `pageAt`, which read the artboard's rectangle every time, so zoom, scroll, the layout
 * of the page stack and the size of each page never have to be tracked): keeping a point on its page, whole device pixels,
 * where a card goes next to its pin, and how pins that sit on top of each other are fanned out. Pure functions on plain
 * numbers, tested without a browser.
 */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** Edge of a pin in CSS px. */
export const PIN_SIZE = 28

/** Keeps a point on its page. Anything else (NaN included) lands on the page's top-left corner. */
export function clampToPage(size: Size, point: Point): Point {
  const clamp = (value: number, max: number): number => (Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 0)
  return { x: clamp(point.x, size.width), y: clamp(point.y, size.height) }
}

/** Rounds a CSS length to a whole device pixel, so a pin's edges and the number in it stay sharp on HiDPI screens. */
export function snapToDevice(css: number, devicePixelRatio: number): number {
  const ratio = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1
  return Math.round(css * ratio) / ratio
}

export type CardSide = 'right' | 'left' | 'below' | 'above'

export interface CardPlacement {
  left: number
  top: number
  side: CardSide
}

/**
 * Where a card goes next to its pin: to the right if there is room, else to the left, else below, else above, and
 * always inside `bounds` (the part of the screen the card may use). When no side has room the card sits below and is
 * pushed inside the bounds.
 */
export function placeCard(anchor: Box, card: Size, bounds: Box, gap = 10, margin = 8): CardPlacement {
  const minX = bounds.left + margin
  const maxX = bounds.left + bounds.width - margin - card.width
  const minY = bounds.top + margin
  const maxY = bounds.top + bounds.height - margin - card.height
  const clampX = (x: number): number => Math.max(minX, Math.min(x, Math.max(minX, maxX)))
  const clampY = (y: number): number => Math.max(minY, Math.min(y, Math.max(minY, maxY)))
  const alongY = clampY(anchor.top + anchor.height / 2 - 28)
  const alongX = clampX(anchor.left + anchor.width / 2 - card.width / 2)

  const right = anchor.left + anchor.width + gap
  if (right <= maxX) return { left: clampX(right), top: alongY, side: 'right' }
  const left = anchor.left - gap - card.width
  if (left >= minX) return { left: clampX(left), top: alongY, side: 'left' }
  const below = anchor.top + anchor.height + gap
  if (below <= maxY) return { left: alongX, top: clampY(below), side: 'below' }
  const above = anchor.top - gap - card.height
  if (above >= minY) return { left: alongX, top: clampY(above), side: 'above' }
  return { left: alongX, top: clampY(below), side: 'below' }
}

/** True when the centre of `anchor` is inside `bounds`: a pin that was scrolled out of view takes its card with it. */
export function isAnchorVisible(anchor: Box, bounds: Box): boolean {
  const x = anchor.left + anchor.width / 2
  const y = anchor.top + anchor.height / 2
  return x >= bounds.left && x <= bounds.left + bounds.width && y >= bounds.top && y <= bounds.top + bounds.height
}

/** True when `inner` lies inside `outer` with at least `margin` to spare on every side: nothing needs to be scrolled to see it. */
export function isComfortablyInside(inner: Box, outer: Box, margin: number): boolean {
  return inner.left >= outer.left + margin && inner.top >= outer.top + margin && inner.left + inner.width <= outer.left + outer.width - margin && inner.top + inner.height <= outer.top + outer.height - margin
}

export interface PinSpot {
  id: string
  /** Page px. */
  x: number
  y: number
}

export interface PinOffset {
  dx: number
  dy: number
}

/** Offsets (in CSS px, tried in this order) a pin may be moved by to get out of the way of the ones already placed. */
const RINGS = 3
const FAN: readonly PinOffset[] = (() => {
  const offsets: PinOffset[] = [{ dx: 0, dy: 0 }]
  for (let ring = 1; ring <= RINGS; ring += 1) {
    const count = 6 * ring
    const radius = ring * PIN_SIZE
    for (let k = 0; k < count; k += 1) {
      const angle = -Math.PI / 4 + (k / count) * Math.PI * 2
      offsets.push({ dx: Math.round(Math.cos(angle) * radius), dy: Math.round(Math.sin(angle) * radius) })
    }
  }
  return offsets
})()

/**
 * Pins that would cover each other are fanned out around the spot they mark, so every one can be seen and clicked.
 * `pins` come in the order they were made: the oldest keeps its place, later ones move to the nearest free spot (at most
 * three pin-widths away; a crowd bigger than that, which no page has room for, keeps overlapping). `scale` is the CSS px
 * per page px, because what collides is what is drawn: zoom in and the pins part by themselves. Pins that touch nothing
 * are not in the result.
 */
export function layoutPins(pins: readonly PinSpot[], scale: number): Map<string, PinOffset> {
  const result = new Map<string, PinOffset>()
  if (pins.length < 2 || !(scale > 0)) return result
  const cell = PIN_SIZE
  const grid = new Map<string, Point[]>()
  const keyOf = (cx: number, cy: number): string => `${cx},${cy}`
  const collides = (x: number, y: number): boolean => {
    const cx = Math.floor(x / cell)
    const cy = Math.floor(y / cell)
    for (let i = cx - 1; i <= cx + 1; i += 1) {
      for (let j = cy - 1; j <= cy + 1; j += 1) {
        const near = grid.get(keyOf(i, j))
        if (near?.some((q) => Math.abs(q.x - x) < PIN_SIZE - 2 && Math.abs(q.y - y) < PIN_SIZE - 2)) return true
      }
    }
    return false
  }
  const place = (x: number, y: number): void => {
    const key = keyOf(Math.floor(x / cell), Math.floor(y / cell))
    const list = grid.get(key)
    if (list) list.push({ x, y })
    else grid.set(key, [{ x, y }])
  }
  for (const pin of pins) {
    const bx = pin.x * scale
    const by = pin.y * scale
    const free = FAN.find((o) => !collides(bx + o.dx, by + o.dy))
    const chosen = free ?? FAN[0]
    place(bx + chosen.dx, by + chosen.dy)
    if (chosen.dx !== 0 || chosen.dy !== 0) result.set(pin.id, { dx: chosen.dx, dy: chosen.dy })
  }
  return result
}
