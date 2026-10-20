/**
 * Rendered pages for a presentation. A page is rasterised once, at the size it is shown (stage size times the device
 * pixel ratio, see `fit.ts`), from the document JSON (never from the editing canvases), after its fonts and images
 * are loaded. Bitmaps are kept for the pages around the current one, so the next page is ready before it is needed;
 * the cache is bounded by count and by pixels, and the least recently used bitmap goes first.
 */
import type { DocPage, DoryDocument } from '@/types/document'
import type { PageSize } from '../engine/docOps'
import { getPageSize } from '../engine/pageSizes'
import type { EditorEngine } from '../engine/editor'
import { renderPageToCanvas } from '../engine/render'

export type RenderFrame = (page: DocPage, size: PageSize, multiplier: number) => Promise<HTMLCanvasElement>

interface Limits {
  /** Most bitmaps kept. */
  entries: number
  /** Most pixels kept in total. */
  pixels: number
}

export const DEFAULT_LIMITS: Limits = { entries: 6, pixels: 60_000_000 }

interface Entry {
  page: DocPage
  canvas: HTMLCanvasElement
  used: number
}

export class FrameCache {
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<string, Promise<HTMLCanvasElement>>()
  private clock = 0
  private generation = 0

  constructor(
    private readonly render: RenderFrame,
    private readonly sizeOf: (page: DocPage) => PageSize,
    private readonly limits: Limits = DEFAULT_LIMITS,
  ) {}

  private key(page: DocPage, width: number): string {
    return `${page.id}@${Math.round(width)}`
  }

  /** The bitmap when it is already rendered, without starting anything. */
  peek(page: DocPage, width: number): HTMLCanvasElement | null {
    const entry = this.entries.get(this.key(page, width))
    if (!entry || entry.page !== page) return null
    entry.used = ++this.clock
    return entry.canvas
  }

  /** The bitmap of `page` that is `width` device pixels wide (rendering it if needed; concurrent calls share the work). */
  get(page: DocPage, width: number): Promise<HTMLCanvasElement> {
    const cached = this.peek(page, width)
    if (cached) return Promise.resolve(cached)
    const key = this.key(page, width)
    const running = this.pending.get(key)
    if (running) return running
    const size = this.sizeOf(page)
    const generation = this.generation
    const work = this.render(page, size, Math.round(width) / size.width)
      .then((canvas) => {
        if (generation === this.generation) this.store(key, page, canvas)
        return canvas
      })
      .finally(() => {
        if (this.pending.get(key) === work) this.pending.delete(key)
      })
    this.pending.set(key, work)
    return work
  }

  /** Starts rendering without waiting (the next page). Failures are left to the call that needs the page. */
  prefetch(page: DocPage | undefined, width: number): void {
    if (page) this.get(page, width).catch(() => undefined)
  }

  /** Forgets every bitmap (the stage changed size); renders that are still running finish but are not kept. */
  clear(): void {
    this.generation++
    this.entries.clear()
    this.pending.clear()
  }

  private store(key: string, page: DocPage, canvas: HTMLCanvasElement): void {
    this.entries.set(key, { page, canvas, used: ++this.clock })
    const total = (): number => [...this.entries.values()].reduce((sum, e) => sum + e.canvas.width * e.canvas.height, 0)
    while (this.entries.size > 1 && (this.entries.size > this.limits.entries || total() > this.limits.pixels)) {
      let oldest: string | null = null
      let oldestUsed = Number.POSITIVE_INFINITY
      for (const [k, e] of this.entries) {
        if (k !== key && e.used < oldestUsed) {
          oldest = k
          oldestUsed = e.used
        }
      }
      if (oldest === null) break
      this.entries.delete(oldest)
    }
  }
}

/** A cache that renders with the editor's own page renderer, so fonts, uploads and effects match the editor and exports. */
export function createFrameCache(editor: EditorEngine, snapshot: DoryDocument): FrameCache {
  return new FrameCache(
    (page, size, multiplier) => renderPageToCanvas(page, size, editor.loadContext, { multiplier }),
    (page) => getPageSize(snapshot, page.id),
  )
}
