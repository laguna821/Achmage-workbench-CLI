/**
 * The binding between the editor's document and the shared Y document.
 *
 * - Local edits (`writeLocal`) become one Y transaction with the local origin that carries only the properties
 *   the user changed (diff.ts).
 * - Everything that arrives with another origin (the server, the undo manager) is collected per animation frame,
 *   read into a new `DoryDocument` that shares every untouched reference with the previous one (schema.ts) and
 *   handed to the engine, which updates only the canvases and objects that changed.
 * - The Y document starts empty: the server's copy arrives with the first sync (`synced`). Edits made before it
 *   are rebased onto it, so nothing the user did while connecting is lost.
 */
import * as Y from 'yjs'
import type { DocObject, DocPage, DoryDocument } from '@/types/document'
import { withUniqueObjectIds, writeChanges } from './diff'
import { type Dirty, collectPageEvents, emptyDirty, hasBrokenSize, hasNoPages, isClean, readDocument, restoreBlankPage, restoreSize, rootsOf, type YRoots } from './schema'

/** Origin of the Y transactions that carry the user's own edits (tracked by the undo manager). */
export const LOCAL_ORIGIN = Symbol('doory.local')
/** Origin of local writes that must not become undo steps (the design was replaced). */
export const REPLACE_ORIGIN = Symbol('doory.replace')

export interface BindingHost {
  /** The document the editor shows right now. */
  document(): DoryDocument
  /** The design as the server has it from the editor's own saves: what edits made before the room opened are measured against. */
  saved(): DoryDocument
  /** Shows a document that came from elsewhere; resolves when the canvases follow. */
  apply(doc: DoryDocument): Promise<void>
  /** Turns inline images (`blob:`, big `data:`) into uploaded assets. */
  persistInline(doc: DoryDocument): Promise<DoryDocument>
  /** The shared state cannot be turned into a design. */
  onInvalid(): void
  /** Local-only images could not be uploaded. */
  onUploadFailed(): void
  /** About to write the objects whose images were uploaded (they belong to the user's last edit). */
  beginUpload(): void
  /** The user may change the design (a viewer must not put a page back). */
  canWrite(): boolean
}

const FRAME_FALLBACK_MS = 120

export class DocBinding {
  readonly roots: YRoots
  private dirty: Dirty = emptyDirty()
  private base: DoryDocument
  private synced = false
  private scheduled = false
  private frame = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  /** Objects the editor has but has not shared yet because they still reference local-only images. */
  private readonly held = new Set<string>()
  private uploading = false
  private readonly cleanups: (() => void)[] = []

