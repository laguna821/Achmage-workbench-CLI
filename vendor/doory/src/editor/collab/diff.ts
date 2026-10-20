/**
 * Local edit → Y operations. `writeChanges` compares the document the editor had (`prev`) with the one it has
 * now (`next`) and writes only what the user changed: a property is written when it differs between the two
 * *and* from what the shared state holds, so a remote change that has not reached the editor yet is never
 * reverted by an unrelated local edit. Call it inside one `Y.Doc.transact`.
 */
import * as Y from 'yjs'
import { newId } from '@/lib/document'
import type { DocObject, DocPage, DoryDocument } from '@/types/document'
import { jsonEqual, toJson } from '../engine/json'
import { KEY_OBJECT_ORDER, KEY_OBJECTS, type YRoots, createObjectMap, createPageMap, isValidId, plain } from './schema'

const MAX_INLINE_DATA = 64 * 1024

/**
 * True when the value carries something the server refuses to store (`blob:` strings anywhere, `data:` strings
 * above 64 KB). Such an object stays local until its images are uploaded (see `CollabBinding`).
 */
export function hasUnshareableSource(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.startsWith('blob:') || (value.startsWith('data:') && value.length > MAX_INLINE_DATA)
  if (depth >= 32 || typeof value !== 'object' || value === null) return false
  if (Array.isArray(value)) return value.some((item) => hasUnshareableSource(item, depth + 1))
  for (const item of Object.values(value)) if (hasUnshareableSource(item, depth + 1)) return true
  return false
}

/** Positions of a longest increasing subsequence of `values` (indices into `values`). */
export function longestIncreasing(values: readonly number[]): number[] {
  const tails: number[] = []
  const previous = new Array<number>(values.length).fill(-1)
  for (let i = 0; i < values.length; i++) {
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (values[tails[mid]] < values[i]) low = mid + 1
      else high = mid
    }
    if (low > 0) previous[i] = tails[low - 1]
    tails[low] = i
  }
  const out: number[] = []
  let at = tails.length > 0 ? tails[tails.length - 1] : -1
  while (at >= 0) {
    out.push(at)
    at = previous[at]
  }
  return out.reverse()
}

/**
 * Makes `array` list `target` in order with the fewest operations: entries already in the right relative order
 * stay, duplicates and moved entries are deleted and re-inserted, new ids are inserted. Ids the editor does not
 * know (`known` lacks them and `target` lacks them) are somebody else's additions and are left alone.
 */
export function syncOrder(array: Y.Array<string>, target: readonly string[], known: ReadonlySet<string>): void {
  const current = array.toArray()
  const wanted = new Map<string, number>()
  target.forEach((id, index) => wanted.set(id, index))

  const first: number[] = []
  const seen = new Set<string>()
  current.forEach((id, position) => {
    if (wanted.has(id) && !seen.has(id)) {
      seen.add(id)
      first.push(position)
    }
  })
  const kept = new Set(longestIncreasing(first.map((position) => wanted.get(current[position]) as number)).map((i) => first[i]))

  const doomed: number[] = []
  current.forEach((id, position) => {
    if (kept.has(position)) return
    if (wanted.has(id) || known.has(id)) doomed.push(position)
  })
  for (let i = doomed.length - 1; i >= 0; ) {
    let start = i
    while (start > 0 && doomed[start - 1] === doomed[start] - 1) start -= 1
    array.delete(doomed[start], i - start + 1)
    i = start - 1
  }

  const removed = new Set(doomed)
  const after = current.filter((_, position) => !removed.has(position))
  const present = new Set(after)
  let cursor = 0
  for (const id of target) {
    if (present.has(id)) {
      cursor = after.indexOf(id, cursor) + 1
    } else {
      array.insert(cursor, [id])
      after.splice(cursor, 0, id)
      present.add(id)
      cursor += 1
    }
  }
}

function writeProps(map: Y.Map<unknown>, prev: object | undefined, next: object, skip: ReadonlySet<string>): void {
  const before = (prev ?? {}) as Record<string, unknown>
  const after = next as Record<string, unknown>
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    if (skip.has(key)) continue
    const was = before[key]
    const now = after[key]
    if (was === now || (prev && jsonEqual(was, now))) continue
    const json = key in after ? toJson(now) : undefined
    if (json === undefined) {
      if (map.has(key)) map.delete(key)
    } else if (!jsonEqual(plain(map.get(key)), json)) {
      map.set(key, json)
    }
  }
}

