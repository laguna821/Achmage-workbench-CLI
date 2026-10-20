/**
 * Object kind registry — the extension point for new object types (QR code, chart, table, …).
 *
 * A kind classifies serialised/live objects (`matches`), declares the extra props it needs persisted
 * and may hook the (de)serialisation pipeline:
 *
 *   JSON ──prepare──▶ Fabric enliven ──hydrate──▶ live object ──dehydrate──▶ JSON
 *
 * Built-ins are registered through this same API (see `builtinKinds.ts`).
 */
import type { FabricObject } from 'fabric'
import type { DocObject } from '@/types/document'
import { Registry } from '../registry'

export interface KindLoadContext {
  /** Turns a stored `src` (`idb://…`, `/media/…`) into a URL Fabric can load. */
  resolveSrc(src: string): Promise<string>
}

/** Anything with a `type` plus arbitrary props: a serialised object or a live Fabric object. */
export type Describable = { type?: unknown } & Record<string, unknown>

export interface ObjectKind {
  id: string
  label: string
  /** Higher priority kinds are tested first. Default 0. */
  priority?: number
  matches(o: Describable): boolean
  /** Own props that must survive serialisation (added to Fabric's `toObject(propertiesToInclude)`). */
  extraProps?: readonly string[]
  /** Runs on the JSON (a private copy) before Fabric rebuilds the object. */
  prepare?(json: DocObject, ctx: KindLoadContext): Promise<void> | void
  /** Runs on the rebuilt live object (derive clip paths, filters, curves, effects…). */
  hydrate?(obj: FabricObject, json: DocObject, ctx: KindLoadContext): Promise<void> | void
  /** Runs on the freshly serialised JSON (strip derived data, swap `src` back…). */
  dehydrate?(out: DocObject, obj: FabricObject): void
}

export const objectKinds = new Registry<ObjectKind>((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

export function registerObjectKind(kind: ObjectKind): () => void {
  return objectKinds.register(kind)
}

/** Lower-case class name without hyphens (`IText` → `itext`, Fabric's live `type` getter says `i-text`). */
export function typeName(o: Describable): string {
  return typeof o.type === 'string' ? o.type.toLowerCase().replace(/-/g, '') : ''
}

export const FALLBACK_KIND = 'object'

export function kindOf(o: Describable): string {
  for (const kind of objectKinds.list()) if (kind.matches(o)) return kind.id
  return FALLBACK_KIND
}

export function kindOfLive(o: FabricObject): string {
  return kindOf(o as unknown as Describable)
}

export function kindOfDoc(o: DocObject): string {
  return kindOf(o)
}

