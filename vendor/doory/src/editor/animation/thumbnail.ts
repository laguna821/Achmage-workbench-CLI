/**
 * The small moving pictures of the Animate panel: a stand-in card drawn through the same sampler as the real thing,
 * so a preset looks in its tile the way it will look on the page. Pure drawing on a 2D surface; the caller owns the
 * clock and the colours.
 */
import type { Anim, DocObject, PageTransition } from '@/types/document'
import { drawTransition } from './transitionRenderer'
import { type Surface, context2d, createCanvas } from './canvasFx'
import { ease } from './easing'
import { inOutPresets } from './presets'
import { type Sample, type UnitSample, REST, sampleObject, sampleTransition, sampleUnit } from './sampler'

export interface ThumbColors {
  /** The card. */
  card: string
  /** What is written on the card. */
  ink: string
  /** Behind the card. */
  ground: string
  /** The other page of a transition. */
  other: string
}

const RAD = Math.PI / 180

/** The thumbnail's own "page": a landscape tile the card sits in. */
export const THUMB_PAGE = { width: 160, height: 110 } as const
const CARD = { width: 84, height: 54 }
const CARD_LEFT = (THUMB_PAGE.width - CARD.width) / 2
const CARD_TOP = (THUMB_PAGE.height - CARD.height) / 2

/** How long a thumbnail holds the finished frame before it starts again, ms. */
export const THUMB_HOLD_MS = 500

