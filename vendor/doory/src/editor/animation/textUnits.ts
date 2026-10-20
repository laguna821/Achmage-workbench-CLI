/**
 * The boxes of the lines, words and letters of a laid-out text object, for animations that step through them.
 *
 * Fabric lays text out in a box of its own (`width` x `height`, origin in the middle); every grapheme has a measured
 * `left` and `kernedWidth` on its line, and every line a height. The boxes returned here partition the object's box
 * without gaps or overlaps (so drawing every unit at rest reproduces the object exactly): lines split it vertically at
 * the line tops, words and letters split a line horizontally where the next one starts. The first and last unit of a
 * line, and the first and last line, reach `pad` px beyond the box so shadows, glows and outlines belong to a unit.
 *
 * Coordinates are page px relative to the object's centre, before its rotation, with the object's scale applied.
 * Limits, on purpose: text on a path (curved text) and right-to-left text are not split, and a glyph that overhangs its
 * cell (an italic f, a wide shadow) is cut at the cell's edge and appears in the neighbouring unit.
 */
import type { FabricObject } from 'fabric'

export interface UnitBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type SplitBy = 'line' | 'word' | 'letter'

interface CharBound {
  left: number
  kernedWidth: number
}

/** The part of Fabric's text objects the measurement reads. */
interface LaidOutText {
  width: number
  height: number
  scaleX: number
  scaleY: number
  flipX: boolean
  flipY: boolean
  direction?: string
  path?: unknown
  _textLines?: string[][]
  __charBounds?: CharBound[][]
  getHeightOfLine?(lineIndex: number): number
  getLineWidth?(lineIndex: number): number
  _getLineLeftOffset?(lineIndex: number): number
}

const isWhite = (g: string): boolean => /^\s+$/.test(g)

/** True when `object` is text that has been laid out and can be split. */
export function canSplit(object: FabricObject): boolean {
  const t = object as unknown as LaidOutText
  return Array.isArray(t._textLines) && Array.isArray(t.__charBounds) && typeof t.getHeightOfLine === 'function' && typeof t._getLineLeftOffset === 'function' && t.path == null && t.direction !== 'rtl'
}

/** The units of `object` (see the file comment), or `null` when it cannot be split or has nothing to split. */
export function textUnitBoxes(object: FabricObject, by: SplitBy, pad: number): UnitBox[] | null {
  if (!canSplit(object)) return null
  const t = object as unknown as Required<Pick<LaidOutText, '_textLines' | '__charBounds' | 'getHeightOfLine' | '_getLineLeftOffset'>> & LaidOutText
  const lines = t._textLines
  // Fabric measures the glyphs of a line when something asks for its width (drawing does, a size set by hand does not):
  // ask, so the measurements are there whatever happened to the object before.
  for (let i = 0; i < lines.length; i++) t.getLineWidth?.(i)
  const bounds = t.__charBounds
  if (lines.length === 0 || bounds.length < lines.length) return null
  const left0 = -t.width / 2
  const top0 = -t.height / 2
  const tops: number[] = []
  let y = top0
  for (let i = 0; i < lines.length; i++) {
    tops.push(y)
    y += t.getHeightOfLine(i)
  }
  const boxes: UnitBox[] = []
  const band = (i: number): [number, number] => [i === 0 ? top0 - pad : tops[i], i === lines.length - 1 ? Math.max(y, t.height / 2) + pad : tops[i + 1]]
  for (let i = 0; i < lines.length; i++) {
    const [y0, y1] = band(i)
    const graphemes = lines[i]
    const chars = bounds[i]
    if (by === 'line') {
      boxes.push({ x0: left0 - pad, y0, x1: -left0 + pad, y1 })
      continue
    }
    if (graphemes.length === 0 || chars.length < graphemes.length) {
      boxes.push({ x0: left0 - pad, y0, x1: -left0 + pad, y1 })
      continue
    }
    const offset = left0 + t._getLineLeftOffset(i)
    // Where each unit starts on the line; a unit ends where the next starts (the last at the end of the line).
    const starts: number[] = []
    for (let j = 0; j < graphemes.length; j++) {
      if (by === 'letter' || j === 0 || (isWhite(graphemes[j - 1]) && !isWhite(graphemes[j]))) starts.push(offset + chars[j].left)
    }
    const end = offset + chars[graphemes.length - 1].left + chars[graphemes.length - 1].kernedWidth
    starts.forEach((x, k) => boxes.push({ x0: k === 0 ? Math.min(x, left0) - pad : x, y0, x1: k === starts.length - 1 ? Math.max(end, -left0) + pad : starts[k + 1], y1 }))
  }
  if (boxes.length === 0) return null
  const sx = Math.abs(t.scaleX)
  const sy = Math.abs(t.scaleY)
  return boxes.map((b) => {
    const x0 = (t.flipX ? -b.x1 : b.x0) * sx
    const x1 = (t.flipX ? -b.x0 : b.x1) * sx
    const y0 = (t.flipY ? -b.y1 : b.y0) * sy
    const y1 = (t.flipY ? -b.y0 : b.y1) * sy
    return { x0, y0, x1, y1 }
  })
}
