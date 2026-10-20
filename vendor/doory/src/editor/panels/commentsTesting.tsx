/** Test kit for the comment UI: a real engine on jsdom with the in-memory comments service of the harness. */
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { createBlankDocument } from '@/lib/document'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import type { CommentRole } from '../dev/memoryComments'
import { EditorProvider } from '../EditorProvider'
import { EditorEngine } from '../engine/editor'
import type { EditorMode } from '@/types/adapter'
import type { DoryDocument } from '@/types/document'

export interface CommentsRig {
  engine: EditorEngine
  handle: ReturnType<typeof createMemoryAdapter>
  doc: DoryDocument
  /** Page ids, in order. */
  pages: string[]
  renderIn(ui: ReactElement): ReturnType<typeof render>
}

interface RigOptions {
  pages?: number
  width?: number
  height?: number
  role?: CommentRole
  seed?: string | null
  mode?: EditorMode
}

/** An editor with `pages` pages, comments of the given role and seed (`demo` or a number), not yet rendered. */
export function createCommentsRig({ pages = 2, width = 800, height = 600, role = 'owner', seed = 'demo', mode = 'account' }: RigOptions = {}): CommentsRig {
  const base = createBlankDocument(width, height)
  const doc: DoryDocument = { ...base, pages: Array.from({ length: pages }, (_, i) => ({ ...base.pages[0], id: `page-${i + 1}` })) }
  const handle = createMemoryAdapter({ account: true, commentRole: role, commentSeed: seed })
  const engine = new EditorEngine({ adapter: handle.adapter, document: doc, meta: { id: 'd', title: 'T', mode }, ephemeral: true })
  handle.bindDocument(() => engine.getDocument())
  return {
    engine,
    handle,
    doc,
    pages: doc.pages.map((p) => p.id),
    renderIn: (ui) => render(<EditorProvider engine={engine} portalRoot={document.body}>{ui}</EditorProvider>),
  }
}

interface PointerInit extends MouseEventInit {
  pointerId?: number
  pointerType?: string
}

/** jsdom has no PointerEvent: this one is a mouse event that also knows its pointer, enough for what the pins read. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number
  readonly pointerType: string
  constructor(type: string, init: PointerInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
    this.pointerType = init.pointerType ?? 'mouse'
  }
}

export function installPointerEvents(): void {
  Object.defineProperty(window, 'PointerEvent', { value: TestPointerEvent, configurable: true, writable: true })
}
