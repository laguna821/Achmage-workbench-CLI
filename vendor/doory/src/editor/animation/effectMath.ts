/** Small pure helpers shared by the built-in presets. */
import type { AnimDirection } from '@/types/document'
import type { Effect } from './presets'

/**
 * A number in [0, 1) that depends only on its two integer inputs. Presets that look random (glitch, flicker) use it
 * so that a frame is the same whenever and wherever it is drawn; it does not use `Math.random` or `Math.sin`.
 */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  h = Math.imul(h, 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Unit vector from an object's centre towards the side it comes from, or (0, 0) for zoom directions. */
export function sideVector(direction: AnimDirection | undefined, fallback: AnimDirection): { x: number; y: number } {
  switch (direction ?? fallback) {
    case 'left':
      return { x: -1, y: 0 }
    case 'right':
      return { x: 1, y: 0 }
    case 'up':
      return { x: 0, y: -1 }
    case 'down':
      return { x: 0, y: 1 }
    default:
      return { x: 0, y: 0 }
  }
}

/**
 * Rotation by `degrees` about the point (`px`, `py`) given relative to the object's centre: the rotation about the
 * centre plus the translation that moves the centre to where it ends up.
 */
export function rotateAbout(degrees: number, px: number, py: number): Pick<Effect, 'rotate' | 'tx' | 'ty'> {
  const r = (degrees * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return { rotate: degrees, tx: px - cos * px + sin * py, ty: py - sin * px - cos * py }
}

/** Piecewise linear value through `[progress, value]` points sorted by progress. */
export function keyframes(p: number, points: readonly (readonly [number, number])[]): number {
  if (p <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i]
    if (p <= t1) {
      const [t0, v0] = points[i - 1]
      return t1 === t0 ? v1 : v0 + ((v1 - v0) * (p - t0)) / (t1 - t0)
    }
  }
  return points[points.length - 1][1]
}
