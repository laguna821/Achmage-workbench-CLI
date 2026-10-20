/**
 * The conversation between the audience window and the presenter view (a second window opened with "Present with
 * notes"). It runs over a `BroadcastChannel`, so it needs no server: the two windows are the same origin in the same
 * browser. The audience window owns the show (the state machine, the clock, the rendering); the presenter view only
 * displays what it is sent and sends commands back.
 *
 *   view  -> show   hello                         "I opened, send me everything"
 *   show  -> view   init                          title, theme, every page's name, notes, time and size, the state
 *   show  -> view   state                         after every change and once a second (the view runs its own clock)
 *   view  -> show   command                       a navigation / playback command, or {goto}
 *   view  -> show   need-frame                    "render this page about this wide"
 *   show  -> view   frame                         the rendered page as an image blob
 *   either          bye                           the window is closing
 *
 * Every incoming value is validated before use (`parseMessage`): the channel is same-origin only, but a message is
 * still data from outside the component, so sizes, ranges and types are checked, and strings are bounded.
 */
import type { SlideshowState } from './machine'
import { DURATION_MAX_SEC, DURATION_MIN_SEC, NOTES_MAX_LENGTH } from './timing'

export const PROTOCOL_VERSION = 1
export type Role = 'show' | 'view'

const SESSION = /^[A-Za-z0-9_-]{16,64}$/
const MAX_PAGES = 100
const MAX_ID = 64
const MAX_NAME = 200
const MAX_TITLE = 300
const MAX_PAGE_SIDE = 20_000
const MAX_FRAME_WIDTH = 4096
const MAX_FRAME_BYTES = 24 * 1024 * 1024
const MAX_MS = 1e11

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION.test(value)
}

/** A fresh, unguessable session id (128 random bits). */
export function newSessionId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const channelName = (session: string): string => `doory-presenter-${session}`

/** What the presenter view needs to know about a page. `durationSec` is the resolved auto-advance time (`null` = waits). */
export interface PagePreview {
  id: string
  name: string
  notes: string
  durationSec: number | null
  width: number
  height: number
}

export type ViewCommand =
  | { action: 'next' | 'prev' | 'first' | 'last' | 'toggle-pause' | 'toggle-loop' | 'toggle-blackout' | 'restart' | 'exit' }
  | { action: 'goto'; index: number }

export type ChannelMessage =
  | { kind: 'hello' }
  | { kind: 'init'; title: string; theme: 'light' | 'dark' | null; pages: PagePreview[]; state: SlideshowState }
  | { kind: 'state'; state: SlideshowState }
  | { kind: 'command'; command: ViewCommand }
  | { kind: 'need-frame'; pageId: string; width: number }
  | { kind: 'frame'; pageId: string; width: number; image: Blob }
  | { kind: 'bye' }

export type Envelope = ChannelMessage & { v: typeof PROTOCOL_VERSION; from: Role }

/** Which side may send which message. */
const SENDER: Readonly<Record<ChannelMessage['kind'], Role | 'both'>> = {
  hello: 'view',
  init: 'show',
  state: 'show',
  command: 'view',
  'need-frame': 'view',
  frame: 'show',
  bye: 'both',
}

const COMMANDS: ReadonlySet<string> = new Set(['next', 'prev', 'first', 'last', 'toggle-pause', 'toggle-loop', 'toggle-blackout', 'restart', 'exit'])

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MS
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max

function parseState(value: unknown): SlideshowState | null {
  if (!isObject(value)) return null
  const { index, ended, autoAdvance, paused, loop, blackout, pageMs, totalMs } = value
  if (!isInt(index, 0, MAX_PAGES - 1) || !isMs(pageMs) || !isMs(totalMs)) return null
  if (typeof ended !== 'boolean' || typeof autoAdvance !== 'boolean' || typeof paused !== 'boolean' || typeof loop !== 'boolean' || typeof blackout !== 'boolean') return null
  return { index, ended, autoAdvance, paused, loop, blackout, pageMs, totalMs }
}

function parsePage(value: unknown): PagePreview | null {
  if (!isObject(value)) return null
  const { id, name, notes, durationSec, width, height } = value
  if (!isText(id, MAX_ID) || id === '' || !isText(name, MAX_NAME) || !isText(notes, NOTES_MAX_LENGTH)) return null
  const timeOk = durationSec === null || (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec >= DURATION_MIN_SEC && durationSec <= DURATION_MAX_SEC)
  const sideOk = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_PAGE_SIDE
  if (!timeOk || !sideOk(width) || !sideOk(height)) return null
  return { id, name, notes, durationSec: durationSec as number | null, width, height }
}

