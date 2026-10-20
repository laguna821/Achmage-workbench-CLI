/**
 * Who else is here, and what they are doing: cursors, selections, the object whose text somebody is editing, the
 * part of the design somebody is looking at. Everything travels in Yjs awareness; the
 * server stamps each state with the sender's identity, everything else is the sender's word and is validated here.
 */
import type { Awareness } from 'y-protocols/awareness'
import { type StoreApi, createStore } from 'zustand/vanilla'
import type { EditorEngine } from '../engine/editor'
import { t } from '../strings'
import { colorForUser, isHexColor } from './colors'
import type { Role } from './provider'

/** Awareness is sent at most this often (about 15 updates a second). */
export const PUBLISH_INTERVAL_MS = 66
/** The edit lock is refreshed while editing; a lock not refreshed for this long is ignored. */
export const LOCK_HEARTBEAT_MS = 10_000
export const LOCK_TTL_MS = 30_000
/** After this long without a change a collaborator counts as idle. */
export const IDLE_AFTER_MS = 30_000
const MAX_SELECTED = 24
const MAX_NAME = 80
const ROLES: readonly string[] = ['owner', 'edit', 'comment', 'view']

/** An oriented box in page coordinates: centre, size and rotation in degrees. */
export interface Box {
  cx: number
  cy: number
  w: number
  h: number
  a: number
}

export interface PeerCursor {
  pageId: string
  x: number
  y: number
}

export interface PeerSelection {
  pageId: string
  ids: string[]
  box: Box | null
}

export interface PeerEditing {
  pageId: string
  id: string
}

/** What a collaborator looks at: the page and the point of it at the middle of their window, and their zoom. */
export interface PeerView {
  pageId: string
  x: number
  y: number
  zoom: number
}

export interface Peer {
  clientId: number
  userId: string
  name: string
  avatarUrl: string | null
  color: string
  role: Role
  cursor: PeerCursor | null
  selection: PeerSelection | null
  editing: PeerEditing | null
  view: PeerView | null
  lastActive: number
  idle: boolean
}

export interface PresenceState {
  /** Everyone else, one entry per connection. */
  peers: Peer[]
  /** The connection whose window this user follows. */
  following: number | null
}

interface LocalState {
  cursor: PeerCursor | null
  view: PeerView | null
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isText = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

function readBox(value: unknown): Box | null {
  const b = record(value)
  if (!b || !isNumber(b.cx) || !isNumber(b.cy) || !isNumber(b.w) || !isNumber(b.h) || !isNumber(b.a)) return null
  return { cx: b.cx, cy: b.cy, w: Math.max(0, b.w), h: Math.max(0, b.h), a: b.a }
}

function readCursor(value: unknown): PeerCursor | null {
  const c = record(value)
  return c && isText(c.pageId) && isNumber(c.x) && isNumber(c.y) ? { pageId: c.pageId, x: c.x, y: c.y } : null
}

function readSelection(value: unknown): PeerSelection | null {
  const s = record(value)
  if (!s || !isText(s.pageId) || !Array.isArray(s.ids)) return null
  const ids = s.ids.filter((id): id is string => isText(id, 64)).slice(0, MAX_SELECTED)
  return ids.length > 0 ? { pageId: s.pageId, ids, box: readBox(s.box) } : null
}

function readEditing(value: unknown): PeerEditing | null {
  const e = record(value)
  return e && isText(e.pageId) && isText(e.id, 64) ? { pageId: e.pageId, id: e.id } : null
}

function readView(value: unknown): PeerView | null {
  const v = record(value)
  return v && isText(v.pageId) && isNumber(v.x) && isNumber(v.y) && isNumber(v.zoom) && v.zoom > 0 ? { pageId: v.pageId, x: v.x, y: v.y, zoom: v.zoom } : null
}

/** An avatar address a page may safely load: an absolute http(s) URL or a path on this site. */
export function safeAvatar(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null
  return /^https?:\/\//i.test(value) || (value.startsWith('/') && !value.startsWith('//')) ? value : null
}

/** One collaborator from an awareness state, or `null` when the state is not one (no identity from the server). */
export function readPeer(clientId: number, state: unknown): Omit<Peer, 'lastActive' | 'idle'> | null {
  const s = record(state)
  const user = record(s?.user)
  if (!s || !user || !isText(user.id, 64)) return null
  const role = typeof user.role === 'string' && ROLES.includes(user.role) ? (user.role as Role) : 'view'
  return {
    clientId,
    userId: user.id,
    name: typeof user.name === 'string' && user.name.trim() ? user.name.trim().slice(0, MAX_NAME) : t.collab.presence.someone,
    avatarUrl: safeAvatar(user.avatarUrl),
    color: isHexColor(user.color) ? user.color : colorForUser(user.id),
    role,
    cursor: readCursor(s.cursor),
    selection: readSelection(s.selection),
    editing: readEditing(s.editing),
    view: readView(s.view),
  }
}

const round = (n: number, step = 0.5): number => Math.round(n / step) * step

/** What presence needs from the editor. */
export type PresenceHost = Pick<EditorEngine, 'store' | 'state' | 'viewOf' | 'setRemoteEditLocks' | 'stopEditingText' | 'toast' | 'announce'>

export class Presence {
  readonly store: StoreApi<PresenceState>
  private local: LocalState = { cursor: null, view: null }
  private myColor: string | null = null
  private lastSent = ''
  private publishTimer: ReturnType<typeof setTimeout> | null = null
  private lastPublish = 0
  private recomputeScheduled = false
  private frame = 0
  private recomputeTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private editingBeat = 0
  /** People who were here at the last look; `null` until the first one (nobody is announced for who is already there). */
  private people: Map<string, string> | null = null
  private readonly seen = new Map<number, { signature: string; at: number; lockAt: number; beat: number }>()
  private readonly cleanups: (() => void)[] = []
  private started = false

