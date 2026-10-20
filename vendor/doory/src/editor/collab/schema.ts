/**
 * The Y document of a design and its conversion to and from `DoryDocument`.
 *
 * Generic at property granularity: every property of the document, of a page and of an object is one entry of a
 * `Y.Map`, so properties added by later features need no change here. Reading shares references with the
 * previous document wherever the content is equal, which is what keeps the engine from rebuilding canvases.
 */
import * as Y from 'yjs'
import { type DocObject, type DocPage, type DoryDocument, SCHEMA_VERSION } from '@/types/document'
import { type Json, jsonEqual, toJson } from '../engine/json'
import { getPageSize } from '../engine/pageSizes'

export const ROOT_META = 'meta'
export const ROOT_PAGE_ORDER = 'pageOrder'
export const ROOT_PAGES = 'pages'
export const KEY_OBJECTS = 'objects'
export const KEY_OBJECT_ORDER = 'objectOrder'

export interface YRoots {
  meta: Y.Map<unknown>
  pageOrder: Y.Array<string>
  pages: Y.Map<Y.Map<unknown>>
}

export function rootsOf(doc: Y.Doc): YRoots {
  return { meta: doc.getMap(ROOT_META), pageOrder: doc.getArray<string>(ROOT_PAGE_ORDER), pages: doc.getMap<Y.Map<unknown>>(ROOT_PAGES) }
}

/** The value of an entry as plain JSON (a nested shared type, which a later feature may use, is converted). */
export function plain(value: unknown): unknown {
  return value instanceof Y.AbstractType ? (value as Y.AbstractType<unknown>).toJSON() : value
}

const DEFAULT_BACKGROUND = { type: 'solid', color: '#ffffff' } as const
const MAX_ID_LENGTH = 64

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH
}

/* ------------------------------------------------------------------------------------------------
 * Writing whole pages and objects (new ones, and test seeding)
 * ---------------------------------------------------------------------------------------------- */

function entriesOf(source: object, skip: ReadonlySet<string>): [string, Json][] {
  const out: [string, Json][] = []
  for (const [key, value] of Object.entries(source)) {
    if (skip.has(key)) continue
    const json = toJson(value)
    if (json !== undefined) out.push([key, json])
  }
  return out
}

const NO_KEYS: ReadonlySet<string> = new Set()
const PAGE_RESERVED: ReadonlySet<string> = new Set([KEY_OBJECTS, KEY_OBJECT_ORDER])

export function createObjectMap(object: DocObject): Y.Map<unknown> {
  return new Y.Map<unknown>(entriesOf(object, NO_KEYS))
}

export function createPageMap(page: DocPage, include: (object: DocObject) => boolean = () => true): Y.Map<unknown> {
  const objects = page.objects.filter((o) => isValidId(o.id) && include(o))
  const map = new Y.Map<unknown>(entriesOf(page, PAGE_RESERVED))
  map.set(KEY_OBJECTS, new Y.Map<Y.Map<unknown>>(objects.map((o): [string, Y.Map<unknown>] => [o.id, createObjectMap(o)])))
  map.set(KEY_OBJECT_ORDER, Y.Array.from(objects.map((o) => o.id)))
  return map
}

/** Id of the blank page that stands in when every page was removed at once (the server uses the same one). */
export const RESTORED_PAGE_ID = 'restored-page'

/**
 * True when the design has arrived (it has its schema and a size) but no page is left. Two people can each remove one of
 * two pages at the same moment; a design must keep one page, so somebody has to put a blank one back.
 */
export function hasNoPages(roots: YRoots): boolean {
  return roots.meta.get('schemaVersion') === SCHEMA_VERSION && validDimension(roots.meta.get('width')) && validDimension(roots.meta.get('height')) && orderedIds(roots.pageOrder, roots.pages).length === 0
}

/** True when the design has arrived (it has its schema) but its size is missing or not a number: nothing can be drawn or saved. */
export function hasBrokenSize(roots: YRoots): boolean {
  return roots.meta.get('schemaVersion') === SCHEMA_VERSION && !(validDimension(roots.meta.get('width')) && validDimension(roots.meta.get('height')))
}

/** Writes the size of `doc` over a broken one: the size of its first page (run inside a transaction). */
export function restoreSize(roots: YRoots, doc: DoryDocument): void {
  const size = getPageSize(doc, doc.pages[0]?.id ?? '')
  roots.meta.set('width', size.width)
  roots.meta.set('height', size.height)
}

/** Puts a blank page back (run inside a transaction). Every peer that does it writes the same page, so they merge into one. */
export function restoreBlankPage(roots: YRoots): void {
  roots.pages.set(RESTORED_PAGE_ID, createPageMap({ id: RESTORED_PAGE_ID, background: DEFAULT_BACKGROUND, objects: [] }))
  roots.pageOrder.push([RESTORED_PAGE_ID])
}

