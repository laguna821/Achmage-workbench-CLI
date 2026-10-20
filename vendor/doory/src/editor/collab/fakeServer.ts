/**
 * An in-memory stand-in for the real-time server for unit tests: it speaks the same frames
 * (login, `ready`, Yjs sync, awareness with a rewritten identity, close codes) so providers, bindings and whole
 * engines can be tested against each other without a network.
 */
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as authProtocol from 'y-protocols/auth'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import type { DoryDocument } from '@/types/document'
import type { Role, WebSocketLike } from './provider'
import { writeDocument } from './schema'

const OPEN = 1
const CLOSED = 3

interface FakeUser {
  id: string
  name: string
  avatarUrl?: string | null
}

export interface ConnectionPlan {
  user: FakeUser
  role: Role
  /** Non-owners must send this token in the auth frame. */
  token?: string
  /** Close right after accepting with this code. */
  refuse?: { code: number; reason: string }
}

class FakeSocket implements WebSocketLike {
  binaryType = 'blob'
  readyState = 0
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  authed = false
  /** The server closed it: nothing more is read from the client. */
  dropped = false

  constructor(readonly server: FakeCollabServer, readonly plan: ConnectionPlan) {}

  send(data: string | Uint8Array): void {
    if (this.readyState !== OPEN) return
    const copy = typeof data === 'string' ? data : new Uint8Array(data)
    queueMicrotask(() => this.server.receive(this, copy))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    queueMicrotask(() => this.server.disconnected(this))
    queueMicrotask(() => this.onclose?.({ code, reason }))
  }

  deliver(data: string | Uint8Array): void {
    queueMicrotask(() => {
      if (this.readyState !== OPEN) return
      if (typeof data === 'string') this.onmessage?.({ data })
      else this.onmessage?.({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) })
    })
  }

  open(): void {
    this.readyState = OPEN
    this.onopen?.({})
  }

  /** The server side closes the connection. */
  drop(code: number, reason: string): void {
    if (this.readyState === CLOSED) return
    this.dropped = true
    this.readyState = CLOSED
    queueMicrotask(() => this.server.disconnected(this))
    queueMicrotask(() => this.onclose?.({ code, reason }))
  }
}

export class FakeCollabServer {
  readonly doc = new Y.Doc()
  readonly sockets = new Set<FakeSocket>()
  readonly received: { text?: string; bytes?: Uint8Array }[] = []
  private readonly awareness = new Map<number, { clock: number; state: string; owner: FakeSocket }>()
  private plans: ConnectionPlan[] = []
  /** Connections accepted so far. */
  connections = 0
  /** When true every new connection is closed with 1006 before it opens (the server is down). */
  down = false
  title = 'Design'
  revision = 1
  maxFrameBytes = 1_048_576
  /** Like the real server: an update that builds on changes the server lacks closes the connection with 4400. */
  strict = true
  /** Withhold the server's step 1 after `ready` until `releaseHandshake()`: a slow link, where the editor keeps working. */
  stallHandshake = false
  private stalled: FakeSocket[] = []

