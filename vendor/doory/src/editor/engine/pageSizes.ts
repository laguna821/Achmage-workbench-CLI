/**
 * Page sizes of a design whose pages may differ (a poster, a flyer and a card in one document).
 *
 * The rules:
 *  - the size of a page is `page.width ?? doc.width` by `page.height ?? doc.height`, each side on its own;
 *  - the document size is the size of the first page and the default of a page without an override;
 *  - the editor writes the canonical form (`normalizeSizes`): only pages that differ from the document size carry
 *    an override, and then both sides. Reading accepts every form, so older documents keep their meaning.
 *
 * Everything here is pure. Code that needs the size of a page goes through `getPageSize` (a document and an id) or
 * `pageSize` (a document and a page); nothing outside this module and `docOps` reads `doc.width` / `doc.height`
 * (`pageSizes.test.ts` enforces that).
 */
import { type DocPage, type DocUnit, type DoryDocument, MAX_DIMENSION_PX } from '@/types/document'
import { type PageSize, pageSize } from './docOps'
import { formatUnit } from './units'

export type { PageSize } from './docOps'

export const sameSize = (a: PageSize, b: PageSize): boolean => a.width === b.width && a.height === b.height

const clampSide = (n: number): number => Math.min(MAX_DIMENSION_PX, Math.max(1, Math.round(n)))

/** The size of the page with this id; the document size when there is no such page. */
export function getPageSize(doc: DoryDocument, pageId: string): PageSize {
  const page = doc.pages.find((p) => p.id === pageId)
  return page ? pageSize(doc, page) : { width: doc.width, height: doc.height }
}

/** Sizes of all pages, in order. */
export function pageSizes(doc: DoryDocument): PageSize[] {
  return doc.pages.map((p) => pageSize(doc, p))
}

/** True when every page has the same size (always true for a single page). */
export function isUniform(doc: DoryDocument): boolean {
  const first = pageSize(doc, doc.pages[0])
  return doc.pages.every((p) => sameSize(pageSize(doc, p), first))
}

/** The widest page width: what "fit width" makes fit the viewport. */
export function widestPage(doc: DoryDocument): number {
  return Math.max(...pageSizes(doc).map((s) => s.width))
}

/**
 * The size a page inserted at `index` starts with: the page before it, or the page it pushes down when it goes first.
 * A new page therefore looks like its neighbour, which in a design of one size is the design size.
 */
export function newPageSize(doc: DoryDocument, index: number): PageSize {
  const neighbour = doc.pages[Math.min(doc.pages.length - 1, Math.max(0, index - 1))]
  return neighbour ? pageSize(doc, neighbour) : { width: doc.width, height: doc.height }
}

/**
 * Rewrites the sizes of `doc` into the canonical form without changing the size of any page: the document size
 * becomes the size of the first page, a page of that size carries no override, any other page carries both sides.
 * Returns `doc` itself when it is already canonical, so history and canvases see no change.
 */
export function normalizeSizes(doc: DoryDocument): DoryDocument {
  if (doc.pages.length === 0) return doc
  const first = pageSize(doc, doc.pages[0])
  const width = clampSide(first.width)
  const height = clampSide(first.height)
  let changed = width !== doc.width || height !== doc.height
  const pages = doc.pages.map((page) => {
    const size = pageSize(doc, page)
    const differs = size.width !== width || size.height !== height
    const canonical = differs ? page.width === size.width && page.height === size.height : page.width === undefined && page.height === undefined
    if (canonical) return page
    changed = true
    const next: DocPage = { ...page }
    if (differs) {
      next.width = clampSide(size.width)
      next.height = clampSide(size.height)
    } else {
      delete next.width
      delete next.height
    }
    return next
  })
  return changed ? { ...doc, width, height, pages } : doc
}

/** Gives one page the size `size` (content untouched) and returns the canonical document. */
export function withPageSize(doc: DoryDocument, pageId: string, size: PageSize): DoryDocument {
  const index = doc.pages.findIndex((p) => p.id === pageId)
  if (index < 0) return doc
  const width = clampSide(size.width)
  const height = clampSide(size.height)
  const pages = doc.pages.slice()
  pages[index] = { ...doc.pages[index], width, height }
  return normalizeSizes({ ...doc, pages })
}

/** Box of at most `maxWidth` x `maxHeight` px with the page's proportions (strip thumbnails, previews). */
export function fitBox(size: PageSize, maxWidth: number, maxHeight: number): PageSize {
  const k = Math.min(maxWidth / Math.max(1, size.width), maxHeight / Math.max(1, size.height))
  return { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) }
}

/** "1080 × 1080 px": the size as the design shows it (the display unit; storage is always px). */
export function formatSize(size: PageSize, unit: DocUnit): string {
  return `${formatUnit(size.width, unit)} × ${formatUnit(size.height, unit)} ${unit}`
}
