/**
 * Document upgrade and normalisation. A loaded document is always passed through `migrateDocument`
 * before use: it is validated, brought to the current `schemaVersion` by chained pure migrations
 * (`vN → vN+1`), and defaulted so the rest of the editor can rely on ids, backgrounds and arrays.
 * The server never rewrites documents; saving writes the upgraded form back.
 */
import { clampDimension, createBlankPage, newId } from '@/lib/document'
import { readTracks } from '../audio/model'
import { normalizeSizes } from './pageSizes'
import { type DocObject, type DocPage, type DoryDocument, MAX_PAGES, type PageBackground, SCHEMA_VERSION } from '@/types/document'

export class DocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentError'
  }
}

/** A migration receives a document at version N and returns it at version N + 1. */
export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>

/** Registered migrations keyed by the version they upgrade *from*. Version 1 is current: none yet. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function normalizeBackground(bg: unknown): PageBackground {
  if (isRecord(bg)) {
    if (bg.type === 'solid' && typeof bg.color === 'string') return bg as PageBackground
    if (bg.type === 'gradient' && Array.isArray(bg.stops) && bg.stops.length >= 2) return bg as PageBackground
    if (bg.type === 'image' && typeof bg.src === 'string') return bg as PageBackground
  }
  return { type: 'solid', color: '#ffffff' }
}

function normalizeObject(raw: unknown, depth: number, seen: Set<string>): DocObject | null {
  if (!isRecord(raw) || typeof raw.type !== 'string' || depth > 32) return null
  const o: DocObject = { ...raw, id: typeof raw.id === 'string' && raw.id && !seen.has(raw.id) ? raw.id : newId(), type: raw.type.toLowerCase() }
  seen.add(o.id)
  if (Array.isArray(raw.objects)) {
    o.objects = raw.objects.map((c) => normalizeObject(c, depth + 1, seen)).filter((c): c is DocObject => c !== null)
  }
  return o
}

function normalizePage(raw: unknown): DocPage {
  if (!isRecord(raw)) return createBlankPage()
  const seen = new Set<string>()
  const objects = Array.isArray(raw.objects)
    ? raw.objects.map((o) => normalizeObject(o, 0, seen)).filter((o): o is DocObject => o !== null)
    : []
  const page: DocPage = {
    ...(raw as Partial<DocPage>),
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    background: normalizeBackground(raw.background),
    objects,
  }
  // A page's own size is two whole numbers of 1..20000 px; anything else means "the design's size".
  for (const side of ['width', 'height'] as const) {
    const value: unknown = page[side]
    if (typeof value === 'number' && Number.isFinite(value)) page[side] = clampDimension(value)
    else delete page[side]
  }
  return page
}

/** Applies `migrations[from]`, `migrations[from+1]`, … until `to` is reached. */
export function runMigrations(
  doc: Record<string, unknown>,
  from: number,
  to: number,
  migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
): Record<string, unknown> {
  let current = doc
  for (let version = from; version < to; version++) {
    const step = migrations[version]
    if (!step) throw new DocumentError(`No migration from version ${version}.`)
    current = step(current)
  }
  return current
}

export function migrateDocument(raw: unknown): DoryDocument {
  if (!isRecord(raw)) throw new DocumentError('The design file is not valid.')
  const version = typeof raw.schemaVersion === 'number' && Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 1
  if (version < 1) throw new DocumentError('The design file has an invalid version.')
  if (version > SCHEMA_VERSION) throw new DocumentError('This design was created with a newer version of Doory. Please update.')
  const doc = runMigrations(raw, version, SCHEMA_VERSION)
  const pagesRaw = Array.isArray(doc.pages) ? doc.pages.slice(0, MAX_PAGES) : []
  const pages = pagesRaw.length > 0 ? pagesRaw.map(normalizePage) : [createBlankPage()]
  const seenPages = new Set<string>()
  for (const p of pages) {
    if (seenPages.has(p.id)) p.id = newId()
    seenPages.add(p.id)
  }
  const unit = doc.unit === 'mm' || doc.unit === 'in' ? doc.unit : 'px'
  const out: DoryDocument = {
    schemaVersion: SCHEMA_VERSION,
    width: clampDimension(typeof doc.width === 'number' ? doc.width : 1080),
    height: clampDimension(typeof doc.height === 'number' ? doc.height : 1080),
    unit,
    pages,
  }
  if (isRecord(doc.meta)) out.meta = doc.meta as DoryDocument['meta']
  // The usable audio tracks; an empty list is not written.
  const tracks = readTracks({ audioTracks: doc.audioTracks as DoryDocument['audioTracks'] })
  if (tracks.length > 0) out.audioTracks = [...tracks]
  return normalizeSizes(out)
}