function parseCommand(value: unknown): ViewCommand | null {
  if (!isObject(value) || typeof value.action !== 'string') return null
  if (value.action === 'goto') return isInt(value.index, 0, MAX_PAGES - 1) ? { action: 'goto', index: value.index } : null
  return COMMANDS.has(value.action) ? ({ action: value.action } as ViewCommand) : null
}

function parseBody(kind: string, data: Record<string, unknown>): ChannelMessage | null {
  switch (kind) {
    case 'hello':
    case 'bye':
      return { kind }
    case 'init': {
      const state = parseState(data.state)
      const theme = data.theme === 'light' || data.theme === 'dark' ? data.theme : data.theme === null ? null : undefined
      if (!state || theme === undefined || !isText(data.title, MAX_TITLE) || !Array.isArray(data.pages) || data.pages.length < 1 || data.pages.length > MAX_PAGES) return null
      const pages: PagePreview[] = []
      for (const raw of data.pages) {
        const page = parsePage(raw)
        if (!page) return null
        pages.push(page)
      }
      return state.index < pages.length ? { kind, title: data.title, theme, pages, state } : null
    }
    case 'state': {
      const state = parseState(data.state)
      return state ? { kind, state } : null
    }
    case 'command': {
      const command = parseCommand(data.command)
      return command ? { kind, command } : null
    }
    case 'need-frame':
      return isText(data.pageId, MAX_ID) && data.pageId !== '' && isInt(data.width, 1, MAX_FRAME_WIDTH) ? { kind, pageId: data.pageId, width: data.width } : null
    case 'frame': {
      const image = data.image
      const ok = image instanceof Blob && image.size > 0 && image.size <= MAX_FRAME_BYTES && /^image\/(png|jpeg|webp)$/.test(image.type)
      return ok && isText(data.pageId, MAX_ID) && data.pageId !== '' && isInt(data.width, 1, MAX_FRAME_WIDTH) ? { kind, pageId: data.pageId, width: data.width, image } : null
    }
    default:
      return null
  }
}

/** The message in `data` when it is a well-formed envelope of this protocol version sent by the other role than `receiver`, else `null`. */
export function parseMessage(data: unknown, receiver: Role): Envelope | null {
  if (!isObject(data) || data.v !== PROTOCOL_VERSION || typeof data.kind !== 'string') return null
  const from = data.from
  if (from !== 'show' && from !== 'view') return null
  if (from === receiver) return null
  const body = parseBody(data.kind, data)
  if (!body) return null
  const allowed = SENDER[body.kind]
  if (allowed !== 'both' && allowed !== from) return null
  return { ...body, v: PROTOCOL_VERSION, from }
}

/** The part of `BroadcastChannel` this module uses, so tests can stand in for it. */
export interface ChannelLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  close(): void
}

export interface PresenterLink {
  send(message: ChannelMessage): void
  /** Calls `handler` for every valid message from the other role; returns the unsubscribe function. */
  subscribe(handler: (message: Envelope) => void): () => void
  close(): void
}

/** True when this browser can link two windows (every current one can). */
export function canLink(): boolean {
  return typeof BroadcastChannel === 'function'
}

function browserChannel(name: string): ChannelLike | null {
  return canLink() ? new BroadcastChannel(name) : null
}

/**
 * Joins the conversation of `session` as `role`. `null` when the browser has no `BroadcastChannel` or the session id
 * is malformed. Sending after `close()` is a no-op.
 */
export function openLink(session: string, role: Role, create: (name: string) => ChannelLike | null = browserChannel): PresenterLink | null {
  if (!isSessionId(session)) return null
  const channel = create(channelName(session))
  if (!channel) return null
  let closed = false
  return {
    send(message) {
      if (closed) return
      channel.postMessage({ ...message, v: PROTOCOL_VERSION, from: role })
    },
    subscribe(handler) {
      const listener = (event: MessageEvent): void => {
        const message = parseMessage(event.data, role)
        if (message) handler(message)
      }
      channel.addEventListener('message', listener)
      return () => channel.removeEventListener('message', listener)
    },
    close() {
      if (closed) return
      closed = true
      channel.close()
    },
  }
}

/** The address of the presenter view page for a session (a same-origin page of the built app, see `presenter-view.html`). */
export function presenterViewUrl(session: string, base: string = import.meta.env.BASE_URL, origin: string = location.href): string {
  const url = new URL(`${base}presenter-view.html`, origin)
  url.searchParams.set('session', session)
  return url.toString()
}
