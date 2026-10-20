/**
 * Engines on both sides of a fake server for the collab tests: a design written by the editor itself, editors that
 * join it, and the small helpers the specs share.
 */
import { createBlankDocument } from '@/lib/document'
import type { RealtimeConnection } from '@/types/adapter'
import type { DocObject, DoryDocument } from '@/types/document'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorEngine } from '../engine/editor'
import { type ConnectionPlan, type FakeCollabServer, settle } from './fakeServer'
import { CollabSession } from './session'

export const owner = (id: string, name: string): ConnectionPlan => ({ user: { id, name }, role: 'owner' })

export interface Peer {
  engine: EditorEngine
  session: CollabSession
  handle: ReturnType<typeof createMemoryAdapter>
  host: HTMLElement
  pageId: string
  /** The document the editor had before it connected. */
  opened: DoryDocument
}

/** A two-rectangle design written by the editor itself, so it carries every property the editor serialises. */
export async function seedDocument(): Promise<DoryDocument> {
  const handle = createMemoryAdapter()
  const engine = new EditorEngine({ adapter: handle.adapter, document: createBlankDocument(800, 600), meta: { id: 's', title: 'Seed', mode: 'guest' }, ephemeral: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const pageId = engine.state.doc.pages[0].id
  engine.mountPage(pageId, host)
  const view = await engine.whenView(pageId)
  view.setLayout(1, { x: 0, y: 0, width: 800, height: 600 })
  await engine.insert.shape('rect')
  await engine.insert.shape('rect')
  const raw = JSON.parse(JSON.stringify(engine.state.doc)) as DoryDocument
  engine.dispose()
  host.remove()
  const ids = ['rect-1', 'rect-2']
  const objects = raw.pages[0].objects.map((o, i) => ({ ...o, id: ids[i], left: 100 + i * 200, top: 100 + i * 100 }))
  return { ...raw, pages: [{ ...raw.pages[0], id: 'page-1', objects }] }
}

export async function open(server: FakeCollabServer, plan: ConnectionPlan, doc: DoryDocument, extra: Partial<RealtimeConnection> = {}): Promise<Peer> {
  const handle = createMemoryAdapter()
  const engine = new EditorEngine({ adapter: handle.adapter, document: doc, meta: { id: 'd1', title: 'Design', mode: 'account' }, ephemeral: true })
  engine.start()
  engine.persistence.start({})
  const host = document.createElement('div')
  document.body.appendChild(host)
  const pageId = doc.pages[0].id
  engine.mountPage(pageId, host)
  const view = await engine.whenView(pageId)
  view.setLayout(1, { x: 0, y: 0, width: 800, height: 600 })
  const opened = engine.state.doc
  const realtime: RealtimeConnection = { url: 'ws://test/', setTitle: async () => undefined, requireSignIn: async () => false, flushRef: { current: null }, early: { room: null, start: () => undefined, release: () => undefined }, ...extra }
  const session = new CollabSession(engine, realtime, { createSocket: server.socketFactory(plan), random: () => 0.5 })
  session.start()
  return { engine, session, handle, host, pageId, opened }
}

export const objects = (peer: Peer): DocObject[] => peer.engine.state.doc.pages[0].objects
export const byId = (peer: Peer, id: string): DocObject | undefined => objects(peer).find((o) => o.id === id)
export const live = (peer: Peer) => peer.engine.viewOf(peer.pageId)?.canvas.getObjects() ?? []
/** The user's own edit, as a toolbar command would do it. */
export function move(peer: Peer, id: string, dx: number): void {
  peer.engine.select([id])
  peer.engine.arrange.nudge(dx, 0)
}
export async function frames(): Promise<void> {
  await settle(4)
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  await settle(4)
}

