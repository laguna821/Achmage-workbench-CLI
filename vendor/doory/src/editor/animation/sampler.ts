/**
 * The sampler: a pure, deterministic function from (object, time) to how the object looks at that time. It knows
 * nothing about Fabric, the DOM or the clock; the frame renderer, the editor preview, the presenter, the timeline's
 * thumbnails and the exporters all ask it. Same input, same output, on any machine.
 *
 * Time is the page clock: 0 is the moment the page has come in, a delay counts from there. An object with an enter
 * animation is hidden before it starts, an object with an exit animation is hidden once it has finished, and in
 * between it rests (with its emphasis on top). Presets the registry does not know play as "none".
 */
import type { Anim, AnimDirection, AnimEasing, AnimTextUnit, DocObject, PageTransition } from '@/types/document'
import './builtins'
import { clamp01, ease } from './easing'
import { hash01 } from './effectMath'
import { animationOf, normalizeTransition } from './model'
import {
  type Clip,
  type Effect,
  type EffectContext,
  type InOutPreset,
  type PageLayer,
  type PageLayerChange,
  type TransitionSample,
  emphasisPresets,
  inOutPresets,
  transitionPresets,
} from './presets'

/* ------------------------------------------------------------------------------------------------
 * Geometry
 * ---------------------------------------------------------------------------------------------- */

export interface PageDims {
  width: number
  height: number
}

