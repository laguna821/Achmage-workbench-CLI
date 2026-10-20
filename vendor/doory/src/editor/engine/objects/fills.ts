/**
 * Fill model shared by shapes, text and page backgrounds: a solid colour or a linear/radial gradient.
 * Gradients use Fabric's percentage units so they scale with the object.
 */
import { Gradient } from 'fabric'
import type { GradientStop } from '@/types/document'

export type FillSpec =
  | { type: 'solid'; color: string }
  | { type: 'gradient'; kind: 'linear' | 'radial'; angle: number; stops: GradientStop[] }

export const DEFAULT_STOPS: GradientStop[] = [
  { offset: 0, color: '#7a64e0' },
  { offset: 1, color: '#f59e0b' },
]

type AnyGradient = Gradient<'linear'> | Gradient<'radial'>

export function isGradient(fill: unknown): fill is AnyGradient {
  if (!fill || typeof fill !== 'object') return false
  const f = fill as { type?: string; colorStops?: unknown }
  return (f.type === 'linear' || f.type === 'radial') && Array.isArray(f.colorStops)
}

export function sortStops(stops: readonly GradientStop[]): GradientStop[] {
  return [...stops].sort((a, b) => a.offset - b.offset)
}

/** CSS gradient string, used for previews and DOM-rendered page backgrounds. */
export function gradientCss(spec: Extract<FillSpec, { type: 'gradient' }>): string {
  const stops = sortStops(spec.stops)
    .map((s) => `${s.color} ${Math.round(s.offset * 1000) / 10}%`)
    .join(', ')
  if (spec.kind === 'radial') return `radial-gradient(circle at 50% 50%, ${stops})`
  // CSS angles start at "up" and go clockwise; ours start at "right" and go clockwise (like canvas y-down).
  return `linear-gradient(${spec.angle + 90}deg, ${stops})`
}

export function buildFill(spec: FillSpec): string | AnyGradient {
  if (spec.type === 'solid') return spec.color
  const colorStops = sortStops(spec.stops).map((s) => ({ offset: Math.min(1, Math.max(0, s.offset)), color: s.color }))
  if (spec.kind === 'radial') {
    return new Gradient({
      type: 'radial',
      gradientUnits: 'percentage',
      coords: { x1: 0.5, y1: 0.5, r1: 0, x2: 0.5, y2: 0.5, r2: 0.5 },
      colorStops,
    })
  }
  const rad = (spec.angle * Math.PI) / 180
  const dx = Math.cos(rad)
  const dy = Math.sin(rad)
  return new Gradient({
    type: 'linear',
    gradientUnits: 'percentage',
    coords: { x1: 0.5 - dx * 0.5, y1: 0.5 - dy * 0.5, x2: 0.5 + dx * 0.5, y2: 0.5 + dy * 0.5 },
    colorStops,
  })
}

export function readFill(fill: unknown, fallback = '#000000'): FillSpec {
  if (isGradient(fill)) {
    const stops = fill.colorStops.map((s) => ({ offset: s.offset, color: String(s.color) }))
    if (fill.type === 'radial') return { type: 'gradient', kind: 'radial', angle: 0, stops }
    const c = fill.coords as { x1: number; y1: number; x2: number; y2: number }
    const angle = Math.round(((Math.atan2(c.y2 - c.y1, c.x2 - c.x1) * 180) / Math.PI + 360) % 360)
    return { type: 'gradient', kind: 'linear', angle, stops }
  }
  if (typeof fill === 'string' && fill) return { type: 'solid', color: fill }
  return { type: 'solid', color: fallback }
}

export function fillCssPreview(spec: FillSpec): string {
  return spec.type === 'solid' ? spec.color : gradientCss(spec)
}
