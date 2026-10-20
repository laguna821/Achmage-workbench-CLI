/**
 * The WebSocket side of real-time co-editing: the Yjs sync and awareness protocols plus a few JSON text
 * frames, with login, reconnect and an explicit connection state.
 *
 * It knows nothing about the editor. It moves bytes between a `Y.Doc` / `Awareness` and the server, and reports
 * what it is doing through `ProviderState`. Local changes made while the socket is down stay in the document and
 * reach the server with the next sync (a reconnect is a normal sync, nothing is lost).
 */
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as authProtocol from 'y-protocols/auth'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_AUTH = 2
const MESSAGE_QUERY_AWARENESS = 3

export const BACKOFF_BASE_MS = 1000
export const BACKOFF_MAX_MS = 30_000
/** Close code 4429 (limits): wait at least this long, whatever the back-off says. */
export const LIMITED_MIN_MS = 10_000
const PING_EVERY_MS = 20_000
const PONG_WITHIN_MS = 10_000
const FLUSH_WAIT_MS = 8_000
/** Local changes that follow each other this closely travel in one frame (about 25 frames a second at most; the server allows 100). */
const BATCH_MS = 40

export type Role = 'owner' | 'edit' | 'comment' | 'view'

/**
 * - `connecting`: opening the socket, logging in or waiting for the first copy of the design.
 * - `live`: in sync and allowed to edit. `read-only`: in sync, may only look.
 * - `offline`: the connection dropped; reconnecting (local edits are kept and will sync).
 * - `signed-out` (4401), `forbidden` (4403), `not-found` (4404), `too-large` (4413): the server said stop.
 * - `busy`: the server is at a limit (4429, 1013); trying again later.
 * - `unavailable`: a protocol failure that retrying cannot fix.
 */
export type ConnectionStatus = 'connecting' | 'live' | 'read-only' | 'offline' | 'signed-out' | 'forbidden' | 'not-found' | 'too-large' | 'busy' | 'unavailable'

export interface ProviderUser {
  id: string
  name: string
  avatarUrl: string | null
}

export interface ProviderState {
  status: ConnectionStatus
  /** The first copy of the design has been applied in this session (the document is usable). */
  synced: boolean
  role: Role | null
  canWrite: boolean
  /** The machine-readable close reason of the last refusal (`link_revoked`, `design_trashed`, …). */
  reason: string | null
  /** Failed connection attempts since the last successful sync. */
  attempt: number
  /** The signed-in user as the server knows them. */
  user: ProviderUser | null
  /** Largest frame the server accepts from us. */
  maxFrameBytes: number
  /**
   * This window holds changes the server does not have and, being read-only now, will never take: made offline before the
   * user lost the right to edit. They stay on screen as if they were saved, and would reach the design if the right came back.
   */
  unsentChanges: boolean
}

export interface WebSocketLike {
  binaryType: string
  readyState: number
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

export interface ProviderEvents {
  /** A `title` frame: somebody renamed the design. */
  onTitle?(title: string): void
  /** A `saved` frame: the server stored the document at this revision. */
  onSaved?(revision: number): void
  /** A `replaced` frame: the shared state was replaced (version restore); the new content follows as updates. */
  onReplaced?(): void
  /** The server needs a session (4401). Resolve `true` once the user is signed in again. */
  onSignInRequired?(): Promise<boolean>
  /** Asked first on 4401 (a cheap call that refreshes the session); resolve `true` to retry without a prompt. */
  refreshSession?(): Promise<boolean>
  /** A `warning` frame (`document_invalid`). */
  onWarning?(code: string, message: string): void
  /** A `saved` frame: the server stored the design just now (not called for the revision the `ready` frame carries). */
  onStored?(): void
}

export interface ProviderOptions extends ProviderEvents {
  url: string
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  /** Share-link credentials of a non-owner. */
  auth?: { token: string; password?: string }
  /** Test seams. */
  createSocket?(url: string): WebSocketLike
  random?(): number
}

/** The state vector inside a sync step 1 frame, or null when the frame is another kind of message. */
function peekStateVector(data: Uint8Array): Uint8Array | null {
  const decoder = decoding.createDecoder(data)
  if (decoding.readVarUint(decoder) !== MESSAGE_SYNC || decoding.readVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) return null
  return decoding.readVarUint8Array(decoder)
}

export function backoffDelay(attempt: number, random: () => number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt))
  return Math.round(ceiling * (0.5 + 0.5 * random()))
}

