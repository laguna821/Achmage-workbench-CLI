/**
 * Export file names (#59). `simple` is the name exports always had (`Summer-Sale-02.png`); `structured` is built from what
 * the design knows: `<title>_<platform>_<preset>_<W>x<H>[_pNN][_<unix>].<ext>`, e.g.
 * `summer-sale_instagram_instagram-story_1080x1920_p02.png`. The server (`apps/exports/filenames.py`) follows the same
 * rules; both are checked against `../fixtures/export-filenames.json`.
 */
import type { DoryDocument } from '@/types/document'
import type { SizePreset } from '@/lib/sizePresets'

export type FilenameStyle = 'simple' | 'structured'
export const FILENAME_STYLES: readonly FilenameStyle[] = ['simple', 'structured']

/** How one export run names its files. `unix` is taken once per run, so every file and the ZIP share it. */
export interface FileNaming {
  style: FilenameStyle
  /** Unix seconds, or null for no timestamp part. */
  unix: number | null
}

export const SIMPLE_NAMING: FileNaming = { style: 'simple', unix: null }

export interface StructuredParts {
  title: string
  platform?: string | null
  preset?: string | null
  width?: number | null
  height?: number | null
  /** 1-based; only named when `pages` is above 1. Null for a file that is not one page (PDF, video, ZIP). */
  page?: number | null
  /** The design's page count: decides whether pages are numbered, and with how many digits. */
  pages?: number
  unix?: number | null
  /** A word after the size, such as `print`. */
  suffix?: string | null
  extension: string
}

const MAX_SLUG_LENGTH = 80

/** Lowercase ASCII letters and digits joined by dashes; accents dropped, anything else is a separator. */
export function slugify(text: string | null | undefined, limit = MAX_SLUG_LENGTH): string {
  return (text ?? '')
    .normalize('NFKD')
    .replace(/[\u0080-\uffff]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, limit)
    .replace(/-+$/, '')
}

export function structuredFilename(parts: StructuredParts): string {
  const out = [slugify(parts.title) || 'design']
  if (parts.preset) out.push(...[slugify(parts.platform), slugify(parts.preset)].filter(Boolean))
  if (parts.width && parts.height) out.push(`${Math.round(parts.width)}x${Math.round(parts.height)}`)
  const pages = parts.pages ?? 1
  if (parts.page != null && pages > 1) out.push(`p${String(parts.page).padStart(Math.max(2, String(pages).length), '0')}`)
  if (parts.suffix) out.push(slugify(parts.suffix))
  if (parts.unix != null) out.push(String(Math.floor(parts.unix)))
  return `${out.join('_')}.${parts.extension}`
}

/**
 * `{platform, preset}` for a page still at its size preset's size (as `safeZoneFor` decides), nothing for a custom
 * size. The platform is the preset's `meta.platforms[0]`, else the group it sits in (Social media → Instagram: `instagram`).
 */
export function presetParts(preset: SizePreset | undefined, width: number, height: number): { platform: string | null; preset: string | null } {
  if (!preset || preset.width !== Math.round(width) || preset.height !== Math.round(height)) return { platform: null, preset: null }
  return { platform: slugify(preset.platform) || preset.path.at(-1)?.slug || null, preset: preset.id }
}

/** One file's structured name for `doc`: `page` is its 0-based index, or null for a file of several pages. */
export function documentFilename(
  doc: DoryDocument,
  title: string,
  extension: string,
  size: { width: number; height: number } | null,
  page: number | null,
  naming: FileNaming,
  lookup: (id: string) => SizePreset | undefined,
  suffix?: string,
): string {
  const parts = size ? presetParts(lookup(doc.meta?.presetId ?? ''), size.width, size.height) : { platform: null, preset: null }
  return structuredFilename({
    title,
    ...parts,
    width: size?.width,
    height: size?.height,
    page: page === null ? null : page + 1,
    pages: doc.pages.length,
    unix: naming.unix,
    suffix,
    extension,
  })
}

/** The timestamp for one export run. */
export const unixNow = (): number => Math.floor(Date.now() / 1000)
