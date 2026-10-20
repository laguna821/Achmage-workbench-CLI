import type { DocUnit } from '@/types/document'

const PX_PER_INCH = 96
const MM_PER_INCH = 25.4

export function pxToUnit(px: number, unit: DocUnit): number {
  if (unit === 'in') return px / PX_PER_INCH
  if (unit === 'mm') return (px / PX_PER_INCH) * MM_PER_INCH
  return px
}

export function unitToPx(value: number, unit: DocUnit): number {
  if (unit === 'in') return value * PX_PER_INCH
  if (unit === 'mm') return (value / MM_PER_INCH) * PX_PER_INCH
  return value
}

export function unitDecimals(unit: DocUnit): number {
  return unit === 'px' ? 0 : unit === 'mm' ? 1 : 2
}

export function formatUnit(px: number, unit: DocUnit): string {
  const decimals = unitDecimals(unit)
  const value = pxToUnit(px, unit)
  return Number(value.toFixed(decimals)).toString()
}

export function parseUnit(text: string, unit: DocUnit): number | null {
  const n = Number.parseFloat(text.replace(',', '.'))
  if (!Number.isFinite(n)) return null
  return unitToPx(n, unit)
}

/** Physical size in millimetres of a px length. */
export function pxToMm(px: number): number {
  return (px / PX_PER_INCH) * MM_PER_INCH
}

export function mmToPx(mm: number): number {
  return (mm / MM_PER_INCH) * PX_PER_INCH
}
