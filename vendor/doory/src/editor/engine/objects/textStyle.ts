/**
 * Text styling that understands per-character styles: while editing with a selection range the
 * character-level props apply to the range; otherwise they apply to the whole object (clearing any
 * stale per-character overrides of the same props, so the change is visible everywhere).
 */
import type { IText, TextStyleDeclaration } from 'fabric'
import type { DocTextFit, ListStyle, TextCase } from '@/types/document'
import { CHAR_SPACING_RANGE, FONT_SIZE_RANGE, LINE_HEIGHT_RANGE, clampOrUndefined, isFiniteNumber } from '../numbers'
import { applyCase, toggleCase } from '../text/case'
import { type TextDirection, alignmentForDirection, detectDirection } from '../text/direction'
import { applyListStyle, detectListStyle } from '../text/lists'
import { asDory } from './dory'
import { applyCurve, refitCurve } from './curvedText'
import { type FillSpec, buildFill } from './fills'

export const MIN_FIT_FONT_SIZE = 4

export function defaultMinFontSize(fontSize: number): number {
  return Math.max(MIN_FIT_FONT_SIZE, Math.round(fontSize * 0.5))
}

export function validFitFontSize(value: unknown): number | null {
  return isFiniteNumber(value) && value >= FONT_SIZE_RANGE[0] && value <= FONT_SIZE_RANGE[1] ? value : null
}

/** Reads an untrusted `fit` value from a document object; returns null if absent or malformed. */
export function readTextFit(raw: unknown): DocTextFit | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.mode !== 'shrink') return null
  const minRaw = r.minFontSize ?? r.min_font_size
  if (minRaw === undefined || minRaw === null) return { mode: 'shrink' }
  if (typeof minRaw !== 'number' || !Number.isFinite(minRaw)) return null
  return {
    mode: 'shrink',
    minFontSize: Math.min(FONT_SIZE_RANGE[1], Math.max(MIN_FIT_FONT_SIZE, Math.round(minRaw))),
  }
}

/**
 * Finds the largest integer-stepped `fontSize` (from `userFontSize` down to `minFontSize`, both clamped to
 * `FONT_SIZE_RANGE`) at which the wrapped lines of `t` fit inside `fitBoxHeight`, using binary search, then restores
 * the fixed box height on `t`. Ignores `fit` when `fontSize` is non-finite or outside `FONT_SIZE_RANGE`.
 */
export function refitTextbox(t: IText): void {
  const d = asDory(t)
  const fit = readTextFit(d.fit)
  if (!fit) return
  const rawTarget = validFitFontSize(d.userFontSize) ?? validFitFontSize(t.fontSize)
  if (rawTarget === null) return
  const target = Math.min(FONT_SIZE_RANGE[1], Math.max(MIN_FIT_FONT_SIZE, rawTarget))
  const boxH = isFiniteNumber(d.fitBoxHeight) && d.fitBoxHeight > 0 ? d.fitBoxHeight : t.height
  const boxW = t.width
  if (!isFiniteNumber(boxH) || boxH <= 0 || !isFiniteNumber(boxW) || boxW <= 0) return
  d.userFontSize = target
  d.fitBoxHeight = boxH
  if (d.curveAmount) {
    t.set('fontSize', target)
    d.fitFontSize = Number(target.toFixed(3))
    return
  }
  const minRequested = fit.minFontSize ?? defaultMinFontSize(target)
  const floor = Math.min(target, Math.max(MIN_FIT_FONT_SIZE, Math.min(FONT_SIZE_RANGE[1], minRequested)))
  const fitsAt = (size: number): boolean => {
    t.fontSize = size
    t.width = boxW
    t.initDimensions()
    return t.height <= boxH + 1e-3
  }
  let current = target
  if (!fitsAt(target) && target > floor) {
    let low = 1
    let high = Math.ceil(target - floor)
    while (low < high) {
      const mid = (low + high) >> 1
      if (fitsAt(Math.max(floor, target - mid))) high = mid
      else low = mid + 1
    }
    current = Math.max(floor, target - low)
    fitsAt(current)
  }
  d.fitFontSize = Number(current.toFixed(3))
  t.width = boxW
  t.height = boxH
  t.setCoords()
  t.set('dirty', true)
}

