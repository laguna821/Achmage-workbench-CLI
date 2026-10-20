/**
 * Pure operations on brand kits (the Brand sidebar): every function returns a new kit and never mutates its
 * input. Limits mirror what the sidebar can show, not what the server stores.
 */
import { newId } from '@/lib/document'
import type { AssetRef } from '@/types/adapter'
import type { Asset, BrandFont, BrandKit } from '@/types/api'
import { normalizeColor } from '../engine/colors'

export const MAX_BRAND_COLORS = 24
export const MAX_BRAND_LOGOS = 12
export const BRAND_ROLES: readonly BrandFont['role'][] = ['heading', 'subheading', 'body']

/** A kit that has not been saved yet (empty id: the adapter creates it). */
export function emptyKit(name: string, isDefault: boolean): BrandKit {
  return { id: '', name: name.trim(), is_default: isDefault, colors: [], fonts: [], logos: [], created_at: '', updated_at: '' }
}

/** The kit the sidebar opens with: the default one, otherwise the first. */
export function pickKit(kits: readonly BrandKit[]): BrandKit | null {
  return kits.find((k) => k.is_default) ?? kits[0] ?? null
}

/** Adds a colour (normalised to `#rrggbb`); a colour the kit already has is not added twice. */
export function withColor(kit: BrandKit, color: string): BrandKit {
  const hex = normalizeColor(color)
  if (kit.colors.length >= MAX_BRAND_COLORS || kit.colors.some((c) => c.hex.toLowerCase() === hex.toLowerCase())) return kit
  return { ...kit, colors: [...kit.colors, { id: newId(), name: hex.toUpperCase(), hex }] }
}

export function withoutColor(kit: BrandKit, id: string): BrandKit {
  return { ...kit, colors: kit.colors.filter((c) => c.id !== id) }
}

export function fontOf(kit: BrandKit, role: BrandFont['role']): string | null {
  return kit.fonts.find((f) => f.role === role)?.family ?? null
}

/** Sets the family of one role, keeping the others. */
export function withFont(kit: BrandKit, role: BrandFont['role'], family: string): BrandKit {
  return { ...kit, fonts: [...kit.fonts.filter((f) => f.role !== role), { role, family }] }
}

/** The editor-side shape of a stored asset. */
export function assetToRef(a: Asset): AssetRef {
  return { id: a.id, url: a.url, thumbUrl: a.thumb_url, width: a.width, height: a.height, name: a.name, kind: a.kind }
}

/** An asset the server has not described yet; only its id is sent when the kit is saved. */
export function refToAsset(ref: AssetRef): Asset {
  return { id: ref.id, kind: ref.kind, name: ref.name, url: ref.url, thumb_url: ref.thumbUrl, width: ref.width, height: ref.height, size: 0, mime: '', tags: [], attribution: null, created_at: '' }
}

export function withLogo(kit: BrandKit, logo: Asset): BrandKit {
  if (kit.logos.length >= MAX_BRAND_LOGOS || kit.logos.some((l) => l.id === logo.id)) return kit
  return { ...kit, logos: [...kit.logos, logo] }
}

export function withoutLogo(kit: BrandKit, id: string): BrandKit {
  return { ...kit, logos: kit.logos.filter((l) => l.id !== id) }
}

/** Replaces the kit with the same id (or appends a new one); a default kit makes the others non-default. */
export function upsertKit(kits: readonly BrandKit[], kit: BrandKit): BrandKit[] {
  const next = kits.some((k) => k.id === kit.id) ? kits.map((k) => (k.id === kit.id ? kit : k)) : [...kits, kit]
  return kit.is_default ? next.map((k) => (k.id === kit.id ? k : { ...k, is_default: false })) : next
}
