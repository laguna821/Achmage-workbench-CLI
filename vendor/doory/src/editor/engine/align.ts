/**
 * Align / distribute / tidy math. Pure: takes bounding rects, returns per-id translations
 * so callers can apply them to Fabric objects (and to JSON in tests).
 */
import { type Rect, rectBottom, rectCenterX, rectCenterY, rectRight, unionRect } from './geometry'

export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type DistributeAxis = 'horizontal' | 'vertical'

export interface Item {
  id: string
  rect: Rect
}

export interface Delta {
  dx: number
  dy: number
}

export type Deltas = Map<string, Delta>

/**
 * Aligns every item to `target` along `edge`. With a single item the target is typically the page
 * rect; with several it is the selection bounds.
 */
export function alignItems(items: readonly Item[], edge: AlignEdge, target: Rect): Deltas {
  const out: Deltas = new Map()
  for (const { id, rect } of items) {
    let dx = 0
    let dy = 0
    switch (edge) {
      case 'left':
        dx = target.left - rect.left
        break
      case 'center':
        dx = rectCenterX(target) - rectCenterX(rect)
        break
      case 'right':
        dx = rectRight(target) - rectRight(rect)
        break
      case 'top':
        dy = target.top - rect.top
        break
      case 'middle':
        dy = rectCenterY(target) - rectCenterY(rect)
        break
      case 'bottom':
        dy = rectBottom(target) - rectBottom(rect)
        break
    }
    out.set(id, { dx, dy })
  }
  return out
}

/** Bounds of the selection, used as the alignment target when more than one object is selected. */
export function selectionBounds(items: readonly Item[]): Rect {
  return unionRect(items.map((i) => i.rect))
}

/**
 * Distributes items so the gaps between neighbours along `axis` are equal. The outermost items stay
 * put. Needs at least three items.
 */
export function distributeItems(items: readonly Item[], axis: DistributeAxis): Deltas {
  const out: Deltas = new Map(items.map((i) => [i.id, { dx: 0, dy: 0 }]))
  if (items.length < 3) return out
  const horizontal = axis === 'horizontal'
  const start = (r: Rect): number => (horizontal ? r.left : r.top)
  const size = (r: Rect): number => (horizontal ? r.width : r.height)
  const sorted = [...items].sort((a, b) => start(a.rect) - start(b.rect))
  const first = sorted[0].rect
  const last = sorted[sorted.length - 1].rect
  const span = start(last) + size(last) - start(first)
  const totalSize = sorted.reduce((s, i) => s + size(i.rect), 0)
  const gap = (span - totalSize) / (sorted.length - 1)
  let cursor = start(first) + size(first) + gap
  for (let i = 1; i < sorted.length - 1; i++) {
    const item = sorted[i]
    const delta = cursor - start(item.rect)
    out.set(item.id, horizontal ? { dx: delta, dy: 0 } : { dx: 0, dy: delta })
    cursor += size(item.rect) + gap
  }
  return out
}

/**
 * "Tidy up": evens out the spacing between items on both axes. Items are treated as a row when
 * they are wider-spread than tall, otherwise a column; the average existing gap is used (never
 * below `minGap`) so the layout feels the same, only regular.
 */
export function tidyItems(items: readonly Item[], minGap = 0): Deltas {
  const out: Deltas = new Map(items.map((i) => [i.id, { dx: 0, dy: 0 }]))
  if (items.length < 2) return out
  const bounds = unionRect(items.map((i) => i.rect))
  const axis: DistributeAxis = bounds.width >= bounds.height ? 'horizontal' : 'vertical'
  const horizontal = axis === 'horizontal'
  const start = (r: Rect): number => (horizontal ? r.left : r.top)
  const size = (r: Rect): number => (horizontal ? r.width : r.height)
  const sorted = [...items].sort((a, b) => start(a.rect) - start(b.rect))
  const totalSize = sorted.reduce((s, i) => s + size(i.rect), 0)
  const span = (horizontal ? bounds.width : bounds.height) - totalSize
  const gap = Math.max(minGap, span / (sorted.length - 1))
  let cursor = start(sorted[0].rect)
  for (const item of sorted) {
    const delta = cursor - start(item.rect)
    out.set(item.id, horizontal ? { dx: delta, dy: 0 } : { dx: 0, dy: delta })
    cursor += size(item.rect) + gap
  }
  return out
}
