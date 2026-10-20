import {
  type DocPage,
  type DoryDocument,
  MAX_DIMENSION_PX,
  type PageBackground,
  SCHEMA_VERSION,
  type DocUnit,
} from '@/types/document'
import { uuid } from './uuid'

export function newId(): string {
  return uuid()
}

export function clampDimension(px: number): number {
  return Math.min(MAX_DIMENSION_PX, Math.max(1, Math.round(px)))
}

export function createBlankPage(background: PageBackground = { type: 'solid', color: '#ffffff' }): DocPage {
  return { id: newId(), background, objects: [] }
}

export function createBlankDocument(
  width: number,
  height: number,
  opts: { unit?: DocUnit; presetId?: string } = {},
): DoryDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    width: clampDimension(width),
    height: clampDimension(height),
    unit: opts.unit ?? 'px',
    pages: [createBlankPage()],
    meta: opts.presetId ? { presetId: opts.presetId } : undefined,
  }
}

const LOCAL_SRC = /^idb:\/\/([0-9a-f-]{36})$/i

/** Every `idb://<uuid>` file reference in the document (page backgrounds, nested objects and audio tracks). */
export function collectLocalAssetIds(doc: DoryDocument): string[] {
  const found = new Set<string>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' && (key === 'src' || key === 'url')) {
        const m = LOCAL_SRC.exec(v)
        if (m) found.add(m[1].toLowerCase())
      } else visit(v, depth + 1)
    }
  }
  visit(doc.pages, 0)
  visit(doc.audioTracks, 0)
  return [...found]
}

/** Returns a deep copy with every `idb://<id>` src replaced via `map` (id → durable URL). */
export function rewriteLocalAssetSrcs(doc: DoryDocument, map: ReadonlyMap<string, { url: string; assetId?: string }>): DoryDocument {
  const rewrite = (value: unknown, depth: number): unknown => {
    if (depth > 64 || value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((item) => rewrite(item, depth + 1))
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(src)) {
      if (typeof v === 'string' && (key === 'src' || key === 'url')) {
        const m = LOCAL_SRC.exec(v)
        const hit = m ? map.get(m[1].toLowerCase()) : undefined
        out[key] = hit ? hit.url : v
        if (hit?.assetId && key === 'src' && ('type' in src || 'kind' in src)) out.assetId = hit.assetId
      } else out[key] = rewrite(v, depth + 1)
    }
    return out
  }
  return { ...doc, pages: rewrite(doc.pages, 0) as DocPage[], ...(doc.audioTracks ? { audioTracks: rewrite(doc.audioTracks, 0) as NonNullable<DoryDocument['audioTracks']> } : {}) }
}
