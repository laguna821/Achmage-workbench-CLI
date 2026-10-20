/**
 * The comments of the open design: loading, polling, and every change with an optimistic update that rolls back when
 * the server says no. One controller per editor (`commentsOf`); the sidebar, the pins on the artboard and the badge on
 * the top bar all read the same snapshot, so they never disagree.
 *
 * Comments are not part of the Y document: they stay REST. Other people's changes arrive by polling
 * while somebody looks at comments (`watch`), and after every change of our own. The only thing that talks to the
 * server is the adapter's `comments` service, and the only thing that schedules a refresh is `watch`, so a push
 * channel can replace the timer later without touching the UI: call `refresh()` when the channel says "something changed".
 */
import type { CommentViewer, EditorServices } from '@/types/adapter'
import type { CommentInput, CommentMove, CommentT } from '@/types/api'
import type { EditorEngine } from '../engine/editor'
import { t } from '../strings'
import { sameComments } from './commentOps'

export type CommentsService = NonNullable<EditorServices['comments']>
export type CommentsStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface CommentsSnapshot {
  status: CommentsStatus
  /** Oldest first, as the server lists them, with our own unconfirmed changes applied. */
  comments: readonly CommentT[]
  /** `undefined`: the adapter does not say who is looking. `null`: nobody is signed in (or the lookup failed). */
  viewer: CommentViewer | null | undefined
  /** Ids of comments the server has not confirmed yet (shown dimmed). */
  pending: ReadonlySet<string>
}

const NO_PENDING: ReadonlySet<string> = new Set()
const INITIAL: CommentsSnapshot = { status: 'idle', comments: [], viewer: undefined, pending: NO_PENDING }

export const POLL_MS = 15_000
const MAX_BACKOFF_MS = 120_000

export interface CommentsControllerOptions {
  /** Time between polls while somebody watches. */
  pollMs?: number
  now?: () => number
  /** False while the tab is in the background: nothing is fetched then. */
  isVisible?: () => boolean
}

const isTemp = (id: string): boolean => id.startsWith('pending:')

export class CommentsController {
  private service: CommentsService | null = null
  private snap: CommentsSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private watchers = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private lastLoadedAt = 0
  /** Bumped by every local change: a list fetched before a change must not overwrite it. */
  private epoch = 0
  private inflight = 0
  private loading: Promise<void> | null = null
  private stale = false
  private tempSeq = 0
  private readonly pollMs: number
  private readonly now: () => number
  private readonly isVisible: () => boolean
  private detach: (() => void) | null = null

  constructor(options: CommentsControllerOptions = {}) {
    this.pollMs = options.pollMs ?? POLL_MS
    this.now = options.now ?? Date.now
    this.isVisible = options.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  }

  /* ------------------------------------------------------------------ store */

  getSnapshot = (): CommentsSnapshot => this.snap

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private commit(next: Partial<CommentsSnapshot>): void {
    this.snap = { ...this.snap, ...next }
    for (const listener of [...this.listeners]) listener()
  }

  /** The service is what the adapter offers; `null` when comments are not available (guests, view-only links). */
  get available(): boolean {
    return this.service !== null
  }

  /** Points the controller at the adapter's service. A different service (guest → account) starts from scratch. */
  bind(service: CommentsService | null): void {
    if (service === this.service) return
    const hadState = this.snap !== INITIAL
    this.service = service
    this.stopTimer()
    this.failures = 0
    this.lastLoadedAt = 0
    this.stale = false
    this.loading = null
    this.snap = INITIAL
    queueMicrotask(() => {
      if (hadState) for (const listener of [...this.listeners]) listener()
      if (this.watchers > 0) this.kick()
    })
  }

  /* ---------------------------------------------------------------- loading */

  /** Loads once if nothing was loaded yet (the badge on the top bar). */
  ensureLoaded(): void {
    if (this.service && this.snap.status === 'idle') void this.refresh()
  }

