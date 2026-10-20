import type { DocUnit } from '@/types/document'

/** The unit a preset is defined in. Documents only know px, mm and in: centimetres show as millimetres. */
export type PresetUnit = 'px' | 'mm' | 'cm' | 'in'

/** Fractions of the page kept clear of a platform's own overlays (captions, buttons…), per side. */
export interface SafeZone {
  top?: number
  bottom?: number
  left?: number
  right?: number
}

/** A preset as `/size-presets/` (and `backend/data/size_presets.json`) write it. */
export interface PresetTreePreset {
  slug: string
  label: string
  width: number
  height: number
  unit?: PresetUnit
  width_px?: number
  height_px?: number
  icon?: string
  tags?: string[]
  is_quick?: boolean
  aliases?: string[]
  meta?: { safe_zone?: SafeZone; platforms?: string[] } & Record<string, unknown>
}

export interface PresetTreeGroup {
  slug: string
  label: string
  icon?: string
  children?: PresetTreeGroup[]
  presets?: PresetTreePreset[]
}

export interface PresetTree {
  version: number
  groups: PresetTreeGroup[]
}

export interface PresetGroupRef {
  slug: string
  label: string
  icon: string
}

export interface SizePreset {
  id: string
  label: string
  /** Pixel size at 96 dpi (what the document stores). */
  width: number
  height: number
  /** Display unit for rulers and the size dialog. */
  unit: DocUnit
  /** The size as the catalogue defines it, in `sourceUnit` (210 × 297 mm). */
  sourceWidth: number
  sourceHeight: number
  sourceUnit: PresetUnit
  /** A Lucide icon name; empty for none. */
  icon: string
  tags: string[]
  quick: boolean
  aliases: string[]
  safeZone: SafeZone | null
  /** `meta.platforms[0]`: the platform export file names use instead of the group's slug. */
  platform?: string
  /** The groups the preset sits in, outermost first (Social media → Instagram). */
  path: PresetGroupRef[]
}

export interface PresetGroup extends PresetGroupRef {
  children: PresetGroup[]
  presets: SizePreset[]
}

export interface SizePresetCatalogue {
  groups: PresetGroup[]
  /** Every preset, in catalogue order. */
  presets: SizePreset[]
  /** Slugs and aliases to presets. */
  byId: ReadonlyMap<string, SizePreset>
}

const PX_PER_UNIT: Record<PresetUnit, number> = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }
const UNITS = Object.keys(PX_PER_UNIT) as PresetUnit[]
const MAX_SIDE_PX = 20000
const MAX_DEPTH = 8

/** Whole pixels at 96 dpi, rounded half away from zero like the server. */
export function presetPx(value: number, unit: PresetUnit): number {
  return Math.round(value * PX_PER_UNIT[unit])
}

const isText = (value: unknown): value is string => typeof value === 'string'
const textList = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isText) : [])
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

