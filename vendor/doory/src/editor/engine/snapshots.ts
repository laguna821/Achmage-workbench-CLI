/**
 * Page bitmaps for pages that have no live canvas (virtualised workspace) and for the page strip.
 * Snapshots are rendered lazily, one at a time, off the critical path, and cached by the immutable
 * `DocPage` reference — editing a page naturally invalidates its snapshot.
 *
 * Rendering a page costs as much as loading it, so the queue only does work somebody still waits for: a request
 * that every consumer has given up on (the page scrolled away, the strip closed) is skipped, and the newest request
 * goes first, so the page now in view is not stuck behind the ones that were scrolled past. Bitmaps of older versions of a
 * page are released when newer ones exist, so a long session of edits does not pile up blobs.
 */
import type { DocPage } from '@/types/document'
import { renderPageToCanvas, canvasToBlob } from './render'
import type { LoadContext } from './serialization'

export const SNAPSHOT_WIDTH = 640

/** How many versions of one page keep their bitmap (the latest, the one before, and one more for an undo). */
export const VERSIONS_KEPT = 3

interface Entry {
  url: Promise<string>
  /** Consumers that still want the bitmap; the render is skipped when none is left by the time it would start. */
  waiters: number
}

interface Made {
  url: string
  page: DocPage
  key: string
}

type Listener = () => void

export class PageSnapshots {
  private readonly cache = new WeakMap<DocPage, Map<string, Entry>>()
  private readonly urls = new Set<string>()
  private readonly made = new Map<string, Made[]>()
  private readonly listeners = new Set<Listener>()
  /** Requests that have not started, the newest last. */
  private readonly queue: (() => Promise<void>)[] = []
  private running = false
  private disposed = false

  constructor(private readonly ctx: () => LoadContext) {}

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Resolves with a blob: URL of the page image (width <= SNAPSHOT_WIDTH px), or with '' when nobody wanted it any more.
   * `signal` aborts this consumer's interest: a render nobody waits for is not started.
   */
  get(page: DocPage, size: { width: number; height: number }, signal?: AbortSignal): Promise<string> {
    const key = `${size.width}x${size.height}`
    let bySize = this.cache.get(page)
    if (!bySize) {
      bySize = new Map()
      this.cache.set(page, bySize)
    }
    let entry = bySize.get(key)
    if (!entry) {
      const made: Entry = { url: Promise.resolve(''), waiters: 0 }
      made.url = this.enqueue(made, () => this.render(page, size, key))
      made.url.then(
        (url) => {
          if (url === '') bySize?.delete(key)
        },
        () => bySize?.delete(key),
      )
      bySize.set(key, made)
      entry = made
    }
    entry.waiters += 1
    signal?.addEventListener('abort', () => (entry.waiters -= 1), { once: true })
    return entry.url
  }

  /** Stores an already rendered bitmap (e.g. captured from a live canvas when it unmounts). */
  put(page: DocPage, size: { width: number; height: number }, url: string): void {
    let bySize = this.cache.get(page)
    if (!bySize) {
      bySize = new Map()
      this.cache.set(page, bySize)
    }
    this.urls.add(url)
    bySize.set(`${size.width}x${size.height}`, { url: Promise.resolve(url), waiters: 1 })
  }

  private enqueue(entry: Entry, task: () => Promise<string>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queue.push(async () => {
        if (entry.waiters <= 0 || this.disposed) {
          resolve('')
          return
        }
        try {
          resolve(await task())
        } catch (err) {
          reject(err)
        }
      })
      this.pump()
    })
  }

  /** Runs the queue one request at a time, giving the browser a turn in between. */
  private pump(): void {
    if (this.running) return
    this.running = true
    const next = (): void => {
      const job = this.queue.pop()
      if (!job) {
        this.running = false
        return
      }
      void job().finally(() => setTimeout(next, 0))
    }
    setTimeout(next, 0)
  }

  private async render(page: DocPage, size: { width: number; height: number }, key: string): Promise<string> {
    const multiplier = Math.min(1, SNAPSHOT_WIDTH / size.width)
    const canvas = await renderPageToCanvas(page, size, this.ctx(), { multiplier })
    if (this.disposed) return ''
    const blob = await canvasToBlob(canvas, 'image/webp', 0.85)
    const url = URL.createObjectURL(blob)
    this.urls.add(url)
    this.keep({ url, page, key })
    for (const l of [...this.listeners]) l()
    return url
  }

  /** Remembers a bitmap and releases those of older versions of the same page beyond `VERSIONS_KEPT`. */
  private keep(made: Made): void {
    const list = this.made.get(made.page.id) ?? []
    list.push(made)
    this.made.set(made.page.id, list)
    while (list.length > VERSIONS_KEPT) {
      const old = list.shift()
      if (!old) break
      URL.revokeObjectURL(old.url)
      this.urls.delete(old.url)
      this.cache.get(old.page)?.delete(old.key)
    }
  }

  dispose(): void {
    this.disposed = true
    this.queue.length = 0
    for (const url of this.urls) URL.revokeObjectURL(url)
    this.urls.clear()
    this.made.clear()
    this.listeners.clear()
  }
}
