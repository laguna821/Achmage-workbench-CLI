/**
 * Template field tags (`field` on an object, see types/document.ts). The rules match the server's
 * (backend/apps/designs/doc/fields.py): a key is `[a-z][a-z0-9_]{0,39}` and names one value. It is used at most once
 * per page; the same key on several pages is the same value there, so it must have the same type everywhere.
 */
import type { DocField, DocObject, DoryDocument, FieldType } from '@/types/document'

export const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/
export const FIELD_LABEL_MAX = 80

/** The field type an object of `kind` can hold (null: it can't be a field). */
export function fieldTypeFor(kind: string | undefined): FieldType | null {
  if (kind === 'text') return 'text'
  if (kind === 'image' || kind === 'placeholder') return 'image'
  if (kind === 'shape') return 'color'
  return null
}

export function readField(value: unknown): DocField | null {
  if (!value || typeof value !== 'object') return null
  const f = value as Record<string, unknown>
  if (typeof f.key !== 'string' || !FIELD_KEY.test(f.key)) return null
  if (f.type !== 'text' && f.type !== 'image' && f.type !== 'color') return null
  return typeof f.label === 'string' && f.label ? { key: f.key, type: f.type, label: f.label } : { key: f.key, type: f.type }
}

function walk(objects: readonly DocObject[], visit: (o: DocObject) => void): void {
  for (const o of objects) {
    visit(o)
    if (Array.isArray(o.objects)) walk(o.objects as DocObject[], visit)
  }
}

export interface FieldUse {
  field: DocField
  objectId: string
  page: number
}

/** Every tagged object of the document, in page and stack order. */
export function collectFields(doc: Pick<DoryDocument, 'pages'>): FieldUse[] {
  const out: FieldUse[] = []
  doc.pages.forEach((page, i) =>
    walk(page.objects, (o) => {
      const field = readField(o.field)
      if (field) out.push({ field, objectId: o.id, page: i + 1 })
    }),
  )
  return out
}

/** Keys used twice on one page or with different types, sorted. */
export function duplicateKeys(doc: Pick<DoryDocument, 'pages'>): string[] {
  const types = new Map<string, FieldType>()
  const seen = new Set<string>()
  const bad = new Set<string>()
  for (const { field, page } of collectFields(doc)) {
    const at = `${page}:${field.key}`
    const type = types.get(field.key)
    if (seen.has(at) || (type && type !== field.type)) bad.add(field.key)
    seen.add(at)
    types.set(field.key, type ?? field.type)
  }
  return [...bad].sort()
}

/** Would tagging object `objectId` on page `page` (1-based) with `key`/`type` clash with another object? */
export function keyClashes(doc: Pick<DoryDocument, 'pages'>, key: string, type: FieldType, objectId: string, page: number): boolean {
  return collectFields(doc).some((u) => u.objectId !== objectId && u.field.key === key && (u.page === page || u.field.type !== type))
}
