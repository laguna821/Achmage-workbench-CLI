/** Test support: an editor engine with one live page, for the tests of the panel, the timeline and the preview. */
import { StaticCanvas } from 'fabric'
import { createBlankDocument } from '@/lib/document'
import type { DocObject, DoryDocument, ObjectAnimation } from '@/types/document'
import { createMemoryAdapter } from '../dev/memoryAdapter'
import { EditorEngine } from '../engine/editor'
import { createRect } from '../engine/objects/factories'
import { serializeObjects } from '../engine/serialization'

export const enter = (preset: string, delayMs = 0, durationMs = 600): ObjectAnimation => ({ enter: { preset, durationMs, delayMs, easing: 'ease-out' } })

export const rectObject = (id: string, left: number, top: number, animation?: ObjectAnimation, over: Partial<DocObject> = {}): DocObject => ({
  id,
  type: 'rect',
  left,
  top,
  width: 100,
  height: 60,
  fill: '#ff0000',
  stroke: null,
  strokeWidth: 0,
  originX: 'center',
  originY: 'center',
  ...(animation ? { animation } : {}),
  ...over,
})

export const textObject = (id: string, left: number, top: number, animation?: ObjectAnimation): DocObject => ({
  id,
  type: 'textbox',
  left,
  top,
  width: 200,
  height: 40,
  text: 'Hello world',
  fontSize: 24,
  fontFamily: 'sans-serif',
  fill: '#000000',
  originX: 'center',
  originY: 'center',
  ...(animation ? { animation } : {}),
})

export interface Setup {
  engine: EditorEngine
  pageId: string
}

/** An editor on `doc` (default: one 800 x 600 page) whose first page is mounted and loaded. */
export async function setupEditor(options: { doc?: DoryDocument; mode?: 'guest' | 'shared-view'; objects?: DocObject[] } = {}): Promise<Setup> {
  const doc = options.doc ?? createBlankDocument(800, 600)
  if (options.objects) doc.pages[0] = { ...doc.pages[0], objects: options.objects }
  const engine = new EditorEngine({ adapter: createMemoryAdapter().adapter, document: doc, meta: { id: 'd1', title: 'Test', mode: options.mode ?? 'guest' }, ephemeral: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const pageId = engine.state.doc.pages[0].id
  engine.mountPage(pageId, host)
  const view = await engine.whenView(pageId)
  view.setLayout(1, { x: 0, y: 0, width: 800, height: 600 })
  return { engine, pageId }
}

/**
 * A rectangle exactly as the editor writes one (every property Fabric keeps, defaults included), so that a change made
 * to it elsewhere shows up as the one property that changed and not as a rewrite of the whole object.
 */
export function serializedRect(id: string, x: number, y: number, animation?: ObjectAnimation): DocObject {
  const canvas = new StaticCanvas(document.createElement('canvas'), { width: 800, height: 600, renderOnAddRemove: false })
  const rect = createRect({ x, y }, 100)
  canvas.add(rect)
  const [json] = serializeObjects(canvas)
  canvas.dispose()
  return { ...json, id, ...(animation ? { animation } : {}) }
}
