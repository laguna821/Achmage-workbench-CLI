import type { ListStyle } from '@/types/document'

export const BULLET = '•'
const BULLET_PREFIX = `${BULLET} `
const NUMBER_RE = /^\d+\.\s/
const BULLET_RE = /^[•\-*]\s/

export function detectListStyle(text: string): ListStyle {
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return 'none'
  if (lines.every((l) => BULLET_RE.test(l))) return 'bullet'
  if (lines.every((l) => NUMBER_RE.test(l))) return 'number'
  return 'none'
}

export function stripListMarkers(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(BULLET_RE, '').replace(NUMBER_RE, ''))
    .join('\n')
}

/** Applies (or removes, when already active) a list style to every non-empty line. */
export function applyListStyle(text: string, style: ListStyle): string {
  const plain = stripListMarkers(text)
  if (style === 'none' || style === detectListStyle(text)) return plain
  let n = 0
  return plain
    .split('\n')
    .map((line) => {
      if (line.trim().length === 0) return line
      n += 1
      return style === 'bullet' ? `${BULLET_PREFIX}${line}` : `${n}. ${line}`
    })
    .join('\n')
}

/** Renumbers a numbered list (after lines were added or removed). */
export function renumber(text: string): string {
  let n = 0
  return text
    .split('\n')
    .map((line) => {
      if (!NUMBER_RE.test(line)) return line
      n += 1
      return line.replace(/^\d+\./, `${n}.`)
    })
    .join('\n')
}

/**
 * Called after the user pressed Enter inside a list: if the previous line is a list item and the
 * new line is empty, the marker is carried over. Returns the new text and the caret delta.
 */
export function continueList(text: string, caret: number): { text: string; caret: number } | null {
  if (caret < 1 || text[caret - 1] !== '\n') return null
  const prevStart = text.lastIndexOf('\n', caret - 2) + 1
  const prev = text.slice(prevStart, caret - 1)
  const rest = text.slice(caret)
  const nextLineEnd = rest.indexOf('\n')
  const currentLine = nextLineEnd === -1 ? rest : rest.slice(0, nextLineEnd)
  if (currentLine.length > 0) return null
  let marker: string | null = null
  if (BULLET_RE.test(prev)) marker = BULLET_PREFIX
  else {
    const m = /^(\d+)\.\s/.exec(prev)
    if (m) marker = `${Number(m[1]) + 1}. `
  }
  if (!marker) return null
  // An empty item followed by Enter ends the list: remove the dangling marker instead.
  if (prev.replace(BULLET_RE, '').replace(NUMBER_RE, '').trim() === '') {
    const cleared = text.slice(0, prevStart) + text.slice(caret)
    return { text: cleared, caret: prevStart }
  }
  return { text: text.slice(0, caret) + marker + text.slice(caret), caret: caret + marker.length }
}
