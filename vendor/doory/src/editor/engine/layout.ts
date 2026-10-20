/**
 * Vertical page-stack layout. Pure functions so virtualisation and scroll-to-page can be unit tested.
 */
export interface PageBox {
  id: string
  width: number
  height: number
}

export interface PageSlot {
  id: string
  /** Top of the page's chrome header, in scroll-content px. */
  top: number
  /** Top of the artboard itself (below the header). */
  artboardTop: number
  /** Artboard size in CSS px (page size x zoom). */
  width: number
  height: number
  /** Bottom of the artboard. */
  bottom: number
}

export interface StackLayout {
  slots: PageSlot[]
  contentHeight: number
  contentWidth: number
}

export interface StackMetrics {
  /** Space above the first header and below the last page. */
  padding: number
  /** Gap between the bottom of a page and the next header. */
  gap: number
  /** Height of the per-page chrome header. */
  header: number
  /** Horizontal padding of the scroll content. */
  sidePadding: number
}

export const DEFAULT_METRICS: StackMetrics = { padding: 40, gap: 28, header: 40, sidePadding: 64 }

export function computeStack(pages: readonly PageBox[], zoom: number, metrics: StackMetrics = DEFAULT_METRICS): StackLayout {
  let y = metrics.padding
  let maxW = 0
  const slots: PageSlot[] = []
  for (const page of pages) {
    const width = page.width * zoom
    const height = page.height * zoom
    const top = y
    const artboardTop = top + metrics.header
    slots.push({ id: page.id, top, artboardTop, width, height, bottom: artboardTop + height })
    maxW = Math.max(maxW, width)
    y = artboardTop + height + metrics.gap
  }
  return {
    slots,
    contentHeight: y - metrics.gap + metrics.padding + 56 /* room for the "add page" row */,
    contentWidth: maxW + metrics.sidePadding * 2,
  }
}

/**
 * Left edge of a page's artboard in scroll-content px, for a viewport `viewportWidth` px wide. Pages of any size
 * share one centre line: the content is as wide as the widest page plus padding (or the viewport, when that is
 * wider) and every artboard is centred in it.
 */
export function slotLeft(layout: StackLayout, slot: PageSlot, viewportWidth: number): number {
  return Math.max(0, (Math.max(layout.contentWidth, viewportWidth) - slot.width) / 2)
}

/** Ids of pages whose artboard intersects `[scrollTop - overscan, scrollTop + viewportH + overscan]`. */
export function visiblePageIds(layout: StackLayout, scrollTop: number, viewportH: number, overscan = 0): string[] {
  const lo = scrollTop - overscan
  const hi = scrollTop + viewportH + overscan
  return layout.slots.filter((s) => s.bottom >= lo && s.top <= hi).map((s) => s.id)
}

/** The page that owns the viewport centre, or the closest one. */
export function pageAtViewportCenter(layout: StackLayout, scrollTop: number, viewportH: number): string | null {
  if (layout.slots.length === 0) return null
  const probe = scrollTop + viewportH / 2
  let best = layout.slots[0]
  let bestDist = Infinity
  for (const s of layout.slots) {
    const dist = probe < s.top ? s.top - probe : probe > s.bottom ? probe - s.bottom : 0
    if (dist < bestDist) {
      best = s
      bestDist = dist
      if (dist === 0) break
    }
  }
  return best.id
}

export interface CanvasWindow {
  /** Offset of the window inside the artboard, CSS px (may be negative: the window overhangs the page). */
  x: number
  y: number
  width: number
  height: number
}

/**
 * The part of an artboard a live canvas element actually covers. A canvas the size of the whole artboard
 * would explode at high zoom (a 1080px page at 800 % is 8640 CSS px square), so the live canvas covers
 * only the visible region plus `overscan`, always including a `bleed` margin around the page so
 * selection handles that hang outside the page stay visible.
 *
 * `visible` is the viewport rectangle expressed in artboard coordinates (CSS px).
 */
export function computeCanvasWindow(
  artboard: Size2,
  visible: { x: number; y: number; width: number; height: number },
  overscan: number,
  bleed: number,
): CanvasWindow {
  const minX = -bleed
  const minY = -bleed
  const maxX = artboard.width + bleed
  const maxY = artboard.height + bleed
  const x0 = Math.max(minX, Math.floor(visible.x - overscan))
  const y0 = Math.max(minY, Math.floor(visible.y - overscan))
  const x1 = Math.min(maxX, Math.ceil(visible.x + visible.width + overscan))
  const y1 = Math.min(maxY, Math.ceil(visible.y + visible.height + overscan))
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) }
}

interface Size2 {
  width: number
  height: number
}

/** True when `inner` is fully inside `outer`. */
export function windowContains(outer: CanvasWindow, inner: { x: number; y: number; width: number; height: number }): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}
