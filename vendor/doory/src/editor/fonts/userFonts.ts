/**
 * The fonts the user can pick besides the catalog: their own uploads (account modes) or the families that came
 * with a shared design. One instance per editor; the font picker, the Brand panel, the upload dialog and the
 * font loader all read the same state, so an upload shows up everywhere at once.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { EditorServices, UserFontsService } from '@/types/adapter'
import type { FontFamily, UserFontUploadInput, UserFontUploadOptions } from '@/types/api'
import { useEditor } from '../context'
import type { FontManager } from '../engine/fonts'
import { t } from '../strings'

export type UserFontsStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface UserFontsState {
  status: UserFontsStatus
  /** Sorted by family name. */
  families: readonly FontFamily[]
  /** Why the last fetch failed, in words for the user (the server's message when it gave one). */
  error: string | null
  /** The user can upload and delete (false for visitors of a shared link, who only get the design's fonts). */
  canManage: boolean
  /** Where the families come from: the user's library or a shared design. */
  source: 'mine' | 'shared' | 'none'
}

type Listener = () => void

const byName = (a: FontFamily, b: FontFamily): number => a.family.localeCompare(b.family)

export class UserFonts {
  private state: UserFontsState = { status: 'ready', families: [], error: null, canManage: false, source: 'none' }
  private service: UserFontsService | null = null
  private attached: EditorServices['fonts'] | null = null
  private pending: Promise<void> | null = null
  private generation = 0
  private readonly listeners = new Set<Listener>()

  constructor(private readonly manager: FontManager) {
    manager.setUserFontsReady(() => this.ensureLoaded())
  }

  /** Connects the store to the adapter's font services (again after a guest became a signed-in user). */
  attach(fonts: EditorServices['fonts']): void {
    if (this.attached === fonts) return
    this.attached = fonts
    this.generation += 1
    this.pending = null
    this.service = fonts.mine ?? null
    if (this.service) this.set({ status: 'idle', families: [], error: null, canManage: true, source: 'mine' })
    else if (fonts.provided && fonts.provided.length > 0) this.set({ status: 'ready', families: [...fonts.provided].sort(byName), error: null, canManage: false, source: 'shared' })
    else this.set({ status: 'ready', families: [], error: null, canManage: false, source: 'none' })
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): UserFontsState => this.state

  /** Fetches the library once; later calls share the result. Never rejects: a failure shows as `status: 'error'`. */
  ensureLoaded(): Promise<void> {
    if (!this.service || this.state.status === 'ready') return Promise.resolve()
    if (this.pending) return this.pending
    return this.load(this.service)
  }

  /** Fetches the library again (after a failure, or to see what changed elsewhere). */
  reload(): Promise<void> {
    return this.service ? this.load(this.service) : Promise.resolve()
  }

  private load(service: UserFontsService): Promise<void> {
    const generation = this.generation
    this.set({ ...this.state, status: 'loading', error: null })
    const pending = service.list().then(
      (families) => {
        if (generation === this.generation) this.set({ ...this.state, status: 'ready', error: null, families: [...families].sort(byName) })
      },
      (error: unknown) => {
        if (generation === this.generation) this.set({ ...this.state, status: 'error', error: error instanceof Error && error.message ? error.message : t.userFonts.loadFailed })
      },
    )
    this.pending = pending
    void pending.finally(() => {
      if (this.pending === pending) this.pending = null
    })
    return pending
  }

  /** Uploads one request's worth of files; the family (new or extended) joins the library when the server accepts it. */
  async upload(input: UserFontUploadInput, options?: UserFontUploadOptions): Promise<FontFamily> {
    const service = this.service
    if (!service) throw new Error('Fonts cannot be uploaded here.')
    const family = await service.upload(input, options)
    const rest = this.state.families.filter((f) => f.id !== family.id)
    this.set({ ...this.state, families: [...rest, family].sort(byName) })
    return family
  }

  async remove(family: FontFamily): Promise<void> {
    const service = this.service
    if (!service) throw new Error('Fonts cannot be deleted here.')
    await service.remove(family.id)
    this.set({ ...this.state, families: this.state.families.filter((f) => f.id !== family.id) })
  }

  private set(next: UserFontsState): void {
    const changed = next.families !== this.state.families
    this.state = next
    if (changed) this.manager.setUserFonts(next.families)
    for (const listener of [...this.listeners]) listener()
  }
}

/** The shared store of the editor this component is in. */
export function useUserFontsStore(): UserFonts {
  return useEditor().userFonts
}

/** Live state of the user's fonts; asks for the library the first time a component needs it. */
export function useUserFonts(): UserFontsState {
  const store = useUserFontsStore()
  useEffect(() => {
    void store.ensureLoaded()
  }, [store])
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