const OPEN = 1

function initialState(): ProviderState {
  return { status: 'connecting', synced: false, role: null, canWrite: false, reason: null, attempt: 0, user: null, maxFrameBytes: 1_048_576, unsentChanges: false }
}

export class CollabProvider {
  private socket: WebSocketLike | null = null
  private state: ProviderState = initialState()
  private readonly listeners = new Set<(state: ProviderState) => void>()
  private ready = false
  /** The server's copy of the design (sync step 2) has been applied on the current connection. */
  private connectionSynced = false
  /**
   * Our answer to the server's step 1 (everything the server lacks) has been sent on this connection. Until then live
   * updates stay back: the server refuses an update that builds on changes it has not got (it closes with 4400), and after
   * a reconnect those changes are exactly what the answer carries.
   */
  private answered = false
  private destroyed = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private roleRetried = false
  /** Automatic attempts to get a session back since the last sync: one quiet refresh, one prompt. */
  private recoveries = 0
  private signInPending = false
  private readonly flushWaiters = new Set<() => void>()
  private unsent: Uint8Array[] = []
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private readonly doc: Y.Doc
  private readonly awareness: awarenessProtocol.Awareness
  private readonly random: () => number
  private readonly cleanups: (() => void)[] = []
  private events: ProviderEvents

