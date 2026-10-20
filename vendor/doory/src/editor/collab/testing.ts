/**
 * Helpers shared by the collab tests: a seeded random generator, a way to build documents with arbitrary
 * properties and a tiny two-way update relay between Y documents.
 */
import * as Y from 'yjs'
import { createBlankDocument } from '@/lib/document'
import type { DocObject, DocPage, DoryDocument } from '@/types/document'
import { type Json } from '../engine/json'

export class Random {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0 || 1
  }

  next(): number {
    let x = this.state
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    this.state = x
    return x / 0x1_0000_0000
  }

  int(max: number): number {
    return Math.floor(this.next() * max)
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]
  }

  bool(): boolean {
    return this.next() < 0.5
  }

  /** A random JSON value, nested up to `depth` levels. */
  json(depth = 2): Json {
    const kind = this.int(depth > 0 ? 8 : 5)
    switch (kind) {
      case 0:
        return null
      case 1:
        return this.bool()
      case 2:
        return this.int(2000) - 1000
      case 3:
        return Math.round(this.next() * 1e6) / 1e3
      case 4:
        return this.pick(['', 'a', 'Grüße — 你好 🎨', 'x'.repeat(40), '#e11d48', 'Inter, sans-serif'])
      case 5:
        return Array.from({ length: this.int(4) }, () => this.json(depth - 1))
      default: {
        const out: Record<string, Json> = {}
        for (let i = this.int(4); i > 0; i--) out[this.pick(['a', 'b', 'color', 'blur', 'offset', 'x', 'y'])] = this.json(depth - 1)
        return out
      }
    }
  }
}

let counter = 0
export function uid(prefix = 'o'): string {
  counter += 1
  return `${prefix}${counter}`
}

export function shape(extra: Record<string, unknown> = {}): DocObject {
  return { id: uid(), type: 'rect', left: 100, top: 100, width: 80, height: 60, fill: '#e11d48', ...extra }
}

export function page(objects: DocObject[] = [], extra: Record<string, unknown> = {}): DocPage {
  return { id: uid('p'), background: { type: 'solid', color: '#ffffff' }, objects, ...extra }
}

export function docOf(pages: DocPage[], extra: Record<string, unknown> = {}): DoryDocument {
  return { ...createBlankDocument(800, 600), pages, ...extra }
}

/** Sends every update of `from` to `to` (and back when `both`) until `detach()` is called. */
export function relay(a: Y.Doc, b: Y.Doc): () => void {
  const toB = (update: Uint8Array, origin: unknown): void => {
    if (origin !== relay) Y.applyUpdate(b, update, relay)
  }
  const toA = (update: Uint8Array, origin: unknown): void => {
    if (origin !== relay) Y.applyUpdate(a, update, relay)
  }
  a.on('update', toB)
  b.on('update', toA)
  return () => {
    a.off('update', toB)
    b.off('update', toA)
  }
}

/** Brings two documents to the same state in one exchange. */
export function exchange(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), relay)
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), relay)
}