const SKIP_ID: ReadonlySet<string> = new Set(['id'])
const SKIP_PAGE: ReadonlySet<string> = new Set(['id', KEY_OBJECTS, KEY_OBJECT_ORDER])
const SKIP_DOC: ReadonlySet<string> = new Set(['pages'])

/**
 * An object the editor knew (`prev`) but the shared state no longer has was deleted by somebody else: the edit
 * disappears with it instead of bringing the object back.
 */
function writeObject(objects: Y.Map<unknown>, object: DocObject, prev: DocObject | undefined, isNew: boolean): void {
  const current = objects.get(object.id)
  if (current instanceof Y.Map) writeProps(current, prev, object, SKIP_ID)
  else if (isNew) objects.set(object.id, createObjectMap(object))
}

function ensureParts(map: Y.Map<unknown>): { objects: Y.Map<unknown>; order: Y.Array<string> } {
  let objects = map.get(KEY_OBJECTS)
  if (!(objects instanceof Y.Map)) {
    objects = new Y.Map<unknown>()
    map.set(KEY_OBJECTS, objects)
  }
  let order = map.get(KEY_OBJECT_ORDER)
  if (!(order instanceof Y.Array)) {
    order = new Y.Array<string>()
    map.set(KEY_OBJECT_ORDER, order)
  }
  return { objects: objects as Y.Map<unknown>, order: order as Y.Array<string> }
}

function writePage(roots: YRoots, page: DocPage, prev: DocPage | undefined, held: Set<string>): void {
  const shareable = (o: DocObject): boolean => {
    if (!isValidId(o.id)) return false
    if (!hasUnshareableSource(o)) return true
    held.add(o.id)
    return false
  }
  const existing = roots.pages.get(page.id)
  if (!(existing instanceof Y.Map)) {
    if (!prev) roots.pages.set(page.id, createPageMap(page, shareable))
    return
  }
  writeProps(existing, prev, page, SKIP_PAGE)
  const { objects, order } = ensureParts(existing)
  const before = new Map<string, DocObject>()
  if (prev) for (const o of prev.objects) before.set(o.id, o)
  const ids: string[] = []
  for (const object of page.objects) {
    const old = before.get(object.id)
    if (old !== object && shareable(object)) {
      writeObject(objects, object, old, !old || held.has(object.id))
      held.delete(object.id)
    }
    if (objects.has(object.id)) ids.push(object.id)
  }
  const wanted = new Set(page.objects.map((o) => o.id))
  for (const id of before.keys()) {
    if (wanted.has(id)) continue
    held.delete(id)
    if (objects.has(id)) objects.delete(id)
  }
  syncOrder(order, ids, new Set(before.keys()))
}

/**
 * `next` with no two objects of one page sharing an id; `next` itself when there are none. The shared state holds one object per
 * id, so a page that has two is not something it can hold. It happens when somebody ungroups a group whose object is also on the
 * page (a delete that somebody undid while somebody else grouped the object): the later of the two gets an id of its own, so
 * that everybody has both objects.
 */
export function withUniqueObjectIds(prev: DoryDocument, next: DoryDocument): DoryDocument {
  let pages: DocPage[] | null = null
  next.pages.forEach((page, index) => {
    if (prev.pages.some((p) => p.id === page.id && p.objects === page.objects)) return
    const seen = new Set<string>()
    let objects: DocObject[] | null = null
    page.objects.forEach((object, at) => {
      if (!seen.has(object.id)) {
        seen.add(object.id)
        return
      }
      let id = newId()
      while (seen.has(id)) id = newId()
      seen.add(id)
      objects ??= page.objects.slice()
      objects[at] = { ...object, id }
    })
    if (!objects) return
    pages ??= next.pages.slice()
    pages[index] = { ...page, objects }
  })
  return pages ? { ...next, pages } : next
}

/**
 * Writes the difference between two editor documents into the Y document. `held` is the set of object ids the editor
 * has but has not shared yet because they reference local-only images; it is updated in place.
 */
export function writeChanges(roots: YRoots, prev: DoryDocument, next: DoryDocument, held: Set<string> = new Set()): void {
  writeProps(roots.meta, prev, next, SKIP_DOC)
  const before = new Map<string, DocPage>()
  for (const page of prev.pages) before.set(page.id, page)
  const ids = next.pages.map((p) => p.id)
  const after = new Set(ids)
  for (const id of before.keys()) if (!after.has(id) && roots.pages.has(id)) roots.pages.delete(id)
  for (const page of next.pages) {
    const old = before.get(page.id)
    if (old !== page) writePage(roots, page, old, held)
  }
  syncOrder(roots.pageOrder, ids, new Set(before.keys()))
}
