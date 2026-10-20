/**
 * Simple charts as SVG markup. They are inserted like catalog elements (`insert.svgElement`), so every bar, slice
 * and line keeps its own colour and can be recoloured from the toolbar.
 */

export type ChartKind = 'bar' | 'line' | 'pie' | 'donut'
export const CHART_KINDS: readonly ChartKind[] = ['bar', 'line', 'pie', 'donut']

/** Sample data a new chart starts with. */
export const CHART_SAMPLES: Record<ChartKind, readonly number[]> = {
  bar: [40, 70, 55, 90],
  line: [20, 55, 40, 80, 65],
  pie: [45, 30, 25],
  donut: [50, 30, 20],
}

export const CHART_COLORS: readonly string[] = ['#7a64e0', '#ffa9b9', '#2b1c17', '#ffd36e', '#6fbf98']
const INK = '#1c1517'
const SIZE = 200

const round = (n: number): number => Math.round(n * 100) / 100
const color = (i: number): string => CHART_COLORS[i % CHART_COLORS.length]

function bars(values: readonly number[]): string {
  const max = Math.max(...values, 1)
  const slot = 160 / values.length
  const width = slot * 0.62
  const rects = values.map((v, i) => {
    const h = (v / max) * 150
    return `<rect x="${round(30 + slot * i + (slot - width) / 2)}" y="${round(180 - h)}" width="${round(width)}" height="${round(h)}" rx="3" fill="${color(i)}"/>`
  })
  return `<path d="M24 14V180H190" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${rects.join('')}`
}

function line(values: readonly number[]): string {
  const max = Math.max(...values, 1)
  const step = values.length > 1 ? 150 / (values.length - 1) : 0
  const points = values.map((v, i) => ({ x: round(34 + step * i), y: round(180 - (v / max) * 150) }))
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ')
  const dots = points.map((p, i) => `<circle cx="${p.x}" cy="${p.y}" r="6" fill="${color(i === 0 ? 0 : 2)}"/>`)
  return `<path d="M24 14V180H190" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="${path}" fill="none" stroke="${color(0)}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>${dots.join('')}`
}

function slices(values: readonly number[], hole: number): string {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1
  const c = SIZE / 2
  const r = 90
  const pt = (radius: number, angle: number): string => `${round(c + radius * Math.cos(angle))} ${round(c + radius * Math.sin(angle))}`
  if (values.filter((v) => v > 0).length === 1) {
    // One slice is a full circle (an arc from a point to itself draws nothing).
    const i = values.findIndex((v) => v > 0)
    if (hole === 0) return `<circle cx="${c}" cy="${c}" r="${r}" fill="${color(i)}" stroke="#ffffff" stroke-width="2"/>`
    return `<path fill-rule="evenodd" d="M${c - r} ${c} A${r} ${r} 0 1 0 ${c + r} ${c} A${r} ${r} 0 1 0 ${c - r} ${c} Z M${c - hole} ${c} A${hole} ${hole} 0 1 0 ${c + hole} ${c} A${hole} ${hole} 0 1 0 ${c - hole} ${c} Z" fill="${color(i)}" stroke="#ffffff" stroke-width="2"/>`
  }
  let from = -Math.PI / 2
  return values
    .map((v, i) => {
      const sweep = (Math.max(0, v) / total) * Math.PI * 2
      const to = from + sweep
      const big = sweep > Math.PI ? 1 : 0
      const outer = `M${pt(r, from)} A${r} ${r} 0 ${big} 1 ${pt(r, to)}`
      const d = hole > 0 ? `${outer} L${pt(hole, to)} A${hole} ${hole} 0 ${big} 0 ${pt(hole, from)} Z` : `M${c} ${c} L${pt(r, from)} A${r} ${r} 0 ${big} 1 ${pt(r, to)} Z`
      from = to
      return `<path d="${d}" fill="${color(i)}" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>`
    })
    .join('')
}

/** SVG markup of a chart; `values` must be finite numbers (negatives count as zero in pies). */
export function chartSvg(kind: ChartKind, values: readonly number[] = CHART_SAMPLES[kind]): string {
  const safe = values.filter((v) => Number.isFinite(v))
  const data = safe.length > 0 ? safe : CHART_SAMPLES[kind]
  const body = kind === 'bar' ? bars(data) : kind === 'line' ? line(data) : slices(data, kind === 'donut' ? 52 : 0)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">${body}</svg>`
}
