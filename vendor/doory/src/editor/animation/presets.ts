/**
 * The preset registries. Everything the editor ships (`builtinInOut.ts`, `builtinEmphasis.ts`,
 * `builtinTransitions.ts`) is registered through the same functions a plugin uses, so the panel, the timeline, the
 * sampler and the renderers never know a preset by name:
 *
 * ```ts
 * registerInOutPreset({ id: 'my-pop', label: 'My pop', group: 'basic', order: 99, defaults: { durationMs: 500, easing: 'spring' }, effect: (p) => ({ opacity: p, scaleX: p, scaleY: p }) })
 * ```
 *
 * An in/out preset describes how an object looks from hidden (`p = 0`) to resting (`p = 1`); the same function plays
 * an *enter* forwards and an *exit* backwards. An emphasis preset describes one cycle (`p = 0..1`, both ends at rest).
 * A transition preset says how the page that is left and the page that comes in are composited at progress `p`.
 */
import type { AnimDirection, AnimEasing } from '@/types/document'
import { Registry } from '../engine/registry'

/* ------------------------------------------------------------------------------------------------
 * What a preset returns
 * ---------------------------------------------------------------------------------------------- */

/**
 * A region of an object that stays visible, in fractions of the object's own box (0,0 = its top-left corner, 1,1 =
 * the bottom-right; values outside 0..1 reach past the box, which keeps shadows and glows). Presets use generous
 * margins on the sides they do not animate.
 */
export interface Clip {
  shape: 'rect' | 'ellipse'
  x0: number
  y0: number
  x1: number
  y1: number
  /** The region stays where the object rests while the content moves (a mask window), instead of moving with it. */
  fixed?: boolean
}

/** How an object is changed. Every field is optional and defaults to "no change". Lengths are page px. */
export interface Effect {
  /** Multiplier, 0..1. */
  opacity?: number
  tx?: number
  ty?: number
  /** Multipliers about the object's centre; they may pass through 0 and be negative (a flip). */
  scaleX?: number
  scaleY?: number
  /** Degrees about the object's centre. */
  rotate?: number
  skewX?: number
  skewY?: number
  /** Blur radius in page px. */
  blur?: number
  clip?: Clip
  /** Units of a text animation only: show a unit only inside the place it rests in (text rising out of its line). */
  clipToUnit?: boolean
}

export interface EffectContext {
  /** Size of what is animated, page px: the object's box, or the unit (line, word, letter) of a text split. */
  w: number
  h: number
  /** A typical travel length for this page or unit (px): large enough to see, small enough to stay near the object. */
  u: number
  /** Strength, 0..2 (the intensity setting times two; 1 = the preset's own size). */
  k: number
  direction: AnimDirection | undefined
  /** How far the object must move in each direction to be completely off the page. */
  reach: { left: number; right: number; up: number; down: number }
  /** A stable number per object (or per unit) for presets that look random but must not change between frames. */
  seed: number
  /** The context describes a unit of a text split. */
  unit: boolean
}

export type EffectFn = (p: number, c: EffectContext) => Effect

/* ------------------------------------------------------------------------------------------------
 * Enter / exit presets
 * ---------------------------------------------------------------------------------------------- */

export interface PresetDefaults {
  durationMs: number
  easing: AnimEasing
  /** 0..1; absent = 0.5. */
  intensity?: number
  /** Direction chosen when the preset is applied (the first of `directions` when absent). */
  direction?: AnimDirection
  /** Emphasis only: the preset starts looping when applied. */
  loop?: boolean
}

export interface InOutPreset {
  id: string
  label: string
  /** Heading in the panel's grid. */
  group: string
  /** Position in the grid; lower first. */
  order: number
  defaults: PresetDefaults
  /** Directions the preset offers; the first is the default. Absent = no direction. */
  directions?: readonly AnimDirection[]
  /** The preset can step through lines, words and letters of text (the "By" control). */
  textUnits?: boolean
  /** Text is always split, into these units, when the setting is "whole object" (typewriter, baseline). */
  textDefault?: 'line' | 'word' | 'letter'
  /**
   * Share (0..1) of a split animation's span over which the units start; each unit then takes the rest of the span.
   * 1 = every unit appears in a hard step in its turn. Default 0.7.
   */
  stagger?: number
  /** Hidden (`p = 0`) to resting (`p = 1`). Must return nothing visible at 0 and no change at 1. */
  effect: EffectFn
}

export const inOutPresets = new Registry<InOutPreset>((a, b) => a.order - b.order)

export function registerInOutPreset(preset: InOutPreset): () => void {
  return inOutPresets.register(preset)
}

/* ------------------------------------------------------------------------------------------------
 * Emphasis presets
 * ---------------------------------------------------------------------------------------------- */

export interface EmphasisPreset {
  id: string
  label: string
  order: number
  defaults: PresetDefaults
  /** One cycle at eased progress `p` (0..1). Must be at rest at both ends so a loop is seamless. */
  effect: EffectFn
}

export const emphasisPresets = new Registry<EmphasisPreset>((a, b) => a.order - b.order)

export function registerEmphasisPreset(preset: EmphasisPreset): () => void {
  return emphasisPresets.register(preset)
}

/* ------------------------------------------------------------------------------------------------
 * Page transitions
 * ---------------------------------------------------------------------------------------------- */

/** A region of the page that shows the incoming page. Coordinates are fractions of the page. */
export type PageClip =
  | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number }
  /** A circle around (`cx`, `cy`) with radius `r` times the longer side of the page (0.71 covers any page from its centre). */
  | { kind: 'circle'; cx: number; cy: number; r: number }
  /** Random blocks: `amount` (0..1) of them show the layer. The pattern is fixed, so a frame is always the same. */
  | { kind: 'dissolve'; amount: number }
  /** `count` bars across the page (vertical ones when `vertical`); each shows the layer up to `amount` of its width. */
  | { kind: 'bars'; count: number; amount: number; vertical: boolean }

/** How one page is drawn during a transition. Offsets are fractions of the page size, blur is a fraction of its shorter side. */
export interface PageLayer {
  opacity: number
  dx: number
  dy: number
  scaleX: number
  scaleY: number
  rotate: number
  blur: number
  clip?: PageClip
}

export interface TransitionSample {
  /** The page that is being left. */
  from: PageLayer
  /** The page that comes in. */
  to: PageLayer
  /** The incoming page is drawn over the outgoing one (otherwise under). */
  toOnTop: boolean
  /** A dip to black (or white) between the pages: 0 = none, 1 = fully covered. */
  veil: number
}

export type PageLayerChange = Partial<PageLayer>

export interface TransitionPreset {
  id: string
  label: string
  order: number
  defaults: { durationMs: number; easing: AnimEasing; direction?: AnimDirection }
  directions?: readonly AnimDirection[]
  /** Eased progress `p` (0..1) and the direction, to the two layers. */
  compose(p: number, direction: AnimDirection | undefined): { from?: PageLayerChange; to?: PageLayerChange; toOnTop?: boolean; veil?: number }
}

export const transitionPresets = new Registry<TransitionPreset>((a, b) => a.order - b.order)

export function registerTransitionPreset(preset: TransitionPreset): () => void {
  return transitionPresets.register(preset)
}