  constructor(
    private readonly awareness: Awareness,
    private readonly engine: PresenceHost,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.store = createStore<PresenceState>(() => ({ peers: [], following: null }))
  }

  start(): void {
    if (this.started) return
    this.started = true
    const onAwareness = (): void => this.scheduleRecompute()
    this.awareness.on('change', onAwareness)
    this.cleanups.push(() => this.awareness.off('change', onAwareness))
    const off = this.engine.store.subscribe((state, prev) => {
      if (state.selection !== prev.selection || state.activePageId !== prev.activePageId) this.schedulePublish()
    })
    this.cleanups.push(off)
    this.heartbeat = setInterval(() => {
      if (this.engine.state.selection.editing) {
        this.editingBeat += 1
        this.schedulePublish()
      }
    }, LOCK_HEARTBEAT_MS)
    this.idleTimer = setInterval(() => this.scheduleRecompute(), 5_000)
    this.scheduleRecompute()
    this.schedulePublish()
  }

  stop(): void {
    this.started = false
    for (const undo of this.cleanups.splice(0)) undo()
    if (this.publishTimer) clearTimeout(this.publishTimer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.idleTimer) clearInterval(this.idleTimer)
    if (this.recomputeTimer) clearTimeout(this.recomputeTimer)
    if (this.frame) cancelAnimationFrame(this.frame)
    this.publishTimer = this.heartbeat = this.idleTimer = this.recomputeTimer = null
    this.frame = 0
    this.engine.setRemoteEditLocks(new Map())
  }

  /** Knows who the server says this user is; the colour follows from the id. */
  identify(userId: string): void {
    this.myColor = colorForUser(userId)
    this.publishNow()
  }

  /* ---------------------------------------------------------------- publishing */

  setCursor(cursor: PeerCursor | null): void {
    const next = cursor ? { pageId: cursor.pageId, x: round(cursor.x), y: round(cursor.y) } : null
    if (JSON.stringify(next) === JSON.stringify(this.local.cursor)) return
    this.local.cursor = next
    this.schedulePublish()
  }

  setView(view: PeerView | null): void {
    const next = view ? { pageId: view.pageId, x: round(view.x, 1), y: round(view.y, 1), zoom: Math.round(view.zoom * 1000) / 1000 } : null
    if (JSON.stringify(next) === JSON.stringify(this.local.view)) return
    this.local.view = next
    this.schedulePublish()
  }

