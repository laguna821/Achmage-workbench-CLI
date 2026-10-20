/**
 * Canvas helpers of the renderers: blur, and creating canvases. Blur uses the canvas filter where the browser has it;
 * where it has not (Safari before its filter support, node-canvas in the unit tests) a bitmap is drawn through a
 * smaller copy of itself, which looks soft in the same way and costs little.
 */

export type Surface = CanvasRenderingContext2D

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

export function context2d(canvas: HTMLCanvasElement): Surface {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot draw on a canvas.')
  return ctx
}

let filterSupport: boolean | null = null

/** True when 2D contexts take a `filter` (checked once, on a throw-away canvas). */
export function canFilter(): boolean {
  if (filterSupport === null) {
    const ctx = createCanvas(1, 1).getContext('2d')
    filterSupport = ctx !== null && 'filter' in ctx
  }
  return filterSupport
}

/** For tests: forget what was found about the canvas filter. */
export function resetFilterSupport(): void {
  filterSupport = null
}

/** The most blur (px of output) that is drawn: beyond it a picture is a smear anyway, and the filter gets slow. */
export const MAX_BLUR_PX = 64

type Source = CanvasImageSource & { width: number; height: number }

/** The bitmap a small picture is blurred on: the browser blurs a whole layer the size of the canvas, so it is kept small. */
let scratch: HTMLCanvasElement | null = null

/** The scratch bitmap, cleared, at least `w` x `h`; nothing outside that corner is used. */
function scratchBitmap(w: number, h: number): { canvas: HTMLCanvasElement; ctx: Surface } {
  if (!scratch || scratch.width < w || scratch.height < h) scratch = createCanvas(Math.max(w, scratch?.width ?? 0), Math.max(h, scratch?.height ?? 0))
  const sctx = context2d(scratch)
  sctx.setTransform(1, 0, 0, 1, 0, 0)
  sctx.globalAlpha = 1
  sctx.clearRect(0, 0, w, h)
  return { canvas: scratch, ctx: sctx }
}

/**
 * Draws `image` into `dest` (output px) with `blur` px of blur. With a canvas filter the context's own filter does it;
 * without one the image goes through a copy that is `1 + blur / 2` times smaller. A picture much smaller than the
 * canvas is blurred on a small bitmap of its own first: a filtered draw costs as much as the whole layer it is drawn
 * in (60 blurring elements at once ran at 8 frames a second when drawn straight on a 690 px canvas).
 */
export function drawBlurred(ctx: Surface, image: Source, x: number, y: number, w: number, h: number, blur: number): void {
  const radius = Math.min(MAX_BLUR_PX, Math.max(0, blur))
  if (radius < 0.25) {
    ctx.drawImage(image, x, y, w, h)
    return
  }
  if (canFilter()) {
    const pad = Math.ceil(radius * 3)
    const ox = Math.floor(x) - pad
    const oy = Math.floor(y) - pad
    const sw = Math.ceil(x + w) + pad - ox
    const sh = Math.ceil(y + h) + pad - oy
    if (sw * sh * 2 < ctx.canvas.width * ctx.canvas.height && sw * sh <= 4_000_000) {
      // The filter's lengths are in canvas pixels whatever the transform, the bitmap is drawn through it: undo its scale.
      const t = ctx.getTransform()
      const k = Math.sqrt(Math.abs(t.a * t.d - t.b * t.c)) || 1
      const { canvas, ctx: sctx } = scratchBitmap(sw, sh)
      sctx.filter = `blur(${radius / k}px)`
      sctx.drawImage(image, x - ox, y - oy, w, h)
      sctx.filter = 'none'
      ctx.drawImage(canvas, 0, 0, sw, sh, ox, oy, sw, sh)
      return
    }
    const previous = ctx.filter
    ctx.filter = `blur(${radius}px)`
    ctx.drawImage(image, x, y, w, h)
    ctx.filter = previous
    return
  }
  const shrink = 1 + radius / 2
  const small = createCanvas(Math.max(1, w / shrink), Math.max(1, h / shrink))
  const sctx = context2d(small)
  sctx.imageSmoothingEnabled = true
  sctx.drawImage(image, 0, 0, small.width, small.height)
  ctx.drawImage(small, x, y, w, h)
}
