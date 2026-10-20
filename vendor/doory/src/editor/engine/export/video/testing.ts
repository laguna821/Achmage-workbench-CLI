/** Fixtures of the video export tests: small documents with and without motion. */
import type { Anim, DocObject, DocPage, DoryDocument, PageTransition } from '@/types/document'
import { pageSize } from '../../docOps'
import type { PageRef } from './timeline'

export const anim = (preset: string, over: Partial<Anim> = {}): Anim => ({ preset, durationMs: 1000, delayMs: 0, easing: 'linear', ...over })

export const rect = (id: string, animation?: DocObject['animation']): DocObject => ({
  id,
  type: 'rect',
  left: 50,
  top: 50,
  width: 40,
  height: 40,
  fill: '#ff0000',
  originX: 'center',
  originY: 'center',
  ...(animation ? { animation } : {}),
})

export function page(id: string, over: Partial<DocPage> = {}): DocPage {
  return { id, background: { type: 'solid', color: '#ffffff' }, objects: [], ...over }
}

export const push: PageTransition = { preset: 'push', durationMs: 800, easing: 'linear', direction: 'left' }

export const doc = (pages: DocPage[], width = 100, height = 100): DoryDocument => ({ schemaVersion: 1, width, height, unit: 'px', pages })

/** Every page of the document, in order, as the timeline compiler takes them. */
export function allPages(document: DoryDocument): PageRef[] {
  return document.pages.map((p, index) => ({ page: p, index, size: pageSize(document, p) }))
}

/** Three pages: one with a 1.5 s build-up and a loop-free emphasis, one with a push transition, one plain with a fade. */
export function deck(): DoryDocument {
  return doc(
    [
      page('a', { durationSec: 4, objects: [rect('a1', { enter: anim('fade', { durationMs: 1500 }) })] }),
      page('b', { durationSec: 3, transition: push, objects: [rect('b1')] }),
      page('c', { transition: { preset: 'fade', durationMs: 500, easing: 'linear' }, objects: [rect('c1', { enter: anim('fade', { durationMs: 500, delayMs: 200 }) })] }),
    ],
    200,
    100,
  )
}

/** The bytes of a Blob (jsdom's Blob has no `arrayBuffer`). */
export function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}