  /** Fetches the list now. Concurrent calls share one request; a result that predates a local change is dropped and fetched again. */
  refresh(): Promise<void> {
    const service = this.service
    if (!service) return Promise.resolve()
    if (this.loading) return this.loading
    const epoch = this.epoch
    if (this.snap.status !== 'ready') this.commit({ status: 'loading' })
    const run = (async (): Promise<void> => {
      try {
        const list = await service.list()
        const viewer = await this.lookupViewer(service)
        if (service !== this.service) return
        if (epoch !== this.epoch || this.inflight > 0) {
          this.stale = true
          return
        }
        this.failures = 0
        this.lastLoadedAt = this.now()
        const unchanged = this.snap.status === 'ready' && this.snap.viewer === viewer && sameComments(this.snap.comments, list)
        if (!unchanged) this.commit({ status: 'ready', viewer, comments: sameComments(this.snap.comments, list) ? this.snap.comments : list })
      } catch {
        if (service !== this.service) return
        this.failures += 1
        if (this.snap.status !== 'ready') this.commit({ status: 'error' })
      }
    })()
    this.loading = run
    void run.finally(() => {
      if (this.loading === run) this.loading = null
      if (this.stale && this.inflight === 0 && service === this.service) {
        this.stale = false
        void this.refresh()
      }
    })
    return run
  }

  private async lookupViewer(service: CommentsService): Promise<CommentViewer | null | undefined> {
    if (!service.viewer) return undefined
    if (this.snap.viewer) return this.snap.viewer
    try {
      return await service.viewer()
    } catch {
      return null
    }
  }

  /** Asks who is looking again (after the visitor signed in). */
  async refreshViewer(): Promise<CommentViewer | null | undefined> {
    const service = this.service
    if (!service?.viewer) return undefined
    const viewer = await this.lookupViewer(service)
    if (service === this.service) this.commit({ viewer })
    return viewer
  }

  /* ---------------------------------------------------------------- polling */

  /** Keeps the list fresh while somebody looks at it. Returns the function that stops watching. */
  watch(): () => void {
    this.watchers += 1
    if (this.watchers === 1) {
      this.attach()
      this.kick()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.watchers -= 1
      if (this.watchers === 0) {
        this.stopTimer()
        this.detach?.()
        this.detach = null
      }
    }
  }

  /** Fetches right away when the list is old (or was never fetched), then keeps polling. */
  private kick(): void {
    if (!this.service) return
    if (this.snap.status === 'idle' || this.now() - this.lastLoadedAt >= this.pollMs) void this.refresh().finally(() => this.schedule())
    else this.schedule()
  }

  private schedule(): void {
    this.stopTimer()
    if (this.watchers === 0 || !this.service) return
    const delay = Math.min(MAX_BACKOFF_MS, this.pollMs * 2 ** Math.min(this.failures, 3))
    this.timer = setTimeout(() => {
      this.timer = null
      const next = this.isVisible() ? this.refresh() : Promise.resolve()
      void next.finally(() => this.schedule())
    }, delay)
  }

