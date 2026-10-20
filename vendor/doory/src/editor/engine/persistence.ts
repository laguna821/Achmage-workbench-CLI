/**
 * Autosave and save state. The engine never knows *where* a design goes — it calls `adapter.save`:
 *
 *  - debounced ~1.5 s after the last change;
 *  - immediately when the page is hidden or about to unload while dirty;
 *  - never two saves at once: edits made during a save in flight queue exactly one follow-up save of the
 *    latest state, so nothing is lost;
 *  - `RevisionConflictError` (by `name`) → `conflict` state + callbacks (the shell decides what to do).
 */
import type { SaveState } from '@/types/adapter'
import type { DoryDocument } from '@/types/document'
import type { EditorEngine } from './editor'
import { renderPageToCanvas, canvasToBlob } from './render'
import { pageSize } from './docOps'
import { assertSaveable } from './assets'
import { t } from '../strings'

export const AUTOSAVE_DELAY_MS = 1500
export const THUMBNAIL_WIDTH = 480

export function isRevisionConflict(err: unknown): boolean {
  return err instanceof Error && err.name === 'RevisionConflictError'
}

export interface PersistenceCallbacks {
  onSaveStateChange?: (state: SaveState) => void
  onConflict?: () => void
  /** A save was refused because a live-editing room holds the design (`409 use_realtime`): join the room. */
  onUseRealtime?: () => void
}

/** The server refuses document saves of a design that has a live room. */
export function isUseRealtime(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'use_realtime'
}

/**
 * While a live-editing room is connected the server stores the document, so the controller stops saving it: only a
 * new title still goes out (`saveTitle`), and "save now" asks the room to write the design (`flush`).
 */
export interface LiveDelegate {
  saveTitle(title: string): Promise<void>
  flush(): Promise<void>
  /** Stores the first page's thumbnail; absent for people who may not (only the owner draws it). */
  saveThumbnail?(image: Blob): Promise<void>
}

const TITLE_DELAY_MS = 800
/** While live, the thumbnail follows the first page this long after the last change, and at most this often. */
const LIVE_THUMBNAIL_DELAY_MS = 5_000
const LIVE_THUMBNAIL_EVERY_MS = 15_000

export class PersistenceController {
  private timer: ReturnType<typeof setTimeout> | null = null
  private saving: Promise<void> | null = null
  private again = false
  private lastSavedDoc: DoryDocument
  private lastSavedTitle: string
  private thumbnailPage: unknown = null
  private callbacks: PersistenceCallbacks = {}
  private disposers: (() => void)[] = []
  private disposed = false
  private live: LiveDelegate | null = null
  private titleTimer: ReturnType<typeof setTimeout> | null = null
  private thumbTimer: ReturnType<typeof setTimeout> | null = null
  private lastThumbnailAt = 0

  constructor(private readonly engine: EditorEngine) {
    this.lastSavedDoc = engine.state.doc
    this.lastSavedTitle = engine.state.title
  }

  /** Starts listening for changes and page lifecycle events. */
  start(callbacks: PersistenceCallbacks): void {
    this.disposed = false
    this.callbacks = callbacks
    if (this.engine.readOnly) return
    const unsub = this.engine.store.subscribe((state, prev) => {
      if (this.live) {
        if (state.doc.pages[0] !== prev.doc.pages[0]) this.scheduleLiveThumbnail()
        if (state.title !== prev.title) this.onChange()
        return
      }
      if (state.doc !== prev.doc || state.title !== prev.title) this.onChange()
    })
    this.disposers.push(unsub)
    const flush = (): void => {
      if (this.isDirty()) void this.flush()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    this.disposers.push(() => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
    })
  }

  /** The design as the server last stored it through this controller (as it was opened until the first save). */
  get savedDocument(): DoryDocument {
    return this.lastSavedDoc
  }

  isDirty(): boolean {
    const s = this.engine.state
    if (this.live) return s.title !== this.lastSavedTitle
    return s.doc !== this.lastSavedDoc || s.title !== this.lastSavedTitle
  }

  /** Hands the document over to a live-editing room (or takes it back with `null`: the next change saves normally). */
  setLive(live: LiveDelegate | null): void {
    this.live = live
    if (this.timer) clearTimeout(this.timer)
    if (this.titleTimer) clearTimeout(this.titleTimer)
    if (this.thumbTimer) clearTimeout(this.thumbTimer)
    this.timer = null
    this.titleTimer = null
    this.thumbTimer = null
    if (!live && this.isDirty()) this.onChange()
  }

  /** Keeps the dashboard's thumbnail in step with the first page while the room holds the design. */
  private scheduleLiveThumbnail(): void {
    if (!this.live?.saveThumbnail || this.thumbTimer || this.disposed) return
    const wait = Math.max(LIVE_THUMBNAIL_DELAY_MS, this.lastThumbnailAt + LIVE_THUMBNAIL_EVERY_MS - Date.now())
    this.thumbTimer = setTimeout(() => {
      this.thumbTimer = null
      void this.saveLiveThumbnail()
    }, wait)
  }

