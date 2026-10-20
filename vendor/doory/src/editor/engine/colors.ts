/** Colour parsing/formatting helpers. Pure and framework-free. */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

export interface Hsva {
  h: number
  s: number
  v: number
  a: number
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_RE = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i

export function isHexColor(value: string): boolean {
  return HEX_RE.test(value.trim())
}

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`. Returns null when unparseable. */
export function parseColor(input: string): Rgba | null {
  const value = input.trim()
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const hex = HEX_RE.exec(value)
  if (hex) {
    let h = hex[1]
    if (h.length <= 4) h = [...h].map((c) => c + c).join('')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    return { r, g, b, a }
  }
  const rgb = RGB_RE.exec(value)
  if (rgb) {
    const alphaRaw = rgb[4]
    let a = 1
    if (alphaRaw !== undefined) a = alphaRaw.endsWith('%') ? parseFloat(alphaRaw) / 100 : parseFloat(alphaRaw)
    return {
      r: clamp(Math.round(parseFloat(rgb[1])), 0, 255),
      g: clamp(Math.round(parseFloat(rgb[2])), 0, 255),
      b: clamp(Math.round(parseFloat(rgb[3])), 0, 255),
      a: clamp(a, 0, 1),
    }
  }
  return null
}

const hex2 = (n: number): string => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')

/** `#rrggbb`, or `#rrggbbaa` when the colour is not fully opaque. */
export function rgbaToHex({ r, g, b, a }: Rgba): string {
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`
  return a >= 1 ? base : `${base}${hex2(a * 255)}`
}

/** Normalises any parseable colour to lowercase `#rrggbb[aa]`; unknown input is returned unchanged. */
export function normalizeColor(input: string): string {
  const parsed = parseColor(input)
  return parsed ? rgbaToHex(parsed) : input
}

export function rgbaToCss({ r, g, b, a }: Rgba): string {
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`
}

export function rgbToHsv({ r, g, b, a }: Rgba): Hsva {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max, a }
}

export function hsvToRgb({ h, s, v, a }: Hsva): Rgba {
  const hh = ((h % 360) + 360) % 360
  const c = v * s
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = v - c
  let rp = 0
  let gp = 0
  let bp = 0
  if (hh < 60) [rp, gp, bp] = [c, x, 0]
  else if (hh < 120) [rp, gp, bp] = [x, c, 0]
  else if (hh < 180) [rp, gp, bp] = [0, c, x]
  else if (hh < 240) [rp, gp, bp] = [0, x, c]
  else if (hh < 300) [rp, gp, bp] = [x, 0, c]
  else [rp, gp, bp] = [c, 0, x]
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
    a,
  }
}

/** Relative luminance (WCAG). */
export function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** Black or white, whichever reads better on `background`. */
export function readableOn(background: string): '#000000' | '#ffffff' {
  const parsed = parseColor(background)
  if (!parsed) return '#000000'
  return luminance(parsed) > 0.4 ? '#000000' : '#ffffff'
}

/** Sets the alpha channel of a colour (0..1) and returns `#rrggbbaa`. */
export function withAlpha(color: string, alpha: number): string {
  const parsed = parseColor(color) ?? { r: 0, g: 0, b: 0, a: 1 }
  return rgbaToHex({ ...parsed, a: clamp(alpha, 0, 1) })
}
