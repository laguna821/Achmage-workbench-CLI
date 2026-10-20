/**
 * In-memory comments for the dev harness and the specs: the owner of a design, somebody commenting through a link, and a
 * visitor who is not signed in see the same threads with the rights the real adapters give them. Never shipped in the
 * production bundle. The handle lets a spec play "the other person" (changes that arrive while the editor polls),
 * make the next call fail, and slow the service down so a change that is still being saved can be seen.
 */
import { newId } from '@/lib/document'
import type { CommentViewer, EditorServices } from '@/types/adapter'
import type { CommentMove, CommentT } from '@/types/api'
import type { DoryDocument } from '@/types/document'

export type CommentRole = 'owner' | 'commenter' | 'anonymous'
export type CommentCall = 'list' | 'create' | 'resolve' | 'remove' | 'move' | 'viewer'

const OWNER = { id: 'user-1', name: 'Alex Rivera', avatar_url: null }
const GUEST = { id: 'user-2', name: 'Sam Lee', avatar_url: null }

export interface MemoryCommentsHandle {
  service: NonNullable<EditorServices['comments']>
  /** Every call the editor made, in order: `create`, `resolve:<id>`, … */
  calls: string[]
  /** The next call of this kind rejects with `error`. */
  failNext(call: CommentCall, error?: Error): void
  /** Milliseconds every call takes. */
  setLatency(ms: number): void
  /** Somebody else's changes, visible to the editor's next refresh. */
  remote: {
    add(input: { body: string; page_id?: string | null; x?: number | null; y?: number | null; parent?: string | null; author?: 'owner' | 'guest' }): CommentT
    resolve(id: string, resolved: boolean): void
    remove(id: string): void
    move(id: string, to: CommentMove): void
  }
  /** The visitor signed in (the `anonymous` role becomes a commenter). */
  signIn(): void
  /** What is stored, without counting as a call. */
  snapshot(): CommentT[]
}

interface Options {
  role: CommentRole
  getDocument: () => DoryDocument
  /** `demo`: a handful of threads; a number: that many pins spread over the pages. */
  seed?: string | null
}

function seedComments(doc: DoryDocument, seed: string, at: () => string): CommentT[] {
  const pages = doc.pages
  const first = pages[0]
  const second = pages[1] ?? pages[0]
  const make = (over: Partial<CommentT> & Pick<CommentT, 'body'>): CommentT => ({ id: newId(), author: OWNER, page_id: null, x: null, y: null, parent: null, resolved: false, created_at: at(), ...over })
  if (seed === 'demo') {
    const a = make({ body: 'Try a bolder headline here.', author: GUEST, page_id: first.id, x: 240, y: 180, created_at: '2026-03-01T09:00:00Z' })
    const reply = make({ body: 'Good call, I will make it heavier.', parent: a.id, page_id: first.id, x: 240, y: 180, created_at: '2026-03-01T09:05:00Z' })
    const b = make({ body: 'The photo looks soft at this size.', author: GUEST, page_id: first.id, x: 620, y: 420, created_at: '2026-03-01T10:00:00Z' })
    const c = make({ body: 'Logo placement approved.', page_id: second.id, x: 120, y: 90, resolved: true, created_at: '2026-03-01T11:00:00Z' })
    const d = make({ body: 'Overall: love the palette.', author: GUEST, created_at: '2026-03-01T12:00:00Z' })
    const gone = make({ body: 'This was on a page that no longer exists.', author: GUEST, page_id: 'deleted-page', x: 10, y: 10, created_at: '2026-03-01T13:00:00Z' })
    return [a, reply, b, c, d, gone]
  }
  const count = Math.max(0, Math.min(2000, Number.parseInt(seed, 10) || 0))
  return Array.from({ length: count }, (_, i) => {
    const page = pages[i % pages.length]
    const column = Math.floor(i / pages.length)
    return make({ body: `Comment ${i + 1}`, author: i % 3 === 0 ? OWNER : GUEST, page_id: page.id, x: 30 + (column % 25) * 38, y: 30 + Math.floor(column / 25) * 38, resolved: i % 7 === 0, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() })
  })
}