  constructor(
    private readonly ydoc: Y.Doc,
    private readonly host: BindingHost,
  ) {
    this.roots = rootsOf(ydoc)
    this.base = host.saved()
    const onPages = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction): void => {
      if (this.isOwn(transaction.origin)) return
      collectPageEvents(this.dirty, events, this.roots.pages)
      this.changed(transaction.origin)
    }
    const onMeta = (_event: unknown, transaction: Y.Transaction): void => {
      if (this.isOwn(transaction.origin)) return
      this.dirty.meta = true
      this.changed(transaction.origin)
    }
    const onOrder = (_event: unknown, transaction: Y.Transaction): void => {
      if (this.isOwn(transaction.origin)) return
      this.dirty.pages = true
      this.changed(transaction.origin)
    }
    this.roots.pages.observeDeep(onPages)
    this.roots.meta.observe(onMeta)
    this.roots.pageOrder.observe(onOrder)
    this.cleanups.push(
      () => this.roots.pages.unobserveDeep(onPages),
      () => this.roots.meta.unobserve(onMeta),
      () => this.roots.pageOrder.unobserve(onOrder),
    )
  }

  private isOwn(origin: unknown): boolean {
    return origin === LOCAL_ORIGIN || origin === REPLACE_ORIGIN
  }

  /* ---------------------------------------------------------- remote → editor */

  private changed(_origin: unknown): void {
    if (this.synced) this.schedule()
  }

  private schedule(): void {
    if (this.scheduled || this.stopped) return
    this.scheduled = true
    const run = (): void => {
      if (!this.scheduled) return
      this.scheduled = false
      if (this.frame) cancelAnimationFrame(this.frame)
      if (this.timer) clearTimeout(this.timer)
      this.frame = 0
      this.timer = null
      void this.flush()
    }
    this.frame = requestAnimationFrame(run)
    this.timer = setTimeout(run, FRAME_FALLBACK_MS)
  }

  /** Reads what changed in the shared state and shows it. Resolves when the canvases follow. */
  async flush(): Promise<void> {
    if (this.stopped || !this.synced || isClean(this.dirty)) return
    const dirty = this.dirty
    const current = this.host.document()
    const read = this.read(current, dirty)
    if (!read) {
      // Not a design right now (a change is still on its way, or pieces of one are). What changed is not forgotten:
      // the next time something arrives the whole state is read again.
      this.dirty.all = true
      return
    }
    this.dirty = emptyDirty()
    const next = this.keepHeld(read, current)
    if (next !== current) await this.host.apply(next)
  }

  /**
   * Reads the shared state. If it is not a design, a writer puts back what is missing: a blank page when every page was removed
   * at once (two people each removed one of two pages), the size the editor knows when the size was overwritten with something
   * that is not a number (an undo, a faulty client, a hostile one). The editor never shows such a design and the server could
   * not save it.
   */
  private read(current: DoryDocument, dirty: Dirty | null): DoryDocument | null {
    const read = readDocument(this.roots, current, dirty)
    if (read || !this.host.canWrite()) return read
    const sizeLost = hasBrokenSize(this.roots)
    if (sizeLost) this.ydoc.transact(() => restoreSize(this.roots, current), REPLACE_ORIGIN)
    const pagesLost = hasNoPages(this.roots)
    if (pagesLost) this.ydoc.transact(() => restoreBlankPage(this.roots), REPLACE_ORIGIN)
    return sizeLost || pagesLost ? readDocument(this.roots, current, null) : null
  }

  /** Reads the whole shared state again (after the first sync, or when the design was replaced under us). */
  async resync(): Promise<void> {
    if (this.stopped || !this.synced) return
    const current = this.host.document()
    const read = this.read(current, null)
    if (!read) {
      this.dirty.all = true
      return
    }
    this.dirty = emptyDirty()
    const next = this.keepHeld(read, current)
    if (next !== current) await this.host.apply(next)
  }

  /** Objects that wait for their upload are not in the shared state; the editor keeps them. */
  private keepHeld(read: DoryDocument, current: DoryDocument): DoryDocument {
    if (this.held.size === 0) return read
    let pages: DocPage[] | null = null
    read.pages.forEach((page, index) => {
      const mine = current.pages.find((p) => p.id === page.id)
      if (!mine) return
      const have = new Set(page.objects.map((o) => o.id))
      const missing = mine.objects.filter((o) => this.held.has(o.id) && !have.has(o.id))
      if (missing.length === 0) return
      const objects: DocObject[] = page.objects.slice()
      for (const object of missing) {
        const at = mine.objects.indexOf(object)
        const before = mine.objects.slice(0, at).reverse().find((o) => objects.some((x) => x.id === o.id))
        objects.splice(before ? objects.findIndex((x) => x.id === before.id) + 1 : 0, 0, object)
      }
      pages ??= read.pages.slice()
      pages[index] = { ...page, objects }
    })
    return pages ? { ...read, pages } : read
  }

  /* ---------------------------------------------------------- editor → shared */

  get isSynced(): boolean {
    return this.synced
  }

  /** The user's edit: `prev` became `next`. Before the first sync nothing is written (see `synced`). */
  writeLocal(prev: DoryDocument, next: DoryDocument, origin: symbol = LOCAL_ORIGIN): void {
    if (!this.synced || this.stopped) return
    const shared = withUniqueObjectIds(prev, next)
    this.ydoc.transact(() => writeChanges(this.roots, prev, shared, this.held), origin)
    // The editor is about to take `next` as its design (this is called from its commit); once it has, it takes the one that was shared.
    if (shared !== next) queueMicrotask(() => (!this.stopped && this.host.document() === next ? void this.host.apply(shared) : undefined))
    if (this.held.size > 0) void this.uploadHeld()
  }

  private async uploadHeld(): Promise<void> {
    if (this.uploading) return
    this.uploading = true
    try {
      while (this.held.size > 0 && !this.stopped) {
        const before = this.host.document()
        const persisted = await this.host.persistInline(before)
        if (this.stopped) return
        if (persisted === before) {
          // Nothing left to upload: whatever is held cannot be shared, so it must not block the editor.
          this.held.clear()
          return
        }
        if (this.host.document() !== before) continue
        await this.host.apply(persisted)
        this.host.beginUpload()
        this.writeLocal(before, persisted)
      }
    } catch {
      this.held.clear()
      this.host.onUploadFailed()
    } finally {
      this.uploading = false
    }
  }

  /* ---------------------------------------------------------------- lifecycle */

  /**
   * The server's copy has been applied. Edits made since the editor opened are written on top of it, then the
   * editor takes over the merged state.
   */
  synchronised(): void {
    if (this.synced || this.stopped) return
    const current = this.host.document()
    const read = this.read(current, null)
    if (!read) {
      this.host.onInvalid()
      return
    }
    this.synced = true
    this.dirty = emptyDirty()
    if (current === this.base) {
      if (read !== current) void this.host.apply(read)
      return
    }
    this.ydoc.transact(() => writeChanges(this.roots, this.base, withUniqueObjectIds(this.base, current), this.held), LOCAL_ORIGIN)
    if (this.held.size > 0) void this.uploadHeld()
    void this.resync()
  }

  stop(): void {
    this.stopped = true
    if (this.frame) cancelAnimationFrame(this.frame)
    if (this.timer) clearTimeout(this.timer)
    this.frame = 0
    this.timer = null
    for (const undo of this.cleanups.splice(0)) undo()
  }
}