  private stopTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /** Looking at the tab again, or the network coming back, is a good moment to catch up. */
  private attach(): void {
    if (typeof document === 'undefined') return
    const wake = (): void => {
      if (this.watchers > 0 && this.isVisible() && this.now() - this.lastLoadedAt >= 1000) void this.refresh()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    this.detach = () => {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
    }
  }

  /* -------------------------------------------------------------- mutations */

  private begin(): void {
    this.inflight += 1
    this.epoch += 1
  }

  private end(): void {
    this.inflight -= 1
    this.epoch += 1
    if (this.inflight === 0 && this.stale && !this.loading) {
      this.stale = false
      void this.refresh()
    }
  }

  private edit(change: (list: readonly CommentT[]) => readonly CommentT[], pending?: ReadonlySet<string>): void {
    this.commit({ comments: change(this.snap.comments), ...(pending ? { pending } : {}) })
  }

  private withPending(id: string, on: boolean): ReadonlySet<string> {
    const next = new Set(this.snap.pending)
    if (on) next.add(id)
    else next.delete(id)
    return next
  }

  private need(): CommentsService {
    if (!this.service) throw new Error('Comments are not available')
    return this.service
  }

  find(id: string): CommentT | undefined {
    return this.snap.comments.find((c) => c.id === id)
  }

  /** Adds a comment (a new thread, or a reply when `input.parent` is set). It shows at once, dimmed, and is replaced by the server's copy. */
  async create(input: CommentInput): Promise<CommentT> {
    const service = this.need()
    const parent = input.parent ? this.find(input.parent) : undefined
    const temp: CommentT = {
      id: `pending:${++this.tempSeq}`,
      author: { id: this.snap.viewer?.id ?? '', name: t.comments.you, avatar_url: null },
      body: input.body,
      page_id: parent ? parent.page_id : (input.page_id ?? null),
      x: parent ? parent.x : (input.x ?? null),
      y: parent ? parent.y : (input.y ?? null),
      parent: input.parent ?? null,
      resolved: false,
      created_at: new Date(this.now()).toISOString(),
    }
    this.begin()
    this.edit((list) => [...list, temp], this.withPending(temp.id, true))
    try {
      const made = await service.create(input)
      this.edit((list) => list.map((c) => (c.id === temp.id ? made : c)), this.withPending(temp.id, false))
      return made
    } catch (error) {
      this.edit((list) => list.filter((c) => c.id !== temp.id), this.withPending(temp.id, false))
      throw error
    } finally {
      this.end()
    }
  }

  /** Resolves or re-opens a thread. */
  async setResolved(id: string, resolved: boolean): Promise<void> {
    const service = this.need()
    const before = this.find(id)
    if (!service.resolve || !before || isTemp(id)) return
    this.begin()
    this.edit((list) => list.map((c) => (c.id === id ? { ...c, resolved } : c)))
    try {
      const next = await service.resolve(id, resolved)
      this.edit((list) => list.map((c) => (c.id === id ? next : c)))
    } catch (error) {
      this.edit((list) => list.map((c) => (c.id === id ? { ...c, resolved: before.resolved } : c)))
      throw error
    } finally {
      this.end()
    }
  }

  /** Deletes a comment; deleting a thread's first comment deletes the thread. */
  async remove(id: string): Promise<void> {
    const service = this.need()
    const target = this.find(id)
    if (!service.remove || !target || isTemp(id)) return
    const gone = this.snap.comments.filter((c) => c.id === id || c.parent === id)
    const goneIds = new Set(gone.map((c) => c.id))
    this.begin()
    this.edit((list) => list.filter((c) => !goneIds.has(c.id)))
    try {
      await service.remove(id)
    } catch (error) {
      this.edit((list) => [...list, ...gone].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id)))
      throw error
    } finally {
      this.end()
    }
  }

  /** Moves a thread's pin; its replies follow. */
  async move(id: string, to: CommentMove): Promise<void> {
    const service = this.need()
    const before = this.find(id)
    if (!service.move || !before || before.parent || isTemp(id)) return
    const apply = (anchor: Pick<CommentT, 'page_id' | 'x' | 'y'>) => (list: readonly CommentT[]): CommentT[] => list.map((c) => (c.id === id || c.parent === id ? { ...c, ...anchor } : c))
    this.begin()
    this.edit(apply(to))
    try {
      const next = await service.move(id, to)
      this.edit((list) => list.map((c) => (c.id === id ? next : c)))
    } catch (error) {
      this.edit(apply({ page_id: before.page_id, x: before.x, y: before.y }))
      throw error
    } finally {
      this.end()
    }
  }
}

const controllers = new WeakMap<EditorEngine, CommentsController>()

/** The controller of an editor, pointed at the service its adapter offers right now. */
export function commentsOf(editor: EditorEngine): CommentsController {
  let controller = controllers.get(editor)
  if (!controller) {
    controller = new CommentsController()
    controllers.set(editor, controller)
  }
  controller.bind(editor.adapter.services.comments ?? null)
  return controller
}