  constructor(private readonly options: ProviderOptions) {
    this.events = options
    this.doc = options.doc
    this.awareness = options.awareness
    this.random = options.random ?? Math.random

    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === this) return
      this.unsent.push(update)
      this.batchTimer ??= setTimeout(() => this.sendUnsent(), BATCH_MS)
    }
    this.doc.on('update', onUpdate)
    this.cleanups.push(() => this.doc.off('update', onUpdate))

    const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown): void => {
      if (origin === this) return
      const changed = added.concat(updated, removed)
      const mine = changed.filter((client) => client === this.awareness.clientID)
      if (mine.length === 0) return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, mine))
      this.sendBinary(encoding.toUint8Array(encoder))
    }
    this.awareness.on('update', onAwareness)
    this.cleanups.push(() => this.awareness.off('update', onAwareness))

    if (typeof window !== 'undefined') {
      const wake = (): void => {
        if (this.destroyed || !['offline', 'busy'].includes(this.state.status) || !this.retryTimer) return
        this.reconnectNow()
      }
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') wake()
      }
      window.addEventListener('online', wake)
      document.addEventListener('visibilitychange', onVisible)
      this.cleanups.push(() => {
        window.removeEventListener('online', wake)
        document.removeEventListener('visibilitychange', onVisible)
      })
    }
  }

  /** Replaces the handlers (a room opened ahead of the editor gets the editor's once it is there). */
  setEvents(events: ProviderEvents): void {
    this.events = { ...this.events, ...events }
  }

  /* ---------------------------------------------------------------- state */

  getState(): ProviderState {
    return this.state
  }

  subscribe(listener: (state: ProviderState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(patch: Partial<ProviderState>): void {
    const next = { ...this.state, ...patch }
    const changed = (Object.keys(next) as (keyof ProviderState)[]).some((key) => next[key] !== this.state[key])
    if (!changed) return
    this.state = next
    for (const listener of [...this.listeners]) listener(next)
  }

  /* ----------------------------------------------------------- connecting */

  connect(): void {
    if (this.destroyed || this.socket) return
    this.clearRetry()
    this.ready = false
    this.connectionSynced = false
    this.answered = false
    this.set({ status: this.state.synced ? 'offline' : 'connecting' })
    let socket: WebSocketLike
    try {
      socket = (this.options.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike))(this.options.url)
    } catch {
      this.scheduleRetry(0)
      return
    }
    this.socket = socket
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      if (this.socket !== socket) return
      if (this.options.auth) socket.send(JSON.stringify({ type: 'auth', token: this.options.auth.token, ...(this.options.auth.password ? { password: this.options.auth.password } : {}) }))
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      this.heard()
      if (typeof event.data === 'string') this.onText(event.data)
      else if (event.data instanceof ArrayBuffer) this.onBinary(new Uint8Array(event.data))
      else if (ArrayBuffer.isView(event.data)) this.onBinary(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength))
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.onClosed(event.code, event.reason)
    }
    socket.onerror = () => undefined
  }

  /** Reconnects right away (the browser came back online, the tab became visible, the user asked). */
  reconnectNow(): void {
    if (this.destroyed) return
    this.clearRetry()
    this.set({ attempt: 0 })
    if (this.socket) return
    this.connect()
  }

  /**
   * A 4401 first tries to refresh the session quietly (a rotated key is repaired by any authenticated request), then
   * asks the shell to sign the user in. That is done once each: if the server still refuses, only the user's own click
   * (`signIn`) asks again, so a shell that believes the user is signed in cannot make the editor loop.
   */
  private async recoverSession(): Promise<void> {
    if (this.recoveries >= 2) return
    this.recoveries += 1
    const refresh = this.events.refreshSession
    if (refresh && this.recoveries === 1) {
      let again = false
      try {
        again = await refresh()
      } catch {
        again = false
      }
      if (this.destroyed) return
      if (again) {
        this.set({ status: 'connecting', reason: null })
        this.connect()
        return
      }
      this.recoveries += 1
    }
    await this.signIn()
  }

  /**
   * Saves the design now: resolves when the server confirms (a `saved` frame) or after a while. Versions snapshot
   * the saved document, which trails the room by up to ten seconds.
   */
  flush(): Promise<void> {
    const socket = this.socket
    if (!socket || !this.ready || !this.answered || !this.state.canWrite || socket.readyState !== OPEN) return Promise.resolve()
    this.sendUnsent()
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.flushWaiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, FLUSH_WAIT_MS)
      this.flushWaiters.add(done)
      socket.send('{"type":"flush"}')
    })
  }

  /** Asks the shell to sign the user in again after a 4401 and reconnects once that succeeded. */
  async signIn(): Promise<void> {
    const ask = this.events.onSignInRequired
    if (!ask || this.signInPending || this.destroyed) return
    this.signInPending = true
    try {
      if (await ask()) {
        this.set({ status: 'connecting', reason: null, attempt: 0 })
        this.connect()
      }
    } finally {
      this.signInPending = false
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private scheduleRetry(minimum: number): void {
    if (this.destroyed) return
    const attempt = this.state.attempt
    const delay = Math.max(minimum, backoffDelay(attempt, this.random))
    this.set({ attempt: attempt + 1 })
    this.clearRetry()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  /* ------------------------------------------------------------- incoming */

  private onText(raw: string): void {
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof message !== 'object' || message === null) return
    const frame = message as Record<string, unknown>
    switch (frame.type) {
      case 'ready':
        this.onReady(frame)
        break
      case 'title':
        if (typeof frame.title === 'string') this.events.onTitle?.(frame.title)
        break
      case 'saved':
        if (typeof frame.revision === 'number') this.events.onSaved?.(frame.revision)
        this.events.onStored?.()
        for (const done of [...this.flushWaiters]) done()
        break
      case 'replaced':
        this.events.onReplaced?.()
        break
      case 'warning':
        if (typeof frame.code === 'string') this.events.onWarning?.(frame.code, typeof frame.message === 'string' ? frame.message : '')
        break
      case 'error':
        if (frame.code === 'password_required') this.set({ status: 'forbidden', reason: 'password_required' })
        break
      default:
        break
    }
  }

  private onReady(frame: Record<string, unknown>): void {
    const role = typeof frame.role === 'string' ? (frame.role as Role) : null
    const user = frame.user as { id?: unknown; name?: unknown; avatar_url?: unknown } | undefined
    const limits = frame.limits as { maxFrameBytes?: unknown } | undefined
    if (frame.canWrite === true && this.state.unsentChanges) {
      // The right to edit came back to a window that still shows changes the server refused: they must not reach the design
      // unseen. The user reloads and starts from what the design is.
      this.stopSocket(1000, 'unsent_changes')
      this.set({ status: 'forbidden', reason: 'unsent_changes', canWrite: false })
      return
    }
    this.ready = true
    this.set({
      role,
      canWrite: frame.canWrite === true,
      reason: null,
      user: user && typeof user.id === 'string' ? { id: user.id, name: typeof user.name === 'string' ? user.name : '', avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : null } : null,
      maxFrameBytes: typeof limits?.maxFrameBytes === 'number' ? limits.maxFrameBytes : this.state.maxFrameBytes,
    })
    if (typeof frame.title === 'string') this.events.onTitle?.(frame.title)
    if (typeof frame.revision === 'number') this.events.onSaved?.(frame.revision)
    this.startPinging()
    const step1 = encoding.createEncoder()
    encoding.writeVarUint(step1, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(step1, this.doc)
    this.sendBinary(encoding.toUint8Array(step1))
    if (this.awareness.getLocalState() !== null) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]))
      this.sendBinary(encoding.toUint8Array(encoder))
    }
  }

  private onBinary(data: Uint8Array): void {
    if (!this.ready) return
    const decoder = decoding.createDecoder(data)
    const type = decoding.readVarUint(decoder)
    try {
      switch (type) {
        case MESSAGE_SYNC: {
          const reply = encoding.createEncoder()
          encoding.writeVarUint(reply, MESSAGE_SYNC)
          const serverVector = peekStateVector(data)
          const kind = syncProtocol.readSyncMessage(decoder, reply, this.doc, this)
          if (kind === syncProtocol.messageYjsSyncStep2 && !this.connectionSynced) {
            this.connectionSynced = true
            this.onSynced()
          }
          if (kind === syncProtocol.messageYjsSyncStep1) {
            // The reply is computed from the document as it is now, so it carries every change made so far.
            this.answered = true
            this.dropUnsent()
            if (!this.state.canWrite && serverVector && Y.parseUpdateMeta(Y.encodeStateAsUpdate(this.doc, serverVector)).from.size > 0) this.set({ unsentChanges: true })
          }
          if (encoding.length(reply) > 1) this.sendBinary(encoding.toUint8Array(reply))
          break
        }
        case MESSAGE_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this)
          break
        case MESSAGE_AUTH:
          authProtocol.readAuthMessage(decoder, this.doc, (_doc, reason) => {
            if (reason === 'read_only') this.set({ canWrite: false, status: this.state.synced ? 'read-only' : this.state.status })
          })
          break
        case MESSAGE_QUERY_AWARENESS: {
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
          encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(this.awareness.getStates().keys())))
          this.sendBinary(encoding.toUint8Array(encoder))
          break
        }
        default:
          break
      }
    } catch {
      this.socket?.close(4400, 'bad_frame')
    }
  }

  private onSynced(): void {
    this.roleRetried = false
    this.recoveries = 0
    this.set({ synced: true, attempt: 0, status: this.state.canWrite ? 'live' : 'read-only' })
  }

  /* ------------------------------------------------------------- outgoing */

  private sendBinary(frame: Uint8Array): void {
    const socket = this.socket
    if (!socket || !this.ready || socket.readyState !== OPEN) return
    if (!this.state.canWrite && frame[0] === MESSAGE_SYNC && frame[1] !== syncProtocol.messageYjsSyncStep1) return
    if (frame.byteLength > this.state.maxFrameBytes) {
      this.set({ status: 'too-large', reason: 'frame_too_large' })
      this.stopSocket(1000, 'too_large')
      return
    }
    socket.send(frame)
  }

  /** Sends the local changes collected so far as one update. (A change made while the socket is down reaches the server with the next sync.) */
  private sendUnsent(): void {
    if (this.batchTimer) clearTimeout(this.batchTimer)
    this.batchTimer = null
    const updates = this.unsent
    this.unsent = []
    if (updates.length === 0 || !this.answered) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeUpdate(encoder, updates.length === 1 ? updates[0] : Y.mergeUpdates(updates))
    this.sendBinary(encoding.toUint8Array(encoder))
  }

  /* ------------------------------------------------------------ keep-alive */

  private startPinging(): void {
    this.stopPinging()
    this.pingTimer = setInterval(() => {
      const socket = this.socket
      if (!socket || socket.readyState !== OPEN || !this.ready) return
      socket.send('{"type":"ping"}')
      if (this.pongTimer) clearTimeout(this.pongTimer)
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null
        this.socket?.close(4408, 'no_pong')
      }, PONG_WITHIN_MS)
    }, PING_EVERY_MS)
  }

  private heard(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pongTimer = null
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pingTimer = null
    this.pongTimer = null
  }

  /* ---------------------------------------------------------------- closing */

  private stopSocket(code: number, reason: string): void {
    this.dropUnsent()
    const socket = this.socket
    this.socket = null
    this.ready = false
    this.connectionSynced = false
    this.answered = false
    this.stopPinging()
    this.forgetPeers()
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
      try {
        socket.close(code, reason)
      } catch {
        /* already closed */
      }
    }
  }

  private forgetPeers(): void {
    const others = Array.from(this.awareness.getStates().keys()).filter((client) => client !== this.awareness.clientID)
    if (others.length > 0) awarenessProtocol.removeAwarenessStates(this.awareness, others, this)
  }

  private dropUnsent(): void {
    if (this.batchTimer) clearTimeout(this.batchTimer)
    this.batchTimer = null
    this.unsent = []
  }

  private onClosed(code: number, reason: string): void {
    this.dropUnsent()
    this.ready = false
    this.connectionSynced = false
    this.answered = false
    this.stopPinging()
    this.forgetPeers()
    if (this.destroyed) return
    const synced = this.state.synced
    switch (code) {
      case 4401:
        this.set({ status: 'signed-out', reason: reason || 'not_authenticated' })
        void this.recoverSession()
        return
      case 4403:
        if (reason === 'role_changed' && !this.roleRetried) {
          this.roleRetried = true
          this.set({ status: 'connecting', reason })
          this.connect()
          return
        }
        this.set({ status: 'forbidden', reason: reason || 'forbidden', canWrite: false })
        return
      case 4404:
        this.set({ status: 'not-found', reason: reason || 'not_found', canWrite: false })
        return
      case 4413:
        this.set({ status: 'too-large', reason: reason || 'frame_too_large' })
        return
      case 4400:
        this.set({ status: 'unavailable', reason: reason || 'bad_frame' })
        return
      case 4429:
        if (reason === 'password_locked') {
          this.set({ status: 'forbidden', reason })
          return
        }
        this.set({ status: 'busy', reason: reason || 'rate_limited' })
        this.scheduleRetry(LIMITED_MIN_MS)
        return
      case 1013:
        this.set({ status: 'busy', reason: reason || 'try_again' })
        this.scheduleRetry(LIMITED_MIN_MS / 2)
        return
      default:
        this.set({ status: synced ? 'offline' : 'connecting', reason: reason || null })
        this.scheduleRetry(0)
    }
  }

  /** Closes the connection for good and releases every listener and timer. */
  destroy(): void {
    if (this.destroyed) return
    this.sendUnsent()
    if (this.ready && this.awareness.getLocalState() !== null) this.awareness.setLocalState(null)
    this.destroyed = true
    this.clearRetry()
    this.stopSocket(1000, 'bye')
    for (const done of [...this.flushWaiters]) done()
    for (const undo of this.cleanups.splice(0)) undo()
    this.listeners.clear()
  }
}
