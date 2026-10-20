import { widestPage } from '../pageSizes'
import { clampZoom, fitZoomForPages, nextZoomStep } from '../zoom'
import type { EditorEngine } from '../editor'

/** Implemented by the workspace component so engine commands can scroll and measure. */
export interface ViewportController {
  scrollToPage(pageId: string, behavior?: ScrollBehavior): void
  viewportSize(): { width: number; height: number }
  /** Recomputes page layout and live canvas windows (after zoom, resize or document changes). */
  relayout(): void
  /** The artboard of a page on screen, in client px; null while the page has no slot. */
  artboardRect(pageId: string): { left: number; top: number; width: number; height: number } | null
}

/**
 * Where a page is on screen. `left`/`top`/`width`/`height` are client px (the artboard, at the current zoom);
 * `zoom` is client px per page px; `pageWidth`/`pageHeight` are the page's own size in page px. Pages of different
 * sizes each get their own rectangle, so a point can be mapped to the page it is on, whatever that page's size.
 */
export interface PageRect {
  pageId: string
  left: number
  top: number
  width: number
  height: number
  zoom: number
  pageWidth: number
  pageHeight: number
}

export interface ZoomAnchor {
  /** Client coordinates of the point that should stay put while zooming. */
  clientX: number
  clientY: number
}

export class ViewApi {
  private controller: ViewportController | null = null
  private anchor: ZoomAnchor | null = null

  constructor(private readonly engine: EditorEngine) {}

  setController(controller: ViewportController | null): void {
    this.controller = controller
  }

  /** Reads and clears the anchor for the zoom change currently being applied. */
  consumeAnchor(): ZoomAnchor | null {
    const a = this.anchor
    this.anchor = null
    return a
  }

  relayout(): void {
    this.controller?.relayout()
  }

  setZoom(zoom: number, anchor?: ZoomAnchor): void {
    if (!Number.isFinite(zoom)) return
    const z = clampZoom(zoom)
    this.anchor = anchor ?? null
    this.engine.store.setState({ zoom: z, zoomMode: 'custom' })
  }

  zoomIn(anchor?: ZoomAnchor): void {
    this.setZoom(nextZoomStep(this.engine.state.zoom, 1), anchor)
  }

  zoomOut(anchor?: ZoomAnchor): void {
    this.setZoom(nextZoomStep(this.engine.state.zoom, -1), anchor)
  }

  actualSize(): void {
    this.setZoom(1)
  }

  fit(mode: 'fit-width' | 'fit-page'): void {
    const size = this.controller?.viewportSize()
    if (!size) {
      this.engine.store.setState({ zoomMode: mode })
      return
    }
    const doc = this.engine.state.doc
    const page = this.engine.pageSizeOf(this.engine.state.activePageId)
    this.engine.store.setState({ zoom: fitZoomForPages(size, page, widestPage(doc), mode), zoomMode: mode })
  }

  /** Recomputes the zoom while a fit mode is active (viewport or page size changed). */
  refit(): void {
    const mode = this.engine.state.zoomMode
    if (mode !== 'custom') this.fit(mode)
  }

  scrollToPage(pageId: string, behavior: ScrollBehavior = 'smooth'): void {
    this.controller?.scrollToPage(pageId, behavior)
  }

  /** The on-screen rectangle of a page (null when the page is unknown or the workspace is not mounted). */
  pageRect(pageId: string): PageRect | null {
    const box = this.controller?.artboardRect(pageId)
    if (!box || !this.engine.getPage(pageId)) return null
    const size = this.engine.pageSizeOf(pageId)
    return { pageId, ...box, zoom: this.engine.state.zoom, pageWidth: size.width, pageHeight: size.height }
  }

  /** A client point in the coordinates of a page (page px, may lie outside the page); null without a rectangle. */
  clientToPage(pageId: string, clientX: number, clientY: number): { x: number; y: number } | null {
    const r = this.pageRect(pageId)
    return r ? { x: (clientX - r.left) / r.zoom, y: (clientY - r.top) / r.zoom } : null
  }

  /** A point of a page (page px) as a client point; null without a rectangle. */
  pageToClient(pageId: string, x: number, y: number): { x: number; y: number } | null {
    const r = this.pageRect(pageId)
    return r ? { x: r.left + x * r.zoom, y: r.top + y * r.zoom } : null
  }

  /** The page under a client point, if any (pages of different sizes are tested against their own rectangles). */
  pageAt(clientX: number, clientY: number): string | null {
    for (const page of this.engine.state.doc.pages) {
      const r = this.pageRect(page.id)
      if (r && clientX >= r.left && clientX <= r.left + r.width && clientY >= r.top && clientY <= r.top + r.height) return page.id
    }
    return null
  }
}
