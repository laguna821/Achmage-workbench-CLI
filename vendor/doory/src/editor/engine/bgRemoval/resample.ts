/**
 * Separable image resampling on typed arrays (no DOM, so it runs in a worker and in unit tests).
 *
 * Shrinking averages exactly the source area each output pixel covers (a box filter with fractional edge
 * weights, so a 12-megapixel photo becomes a clean thumbnail without aliasing); enlarging interpolates
 * linearly between the two nearest pixel centres.
 */
export interface AxisWeights {
  /** First source index of each output position. */
  start: Int32Array
  /** Number of taps of each output position. */
  count: Int32Array
  /** Where each output position's weights begin in `weights`. */
  offset: Int32Array
  weights: Float32Array
}

export function axisWeights(source: number, target: number): AxisWeights {
  const start = new Int32Array(target)
  const count = new Int32Array(target)
  const offset = new Int32Array(target)
  const weights: number[] = []
  const shrink = target < source
  const ratio = source / target
  for (let d = 0; d < target; d++) {
    offset[d] = weights.length
    if (shrink) {
      const lo = d * ratio
      const hi = Math.min(source, (d + 1) * ratio)
      const first = Math.floor(lo)
      const last = Math.min(source - 1, Math.ceil(hi) - 1)
      start[d] = first
      for (let i = first; i <= last; i++) weights.push((Math.min(i + 1, hi) - Math.max(i, lo)) / ratio)
      count[d] = last - first + 1
    } else {
      const centre = (d + 0.5) * ratio - 0.5
      const left = Math.floor(centre)
      const fraction = centre - left
      const a = Math.min(Math.max(left, 0), source - 1)
      const b = Math.min(Math.max(left + 1, 0), source - 1)
      if (a === b || fraction === 0) {
        start[d] = a
        count[d] = 1
        weights.push(1)
      } else {
        start[d] = a
        count[d] = 2
        weights.push(1 - fraction, fraction)
      }
    }
  }
  return { start, count, offset, weights: Float32Array.from(weights) }
}

export interface Raster {
  data: Uint8ClampedArray | Float32Array
  width: number
  height: number
  /** Values per pixel in `data` (4 for RGBA bytes, 3 for RGB floats, 1 for a matte). */
  stride: number
}

/**
 * Resamples the first `channels` values of every pixel to `width` x `height`; the result is interleaved
 * floats. `scale` is multiplied in (1/255 turns bytes into 0..1).
 */
export function resample(source: Raster, channels: number, width: number, height: number, scale = 1): Float32Array {
  const { data, width: sw, height: sh, stride } = source
  const columns = axisWeights(sw, width)
  const rows = axisWeights(sh, height)
  const across = new Float32Array(width * sh * channels)
  for (let y = 0; y < sh; y++) {
    const rowBase = y * sw * stride
    const outBase = y * width * channels
    for (let x = 0; x < width; x++) {
      const first = columns.start[x]
      const taps = columns.count[x]
      const at = columns.offset[x]
      for (let c = 0; c < channels; c++) {
        let sum = 0
        for (let t = 0; t < taps; t++) sum += columns.weights[at + t] * data[rowBase + (first + t) * stride + c]
        across[outBase + x * channels + c] = sum * scale
      }
    }
  }
  const out = new Float32Array(width * height * channels)
  const rowLength = width * channels
  for (let y = 0; y < height; y++) {
    const first = rows.start[y]
    const taps = rows.count[y]
    const at = rows.offset[y]
    const outBase = y * rowLength
    for (let t = 0; t < taps; t++) {
      const weight = rows.weights[at + t]
      const inBase = (first + t) * rowLength
      for (let i = 0; i < rowLength; i++) out[outBase + i] += weight * across[inBase + i]
    }
  }
  return out
}

/** The size that fits `width` x `height` inside `longSide` on its longer edge (never enlarges). */
export function fitLongSide(width: number, height: number, longSide: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= longSide) return { width, height }
  const scale = longSide / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** The size with at most `maxPixels` pixels, keeping the aspect ratio (never enlarges). */
export function fitPixels(width: number, height: number, maxPixels: number): { width: number; height: number } {
  if (width * height <= maxPixels) return { width, height }
  const scale = Math.sqrt(maxPixels / (width * height))
  const fitted = { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
  // A one-pixel-high strip cannot get thinner, so it gives up width instead.
  if (fitted.width * fitted.height > maxPixels) fitted.width = Math.max(1, Math.floor(maxPixels / fitted.height))
  return fitted
}
