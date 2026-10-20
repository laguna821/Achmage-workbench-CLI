/**
 * The pixel work of an animated GIF that `gifenc` does not do: telling two frames apart, and dithering. Pure functions
 * on RGBA bytes, so they are tested without a browser.
 */

/** True when two frames of the same size hold the same pixels. */
export function framesEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2)
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2)
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

const clampByte = (n: number): number => (n < 0 ? 0 : n > 255 ? 255 : n)

/**
 * The palette entry nearest to a colour. A colour the palette holds is found at once and exactly; any other is measured
 * once per 5-bit-per-channel cell and remembered.
 */
class NearestColour {
  private readonly cache = new Int16Array(32_768).fill(-1)
  private readonly exact = new Map<number, number>()

  constructor(private readonly palette: readonly (readonly number[])[]) {
    palette.forEach(([r, g, b], i) => {
      const key = (r << 16) | (g << 8) | b
      if (!this.exact.has(key)) this.exact.set(key, i)
    })
  }

  indexOf(r: number, g: number, b: number): number {
    const own = this.exact.get((r << 16) | (g << 8) | b)
    if (own !== undefined) return own
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const hit = this.cache[key]
    if (hit >= 0) return hit
    // Measure from the middle of the 5-bit cell, so that the answer does not lean towards the darker corner.
    const cr = (r & 0xf8) | 4
    const cg = (g & 0xf8) | 4
    const cb = (b & 0xf8) | 4
    let best = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (let i = 0; i < this.palette.length; i++) {
      const [pr, pg, pb] = this.palette[i]
      const dr = pr - cr
      const dg = pg - cg
      const db = pb - cb
      // The eye weighs green most and blue least.
      const distance = 2 * dr * dr + 4 * dg * dg + 3 * db * db
      if (distance < bestDistance) {
        bestDistance = distance
        best = i
      }
    }
    this.cache[key] = best
    return best
  }
}

/**
 * Maps RGBA pixels to `palette` indices with Floyd-Steinberg error diffusion: the part of a pixel's colour that the
 * palette cannot show is added to the pixels next to it, so a gradient becomes a fine pattern of palette colours
 * instead of bands. The scan runs left to right and right to left on alternate rows, which keeps the pattern from
 * streaking. A colour the palette holds exactly leaves no error, so flat artwork is not made noisy.
 */
export function ditherToPalette(rgba: Uint8ClampedArray, width: number, height: number, palette: readonly (readonly number[])[]): Uint8Array {
  const index = new Uint8Array(width * height)
  if (palette.length === 0 || width === 0 || height === 0) return index
  const nearest = new NearestColour(palette)
  // Two rows of error, three channels each, padded by a pixel on both sides.
  const stride = (width + 2) * 3
  let current = new Float32Array(stride)
  let next = new Float32Array(stride)
  for (let y = 0; y < height; y++) {
    const leftToRight = (y & 1) === 0
    next.fill(0)
    for (let step = 0; step < width; step++) {
      const x = leftToRight ? step : width - 1 - step
      const at = (y * width + x) * 4
      const e = (x + 1) * 3
      const r = clampByte(rgba[at] + current[e])
      const g = clampByte(rgba[at + 1] + current[e + 1])
      const b = clampByte(rgba[at + 2] + current[e + 2])
      const chosen = nearest.indexOf(Math.round(r), Math.round(g), Math.round(b))
      index[y * width + x] = chosen
      const [pr, pg, pb] = palette[chosen]
      const er = r - pr
      const eg = g - pg
      const eb = b - pb
      // Ahead in the scan direction, and the three pixels below.
      const ahead = leftToRight ? e + 3 : e - 3
      const behind = leftToRight ? e - 3 : e + 3
      current[ahead] += (er * 7) / 16
      current[ahead + 1] += (eg * 7) / 16
      current[ahead + 2] += (eb * 7) / 16
      next[behind] += (er * 3) / 16
      next[behind + 1] += (eg * 3) / 16
      next[behind + 2] += (eb * 3) / 16
      next[e] += (er * 5) / 16
      next[e + 1] += (eg * 5) / 16
      next[e + 2] += (eb * 5) / 16
      next[ahead] += er / 16
      next[ahead + 1] += eg / 16
      next[ahead + 2] += eb / 16
    }
    const swap = current
    current = next
    next = swap
  }
  return index
}
