/**
 * Writing direction and complex scripts. A text box's direction follows its content (the first letter decides, the
 * way a browser's `dir="auto"` does) until someone picks a direction for it in the toolbar.
 */

export type TextDirection = 'ltr' | 'rtl'

/** Letters of right-to-left scripts: Hebrew, Arabic, Syriac, Thaana, N'Ko and their presentation forms. */
const RTL_LETTER = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}]/u
const LETTER = /\p{L}/u

/**
 * Scripts whose letters change shape with their neighbours or are reordered (Arabic, Hebrew, Indic, Thai, Lao,
 * Tibetan, Myanmar, Khmer). Drawn one letter at a time they come apart, so they are drawn a word run at a time.
 */
const COMPLEX = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Tibetan}\p{Script=Myanmar}\p{Script=Khmer}]/u

/** The direction the first letter of `text` asks for; `null` when there is no letter (only digits, spaces or emoji). */
export function detectDirection(text: string): TextDirection | null {
  for (const ch of text) {
    if (RTL_LETTER.test(ch)) return 'rtl'
    if (LETTER.test(ch)) return 'ltr'
  }
  return null
}

export function hasComplexScript(text: string): boolean {
  return COMPLEX.test(text)
}

/**
 * The alignment that keeps a text flush with the start of its lines when its direction changes: "left" on a text that
 * turns right-to-left becomes "right", and the other way round. Centred and justified texts keep theirs.
 */
export function alignmentForDirection(align: string, from: TextDirection, to: TextDirection): string {
  if (from === to) return align
  if (align === 'left' && to === 'rtl') return 'right'
  if (align === 'right' && to === 'ltr') return 'left'
  return align
}
