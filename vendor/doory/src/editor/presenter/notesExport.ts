/**
 * "Download notes": the speaker notes of a design as one text file, a section per page, in page order. Pages without
 * notes keep their section ("(no notes)") so the numbers still match the pages. The text is written as the speaker
 * typed it; it is never turned into markup.
 */
import type { DoryDocument } from '@/types/document'
import { t } from '../strings'
import { pageNotes } from './pageProps'

export type NotesFormat = 'markdown' | 'text'

export const NOTES_FORMATS: Readonly<Record<NotesFormat, { extension: string; mime: string }>> = {
  markdown: { extension: 'md', mime: 'text/markdown;charset=utf-8' },
  text: { extension: 'txt', mime: 'text/plain;charset=utf-8' },
}

/** True when at least one page has notes. */
export function hasNotes(doc: DoryDocument): boolean {
  return doc.pages.some((p) => pageNotes(p).trim() !== '')
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The file's content. */
export function buildNotes(doc: DoryDocument, title: string, format: NotesFormat): string {
  const heading = t.notes.fileTitle(oneLine(title) || t.untitled)
  const lines: string[] = format === 'markdown' ? [`# ${heading}`, ''] : [heading, '='.repeat(heading.length), '']
  doc.pages.forEach((page, index) => {
    const name = oneLine(page.name ?? '')
    const section = t.notes.pageHeading(index + 1, name || t.workspace.page(index + 1))
    const notes = pageNotes(page).trim() === '' ? t.notes.noNotes : pageNotes(page).replace(/\s+$/, '')
    if (format === 'markdown') lines.push(`## ${section}`, '', notes, '')
    else lines.push(section, '-'.repeat(section.length), '', notes, '')
  })
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/** `my-pitch-deck-notes.md`: the title as a safe file name. */
export function notesFileName(title: string, format: NotesFormat): string {
  const slug = oneLine(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return `${slug || 'design'}-notes.${NOTES_FORMATS[format].extension}`
}

/** The file ready for `downloadFiles`. */
export function notesFile(doc: DoryDocument, title: string, format: NotesFormat): { blob: Blob; filename: string } {
  return { blob: new Blob([buildNotes(doc, title, format)], { type: NOTES_FORMATS[format].mime }), filename: notesFileName(title, format) }
}