function roundRect(ctx: Surface, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** The stand-in object: the card, as a document object for the sampler. */
function cardObject(animation: DocObject['animation'], text: boolean): DocObject {
  return { id: 'thumb', type: text ? 'textbox' : 'rect', left: CARD_LEFT + CARD.width / 2, top: CARD_TOP + CARD.height / 2, width: CARD.width, height: CARD.height, animation }
}

/** What the card is made of: the card itself and, for text animations, the units that move on it. */
interface Block {
  x: number
  y: number
  w: number
  h: number
}

function unitBlocks(by: 'line' | 'word' | 'letter'): Block[] {
  const inset = 8
  const left = CARD_LEFT + inset
  const width = CARD.width - 2 * inset
  if (by === 'line') {
    return [0, 1, 2].map((i) => ({ x: left, y: CARD_TOP + 9 + i * 14, w: i === 2 ? width * 0.6 : width, h: 9 }))
  }
  const count = by === 'word' ? 3 : 7
  const gap = by === 'word' ? 5 : 2
  const w = (width - gap * (count - 1)) / count
  return Array.from({ length: count }, (_, i) => ({ x: left + i * (w + gap), y: CARD_TOP + CARD.height / 2 - 6, w, h: 12 }))
}

function drawCardBody(ctx: Surface, colors: ThumbColors, withText: boolean): void {
  ctx.fillStyle = colors.card
  roundRect(ctx, CARD_LEFT, CARD_TOP, CARD.width, CARD.height, 8)
  ctx.fill()
  if (withText) return
  ctx.fillStyle = colors.ink
  ctx.globalAlpha *= 0.85
  roundRect(ctx, CARD_LEFT + 10, CARD_TOP + 14, CARD.width * 0.55, 6, 3)
  ctx.fill()
  roundRect(ctx, CARD_LEFT + 10, CARD_TOP + 28, CARD.width * 0.38, 6, 3)
  ctx.fill()
}

const RESTING_UNIT: UnitSample = { opacity: 1, tx: 0, ty: 0, scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, skewY: 0, blur: 0, clipToUnit: false }

function applySample(ctx: Surface, s: Readonly<Sample>): void {
  const cx = CARD_LEFT + CARD.width / 2
  const cy = CARD_TOP + CARD.height / 2
  ctx.translate(cx + s.tx, cy + s.ty)
  if (s.rotate) ctx.rotate(s.rotate * RAD)
  if (s.skewX || s.skewY) ctx.transform(1, Math.tan(s.skewY * RAD), Math.tan(s.skewX * RAD), 1, 0, 0)
  ctx.scale(s.scaleX, s.scaleY)
  ctx.translate(-cx, -cy)
}

function drawUnit(ctx: Surface, b: Block, u: UnitSample, colors: ThumbColors, outer: Readonly<Sample>): void {
  ctx.save()
  ctx.globalAlpha = outer.opacity * u.opacity
  applySample(ctx, outer)
  if (u.clipToUnit) {
    ctx.beginPath()
    ctx.rect(b.x - 1, b.y - 1, b.w + 2, b.h + 2)
    ctx.clip()
  }
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  ctx.translate(cx + u.tx, cy + u.ty)
  if (u.rotate) ctx.rotate(u.rotate * RAD)
  ctx.scale(u.scaleX, u.scaleY)
  ctx.translate(-cx, -cy)
  ctx.fillStyle = colors.ink
  roundRect(ctx, b.x, b.y, b.w, b.h, Math.min(3, b.h / 2))
  ctx.fill()
  ctx.restore()
}

/**
 * Draws the card of an animation at `tMs` on a surface of `width` x `height` (any size; the thumbnail scales). The
 * animation is played from 0, `enter` and `exit` hide the card at their ends, `emphasis` returns it to rest.
 */
export function drawAnimationThumb(ctx: Surface, width: number, height: number, slot: 'enter' | 'exit' | 'emphasis', anim: Anim, tMs: number, colors: ThumbColors): void {
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = colors.ground
  ctx.fillRect(0, 0, width, height)
  ctx.scale(width / THUMB_PAGE.width, height / THUMB_PAGE.height)
  const preset = slot === 'emphasis' ? undefined : inOutPresets.get(anim.preset)
  const by = preset?.textDefault ?? null
  const object = cardObject({ [slot]: { ...anim, delayMs: 0, ...(by ? { by } : {}) } }, by !== null)
  const sample = sampleObject(object, tMs, THUMB_PAGE)
  if (sample.visible) {
    if (by) {
      // A text animation: the card stays and the writing on it, in units, comes and goes.
      const blocks = unitBlocks(by)
      const plan = sample.units
      ctx.save()
      ctx.globalAlpha = sample.opacity
      applySample(ctx, sample)
      drawCardBody(ctx, colors, true)
      ctx.restore()
      blocks.forEach((b, i) => drawUnit(ctx, b, plan ? sampleUnit(plan, i, blocks.length, { w: b.w, h: b.h }) : RESTING_UNIT, colors, { ...REST, opacity: sample.opacity }))
    } else {
      ctx.save()
      ctx.globalAlpha = sample.opacity
      if (sample.blur > 0.25 && 'filter' in ctx) ctx.filter = `blur(${sample.blur / 3}px)`
      if (sample.clip) {
        const c = sample.clip
        ctx.beginPath()
        const x0 = CARD_LEFT + c.x0 * CARD.width
        const y0 = CARD_TOP + c.y0 * CARD.height
        const w = (c.x1 - c.x0) * CARD.width
        const h = (c.y1 - c.y0) * CARD.height
        if (c.shape === 'ellipse') ctx.ellipse(x0 + w / 2, y0 + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2)
        else ctx.rect(x0, y0, w, h)
        ctx.clip()
      }
      applySample(ctx, sample)
      drawCardBody(ctx, colors, false)
      ctx.restore()
    }
  }
  ctx.restore()
}

/** The time at which a still tile shows the animation: where it is half way, however its easing spends the time. */
export function stillTime(anim: Pick<Anim, 'durationMs' | 'easing'>): number {
  let p = 0
  while (p < 1 && ease(anim.easing, p) < 0.5) p += 0.01
  return Math.min(1, p) * anim.durationMs
}

/** The time on a hovered tile's loop: the animation, then a pause on its last frame. */
export function loopTime(elapsedMs: number, durationMs: number): number {
  return elapsedMs % (durationMs + THUMB_HOLD_MS)
}

/* ------------------------------------------------------------------------------------------------
 * Page transitions
 * ---------------------------------------------------------------------------------------------- */

let pages: { key: string; from: HTMLCanvasElement; to: HTMLCanvasElement } | null = null

function samplePages(colors: ThumbColors, width: number, height: number): { from: HTMLCanvasElement; to: HTMLCanvasElement } {
  const key = `${width}x${height}|${colors.card}|${colors.other}|${colors.ink}`
  if (pages?.key === key) return pages
  const make = (fill: string, letter: string, ink: string): HTMLCanvasElement => {
    const canvas = createCanvas(width, height)
    const ctx = context2d(canvas)
    ctx.fillStyle = fill
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = ink
    ctx.font = `700 ${Math.round(height * 0.5)}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(letter, width / 2, height / 2 + height * 0.04)
    return canvas
  }
  pages = { key, from: make(colors.card, 'A', colors.ground), to: make(colors.other, 'B', colors.ink) }
  return pages
}

/** Draws a transition between two sample pages ("A" and "B") at linear progress `p`. */
export function drawTransitionThumb(ctx: Surface, width: number, height: number, transition: Pick<PageTransition, 'preset' | 'easing' | 'direction'>, p: number, colors: ThumbColors): void {
  const { from, to } = samplePages(colors, width, height)
  drawTransition(ctx, sampleTransition(transition, p), from, to, width, height)
}