  constructor(document?: DoryDocument) {
    if (document) writeDocument(this.doc, document)
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 0)
      syncProtocol.writeUpdate(encoder, update)
      const frame = encoding.toUint8Array(encoder)
      for (const socket of this.sockets) if (socket.authed && socket !== origin) socket.deliver(frame)
    })
  }

  /** The user of the next `createSocket()` call(s). */
  plan(...plans: ConnectionPlan[]): this {
    this.plans.push(...plans)
    return this
  }

  /** Replaces the plans that are still waiting (the user's rights changed). */
  replacePlans(...plans: ConnectionPlan[]): this {
    this.plans = [...plans]
    return this
  }

  /** `createSocket` for a provider: each call consumes the next plan (the last one repeats). */
  socketFactory(defaultPlan: ConnectionPlan): (url: string) => WebSocketLike {
    return () => {
      const plan = this.plans.length > 1 ? (this.plans.shift() as ConnectionPlan) : (this.plans[0] ?? defaultPlan)
      const socket = new FakeSocket(this, plan)
      this.connections += 1
      queueMicrotask(() => {
        if (this.down) {
          socket.readyState = CLOSED
          socket.onclose?.({ code: 1006, reason: '' })
          return
        }
        this.sockets.add(socket)
        socket.open()
        if (plan.refuse) {
          socket.drop(plan.refuse.code, plan.refuse.reason)
          return
        }
        if (plan.role === 'owner') this.admit(socket)
      })
      return socket
    }
  }

  private admit(socket: FakeSocket): void {
    socket.authed = true
    const plan = socket.plan
    const canWrite = plan.role === 'owner' || plan.role === 'edit'
    socket.deliver(
      JSON.stringify({
        type: 'ready',
        role: plan.role,
        canWrite,
        user: { id: plan.user.id, name: plan.user.name, avatar_url: plan.user.avatarUrl ?? null },
        title: this.title,
        revision: this.revision,
        limits: { maxFrameBytes: this.maxFrameBytes, maxParticipants: 25 },
      }),
    )
    if (this.stallHandshake) this.stalled.push(socket)
    else this.sendStep1(socket)
  }

  private sendStep1(socket: FakeSocket): void {
    const step1 = encoding.createEncoder()
    encoding.writeVarUint(step1, 0)
    syncProtocol.writeSyncStep1(step1, this.doc)
    socket.deliver(encoding.toUint8Array(step1))
  }

  /** Lets the withheld step 1 frames through. */
  releaseHandshake(): void {
    this.stallHandshake = false
    for (const socket of this.stalled.splice(0)) if (socket.readyState === OPEN) this.sendStep1(socket)
  }

  receive(socket: FakeSocket, data: string | Uint8Array): void {
    if (socket.dropped) return
    if (typeof data === 'string') {
      this.received.push({ text: data })
      this.onText(socket, data)
      return
    }
    this.received.push({ bytes: data })
    if (!socket.authed) {
      socket.drop(4400, 'auth_required')
      return
    }
    if (data.byteLength > this.maxFrameBytes) {
      socket.drop(4413, 'frame_too_large')
      return
    }
    const decoder = decoding.createDecoder(data)
    const type = decoding.readVarUint(decoder)
    const canWrite = socket.plan.role === 'owner' || socket.plan.role === 'edit'
    if (type === 0) this.onSync(socket, decoder, canWrite)
    else if (type === 1) this.onAwareness(socket, decoding.readVarUint8Array(decoder))
    else if (type === 3) this.sendAwarenessTable(socket)
  }

  private onText(socket: FakeSocket, text: string): void {
    const message = JSON.parse(text) as { type?: string; token?: string }
    if (message.type === 'ping') {
      socket.deliver('{"type":"pong"}')
      return
    }
    if (message.type === 'flush') {
      socket.deliver(JSON.stringify({ type: 'saved', revision: this.revision, at: new Date().toISOString() }))
      return
    }
    if (message.type === 'auth' && !socket.authed) {
      if (socket.plan.token && message.token === socket.plan.token) this.admit(socket)
      else socket.drop(4403, 'forbidden')
    }
  }

  private onSync(socket: FakeSocket, decoder: decoding.Decoder, canWrite: boolean): void {
    const syncType = decoding.readVarUint(decoder)
    if (syncType === syncProtocol.messageYjsSyncStep1) {
      const reply = encoding.createEncoder()
      encoding.writeVarUint(reply, 0)
      syncProtocol.writeSyncStep2(reply, this.doc, decoding.readVarUint8Array(decoder))
      socket.deliver(encoding.toUint8Array(reply))
      this.sendAwarenessTable(socket)
      return
    }
    const update = decoding.readVarUint8Array(decoder)
    if (!canWrite) {
      const denied = encoding.createEncoder()
      encoding.writeVarUint(denied, 2)
      authProtocol.writePermissionDenied(denied, 'read_only')
      socket.deliver(encoding.toUint8Array(denied))
      return
    }
    if (this.strict && this.hasGap(update)) {
      socket.drop(4400, 'bad_frame')
      return
    }
    Y.applyUpdate(this.doc, update, socket)
    this.revision += 1
  }

  private hasGap(update: Uint8Array): boolean {
    const known = Y.decodeStateVector(Y.encodeStateVector(this.doc))
    for (const [client, from] of Y.parseUpdateMeta(update).from) if (from > (known.get(client) ?? 0)) return true
    return false
  }

  private sendAwarenessTable(socket: FakeSocket): void {
    const entries = [...this.awareness.entries()].filter(([, slot]) => slot.owner !== socket)
    if (entries.length === 0) return
    socket.deliver(this.awarenessFrame(entries.map(([client, slot]) => ({ client, clock: slot.clock, state: slot.state }))))
  }

  private awarenessFrame(entries: { client: number; clock: number; state: string }[]): Uint8Array {
    const inner = encoding.createEncoder()
    encoding.writeVarUint(inner, entries.length)
    for (const entry of entries) {
      encoding.writeVarUint(inner, entry.client)
      encoding.writeVarUint(inner, entry.clock)
      encoding.writeVarString(inner, entry.state)
    }
    const outer = encoding.createEncoder()
    encoding.writeVarUint(outer, 1)
    encoding.writeVarUint8Array(outer, encoding.toUint8Array(inner))
    return encoding.toUint8Array(outer)
  }

  private onAwareness(socket: FakeSocket, payload: Uint8Array): void {
    const decoder = decoding.createDecoder(payload)
    const count = decoding.readVarUint(decoder)
    const accepted: { client: number; clock: number; state: string }[] = []
    for (let i = 0; i < count; i++) {
      const client = decoding.readVarUint(decoder)
      const clock = decoding.readVarUint(decoder)
      const raw = decoding.readVarString(decoder)
      const known = this.awareness.get(client)
      if (known && known.owner !== socket) continue
      if (known && clock <= known.clock) continue
      const parsed = JSON.parse(raw) as Record<string, unknown> | null
      if (parsed === null) {
        this.awareness.delete(client)
        accepted.push({ client, clock, state: 'null' })
        continue
      }
      const claimed = (parsed.user ?? {}) as { color?: unknown }
      const state = JSON.stringify({
        ...parsed,
        user: {
          id: socket.plan.user.id,
          name: socket.plan.user.name,
          avatarUrl: socket.plan.user.avatarUrl ?? null,
          color: typeof claimed.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(claimed.color) ? claimed.color : '#2563eb',
          role: socket.plan.role,
        },
      })
      this.awareness.set(client, { clock, state, owner: socket })
      accepted.push({ client, clock, state })
    }
    if (accepted.length === 0) return
    const frame = this.awarenessFrame(accepted)
    for (const other of this.sockets) if (other !== socket && other.authed) other.deliver(frame)
  }

  disconnected(socket: FakeSocket): void {
    this.sockets.delete(socket)
    const gone = [...this.awareness.entries()].filter(([, slot]) => slot.owner === socket)
    for (const [client] of gone) this.awareness.delete(client)
    if (gone.length > 0) {
      const frame = this.awarenessFrame(gone.map(([client, slot]) => ({ client, clock: slot.clock + 1, state: 'null' })))
      for (const other of this.sockets) if (other.authed) other.deliver(frame)
    }
  }

  /** Closes every connection like a restarting server does. */
  dropAll(code = 1012, reason = 'server_restart'): void {
    for (const socket of [...this.sockets]) socket.drop(code, reason)
  }

  /** Closes the connections of one user. */
  dropUser(userId: string, code: number, reason: string): void {
    for (const socket of [...this.sockets]) if (socket.plan.user.id === userId) socket.drop(code, reason)
  }
}

/** Lets queued frames reach their destination (the fake transport delivers through microtasks and timers). */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}
