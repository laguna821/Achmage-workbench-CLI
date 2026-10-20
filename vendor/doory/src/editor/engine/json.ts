/**
 * JSON helpers for the Y binding. A document travels through Yjs as plain JSON, so everything that goes into
 * the shared state is first reduced to what `JSON.stringify` would keep, and values are compared structurally
 * so an unchanged value never produces a Yjs operation.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const MAX_DEPTH = 64

/**
 * A deep copy of `value` limited to JSON: `undefined`, functions and symbols vanish from objects and become
 * `null` in arrays, non-finite numbers become `null` when nested. At the top level, a value with no JSON form
 * (including `NaN` and `Infinity`) gives `undefined`, which the caller treats as "property not set".
 */
export function toJson(value: unknown): Json | undefined {
  return convert(value, 0, true)
}

function convert(value: unknown, depth: number, top: boolean): Json | undefined {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value + 0 : top ? undefined : null
    case 'object': {
      if (value === null) return null
      if (depth >= MAX_DEPTH) return top ? undefined : null
      if (Array.isArray(value)) {
        const out: Json[] = new Array<Json>(value.length)
        for (let i = 0; i < value.length; i++) out[i] = convert(value[i], depth + 1, false) ?? null
        return out
      }
      const source = value as { toJSON?: unknown }
      if (typeof source.toJSON === 'function') return convert((source.toJSON as () => unknown)(), depth + 1, top)
      const out: { [key: string]: Json } = {}
      for (const key of Object.keys(value)) {
        const item = convert((value as Record<string, unknown>)[key], depth + 1, false)
        if (item !== undefined) out[key] = item
      }
      return out
    }
    default:
      return undefined
  }
}

/** Structural equality of two JSON values (`-0` equals `0`, key order does not matter). */
export function jsonEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || depth >= MAX_DEPTH) return false
  const arrayA = Array.isArray(a)
  if (arrayA !== Array.isArray(b)) return false
  if (arrayA) {
    const listA = a as unknown[]
    const listB = b as unknown[]
    if (listA.length !== listB.length) return false
    for (let i = 0; i < listA.length; i++) if (!jsonEqual(listA[i], listB[i], depth + 1)) return false
    return true
  }
  const objA = a as Record<string, unknown>
  const objB = b as Record<string, unknown>
  let defined = 0
  for (const key of Object.keys(objA)) {
    const item = objA[key]
    if (item === undefined) continue
    defined += 1
    if (!jsonEqual(item, objB[key], depth + 1)) return false
  }
  for (const key of Object.keys(objB)) if (objB[key] !== undefined) defined -= 1
  return defined === 0
}
