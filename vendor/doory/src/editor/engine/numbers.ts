/**
 * Numeric guards for engine commands. Callers (toolbars, shortcuts, extensions, tests) can pass anything a
 * number input produces — NaN from an empty field, Infinity, a negative size — and none of it may reach a
 * Fabric object or the saved document, so every command that takes a number runs it through these first.
 */
export function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

/** `n` limited to `[min, max]`, or `undefined` when it is not a finite number (the command then ignores it). */
export function clampOrUndefined(n: unknown, min: number, max: number): number | undefined {
  return isFiniteNumber(n) ? Math.min(max, Math.max(min, n)) : undefined
}

export const FONT_SIZE_RANGE = [1, 999] as const
export const LINE_HEIGHT_RANGE = [0.1, 10] as const
export const CHAR_SPACING_RANGE = [-200, 800] as const
export const STROKE_WIDTH_MAX = 1000
export const CORNER_RADIUS_MAX = 5000
