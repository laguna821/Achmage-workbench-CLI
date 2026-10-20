/**
 * "Page animation": one style applied to every object of a page, one after another. It is a convenience of the
 * panel, not a stored concept: applying a style writes an ordinary `enter` animation on each object, with a growing
 * delay, and nothing remembers which style it came from.
 */
import type { Anim, AnimDirection, DocObject } from '@/types/document'
import { clampNumber, DELAY_RANGE } from './model'
import { isSplittableText, objectBox, boxBounds } from './sampler'
import { inOutPresets } from './presets'

export interface PageStyle {
  id: string
  /** The enter preset of every object. */
  preset: string
  /** Gap between objects, ms. */
  staggerMs: number
  durationMs: number
  /** Text steps through these units (words, letters) instead of coming in as one piece. */
  textBy?: 'line' | 'word' | 'letter'
  /** Text uses another preset than the other objects. */
  textPreset?: string
  /** The side objects come from; `alternate` takes turns between left and right. */
  direction?: AnimDirection | 'alternate'
}

export const PAGE_STYLES: readonly PageStyle[] = [
  { id: 'fade', preset: 'fade', staggerMs: 200, durationMs: 600 },
  { id: 'rise', preset: 'rise', staggerMs: 180, durationMs: 700 },
  { id: 'pop', preset: 'pop', staggerMs: 160, durationMs: 550 },
  { id: 'slide', preset: 'slide', staggerMs: 220, durationMs: 650, direction: 'alternate' },
  { id: 'words', preset: 'fade', staggerMs: 240, durationMs: 700, textPreset: 'rise', textBy: 'word' },
  { id: 'typewriter', preset: 'fade', staggerMs: 300, durationMs: 1400, textPreset: 'typewriter', textBy: 'letter' },
  { id: 'wipe', preset: 'wipe', staggerMs: 200, durationMs: 700, direction: 'left' },
  { id: 'focus', preset: 'focus', staggerMs: 240, durationMs: 800 },
]

export function pageStyleById(id: string): PageStyle | undefined {
  return PAGE_STYLES.find((s) => s.id === id)
}

/** The longest the objects of one page take to start, however many there are. */
const MAX_SPREAD_MS = 3000

/** Objects a style animates: not hidden, not locked (locked objects are usually the background), not unfilled photo frames. */
export function isStylable(object: DocObject): boolean {
  return object.visible !== false && object.locked !== true && object.isPlaceholder !== true
}

/** Reading order of a page: top to bottom, then left to right. */
export function readingOrder(objects: readonly DocObject[]): DocObject[] {
  const key = (o: DocObject): { y: number; x: number } => {
    const b = boxBounds(objectBox(o))
    return { y: b.y, x: b.x }
  }
  const keyed = objects.map((o, index) => ({ o, index, ...key(o) }))
  keyed.sort((a, b) => a.y - b.y || a.x - b.x || a.index - b.index)
  return keyed.map((k) => k.o)
}

/**
 * The enter animation each stylable object gets from `style`, by object id, in reading order. Objects that already
 * have an enter animation are replaced; their other animations are not this function's business.
 */
export function stylePageObjects(objects: readonly DocObject[], style: PageStyle): Map<string, Anim> {
  const targets = readingOrder(objects.filter(isStylable))
  const gap = targets.length > 1 ? Math.min(style.staggerMs, MAX_SPREAD_MS / (targets.length - 1)) : 0
  const out = new Map<string, Anim>()
  targets.forEach((object, index) => {
    const text = isSplittableText(object)
    const presetId = text && style.textPreset && inOutPresets.has(style.textPreset) ? style.textPreset : style.preset
    const preset = inOutPresets.get(presetId)
    if (!preset) return
    const anim: Anim = {
      preset: presetId,
      durationMs: style.durationMs,
      delayMs: clampNumber(Math.round((index * gap) / 100) * 100, DELAY_RANGE.min, DELAY_RANGE.max),
      easing: preset.defaults.easing,
    }
    const directions = preset.directions ?? []
    if (directions.length > 0) {
      const wanted = style.direction === 'alternate' ? (index % 2 === 0 ? 'left' : 'right') : style.direction
      anim.direction = wanted && directions.includes(wanted) ? wanted : (preset.defaults.direction ?? directions[0])
    }
    if (text && style.textBy && preset.textUnits) anim.by = style.textBy
    out.set(object.id, anim)
  })
  return out
}
