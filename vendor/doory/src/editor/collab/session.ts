/**
 * A live-editing session of one editor: the Y document, the connection, the binding to the engine, local undo
 * and (see presence.ts) who else is here. `EditorApp` starts one when the adapter offers a room; the engine only
 * knows it as a `LiveSession`.
 *
 * If live editing cannot work (the server never answers, speaks another protocol, or the shared state is not a
 * design) the session hands the design back to the engine, which then saves over REST like before.
 */
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import { type StoreApi, createStore } from 'zustand/vanilla'
import type { RealtimeConnection } from '@/types/adapter'
import type { DoryDocument } from '@/types/document'
import type { EditorEngine, LiveSession, LocalChange } from '../engine/editor'
import type { HistoryStatus } from '../store/editorStore'
import { t } from '../strings'
import { DocBinding, LOCAL_ORIGIN, REPLACE_ORIGIN } from './binding'
import type { CollabProvider, ConnectionStatus, ProviderState, ProviderUser, Role } from './provider'
import { Presence } from './presence'
import { type Room, type RoomOptions, openRoom, takeEarlyRoom } from './room'
import { type Place, LocalUndo } from './undo'

/** Failed attempts before the first copy of the design arrives after which the editor saves over REST instead. */
export const FALLBACK_AFTER_ATTEMPTS = 3

export type CollabStatus = ConnectionStatus | 'fallback'

export interface Notice {
  tone: 'error' | 'warning'
  title: string
  body: string
  action?: 'reload' | 'sign-in'
}

export interface CollabState {
  status: CollabStatus
  /** The design's first copy has arrived: the document in the editor is the shared one. */
  synced: boolean
  role: Role | null
  canWrite: boolean
  reason: string | null
  attempt: number
  me: ProviderUser | null
  /** The user may rename the design. */
  canRename: boolean
  notice: Notice | null
}

export interface SessionOptions extends RoomOptions {
  now?: () => number
}

const NOTICES: Record<string, { title: string; body: string }> = {
  link_revoked: { title: t.collab.notice.accessLostTitle, body: t.collab.notice.linkRevoked },
  link_expired: { title: t.collab.notice.accessLostTitle, body: t.collab.notice.linkExpired },
  account_disabled: { title: t.collab.notice.accessLostTitle, body: t.collab.notice.accountDisabled },
  password_required: { title: t.collab.notice.accessLostTitle, body: t.collab.notice.passwordNeeded },
}

export class CollabSession implements LiveSession {
  readonly store: StoreApi<CollabState>
  readonly ydoc: Y.Doc
  readonly awareness: Awareness
  readonly binding: DocBinding
  readonly presence: Presence
  private readonly room: Room
  private readonly provider: CollabProvider
  private readonly steps: LocalUndo
  private place: Place
  private ended = false
  private identified = false
  private unstorable = false
  /** Whether the user could edit when last in sync; null before the first sync. */
  private wasWriter: boolean | null = null
  private readonly offProvider: () => void

  constructor(
    private readonly engine: EditorEngine,
    private readonly realtime: RealtimeConnection,
    options: SessionOptions = {},
  ) {
    this.store = createStore<CollabState>(() => ({
      status: 'connecting',
      synced: false,
      role: null,
      canWrite: false,
      reason: null,
      attempt: 0,
      me: null,
      canRename: realtime.setTitle !== null,
      notice: null,
    }))
    // The room may already be open: the shell starts it while the design and the editor load.
    this.room = takeEarlyRoom(realtime) ?? openRoom(realtime, options)
    this.ydoc = this.room.ydoc
    this.awareness = this.room.awareness
    this.provider = this.room.provider
    this.presence = new Presence(this.awareness, engine, options.now)
    this.place = this.currentPlace()
    this.binding = new DocBinding(this.ydoc, {
      document: () => engine.state.doc,
      saved: () => engine.persistence.savedDocument,
      apply: (doc) => engine.applyRemoteDocument(doc),
      persistInline: (doc) => engine.assets.persistInline(doc),
      onInvalid: () => this.fallback(),
      onUploadFailed: () => engine.toast(t.collab.notice.uploadFailed, 'error'),
      beginUpload: () => this.steps.begin({ label: t.history.edit, before: this.place, after: this.currentPlace() }),
      canWrite: () => this.store.getState().canWrite,
    })
    this.steps = new LocalUndo(this.binding.roots, LOCAL_ORIGIN, () => engine.refreshHistoryStatus(), options.now)
    this.provider.setEvents({
      onTitle: (title) => {
        engine.persistence.adoptTitle(title)
        engine.setTitle(title)
      },
      onWarning: (code) => {
        if (code === 'document_invalid') this.setUnstorable(true)
      },
      onStored: () => this.setUnstorable(false),
      onReplaced: () => {
        this.steps.clear()
        void this.binding.resync()
        // The restore dialog's "Undo" has nothing left to undo.
        for (const toast of engine.state.toasts) if (toast.action) engine.dismissToast(toast.id)
        engine.toast(t.collab.notice.restored, 'info')
      },
    })
    this.offProvider = this.provider.subscribe((state) => this.onProvider(state))
  }

  /** Attaches to the engine and opens the connection. */
  start(): void {
    this.engine.attachLive(this)
    this.engine.persistence.setLive({
      saveTitle: (title) => (this.realtime.setTitle ? this.realtime.setTitle(title) : Promise.reject(new Error('rename not allowed'))),
      flush: () => this.flush(),
      saveThumbnail: this.realtime.uploadThumbnail,
    })
    this.realtime.flushRef.current = () => this.flush()
    this.engine.editBlockedHandler = (pageId, id) => {
      const owner = this.presence.lockOwner(pageId, id)
      this.engine.toast(t.collab.presence.editBlocked(owner?.name ?? t.collab.presence.someone), 'info')
    }
    this.presence.start()
    this.onProvider(this.provider.getState())
  }

