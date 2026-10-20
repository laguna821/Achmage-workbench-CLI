/**
 * What the Download dialog knows about printing: the presets, how a choice is kept per design, how the chosen pages are
 * summed up. No React here, so all of it is tested without a browser.
 */
import type { DocUnit } from '@/types/document'
import type { PageSize } from '../../engine/docOps'
import { MAX_BLEED_MM } from '../../engine/export/printGeometry'
import { findPresetBySize, getSizePresets } from '@/lib/sizePresets'
import { formatUnit, mmToPx, pxToUnit } from '../../engine/units'
import { t } from '../../strings'

export type PrintPresetId = 'screen' | 'standard' | 'custom'

/** Bleed and crop marks as the user set them, and which preset chip they came from. */
export interface PrintSettings {
  preset: PrintPresetId
  /** 0..10 mm in steps of 0.1. */
  bleedMm: number
  cropMarks: boolean
}

export const PRINT_PRESETS: Record<'screen' | 'standard', Pick<PrintSettings, 'bleedMm' | 'cropMarks'>> = {
  screen: { bleedMm: 0, cropMarks: false },
  standard: { bleedMm: 3, cropMarks: true },
}

export const DEFAULT_PRINT_SETTINGS: PrintSettings = { preset: 'screen', ...PRINT_PRESETS.screen }

/** A bleed the server accepts: finite, 0..10 mm, one decimal. Anything else (NaN, text) becomes 0. */
export function clampBleedMm(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.min(MAX_BLEED_MM, Math.max(0, value)) * 10) / 10
}

export function applyPreset(id: PrintPresetId, current: PrintSettings): PrintSettings {
  return id === 'custom' ? { ...current, preset: 'custom' } : { preset: id, ...PRINT_PRESETS[id] }
}

/** The settings after the user typed a bleed or flipped the marks: always a custom setup. */
export function customize(current: PrintSettings, patch: Partial<Pick<PrintSettings, 'bleedMm' | 'cropMarks'>>): PrintSettings {
  return { preset: 'custom', bleedMm: clampBleedMm(patch.bleedMm ?? current.bleedMm), cropMarks: patch.cropMarks ?? current.cropMarks }
}

/** Settings read back from storage: anything that is not valid falls back to the defaults, field by field. */
export function sanitizeSettings(raw: unknown): PrintSettings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_PRINT_SETTINGS
  const data = raw as Record<string, unknown>
  const preset = data.preset === 'standard' || data.preset === 'custom' || data.preset === 'screen' ? data.preset : 'custom'
  const bleedMm = typeof data.bleedMm === 'number' ? clampBleedMm(data.bleedMm) : DEFAULT_PRINT_SETTINGS.bleedMm
  const cropMarks = typeof data.cropMarks === 'boolean' ? data.cropMarks : DEFAULT_PRINT_SETTINGS.cropMarks
  if (preset === 'screen' || preset === 'standard') {
    const wanted = PRINT_PRESETS[preset]
    // A preset chip whose numbers were edited by hand is a custom setup.
    return wanted.bleedMm === bleedMm && wanted.cropMarks === cropMarks ? { preset, ...wanted } : { preset: 'custom', bleedMm, cropMarks }
  }
  return { preset, bleedMm, cropMarks }
}

const KEY_PREFIX = 'doory.editor.print.v1.'

/** The choice made last time for this design; the defaults when there is none or storage is not available. */
export function loadPrintSettings(designId: string): PrintSettings {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + designId)
    return raw ? sanitizeSettings(JSON.parse(raw)) : DEFAULT_PRINT_SETTINGS
  } catch {
    return DEFAULT_PRINT_SETTINGS
  }
}

export function savePrintSettings(designId: string, settings: PrintSettings): void {
  try {
    localStorage.setItem(KEY_PREFIX + designId, JSON.stringify(settings))
  } catch {
    /* storage is full or blocked (private window): the choice is simply not remembered */
  }
}

/** The bleed in the unit the design uses, for the hint under the field ("= 0.12 in"); null when that unit is mm itself. */
export function bleedInUnit(bleedMm: number, unit: DocUnit): { value: string; unit: string } | null {
  if (unit === 'mm') return null
  const px = mmToPx(bleedMm)
  return { value: unit === 'in' ? String(Number(pxToUnit(px, 'in').toFixed(2))) : formatUnit(px, unit), unit }
}

export interface SizeSummary {
  pages: number
  /** Distinct sizes in the order they first appear, named when they are a known paper or design size. */
  sizes: string[]
  /** Distinct sizes that did not fit in `sizes`. */
  more: number
}

const MAX_LISTED_SIZES = 4

/** "1080×1080" in the design's unit, or the name of the paper size it is (A4, US Letter…); orientation does not matter. */
export function sizeLabel(size: PageSize, unit: DocUnit): string {
  const catalogue = getSizePresets()
  const preset = findPresetBySize(catalogue, size.width, size.height) ?? findPresetBySize(catalogue, size.height, size.width)
  // Sizes defined in millimetres or inches are paper sizes; pixel sizes (screens, social posts) are written as numbers.
  if (preset && preset.sourceUnit !== 'px') return t.print.paper[preset.id] ?? preset.label.replace(/\s*\(.*\)$/, '')
  const suffix = unit === 'px' ? '' : ` ${unit}`
  return `${formatUnit(size.width, unit)}×${formatUnit(size.height, unit)}${suffix}`
}

export function summarizeSizes(sizes: readonly PageSize[], unit: DocUnit): SizeSummary {
  const seen = new Map<string, string>()
  for (const size of sizes) {
    const key = `${size.width}x${size.height}`
    if (!seen.has(key)) seen.set(key, sizeLabel(size, unit))
  }
  const labels = [...seen.values()]
  return { pages: sizes.length, sizes: labels.slice(0, MAX_LISTED_SIZES), more: Math.max(0, labels.length - MAX_LISTED_SIZES) }
}

export function describeSizes(sizes: readonly PageSize[], unit: DocUnit): string {
  if (sizes.length === 0) return t.print.noPages
  const summary = summarizeSizes(sizes, unit)
  return t.print.summary(summary.pages, summary.sizes, summary.more)
}