/** An object's box in page px: centre, size before rotation, rotation in degrees. */
export interface Box {
  cx: number
  cy: number
  w: number
  h: number
  angle: number
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** The box of a document object, from its JSON (the renderer passes the exact box of the live object instead). */
export function objectBox(object: DocObject): Box {
  const sx = Math.abs(num(object.scaleX, 1))
  const sy = Math.abs(num(object.scaleY, 1))
  const stroke = Math.max(0, num(object.strokeWidth, 0))
  const w = Math.max(0, (num(object.width, 0) + stroke) * sx)
  const h = Math.max(0, (num(object.height, 0) + stroke) * sy)
  const angle = num(object.angle, 0)
  const r = (angle * Math.PI) / 180
  const ox = object.originX === 'left' ? w / 2 : object.originX === 'right' ? -w / 2 : 0
  const oy = object.originY === 'top' ? h / 2 : object.originY === 'bottom' ? -h / 2 : 0
  const left = num(object.left, 0)
  const top = num(object.top, 0)
  return { cx: left + ox * Math.cos(r) - oy * Math.sin(r), cy: top + ox * Math.sin(r) + oy * Math.cos(r), w, h, angle }
}

/** The smallest upright rectangle around a box. */
export function boxBounds(box: Box): { x: number; y: number; w: number; h: number } {
  const r = (box.angle * Math.PI) / 180
  const cos = Math.abs(Math.cos(r))
  const sin = Math.abs(Math.sin(r))
  const w = box.w * cos + box.h * sin
  const h = box.w * sin + box.h * cos
  return { x: box.cx - w / 2, y: box.cy - h / 2, w, h }
}

const TEXT_TYPES: ReadonlySet<string> = new Set(['textbox', 'itext', 'text'])

/** Text that can be animated line by line, word by word or letter by letter (curved text is one piece). */
export function isSplittableText(object: { type: string; curveAmount?: unknown }): boolean {
  return TEXT_TYPES.has(object.type) && !(typeof object.curveAmount === 'number' && object.curveAmount !== 0)
}

function seedOf(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return h | 0
}

/* ------------------------------------------------------------------------------------------------
 * Samples
 * ---------------------------------------------------------------------------------------------- */

/** A text animation that steps through units: ask `sampleUnit` for each one. */
export interface UnitPlan {
  by: Exclude<AnimTextUnit, 'object'>
  preset: string
  phase: 'enter' | 'exit'
  /** Linear progress of the whole animation, 0..1. */
  progress: number
  easing: AnimEasing
  direction: AnimDirection | undefined
  k: number
  page: PageDims
  seed: number
}

/** How an object looks at one moment, relative to how it rests. */
export interface Sample {
  /** False when nothing of the object is on screen (before its enter, after its exit). */
  visible: boolean
  opacity: number
  tx: number
  ty: number
  scaleX: number
  scaleY: number
  rotate: number
  skewX: number
  skewY: number
  blur: number
  clip?: Clip
  units?: UnitPlan
}

export const REST: Readonly<Sample> = Object.freeze({
  visible: true,
  opacity: 1,
  tx: 0,
  ty: 0,
  scaleX: 1,
  scaleY: 1,
  rotate: 0,
  skewX: 0,
  skewY: 0,
  blur: 0,
})

const HIDDEN: Readonly<Sample> = Object.freeze({ ...REST, visible: false, opacity: 0 })

/** True when the object is drawn exactly as it rests. */
export function isRest(s: Readonly<Sample>): boolean {
  return (
    s.visible &&
    s.opacity === 1 &&
    s.tx === 0 &&
    s.ty === 0 &&
    s.scaleX === 1 &&
    s.scaleY === 1 &&
    s.rotate === 0 &&
    s.skewX === 0 &&
    s.skewY === 0 &&
    s.blur === 0 &&
    s.clip === undefined &&
    s.units === undefined
  )
}

function finite(n: number | undefined, fallback: number): number {
  return n !== undefined && Number.isFinite(n) ? n : fallback
}

/** Rounding noise of 1e-9 or less is not a change: a cycle that ends where it started ends exactly there (and never at -0). */
const SNAP = 1e-9
const snap = (n: number, rest: number): number => (Math.abs(n - rest) < SNAP ? rest : n)
/** A whole number of turns looks like no rotation; any other angle is kept as it is (a spin of 540 degrees is not one of 180). */
const snapTurn = (deg: number): number => (Math.abs(deg % 360) < SNAP ? 0 : deg)

function addEffect(acc: Sample, e: Effect): void {
  if (e.opacity !== undefined) acc.opacity *= clamp01(finite(e.opacity, 1))
  acc.tx += finite(e.tx, 0)
  acc.ty += finite(e.ty, 0)
  acc.scaleX *= finite(e.scaleX, 1)
  acc.scaleY *= finite(e.scaleY, 1)
  acc.rotate += finite(e.rotate, 0)
  acc.skewX += finite(e.skewX, 0)
  acc.skewY += finite(e.skewY, 0)
  acc.blur = Math.max(acc.blur, Math.max(0, finite(e.blur, 0)))
  if (e.clip) acc.clip = e.clip
}

function newSample(): Sample {
  return { ...REST }
}

/** The effect strength: the intensity setting (0.5 when unset) times two. */
export function strengthOf(anim: Pick<Anim, 'intensity'>): number {
  return 2 * clamp01(anim.intensity ?? 0.5)
}

function contextOf(box: Box, page: PageDims, anim: Anim, seed: number): EffectContext {
  const b = boxBounds(box)
  return {
    w: box.w,
    h: box.h,
    u: Math.max(24, Math.min(page.width, page.height) * 0.07),
    k: strengthOf(anim),
    direction: anim.direction,
    reach: {
      left: Math.max(0, b.x + b.w),
      right: Math.max(0, page.width - b.x),
      up: Math.max(0, b.y + b.h),
      down: Math.max(0, page.height - b.y),
    },
    seed,
    unit: false,
  }
}

/** The unit a text animation steps through for this object, `object` when it is played as one piece. */
export function unitFor(preset: InOutPreset, anim: Pick<Anim, 'by'>, splittable: boolean): AnimTextUnit {
  if (!splittable || !preset.textUnits) return 'object'
  if (anim.by === 'line' || anim.by === 'word' || anim.by === 'letter') return anim.by
  return preset.textDefault ?? 'object'
}

/** Adds an enter or exit to `acc`. Returns false when the object is not on screen at `t` (before its enter, after its exit). */
function applyInOut(acc: Sample, phase: 'enter' | 'exit', anim: Anim, t: number, object: DocObject, box: Box, page: PageDims): boolean {
  const preset = inOutPresets.get(anim.preset)
  if (!preset) return true
  const start = anim.delayMs
  const end = start + anim.durationMs
  if (phase === 'enter' && t >= end) return true
  if (phase === 'exit' && t < start) return true
  if (phase === 'exit' && t >= end) return false
  const linear = clamp01((t - start) / anim.durationMs)
  const seed = seedOf(object.id)
  const by = unitFor(preset, anim, isSplittableText(object))
  if (by !== 'object') {
    acc.units = { by, preset: anim.preset, phase, progress: linear, easing: anim.easing, direction: anim.direction, k: strengthOf(anim), page, seed }
    return true
  }
  if (phase === 'enter' && t < start) return false
  const eased = ease(anim.easing, linear)
  addEffect(acc, preset.effect(phase === 'enter' ? eased : 1 - eased, contextOf(box, page, anim, seed)))
  return true
}

function applyEmphasis(acc: Sample, anim: Anim, t: number, object: DocObject, box: Box, page: PageDims): void {
  const preset = emphasisPresets.get(anim.preset)
  if (!preset) return
  const local = t - anim.delayMs
  if (local < 0) return
  let cycle = local
  if (anim.loop === true) cycle = local % anim.durationMs
  else if (local > anim.durationMs) return
  const p = ease(anim.easing, cycle / anim.durationMs)
  addEffect(acc, preset.effect(p, contextOf(box, page, anim, seedOf(object.id))))
}

/**
 * How `object` looks at page time `tMs`. `box` is the exact box of the object when the caller has it (the frame
 * renderer measures the live object); without it the box is worked out from the document JSON.
 */
export function sampleObject(object: DocObject, tMs: number, page: PageDims, box?: Box): Readonly<Sample> {
  const animation = animationOf(object)
  if (!animation) return REST
  const t = Number.isFinite(tMs) ? tMs : 0
  const b = box ?? objectBox(object)
  const acc = newSample()
  const { enter, exit, emphasis } = animation
  if (enter && inOutPresets.has(enter.preset) && !applyInOut(acc, 'enter', enter, t, object, b, page)) return HIDDEN
  if (exit && inOutPresets.has(exit.preset) && !applyInOut(acc, 'exit', exit, t, object, b, page)) return HIDDEN
  if (emphasis) applyEmphasis(acc, emphasis, t, object, b, page)
  return finish(acc)
}

function finish(acc: Sample): Readonly<Sample> {
  if (!acc.visible) return HIDDEN
  if (acc.opacity <= 0.001 && acc.units === undefined) return HIDDEN
  acc.opacity = snap(clamp01(acc.opacity), 1)
  acc.tx = snap(acc.tx, 0)
  acc.ty = snap(acc.ty, 0)
  acc.scaleX = snap(acc.scaleX, 1)
  acc.scaleY = snap(acc.scaleY, 1)
  acc.rotate = snapTurn(acc.rotate)
  acc.skewX = snap(acc.skewX, 0)
  acc.skewY = snap(acc.skewY, 0)
  acc.blur = snap(acc.blur, 0)
  return isRest(acc) ? REST : acc
}

/* ------------------------------------------------------------------------------------------------
 * Text units
 * ---------------------------------------------------------------------------------------------- */

/** How one unit of a split text looks: like a `Sample`, with lengths in page px. */
export interface UnitSample {
  opacity: number
  tx: number
  ty: number
  scaleX: number
  scaleY: number
  rotate: number
  skewX: number
  skewY: number
  blur: number
  /** Show the unit only inside the place it rests in. */
  clipToUnit: boolean
}

/**
 * The look of unit `index` of `count` (a line, word or letter of `size` page px) under a split text animation. Units
 * start one after another over the preset's stagger share of the span and each takes the rest of it.
 */
export function sampleUnit(plan: UnitPlan, index: number, count: number, size: { w: number; h: number }): UnitSample {
  const preset = inOutPresets.get(plan.preset)
  const unit: UnitSample = { opacity: 1, tx: 0, ty: 0, scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, skewY: 0, blur: 0, clipToUnit: false }
  if (!preset) return unit
  const n = Math.max(1, count)
  const stagger = clamp01(preset.stagger ?? 0.7)
  let local: number
  if (stagger >= 1) local = plan.progress > index / n ? 1 : 0
  else {
    const start = n > 1 ? (stagger * index) / (n - 1) : 0
    local = clamp01((plan.progress - start) / (1 - stagger))
  }
  const eased = stagger >= 1 ? local : ease(plan.easing, local)
  const p = plan.phase === 'enter' ? eased : 1 - eased
  const ctx: EffectContext = {
    w: size.w,
    h: size.h,
    u: Math.max(8, size.h * 0.9),
    k: plan.k,
    direction: plan.direction,
    reach: { left: 0, right: 0, up: 0, down: 0 },
    seed: (plan.seed + Math.imul(index + 1, 7919)) | 0,
    unit: true,
  }
  const e = preset.effect(p, ctx)
  unit.opacity = snap(clamp01(finite(e.opacity, 1)), 1)
  unit.tx = snap(finite(e.tx, 0), 0)
  unit.ty = snap(finite(e.ty, 0), 0)
  unit.scaleX = snap(finite(e.scaleX, 1), 1)
  unit.scaleY = snap(finite(e.scaleY, 1), 1)
  unit.rotate = snapTurn(finite(e.rotate, 0))
  unit.skewX = snap(finite(e.skewX, 0), 0)
  unit.skewY = snap(finite(e.skewY, 0), 0)
  unit.blur = snap(Math.max(0, finite(e.blur, 0)), 0)
  unit.clipToUnit = e.clipToUnit === true
  return unit
}

/* ------------------------------------------------------------------------------------------------
 * Page transitions
 * ---------------------------------------------------------------------------------------------- */

const LAYER_REST: PageLayer = { opacity: 1, dx: 0, dy: 0, scaleX: 1, scaleY: 1, rotate: 0, blur: 0 }

function layerOf(change: PageLayerChange | undefined): PageLayer {
  const layer: PageLayer = { ...LAYER_REST, ...change }
  layer.opacity = clamp01(finite(layer.opacity, 1))
  layer.blur = Math.max(0, finite(layer.blur, 0))
  for (const key of ['dx', 'dy', 'rotate'] as const) layer[key] = finite(layer[key], 0)
  for (const key of ['scaleX', 'scaleY'] as const) layer[key] = finite(layer[key], 1)
  return layer
}

/** True when the transition has an effect: a known preset other than "none". */
export function isPlayableTransition(transition: Pick<PageTransition, 'preset'> | null | undefined): boolean {
  return !!transition && transition.preset !== 'none' && transitionPresets.has(transition.preset)
}

/**
 * How the page that is left (`from`) and the page that comes in (`to`) are composited at linear progress `p` of the
 * transition (0 = the old page on screen, 1 = the new one). The transition's own easing is applied here.
 */
export function sampleTransition(transition: Pick<PageTransition, 'preset' | 'easing' | 'direction'>, p: number): TransitionSample {
  const preset = transitionPresets.get(transition.preset) ?? transitionPresets.get('none')
  const eased = ease(transition.easing, p)
  const composed = preset ? preset.compose(eased, transition.direction ?? preset.defaults.direction) : {}
  return { from: layerOf(composed.from), to: layerOf(composed.to), toOnTop: composed.toOnTop === true, veil: clamp01(finite(composed.veil, 0)) }
}

/** The transition of a page as the editor plays it, or `null` when the page has none that plays. */
export function playableTransition(raw: unknown): PageTransition | null {
  const transition = normalizeTransition(raw)
  return isPlayableTransition(transition) ? transition : null
}

export { hash01 }
