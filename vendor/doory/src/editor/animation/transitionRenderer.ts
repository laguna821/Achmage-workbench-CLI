/**
 * Draws a page transition: the page that is left and the page that comes in, composited as `sampleTransition` says.
 * Both pages are canvases of the same size (the stage, with each page letterboxed inside it when their shapes differ),
 * so offsets and regions are fractions of that one rectangle.
 */
import { hash01 } from './effectMath'
import { MAX_BLUR_PX, type Surface, drawBlurred } from './canvasFx'
import type { PageClip, PageLayer, TransitionSample } from './presets'

const RAD = Math.PI / 180

/** Block size of the dissolve, in output px: about sixty blocks across the shorter side. */
function blockSize(width: number, height: number): number {
  return Math.max(6, Math.round(Math.min(width, height) / 60))
}

/** The part of the output a clip leaves visible, as a path on `ctx`. */
function clipPath(ctx: Surface, clip: PageClip, w: number, h: number): void {
  ctx.beginPath()
  switch (clip.kind) {
    case 'rect':
      ctx.rect(clip.x0 * w, clip.y0 * h, (clip.x1 - clip.x0) * w, (clip.y1 - clip.y0) * h)
      break
    case 'circle':
      ctx.arc(clip.cx * w, clip.cy * h, Math.max(0, clip.r) * Math.max(w, h), 0, Math.PI * 2)
      break
    case 'dissolve': {
      const block = blockSize(w, h)
      const cols = Math.ceil(w / block)
      const rows = Math.ceil(h / block)
      for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) if (hash01(col, row) < clip.amount) ctx.rect(col * block, row * block, block + 0.5, block + 0.5)
      break
    }
    case 'bars': {
      const span = (clip.vertical ? w : h) / clip.count
      for (let i = 0; i < clip.count; i++) {
        const length = Math.min(1, Math.max(0, clip.amount)) * span
        if (length <= 0) continue
        if (clip.vertical) ctx.rect(i * span, 0, length + 0.5, h)
        else ctx.rect(0, i * span, w, length + 0.5)
      }
      break
    }
  }
}

function drawLayer(ctx: Surface, layer: PageLayer, image: HTMLCanvasElement, w: number, h: number): void {
  if (layer.opacity <= 0 || layer.scaleX === 0 || layer.scaleY === 0) return
  ctx.save()
  if (layer.clip) {
    clipPath(ctx, layer.clip, w, h)
    ctx.clip()
  }
  ctx.globalAlpha = layer.opacity
  ctx.translate(w / 2 + layer.dx * w, h / 2 + layer.dy * h)
  if (layer.rotate) ctx.rotate(layer.rotate * RAD)
  ctx.scale(layer.scaleX, layer.scaleY)
  drawBlurred(ctx, image, -w / 2, -h / 2, w, h, Math.min(MAX_BLUR_PX, layer.blur * Math.min(w, h)))
  ctx.restore()
}

/**
 * Draws one frame of a transition on `ctx` (a surface of `width` x `height`, cleared first). `from` and `to` are
 * canvases of that size.
 */
export function drawTransition(ctx: Surface, sample: TransitionSample, from: HTMLCanvasElement, to: HTMLCanvasElement, width: number, height: number): void {
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  const order: [PageLayer, HTMLCanvasElement][] = sample.toOnTop ? [[sample.from, from], [sample.to, to]] : [[sample.to, to], [sample.from, from]]
  for (const [layer, image] of order) drawLayer(ctx, layer, image, width, height)
  if (sample.veil > 0) {
    ctx.globalAlpha = sample.veil
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, width, height)
  }
  ctx.restore()
}
