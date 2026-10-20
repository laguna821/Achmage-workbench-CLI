import type { TextCase } from '@/types/document'

/**
 * Every word starts with a capital ("Save The Date"), the way invitations and greeting cards are set. Apostrophes
 * stay inside the word ("Don't", not "Don'T").
 */
export function toTitleCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/(^|[\s\-/(["'])([\p{L}\p{N}][\p{L}\p{N}'’]*)/gu, (_match, lead: string, word: string) => lead + word.charAt(0).toUpperCase() + word.slice(1))
}

/** The first letter of every sentence is a capital, the rest is lower case ("Hello world. How are you?"). */
export function toSentenceCase(text: string): string {
  return text.toLowerCase().replace(/(^|[.!?]\s+)(\p{L})/gu, (_match, lead: string, letter: string) => lead + letter.toUpperCase())
}

export function applyCase(text: string, mode: TextCase): string {
  switch (mode) {
    case 'upper':
      return text.toLocaleUpperCase()
    case 'lower':
      return text.toLocaleLowerCase()
    case 'title':
      return toTitleCase(text)
    case 'sentence':
      return toSentenceCase(text)
    default:
      return text
  }
}

/**
 * Toggling a case that is already active restores the text the user originally typed (`source`);
 * otherwise the new case is applied to that original (so Upper → Lower works from the raw text).
 */
export function toggleCase(
  current: { text: string; textCase: TextCase; caseSource?: string },
  next: TextCase,
): { text: string; textCase: TextCase; caseSource: string | undefined } {
  const source =
    current.textCase !== 'none' && current.caseSource !== undefined && applyCase(current.caseSource, current.textCase) === current.text
      ? current.caseSource
      : current.text
  if (next === 'none' || next === current.textCase) {
    return { text: source, textCase: 'none', caseSource: undefined }
  }
  return { text: applyCase(source, next), textCase: next, caseSource: source }
}