  private schedulePublish(): void {
    if (!this.started || this.publishTimer) return
    const wait = Math.max(0, PUBLISH_INTERVAL_MS - (this.now() - this.lastPublish))
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null
      this.publishNow()
    }, wait)
  }

  private selectionState(): { selection: PeerSelection | null; editing: PeerEditing | null } {
    const { selection } = this.engine.state
    if (!selection.pageId || selection.ids.length === 0) return { selection: null, editing: null }
    const active = this.engine.viewOf(selection.pageId)?.canvas.getActiveObject()
    let box: Box | null = null
    if (active) {
      const center = active.getCenterPoint()
      box = { cx: round(center.x, 0.1), cy: round(center.y, 0.1), w: round(active.getScaledWidth(), 0.1), h: round(active.getScaledHeight(), 0.1), a: round(active.angle, 0.1) }
    }
    const ids = selection.ids.slice(0, MAX_SELECTED)
    return {
      selection: { pageId: selection.pageId, ids, box },
      editing: selection.editing && selection.ids.length === 1 ? { pageId: selection.pageId, id: selection.ids[0] } : null,
    }
  }

  private publishNow(): void {
    if (!this.started) return
    this.lastPublish = this.now()
    const { selection, editing } = this.selectionState()
    const state = {
      user: this.myColor ? { color: this.myColor } : {},
      cursor: this.local.cursor,
      view: this.local.view,
      selection,
      editing: editing ? { ...editing, beat: this.editingBeat } : null,
    }
    const text = JSON.stringify(state)
    if (text === this.lastSent) return
    this.lastSent = text
    this.awareness.setLocalState(state)
  }

  /* ----------------------------------------------------------------- receiving */

  private scheduleRecompute(): void {
    if (this.recomputeScheduled) return
    this.recomputeScheduled = true
    const run = (): void => {
      if (!this.recomputeScheduled) return
      this.recomputeScheduled = false
      if (this.frame) cancelAnimationFrame(this.frame)
      if (this.recomputeTimer) clearTimeout(this.recomputeTimer)
      this.frame = 0
      this.recomputeTimer = null
      this.recompute()
    }
    this.frame = requestAnimationFrame(run)
    this.recomputeTimer = setTimeout(run, 120)
  }

  private recompute(): void {
    if (!this.started) return
    const now = this.now()
    const alive = new Set<number>()
    const peers: Peer[] = []
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.awareness.clientID) continue
      const peer = readPeer(clientId, state)
      if (!peer) continue
      alive.add(clientId)
      const s = record(state)
      const editing = record(s?.editing)
      const beat = isNumber(editing?.beat) ? editing.beat : -1
      const signature = JSON.stringify([peer.cursor, peer.selection, peer.view, peer.editing])
      const known = this.seen.get(clientId)
      const changed = !known || known.signature !== signature
      const record_ = { signature, at: changed ? now : known.at, lockAt: !known || known.beat !== beat || !peer.editing ? now : known.lockAt, beat }
      this.seen.set(clientId, record_)
      peers.push({ ...peer, lastActive: record_.at, idle: now - record_.at > IDLE_AFTER_MS, editing: peer.editing && now - record_.lockAt <= LOCK_TTL_MS ? peer.editing : null })
    }
    for (const id of this.seen.keys()) if (!alive.has(id)) this.seen.delete(id)
    peers.sort((a, b) => a.clientId - b.clientId)
    this.announceChanges(peers)
    const previous = this.store.getState()
    const following = previous.following !== null && alive.has(previous.following) ? previous.following : null
    this.store.setState({ peers: samePeers(previous.peers, peers) ? previous.peers : peers, following })
    this.applyLocks(peers)
  }

  /** Tells assistive technology when somebody joins or leaves. */
  private announceChanges(peers: readonly Peer[]): void {
    const now = new Map(peers.map((p) => [p.userId, p.name]))
    const before = this.people
    this.people = now
    if (!before) return
    const arrived = [...now].filter(([id]) => !before.has(id)).map(([, name]) => t.collab.presence.joined(name))
    const gone = [...before].filter(([id]) => !now.has(id)).map(([, name]) => t.collab.presence.left(name))
    const message = [...arrived, ...gone].join('. ')
    if (message) this.engine.announce(message)
  }

  /** Objects whose text somebody else is editing cannot be edited here; if both started together, the lower connection wins. */
  private applyLocks(peers: readonly Peer[]): void {
    const locks = new Map<string, Set<string>>()
    for (const peer of peers) {
      if (!peer.editing) continue
      const set = locks.get(peer.editing.pageId) ?? new Set<string>()
      set.add(peer.editing.id)
      locks.set(peer.editing.pageId, set)
    }
    this.engine.setRemoteEditLocks(locks)
    const mine = this.engine.state.selection
    if (mine.editing && mine.pageId && mine.ids.length === 1) {
      const rival = peers.find((p) => p.editing?.pageId === mine.pageId && p.editing.id === mine.ids[0] && p.clientId < this.awareness.clientID)
      if (rival) {
        this.engine.stopEditingText()
        this.engine.toast(t.collab.presence.lockTaken(rival.name), 'info')
      }
    }
  }

  /* ------------------------------------------------------------------- queries */

  /** The collaborator editing the text of an object, if any. */
  lockOwner(pageId: string, objectId: string): Peer | undefined {
    return this.store.getState().peers.find((p) => p.editing?.pageId === pageId && p.editing.id === objectId)
  }

  follow(clientId: number | null): void {
    const current = this.store.getState().following
    const next = clientId === current ? null : clientId
    this.store.setState({ following: next })
  }
}

function samePeers(a: readonly Peer[], b: readonly Peer[]): boolean {
  return a.length === b.length && a.every((peer, i) => JSON.stringify(peer) === JSON.stringify(b[i]))
}