/** Enables, updates or clears (`null`) shrink-to-fit on `t`. */
export function applyTextFit(t: IText, fit: DocTextFit | null): void {
  const d = asDory(t)
  const parsed = fit ? readTextFit(fit) : null
  if (!parsed) {
    if (isFiniteNumber(d.userFontSize) && d.userFontSize > 0) t.set('fontSize', d.userFontSize)
    delete d.fit
    delete d.fitFontSize
    delete d.userFontSize
    delete d.fitBoxHeight
    t.initDimensions()
    t.setCoords()
    t.set('dirty', true)
    return
  }
  if (!d.fit) {
    d.userFontSize = t.fontSize
    d.fitBoxHeight = t.height
  }
  const userSize = d.userFontSize ?? t.fontSize
  if (parsed.minFontSize !== undefined) {
    parsed.minFontSize = Math.min(Math.round(userSize), Math.max(MIN_FIT_FONT_SIZE, Math.round(parsed.minFontSize)))
  }
  d.fit = parsed
  refitTextbox(t)
}

export interface TextPatch {
  fontFamily?: string
  fontSize?: number
  fontWeight?: number | string
  fontStyle?: 'normal' | 'italic'
  underline?: boolean
  linethrough?: boolean
  fill?: FillSpec
  textAlign?: 'left' | 'center' | 'right' | 'justify'
  lineHeight?: number
  charSpacing?: number
  textCase?: TextCase
  listStyle?: ListStyle
  curveAmount?: number
  /** `auto` lets the content decide (the first letter); `ltr` / `rtl` fix it. */
  direction?: TextDirection | 'auto'
}

/**
 * Drops what cannot be applied (NaN, Infinity, an unknown weight) and limits the numbers to the engine's range, so a
 * text patch from any caller is safe: the toolbar's tighter limits (size 8-200, line height 0.5-3) are the UI's own rules.
 */
export function sanitizeTextPatch(patch: TextPatch): TextPatch {
  const out: TextPatch = { ...patch }
  const size = clampOrUndefined(patch.fontSize, FONT_SIZE_RANGE[0], FONT_SIZE_RANGE[1])
  const lineHeight = clampOrUndefined(patch.lineHeight, LINE_HEIGHT_RANGE[0], LINE_HEIGHT_RANGE[1])
  const spacing = clampOrUndefined(patch.charSpacing, CHAR_SPACING_RANGE[0], CHAR_SPACING_RANGE[1])
  if (size === undefined) delete out.fontSize
  else out.fontSize = size
  if (lineHeight === undefined) delete out.lineHeight
  else out.lineHeight = lineHeight
  if (spacing === undefined) delete out.charSpacing
  else out.charSpacing = spacing
  if (!isFiniteNumber(patch.curveAmount)) delete out.curveAmount
  const w = patch.fontWeight
  if (typeof w === 'number') {
    if (isFiniteNumber(w)) out.fontWeight = Math.min(900, Math.max(100, Math.round(w / 100) * 100))
    else delete out.fontWeight
  } else if (w !== undefined && !/^(normal|bold|[1-9]00)$/.test(w)) delete out.fontWeight
  if (typeof patch.fontFamily === 'string' && patch.fontFamily.trim() === '') delete out.fontFamily
  return out
}

const CHAR_LEVEL = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'underline', 'linethrough', 'fill'] as const
type CharKey = (typeof CHAR_LEVEL)[number]

/** A partial selection while editing. Selecting the whole text counts as styling the whole object. */
function hasRange(t: IText): boolean {
  return t.isEditing && t.selectionStart !== t.selectionEnd && !(t.selectionStart === 0 && t.selectionEnd >= t.text.length)
}

function clearStyleKeys(t: IText, keys: readonly string[]): void {
  const styles = t.styles
  for (const line of Object.keys(styles)) {
    const row = styles[Number(line)]
    for (const ch of Object.keys(row)) {
      const style = row[Number(ch)] as Record<string, unknown>
      for (const k of keys) delete style[k]
      if (Object.keys(style).length === 0) delete row[Number(ch)]
    }
    if (Object.keys(row).length === 0) delete styles[Number(line)]
  }
}