  private async saveLiveThumbnail(): Promise<void> {
    const live = this.live
    if (!live?.saveThumbnail) return
    const doc = this.engine.state.doc
    const image = await this.thumbnail(doc)
    if (!image) return
    try {
      await live.saveThumbnail(image)
      this.thumbnailPage = doc.pages[0]
      this.lastThumbnailAt = Date.now()
    } catch {
      /* the thumbnail is a nicety: the next change tries again */
    }
  }

  /** A title that came from the server is the saved one; it must not be sent back. */
  adoptTitle(title: string): void {
    this.lastSavedTitle = title
  }

  private async saveLiveTitle(): Promise<void> {
    const live = this.live
    if (!live) return
    const title = this.engine.state.title
    if (title === this.lastSavedTitle) return
    try {
      await live.saveTitle(title)
      this.lastSavedTitle = title
    } catch {
      this.engine.toast(t.collab.titleNotSaved, 'error')
    }
  }

  private setState(state: SaveState): void {
    this.engine.store.setState({ save: state, conflict: state.status === 'conflict' })
    this.callbacks.onSaveStateChange?.(state)
  }

  private onChange(): void {
    if (this.disposed || this.engine.readOnly) return
    if (this.live) {
      if (this.titleTimer) clearTimeout(this.titleTimer)
      this.titleTimer = setTimeout(() => void this.saveLiveTitle(), TITLE_DELAY_MS)
      return
    }
    if (this.engine.state.save.status === 'conflict') return
    if (!this.saving) this.setState({ status: 'dirty' })
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_DELAY_MS)
  }

  /** Saves immediately (also the manual "retry" / Ctrl+S path). Resolves when the latest state is saved. */
  async saveNow(): Promise<void> {
    if (this.engine.readOnly) return
    if (this.live) {
      await this.saveLiveTitle()
      await this.live.flush()
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.engine.state.save.status === 'conflict') this.engine.store.setState({ conflict: false })
    await this.flush(true)
  }

  private async flush(force = false): Promise<void> {
    if (this.live) {
      await this.saveLiveTitle()
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.saving) {
      this.again = true
      await this.saving
      return
    }
    if (!force && !this.isDirty()) return
    if (!force && this.engine.state.save.status === 'conflict') return
    const run = this.perform().finally(() => {
      this.saving = null
    })
    this.saving = run
    await run
    if (this.again && !this.disposed) {
      this.again = false
      if (this.isDirty() && this.engine.state.save.status !== 'conflict' && this.engine.state.save.status !== 'error') await this.flush()
    }
  }

  private async perform(): Promise<void> {
    const engine = this.engine
    const snapshotDoc = engine.state.doc
    const snapshotTitle = engine.state.title
    this.setState({ status: 'saving' })
    try {
      const document = await engine.assets.persistInline(snapshotDoc)
      assertSaveable(document)
      const thumbnail = await this.thumbnail(snapshotDoc)
      const result = await engine.adapter.save({ document, title: snapshotTitle, thumbnail })
      this.lastSavedDoc = snapshotDoc
      this.lastSavedTitle = snapshotTitle
      if (thumbnail || this.thumbnailPage === null) this.thumbnailPage = snapshotDoc.pages[0]
      const stillDirty = this.isDirty()
      this.setState(
        stillDirty
          ? { status: 'dirty' }
          : this.engine.state.mode === 'guest'
            ? { status: 'local', savedAt: result.savedAt }
            : { status: 'saved', savedAt: result.savedAt },
      )
      if (stillDirty) this.onChange()
    } catch (err) {
      if (isUseRealtime(err)) {
        this.setState({ status: 'dirty' })
        this.callbacks.onUseRealtime?.()
      } else if (isRevisionConflict(err)) {
        this.setState({ status: 'conflict' })
        this.callbacks.onConflict?.()
      } else {
        this.setState({ status: 'error', message: err instanceof Error ? err.message : 'The design could not be saved.' })
      }
    }
  }

  /** First-page thumbnail (~480 px WebP/PNG). Skipped when page 1 has not changed since the last one. */
  private async thumbnail(doc: DoryDocument): Promise<Blob | undefined> {
    const first = doc.pages[0]
    if (this.thumbnailPage === first) return undefined
    try {
      const size = pageSize(doc, first)
      const canvas = await renderPageToCanvas(first, size, this.engine.loadContext, { multiplier: Math.min(1, THUMBNAIL_WIDTH / size.width) })
      return await canvasToBlob(canvas, 'image/webp', 0.85)
    } catch {
      return undefined
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.titleTimer) clearTimeout(this.titleTimer)
    if (this.thumbTimer) clearTimeout(this.thumbTimer)
    for (const off of this.disposers) off()
    this.disposers = []
  }
}