/** Writes `doc` into an empty Y document, the way the server seeds a room (tests and tools). */
export function writeDocument(ydoc: Y.Doc, doc: DoryDocument, origin?: unknown): void {
  ydoc.transact(() => {
    const roots = rootsOf(ydoc)
    for (const [key, value] of entriesOf(doc, new Set(['pages']))) roots.meta.set(key, value)
    for (const page of doc.pages) roots.pages.set(page.id, createPageMap(page))
    roots.pageOrder.insert(0, doc.pages.map((p) => p.id))
  }, origin)
}

/* ------------------------------------------------------------------------------------------------
 * Reading
 * ---------------------------------------------------------------------------------------------- */

/** Ids in display order: first occurrence of each, skipping ids without an entry. */
export function orderedIds(order: Y.Array<string>, entries: { has(key: string): boolean }): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of order.toArray()) {
    if (typeof id !== 'string' || seen.has(id) || !entries.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function pageParts(page: Y.Map<unknown>): { objects: Y.Map<unknown>; order: Y.Array<string> } | null {
  const objects = page.get(KEY_OBJECTS)
  const order = page.get(KEY_OBJECT_ORDER)
  return objects instanceof Y.Map && order instanceof Y.Array ? { objects, order: order as Y.Array<string> } : null
}

/**
 * Collects entries into an object whose key order follows `like` (so that a document compared as a string
 * with its predecessor stays equal when nothing changed), reusing `like`'s values where they are equal.
 */
function collect(map: Y.Map<unknown>, skip: ReadonlySet<string>, like: object | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const before = like as Record<string, unknown> | undefined
  const fresh = new Map<string, unknown>()
  map.forEach((value, key) => {
    if (!skip.has(key)) fresh.set(key, plain(value))
  })
  if (before) {
    for (const key of Object.keys(before)) {
      if (!fresh.has(key)) continue
      const value = fresh.get(key)
      out[key] = jsonEqual(before[key], value) ? before[key] : value
      fresh.delete(key)
    }
  }
  for (const [key, value] of fresh) out[key] = value
  return out
}

function readObject(id: string, map: Y.Map<unknown>, prev?: DocObject): DocObject {
  const next = collect(map, NO_KEYS, prev)
  next.id = id
  if (prev && jsonEqual(prev, next)) return prev
  return next as DocObject
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Same values by reference; a key whose value is `undefined` counts as absent. */
function sameProps(a: object, b: object): boolean {
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  let defined = 0
  for (const key of Object.keys(left)) {
    if (left[key] === undefined) continue
    defined += 1
    if (left[key] !== right[key]) return false
  }
  for (const key of Object.keys(right)) if (right[key] !== undefined) defined -= 1
  return defined === 0
}

/** What changed in the Y document since the last read; `all` forces a full read. */
export interface Dirty {
  all: boolean
  meta: boolean
  /** Page ids were added or removed, or the page order changed. */
  pages: boolean
  /** Pages whose own properties changed. */
  props: Set<string>
  /** Pages that must be read completely (their `objects` or `objectOrder` entry was replaced). */
  rebuild: Set<string>
  /** Pages whose object order or object set changed. */
  structure: Set<string>
  /** Objects whose properties changed, per page. */
  objects: Map<string, Set<string>>
}

export function emptyDirty(): Dirty {
  return { all: false, meta: false, pages: false, props: new Set(), rebuild: new Set(), structure: new Set(), objects: new Map() }
}

export function isClean(dirty: Dirty): boolean {
  return !dirty.all && !dirty.meta && !dirty.pages && dirty.props.size === 0 && dirty.rebuild.size === 0 && dirty.structure.size === 0 && dirty.objects.size === 0
}

function markObject(dirty: Dirty, pageId: string, objectId: string): void {
  let set = dirty.objects.get(pageId)
  if (!set) {
    set = new Set()
    dirty.objects.set(pageId, set)
  }
  set.add(objectId)
}

/** Records which parts of the document a batch of events on the `pages` root touched. */
export function collectPageEvents(dirty: Dirty, events: readonly Y.YEvent<Y.AbstractType<unknown>>[], pages: Y.Map<Y.Map<unknown>>): void {
  for (const event of events) {
    if (event.target === pages) {
      dirty.pages = true
      // A page that was replaced (deleted and restored by undo) is a new map: read it completely.
      for (const key of (event as Y.YMapEvent<unknown>).keysChanged ?? []) dirty.rebuild.add(key)
      continue
    }
    const path = event.path
    const pageId = path[0]
    if (typeof pageId !== 'string') {
      dirty.all = true
    } else if (path.length === 1) {
      const keys = (event as Y.YMapEvent<unknown>).keysChanged
      if (keys && (keys.has(KEY_OBJECTS) || keys.has(KEY_OBJECT_ORDER))) dirty.rebuild.add(pageId)
      dirty.props.add(pageId)
    } else if (path.length === 2 && (path[1] === KEY_OBJECT_ORDER || path[1] === KEY_OBJECTS)) {
      dirty.structure.add(pageId)
      // An entry that was replaced (an object deleted and restored by undo, or added by two people at once) is a new
      // map: what the editor holds for that id is out of date even though no property event names it.
      if (path[1] === KEY_OBJECTS) for (const key of (event as Y.YMapEvent<unknown>).keysChanged ?? []) markObject(dirty, pageId, key)
    } else if (path[1] === KEY_OBJECTS && typeof path[2] === 'string') {
      markObject(dirty, pageId, path[2])
    } else {
      dirty.all = true
    }
  }
}

function readPage(id: string, map: Y.Map<unknown>, prev: DocPage | undefined, dirty: Dirty | null): DocPage {
  /** The events to honour for this page, or null when it has to be read completely. */
  const part = prev && dirty && !dirty.all && !dirty.rebuild.has(id) ? dirty : null
  const rebuildProps = !part || part.props.has(id)
  const changedObjects = part?.objects.get(id)
  const rebuildObjects = !part || part.structure.has(id) || (changedObjects?.size ?? 0) > 0

  let objects: DocObject[]
  if (!rebuildObjects && prev) {
    objects = prev.objects
  } else {
    const parts = pageParts(map)
    const previous = new Map<string, DocObject>()
    if (prev) for (const o of prev.objects) previous.set(o.id, o)
    const ids = parts ? orderedIds(parts.order, parts.objects) : []
    objects = ids.map((objectId) => {
      const old = previous.get(objectId)
      if (old && part && !changedObjects?.has(objectId)) return old
      const source = parts?.objects.get(objectId)
      return source instanceof Y.Map ? readObject(objectId, source, old) : (old ?? { id: objectId, type: 'unknown' })
    })
    if (prev && sameList(objects, prev.objects)) objects = prev.objects
  }

  let props: Record<string, unknown>
  if (!rebuildProps && prev) {
    const { objects: _ignored, ...rest } = prev
    props = rest
  } else {
    props = collect(map, PAGE_RESERVED, prev ? { ...prev, objects: undefined } : undefined)
  }
  props.id = id
  const background = props.background
  if (typeof background !== 'object' || background === null || typeof (background as { type?: unknown }).type !== 'string') props.background = DEFAULT_BACKGROUND

  if (prev && objects === prev.objects) {
    const { objects: _prevObjects, ...prevProps } = prev
    if (sameProps(prevProps, props)) return prev
  }
  return { ...(props as unknown as Omit<DocPage, 'objects'>), objects }
}

function validDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
}

/**
 * Builds the document from the Y state. `prev` and `dirty` make it incremental: only the parts the events touched
 * are read again. Returns `null` when the state is not a usable design (nothing synced yet, or a foreign schema).
 */
export function readDocument(roots: YRoots, prev: DoryDocument | null, dirty: Dirty | null = null): DoryDocument | null {
  const incremental = !!prev && !!dirty && !dirty.all
  const pageIds = orderedIds(roots.pageOrder, roots.pages)
  if (pageIds.length === 0) return null

  let head: Record<string, unknown>
  if (incremental && !dirty.meta) {
    const { pages: _pages, ...rest } = prev
    head = rest
  } else {
    head = collect(roots.meta, new Set(['pages']), prev ? { ...prev, pages: undefined } : undefined)
  }
  if (head.schemaVersion !== SCHEMA_VERSION || !validDimension(head.width) || !validDimension(head.height)) return null

  const previousPages = new Map<string, DocPage>()
  if (prev) for (const p of prev.pages) previousPages.set(p.id, p)
  const pages = pageIds.map((id) => {
    const map = roots.pages.get(id)
    const old = previousPages.get(id)
    if (!(map instanceof Y.Map)) return old ?? { id, background: DEFAULT_BACKGROUND, objects: [] }
    if (incremental && old && !dirty.rebuild.has(id) && !dirty.props.has(id) && !dirty.structure.has(id) && !dirty.objects.has(id)) return old
    return readPage(id, map, old, incremental ? dirty : null)
  })

  if (prev && sameList(pages, prev.pages)) {
    const { pages: _prevPages, ...prevHead } = prev
    if (sameProps(prevHead, head)) return prev
  }
  return { ...(head as unknown as Omit<DoryDocument, 'pages'>), pages }
}