  /** Saves the live state to the design and resolves once the server confirms. */
  flush(): Promise<void> {
    return this.provider.flush()
  }

  /* ------------------------------------------------------------- connection */

  private onProvider(state: ProviderState): void {
    if (this.ended) return
    const unreachable = !state.synced && state.attempt >= FALLBACK_AFTER_ATTEMPTS
    if (state.status === 'unavailable' || unreachable) {
      this.fallback()
      return
    }
    this.store.setState({ status: state.status, synced: state.synced, role: state.role, canWrite: state.canWrite, reason: state.reason, attempt: state.attempt, me: state.user, notice: this.noticeFor(state) })
    if (state.user && !this.identified) {
      this.identified = true
      this.presence.identify(state.user.id)
    }
    if (state.synced && !this.binding.isSynced) this.binding.synchronised()
    if (state.role) {
      this.engine.setLiveReadOnly(!state.canWrite || ['forbidden', 'not-found', 'too-large'].includes(state.status))
      if (this.wasWriter !== null && state.synced && state.canWrite !== this.wasWriter && state.status !== 'forbidden') {
        this.engine.toast(state.canWrite ? t.collab.notice.editingAgain : t.collab.notice.viewOnly, 'info')
      }
      if (state.synced) this.wasWriter = state.canWrite
    }
  }

  private noticeFor(state: ProviderState): Notice | null {
    const text = t.collab.notice
    if (state.unsentChanges || state.reason === 'unsent_changes') return { tone: 'error', title: text.unsentTitle, body: text.unsent, action: 'reload' }
    switch (state.status) {
      case 'forbidden': {
        const known = NOTICES[state.reason ?? '']
        return { tone: 'error', title: known?.title ?? text.accessLostTitle, body: known?.body ?? text.accessRemoved }
      }
      case 'not-found':
        return { tone: 'error', title: text.designGoneTitle, body: text.designGone }
      case 'too-large':
        return { tone: 'error', title: text.tooLargeTitle, body: text.tooLarge, action: 'reload' }
      case 'signed-out':
        return { tone: 'warning', title: text.signedOutTitle, body: text.signedOut, action: 'sign-in' }
      case 'busy':
        return state.reason === 'design_full' ? { tone: 'warning', title: text.fullTitle, body: text.full } : null
      default:
        return this.unstorable ? { tone: 'warning', title: text.unstorableTitle, body: text.unstorable } : null
    }
  }

  /** The server says the design is not valid and cannot be stored (until a save works again). */
  private setUnstorable(value: boolean): void {
    if (this.unstorable === value || this.ended) return
    this.unstorable = value
    this.store.setState({ notice: this.noticeFor(this.provider.getState()) })
  }

  /** Asks the shell for a session again (the sign-in button of the notice). */
  signIn(): void {
    void this.provider.signIn()
  }

  /** Live editing cannot work: give the design back to the engine, which saves over REST. */
  private fallback(): void {
    if (this.ended) return
    this.release()
    this.store.setState({ status: 'fallback', notice: null })
    this.engine.setLiveReadOnly(false)
    this.engine.toast(t.collab.notice.fallback, 'info')
  }

  /* ----------------------------------------------------------- LiveSession */

  private currentPlace(): Place {
    return { activePageId: this.engine.state.activePageId, selection: this.engine.activeView()?.selectedIds() ?? [] }
  }

  recordLocal(prev: DoryDocument, next: DoryDocument, change: LocalChange): void {
    if (!this.binding.isSynced) return
    this.steps.begin({ label: change.label, coalesceKey: change.coalesceKey, before: this.place, after: { activePageId: change.activePageId, selection: change.selection } })
    this.binding.writeLocal(prev, next)
  }

  replaceDocument(prev: DoryDocument, next: DoryDocument): void {
    this.steps.clear()
    this.binding.writeLocal(prev, next, REPLACE_ORIGIN)
  }

  async undo(): Promise<void> {
    const step = this.steps.undo()
    await this.binding.flush()
    if (!step) return
    this.restore(step.before)
    this.engine.announce(t.announce.undone(step.label))
  }

  async redo(): Promise<void> {
    const step = this.steps.redo()
    await this.binding.flush()
    if (!step) return
    this.restore(step.after)
    this.engine.announce(t.announce.redone(step.label))
  }

  seal(): void {
    this.steps.seal()
    this.place = this.currentPlace()
  }

  historyStatus(): HistoryStatus {
    return this.steps.status()
  }

  private restore(place: Place): void {
    const doc = this.engine.state.doc
    const pageId = doc.pages.some((p) => p.id === place.activePageId) ? place.activePageId : this.engine.state.activePageId
    this.engine.select(place.selection, pageId)
  }

  /* ---------------------------------------------------------------- teardown */

  private release(): void {
    if (this.ended) return
    this.ended = true
    this.offProvider()
    this.presence.stop()
    this.engine.editBlockedHandler = null
    this.binding.stop()
    this.steps.destroy()
    this.room.close()
    this.realtime.flushRef.current = null
    this.engine.attachLive(null)
    this.engine.persistence.setLive(null)
  }

  /** Ends the session (the editor unmounts or opens another design). */
  destroy(): void {
    this.release()
  }
}