function safeZone(meta: unknown): SafeZone | null {
  if (typeof meta !== 'object' || meta === null) return null
  const zone = (meta as { safe_zone?: unknown }).safe_zone
  if (typeof zone !== 'object' || zone === null) return null
  const out: SafeZone = {}
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const value = (zone as Record<string, unknown>)[side]
    if (typeof value === 'number' && value >= 0 && value < 0.5) out[side] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

function platformOf(meta: unknown): string {
  const platforms = typeof meta === 'object' && meta !== null ? (meta as { platforms?: unknown }).platforms : undefined
  return Array.isArray(platforms) && isText(platforms[0]) ? platforms[0] : ''
}

function toPreset(raw: PresetTreePreset, path: PresetGroupRef[]): SizePreset | null {
  if (typeof raw !== 'object' || raw === null || !isText(raw.slug) || !raw.slug || !isText(raw.label)) return null
  const sourceUnit: PresetUnit = UNITS.includes(raw.unit as PresetUnit) ? (raw.unit as PresetUnit) : 'px'
  if (!positive(raw.width) || !positive(raw.height)) return null
  const width = positive(raw.width_px) ? Math.round(raw.width_px) : presetPx(raw.width, sourceUnit)
  const height = positive(raw.height_px) ? Math.round(raw.height_px) : presetPx(raw.height, sourceUnit)
  if (width < 1 || height < 1 || width > MAX_SIDE_PX || height > MAX_SIDE_PX) return null
  const platform = platformOf(raw.meta)
  return {
    id: raw.slug,
    label: raw.label,
    width,
    height,
    unit: sourceUnit === 'cm' ? 'mm' : sourceUnit,
    sourceWidth: raw.width,
    sourceHeight: raw.height,
    sourceUnit,
    icon: isText(raw.icon) ? raw.icon : '',
    tags: textList(raw.tags),
    quick: raw.is_quick === true,
    aliases: textList(raw.aliases),
    safeZone: safeZone(raw.meta),
    ...(platform ? { platform } : {}),
    path,
  }
}

/**
 * The catalogue a tree describes; anything malformed in it is skipped, a slug or alias already taken keeps its first
 * preset. `null` when nothing usable is left, so the caller keeps what it had.
 */
export function buildCatalogue(tree: unknown): SizePresetCatalogue | null {
  if (typeof tree !== 'object' || tree === null || !Array.isArray((tree as PresetTree).groups)) return null
  const presets: SizePreset[] = []
  const byId = new Map<string, SizePreset>()

  const walk = (items: unknown, path: PresetGroupRef[]): PresetGroup[] => {
    if (!Array.isArray(items) || path.length >= MAX_DEPTH) return []
    const groups: PresetGroup[] = []
    for (const item of items as PresetTreeGroup[]) {
      if (typeof item !== 'object' || item === null || !isText(item.slug) || !isText(item.label)) continue
      const ref: PresetGroupRef = { slug: item.slug, label: item.label, icon: isText(item.icon) ? item.icon : '' }
      const here = [...path, ref]
      const own: SizePreset[] = []
      for (const raw of Array.isArray(item.presets) ? item.presets : []) {
        const preset = toPreset(raw, here)
        if (!preset || byId.has(preset.id)) continue
        own.push(preset)
        presets.push(preset)
        byId.set(preset.id, preset)
      }
      const children = walk(item.children, here)
      if (own.length > 0 || children.length > 0) groups.push({ ...ref, children, presets: own })
    }
    return groups
  }

  const groups = walk((tree as PresetTree).groups, [])
  if (presets.length === 0) return null
  // Aliases only fill names no slug has taken.
  for (const preset of presets) for (const alias of preset.aliases) if (!byId.has(alias)) byId.set(alias, preset)
  return { groups, presets, byId }
}

/** The handful offered as one-click chips; the old fixed list when the catalogue marks none. */
export const DEFAULT_QUICK_PRESET_IDS = ['instagram-post', 'presentation', 'poster', 'a4', 'youtube-thumbnail', 'instagram-story', 'logo'] as const

/** The quick presets: the default ones in their usual order (Instagram Post, Presentation, Poster…), then any others. */
export function quickPresets(catalogue: SizePresetCatalogue, limit = 8): SizePreset[] {
  const rank = (preset: SizePreset): number => {
    const index = (DEFAULT_QUICK_PRESET_IDS as readonly string[]).indexOf(preset.id)
    return index === -1 ? DEFAULT_QUICK_PRESET_IDS.length : index
  }
  const marked = catalogue.presets.filter((preset) => preset.quick)
  const list = marked.length > 0 ? marked : DEFAULT_QUICK_PRESET_IDS.map((id) => catalogue.byId.get(id)).filter((preset): preset is SizePreset => preset !== undefined)
  // Array.prototype.sort is stable, so presets outside the default list keep their catalogue order.
  return [...list].sort((a, b) => rank(a) - rank(b)).slice(0, limit)
}

export interface PresetSection {
  /** The group the presets sit in directly, outermost first. */
  path: PresetGroupRef[]
  presets: SizePreset[]
}

export interface PresetFilter {
  /** Words that must all appear in the label, slug, aliases, tags or group names. */
  query?: string
  /** Only presets inside the group with this slug (at any depth). */
  group?: string | null
  /** Only presets carrying every one of these tags. */
  tags?: readonly string[]
}

function haystack(preset: SizePreset): string {
  return [preset.label, preset.id, ...preset.aliases, ...preset.tags, ...preset.path.map((group) => group.label)].join(' ').toLowerCase()
}

/** The presets matching `filter`, in catalogue order, one section per group that holds some directly. */
export function filterPresets(catalogue: SizePresetCatalogue, filter: PresetFilter = {}): PresetSection[] {
  const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const tags = filter.tags ?? []
  const sections: PresetSection[] = []
  const visit = (group: PresetGroup, path: PresetGroupRef[], inside: boolean): void => {
    const here = [...path, group]
    const within = inside || !filter.group || group.slug === filter.group
    if (within) {
      const presets = group.presets.filter((preset) => {
        if (!tags.every((tag) => preset.tags.includes(tag))) return false
        const text = haystack(preset)
        return words.every((word) => text.includes(word))
      })
      if (presets.length > 0) sections.push({ path: here.map(({ slug, label, icon }) => ({ slug, label, icon })), presets })
    }
    for (const child of group.children) visit(child, here, within)
  }
  for (const group of catalogue.groups) visit(group, [], false)
  return sections
}

/** The tags used in a list of presets, most used first (then alphabetically). */
export function presetTags(presets: readonly SizePreset[]): string[] {
  const counts = new Map<string, number>()
  for (const preset of presets) for (const tag of preset.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag)
}

/** The first preset of exactly this pixel size, or undefined. */
export function findPresetBySize(catalogue: SizePresetCatalogue, width: number, height: number): SizePreset | undefined {
  return catalogue.presets.find((preset) => preset.width === width && preset.height === height)
}
