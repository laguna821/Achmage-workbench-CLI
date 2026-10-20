/**
 * Pure document operations for the two presentation properties of a page, `notes` and `durationSec`.
 * Like everything in `engine/docOps.ts` they return a new document, keep untouched pages referentially identical
 * and leave an unset property absent (the collaboration layer syncs one entry per property and has no `undefined`).
 */
import type { DocPage, DoryDocument } from '@/types/document'
import { clampDuration, NOTES_MAX_LENGTH } from './timing'

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/**
 * Text the document can always store: line breaks become `\n`, NUL characters and lone surrogates (which the server
 * refuses, so one bad paste would make the whole design unsaveable) are dropped, and the length is capped at
 * `NOTES_MAX_LENGTH` without cutting an emoji in half.
 */
export function sanitizeNotes(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0) continue
    if (code === 13) {
      out += '\n'
      if (text.charCodeAt(i + 1) === 10) i++
      continue
    }
    if (isHighSurrogate(code)) {
      if (!isLowSurrogate(text.charCodeAt(i + 1))) continue
      out += text.slice(i, i + 2)
      i++
      continue
    }
    if (isLowSurrogate(code)) continue
    out += text[i]
  }
  if (out.length <= NOTES_MAX_LENGTH) return out
  const cut = isHighSurrogate(out.charCodeAt(NOTES_MAX_LENGTH - 1)) ? NOTES_MAX_LENGTH - 1 : NOTES_MAX_LENGTH
  return out.slice(0, cut)
}

/** The speaker notes of a page as a string (a document from another tool may hold anything). */
export function pageNotes(page: Pick<DocPage, 'notes'>): string {
  return typeof page.notes === 'string' ? page.notes : ''
}

function withPage(doc: DoryDocument, pageId: string, change: (page: DocPage) => DocPage): DoryDocument {
  const index = doc.pages.findIndex((p) => p.id === pageId)
  if (index < 0) return doc
  const page = doc.pages[index]
  const next = change(page)
  if (next === page) return doc
  const pages = doc.pages.slice()
  pages[index] = next
  return { ...doc, pages }
}

/** Sets the notes of a page; empty (or only white space) text removes the property. */
export function setPageNotes(doc: DoryDocument, pageId: string, text: string): DoryDocument {
  const clean = sanitizeNotes(text)
  const value = clean.trim() === '' ? null : clean
  return withPage(doc, pageId, (page) => {
    if ((page.notes ?? null) === value) return page
    const next: DocPage = { ...page }
    if (value === null) delete next.notes
    else next.notes = value
    return next
  })
}

function withDuration(page: DocPage, sec: number | null): DocPage {
  if ((page.durationSec ?? null) === sec) return page
  const next: DocPage = { ...page }
  if (sec === null) delete next.durationSec
  else next.durationSec = sec
  return next
}

/** Sets the time of a page (1-600 s, rounded); `null` removes it. A value that is not a number changes nothing. */
export function setPageDuration(doc: DoryDocument, pageId: string, sec: number | null): DoryDocument {
  const value = sec === null ? null : clampDuration(sec)
  if (sec !== null && value === null) return doc
  return withPage(doc, pageId, (page) => withDuration(page, value))
}

/** Gives every page the same time (`null` clears them all). A value that is not a number changes nothing. */
export function setAllDurations(doc: DoryDocument, sec: number | null): DoryDocument {
  const value = sec === null ? null : clampDuration(sec)
  if (sec !== null && value === null) return doc
  const pages = doc.pages.map((page) => withDuration(page, value))
  return pages.every((p, i) => p === doc.pages[i]) ? doc : { ...doc, pages }
}
