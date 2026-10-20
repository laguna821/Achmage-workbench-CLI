/**
 * Letter spacing for scripts whose letters join or reorder (Arabic, Hebrew, Indic, Thai…). Fabric applies letter spacing
 * by drawing every letter on its own, which pulls joined Arabic letters apart and draws a Latin word inside a
 * right-to-left line backwards. For a line in such a script this draws each run of same-styled text in one go and lets
 * the browser space the letters (`ctx.letterSpacing`), so the shaping and the bidi order stay right.
 *
 * Imported for its side effect by serialization.ts, which every page canvas, export and preview goes through.
 */
import { FabricText, util } from 'fabric'
import { hasComplexScript } from '../text/direction'

type RenderChars = (method: 'fillText' | 'strokeText', ctx: CanvasRenderingContext2D, line: string[], left: number, top: number, lineIndex: number) => void

interface TextInternals {
  path?: unknown
  charSpacing: number
  textAlign: string
  direction: CanvasDirection
  __charBounds: { width: number; kernedWidth: number }[][]
  getHeightOfLineImpl(lineIndex: number): number
  _fontSizeFraction: number
  getCompleteStyleDeclaration(lineIndex: number, charIndex: number): Record<string, unknown> & { fontSize: number }
  _renderChar(method: string, ctx: CanvasRenderingContext2D, lineIndex: number, charIndex: number, chars: string, left: number, top: number): void
}

const PATCHED = Symbol.for('doory.complexText')
/** Browsers without `ctx.letterSpacing` (and test environments) keep Fabric's letter-by-letter drawing. */
const LETTER_SPACING = typeof CanvasRenderingContext2D !== 'undefined' && 'letterSpacing' in CanvasRenderingContext2D.prototype
const proto = FabricText.prototype as unknown as { _renderChars: RenderChars; [PATCHED]?: boolean }

export function usesRunSpacing(text: Pick<TextInternals, 'path' | 'charSpacing' | 'textAlign'>, line: readonly string[]): boolean {
  return !text.path && text.charSpacing !== 0 && !text.textAlign.includes('justify') && LETTER_SPACING && hasComplexScript(line.join(''))
}

if (!proto[PATCHED]) {
  proto[PATCHED] = true
  const original = proto._renderChars
  proto._renderChars = function (this: TextInternals, method, ctx, line, left, top, lineIndex) {
    if (!usesRunSpacing(this, line)) {
      original.call(this, method, ctx, line, left, top, lineIndex)
      return
    }
    const isLtr = this.direction !== 'rtl'
    const sign = isLtr ? 1 : -1
    ctx.save()
    if (ctx.direction !== this.direction) {
      ctx.canvas.setAttribute('dir', isLtr ? 'ltr' : 'rtl')
      ctx.direction = isLtr ? 'ltr' : 'rtl'
      ctx.textAlign = isLtr ? 'left' : 'right'
    }
    top -= this.getHeightOfLineImpl(lineIndex) * this._fontSizeFraction
    let run = ''
    let runStart = 0
    let runWidth = 0
    let style = this.getCompleteStyleDeclaration(lineIndex, 0)
    for (let i = 0; i < line.length; i++) {
      const box = this.__charBounds[lineIndex][i]
      run += line[i]
      runWidth += box.kernedWidth
      const next = i < line.length - 1 ? this.getCompleteStyleDeclaration(lineIndex, i + 1) : null
      if (next && !util.hasStyleChanged(style as never, next as never, false)) continue
      const target = ctx as CanvasRenderingContext2D & { letterSpacing: string }
      const before = target.letterSpacing
      target.letterSpacing = `${(this.charSpacing / 1000) * style.fontSize}px`
      this._renderChar(method, ctx, lineIndex, runStart, run, left, top)
      target.letterSpacing = before
      left += sign * runWidth
      run = ''
      runWidth = 0
      runStart = i + 1
      if (next) style = next
    }
    ctx.restore()
  }
}
