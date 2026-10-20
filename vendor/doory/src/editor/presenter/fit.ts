/**
 * Letterboxing. A presentation shows every page at the largest size that fits the screen without cutting or
 * stretching it, centred, so a deck whose pages differ in size (a square page between 16:9 slides) is boxed page by
 * page, each by its own size.
 */

export interface Size {
  width: number
  height: number
}

export interface Rect extends Size {
  x: number
  y: number
}

/** The largest `content`-shaped rectangle inside `container`, centred (it may be larger than `content` itself). */
export function fitContain(container: Size, content: Size): Rect {
  if (!(container.width > 0) || !(container.height > 0) || !(content.width > 0) || !(content.height > 0)) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const scaleX = container.width / content.width
  const scaleY = container.height / content.height
  // The limiting side is the container's own, exactly (a product of floats could fall a hair short of it).
  const width = scaleX <= scaleY ? container.width : content.width * scaleY
  const height = scaleX <= scaleY ? content.height * scaleX : container.height
  return { x: (container.width - width) / 2, y: (container.height - height) / 2, width, height }
}

/** Largest bitmap side and area a page is rendered at, whatever the screen: keeps a 4K display from allocating 100 MB per page. */
export const MAX_FRAME_SIDE = 4096
export const MAX_FRAME_PIXELS = 16_000_000

export interface FrameGeometry {
  /** Where the page sits in the stage, in CSS px (whole numbers, so the edges stay crisp). */
  css: Rect
  /** The bitmap to render it at: CSS size times the device pixel ratio, within the limits above. */
  pixels: Size
}

/** Where a page goes in a stage of `container` CSS px and how many device pixels it is rendered with. */
export function frameGeometry(container: Size, page: Size, devicePixelRatio: number): FrameGeometry {
  const fit = fitContain(container, page)
  const width = Math.min(Math.floor(container.width), Math.round(fit.width))
  const height = Math.min(Math.floor(container.height), Math.round(fit.height))
  if (width <= 0 || height <= 0) return { css: { x: 0, y: 0, width: 0, height: 0 }, pixels: { width: 0, height: 0 } }
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  let w = width * dpr
  let h = height * dpr
  const shrink = Math.min(1, MAX_FRAME_SIDE / Math.max(w, h), Math.sqrt(MAX_FRAME_PIXELS / (w * h)))
  w *= shrink
  h *= shrink
  return {
    css: { x: Math.round((container.width - width) / 2), y: Math.round((container.height - height) / 2), width, height },
    pixels: { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) },
  }
}
