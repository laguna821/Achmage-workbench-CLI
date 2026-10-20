/**
 * Pure operations behind the Templates sidebar: put the pages of a template into the design the user is
 * editing. Every function returns a new document (or null when nothing can change) and never mutates its input.
 *
 * A design may hold pages of different sizes, so a template page keeps its own size wherever it becomes a page of
 * its own (`add`, `add-all`, `replace-resize`); only `replace` fits it into the size the page already has.
 */
import { newId } from '@/lib/document'
import { type DocPage, type DoryDocument, MAX_PAGES } from '@/types/document'
import { clampSize, cloneObjects, findPageIndex, pageSize } from '../engine/docOps'
import { resizeDocument } from '../engine/magicResize'
import { type PageSize, isUniform, normalizeSizes, sameSize } from '../engine/pageSizes'

/**
 * `replace`: the first template page takes the place of the active page and is scaled to its size.
 * `replace-resize`: the same, and the page takes the template's size.
 * `add`: the first template page becomes a new page after the active one, at its own size.
 * `add-all`: every template page does.
 */
export type TemplateMode = 'replace' | 'replace-resize' | 'add' | 'add-all'

export interface TemplateApplication {
  doc: DoryDocument
  activePageId: string
  /** Pages that are new in the design (0 when a page was replaced). */
  added: number
}

const hasContent = (doc: DoryDocument): boolean => doc.pages.some((p) => p.objects.length > 0)

const fresh = (page: DocPage): DocPage => ({ ...structuredClone({ ...page, objects: [] }), id: newId(), objects: cloneObjects(page.objects) })

/** Template pages with fresh page and object ids, scaled (uniformly, centred) to `size` like the canvas-size popover does. */
export function fitTemplatePages(template: DoryDocument, size: PageSize): DocPage[] {
  return resizeDocument(template, size.width, size.height, 'scale').pages.map(fresh)
}

/** Template pages with fresh ids that each keep their own size (stored on the page, whatever the template's default). */
export function ownSizeTemplatePages(template: DoryDocument): DocPage[] {
  return template.pages.map((page) => {
    const size = pageSize(template, page)
    return { ...fresh(page), width: clampSize(size.width), height: clampSize(size.height) }
  })
}

/**
 * Applies a template to `doc`. A design that is still empty takes over the template's size (an empty A4 page
 * becomes the template's Instagram post; when its pages differ in size, only the active page does). Returns null
 * when the page is unknown or the 100-page limit leaves no room.
 */
export function applyTemplate(doc: DoryDocument, activePageId: string, template: DoryDocument, mode: TemplateMode): TemplateApplication | null {
  const index = findPageIndex(doc, activePageId)
  if (index < 0 || template.pages.length === 0) return null

  if (mode === 'replace' || mode === 'replace-resize') {
    const current = doc.pages[index]
    const currentSize = pageSize(doc, current)
    const templateSize = pageSize(template, template.pages[0])
    const target: PageSize = { width: clampSize(templateSize.width), height: clampSize(templateSize.height) }
    const empty = !hasContent(doc)
    const resize = mode === 'replace-resize' || (empty && !sameSize(currentSize, target))
    const size = resize ? target : currentSize
    const first = resize ? ownSizeTemplatePages(template)[0] : fitTemplatePages(template, size)[0]
    const merged: DocPage = { ...first, id: current.id, width: size.width, height: size.height }
    if (current.name) merged.name = current.name
    // An empty design of one size takes the template's size on every page, not on one page only.
    const wholeDesign = resize && empty && isUniform(doc)
    const pages = doc.pages.map((p, i) => (i === index ? merged : wholeDesign ? { ...p, width: size.width, height: size.height } : p))
    return { doc: normalizeSizes({ ...doc, pages }), activePageId: current.id, added: 0 }
  }

  const room = MAX_PAGES - doc.pages.length
  const pages = ownSizeTemplatePages(template)
  const incoming = (mode === 'add' ? pages.slice(0, 1) : pages).slice(0, Math.max(0, room))
  if (incoming.length === 0) return null
  const next = doc.pages.slice()
  next.splice(index + 1, 0, ...incoming)
  return { doc: normalizeSizes({ ...doc, pages: next }), activePageId: incoming[0].id, added: incoming.length }
}
