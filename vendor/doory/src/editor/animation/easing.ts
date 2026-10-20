/**
 * Easing curves of animations. Every curve maps linear progress 0..1 to eased progress with `f(0) = 0` and
 * `f(1) = 1` exactly, so an animation always starts and ends at its two states. `linear`, `ease-in`, `ease-out` and
 * `ease-in-out` are monotone; `spring` overshoots the end and settles, `bounce` hits it and rebounds (neither is
 * monotone, and `MONOTONE_EASINGS` says which are).
 */
import type { AnimEasing } from '@/types/document'

export const EASINGS: readonly AnimEasing[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'spring', 'bounce']

/** The curves that never go backwards (a preset that must not overshoot picks from these). */
export const MONOTONE_EASINGS: readonly AnimEasing[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out']

export function isEasing(value: unknown): value is AnimEasing {
  return typeof value === 'string' && (EASINGS as readonly string[]).includes(value)
}

export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/** `a` at `p = 0`, `b` at `p = 1`, exactly (no rounding drift at the end points). */
export const mix = (a: number, b: number, p: number): number => a * (1 - p) + b * p

const easeOutBounce = (p: number): number => {
  const n = 7.5625
  const d = 2.75
  if (p < 1 / d) return n * p * p
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375
  return n * (p -= 2.625 / d) * p + 0.984375
}

/**
 * A damped oscillation that crosses 1 at about a third of the way (a peak of about 109 %), swings back under it
 * a little and settles; `cos(2.5 pi)` is 0, so the curve ends on 1 without a correction term.
 */
const spring = (p: number): number => 1 - Math.exp(-6 * p) * Math.cos(2.5 * Math.PI * p)

/** Eased progress for linear progress `p` (limited to 0..1 first, so a clock that overshoots cannot extrapolate). */
export function ease(easing: AnimEasing, p: number): number {
  if (!(p > 0)) return 0
  if (p >= 1) return 1
  switch (easing) {
    case 'linear':
      return p
    case 'ease-in':
      return p * p * p
    case 'ease-out': {
      const q = 1 - p
      return 1 - q * q * q
    }
    case 'ease-in-out':
      return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
    case 'spring':
      return spring(p)
    case 'bounce':
      return easeOutBounce(p)
    default:
      return p
  }
}