export function createMemoryComments({ role, getDocument, seed }: Options): MemoryCommentsHandle {
  let comments: CommentT[] = []
  let seeded = false
  let signedIn = role !== 'anonymous'
  let latency = 0
  const failures = new Map<CommentCall, Error>()
  const calls: string[] = []
  const now = (): string => new Date().toISOString()
  const me = (): typeof OWNER => (role === 'owner' ? OWNER : GUEST)

  const enter = async (call: CommentCall, label: string = call): Promise<void> => {
    calls.push(label)
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency))
    const failure = failures.get(call)
    if (failure) {
      failures.delete(call)
      throw failure
    }
  }
  const ensureSeeded = (): void => {
    if (seeded) return
    seeded = true
    if (seed) comments = seedComments(getDocument(), seed, now)
  }
  const change = (id: string, edit: (c: CommentT) => CommentT): CommentT => {
    const current = comments.find((c) => c.id === id)
    if (!current) throw new Error('Unknown comment')
    const next = edit(current)
    comments = comments.map((c) => (c.id === id ? next : c))
    return next
  }

  const service: NonNullable<EditorServices['comments']> = {
    async list() {
      await enter('list')
      ensureSeeded()
      return comments
    },
    async create(input) {
      await enter('create')
      ensureSeeded()
      if (!signedIn) throw new Error('Sign in to comment.')
      const parent = input.parent ? comments.find((c) => c.id === input.parent) : undefined
      const made: CommentT = {
        id: newId(),
        author: me(),
        body: input.body,
        page_id: parent ? parent.page_id : (input.page_id ?? null),
        x: parent ? parent.x : (input.x ?? null),
        y: parent ? parent.y : (input.y ?? null),
        parent: input.parent ?? null,
        resolved: false,
        created_at: now(),
      }
      comments = [...comments, made]
      return made
    },
    ...(role === 'owner'
      ? {
          async resolve(id: string, resolved: boolean) {
            await enter('resolve', `resolve:${id}`)
            return change(id, (c) => ({ ...c, resolved }))
          },
        }
      : {}),
    async remove(id) {
      await enter('remove', `remove:${id}`)
      comments = comments.filter((c) => c.id !== id && c.parent !== id)
    },
    async move(id, to) {
      await enter('move', `move:${id}`)
      comments = comments.map((c) => (c.id === id || c.parent === id ? { ...c, ...to } : c))
      const moved = comments.find((c) => c.id === id)
      if (!moved) throw new Error('Unknown comment')
      return moved
    },
    async viewer(): Promise<CommentViewer | null> {
      await enter('viewer')
      return signedIn ? { id: me().id, owner: role === 'owner' } : null
    },
  }

  return {
    service,
    calls,
    failNext: (call, error = new Error(`${call} failed`)) => void failures.set(call, error),
    setLatency: (ms) => {
      latency = ms
    },
    remote: {
      add(input) {
        ensureSeeded()
        const parent = input.parent ? comments.find((c) => c.id === input.parent) : undefined
        const made: CommentT = {
          id: newId(),
          author: input.author === 'owner' ? OWNER : GUEST,
          body: input.body,
          page_id: parent ? parent.page_id : (input.page_id ?? null),
          x: parent ? parent.x : (input.x ?? null),
          y: parent ? parent.y : (input.y ?? null),
          parent: input.parent ?? null,
          resolved: false,
          created_at: now(),
        }
        comments = [...comments, made]
        return made
      },
      resolve(id, resolved) {
        change(id, (c) => ({ ...c, resolved }))
      },
      remove(id) {
        comments = comments.filter((c) => c.id !== id && c.parent !== id)
      },
      move(id, to) {
        comments = comments.map((c) => (c.id === id || c.parent === id ? { ...c, ...to } : c))
      },
    },
    signIn() {
      signedIn = true
    },
    snapshot: () => {
      ensureSeeded()
      return comments
    },
  }
}