/** Applies `patch` to `t`. Returns true when the text content changed (case / list). */
export function applyTextPatch(t: IText, patch: TextPatch): boolean {
  let textChanged = false
  const d = asDory(t)
  const range = hasRange(t)
  if (!range && patch.fontSize !== undefined && d.fit) {
    d.userFontSize = patch.fontSize
    if (d.fit.minFontSize !== undefined && d.fit.minFontSize > patch.fontSize) {
      d.fit = { ...d.fit, minFontSize: Math.max(MIN_FIT_FONT_SIZE, Math.round(patch.fontSize)) }
    }
  }
  const charPatch: Partial<Record<CharKey, unknown>> = {}
  for (const key of CHAR_LEVEL) {
    if (key === 'fill') {
      if (patch.fill) charPatch.fill = buildFill(patch.fill)
    } else if (patch[key] !== undefined) {
      charPatch[key] = patch[key]
    }
  }

  if (Object.keys(charPatch).length > 0) {
    if (range) {
      t.setSelectionStyles(charPatch as TextStyleDeclaration, t.selectionStart, t.selectionEnd)
    } else {
      clearStyleKeys(t, Object.keys(charPatch))
      t.set(charPatch)
    }
  }

  if (patch.direction !== undefined) {
    if (patch.direction === 'auto') delete d.textDir
    else d.textDir = patch.direction
    syncDirection(t)
  }
  if (patch.textAlign !== undefined) t.set('textAlign', patch.textAlign)
  if (patch.lineHeight !== undefined) t.set('lineHeight', patch.lineHeight)
  if (patch.charSpacing !== undefined) t.set('charSpacing', patch.charSpacing)

  if (patch.textCase !== undefined) {
    const next = toggleCase({ text: t.text, textCase: d.textCase ?? 'none', caseSource: d.caseSource }, patch.textCase)
    if (next.text !== t.text) {
      t.set('text', next.text)
      textChanged = true
    }
    d.textCase = next.textCase === 'none' ? undefined : next.textCase
    d.caseSource = next.caseSource
  }
  if (patch.listStyle !== undefined) {
    const next = applyListStyle(t.text, patch.listStyle)
    if (next !== t.text) {
      t.set('text', next)
      textChanged = true
    }
    const style = detectListStyle(next)
    d.listStyle = style === 'none' ? undefined : style
  }

  if (patch.curveAmount !== undefined) applyCurve(t, patch.curveAmount)
  else if (d.curveAmount && (patch.fontSize !== undefined || patch.fontFamily !== undefined || patch.fontWeight !== undefined || patch.charSpacing !== undefined || textChanged)) {
    refitCurve(t)
  }

  if (d.fit && !d.curveAmount) {
    refitTextbox(t)
  } else {
    t.initDimensions()
    t.setCoords()
    t.set('dirty', true)
  }
  return textChanged
}

/**
 * Gives `t` the direction it should have: the one picked in the toolbar, or else the one its first letter asks for (a text
 * without letters keeps its direction). A text that changes direction keeps hugging the start of its lines, so "left"
 * becomes "right" and back. Returns true when something changed.
 */
export function syncDirection(t: IText): boolean {
  const from = (t.direction === 'rtl' ? 'rtl' : 'ltr') as TextDirection
  const to = asDory(t).textDir ?? detectDirection(t.text) ?? from
  if (to === from) return false
  t.set({ direction: to, textAlign: alignmentForDirection(t.textAlign, from, to) })
  if (asDory(t).fit && !asDory(t).curveAmount) refitTextbox(t)
  else {
    t.initDimensions()
    t.setCoords()
    t.set('dirty', true)
  }
  return true
}

/** Re-applies the active case after the user edited the characters. */
export function reapplyCase(t: IText): void {
  const d = asDory(t)
  if (!d.textCase || d.textCase === 'none') return
  const next = applyCase(t.text, d.textCase)
  d.caseSource = t.text
  if (next !== t.text) t.set('text', next)
}

/** The effective character style at the caret/selection (for toolbar state). */
export function currentTextStyle(t: IText): Record<string, unknown> {
  const d = asDory(t)
  const base: Record<string, unknown> = {
    fontFamily: t.fontFamily,
    fontSize: d.fit ? (d.userFontSize ?? t.fontSize) : t.fontSize,
    fontWeight: t.fontWeight,
    fontStyle: t.fontStyle,
    underline: t.underline,
    linethrough: t.linethrough,
    fill: t.fill,
  }
  if (!t.isEditing) return base
  const start = t.selectionStart
  const end = t.selectionEnd
  const style = start === end ? t.getSelectionStyles(Math.max(0, start - 1), start, true)[0] : t.getSelectionStyles(start, start + 1, true)[0]
  return { ...base, ...(style as Record<string, unknown> | undefined) }
}
