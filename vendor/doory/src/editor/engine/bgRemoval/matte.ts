import { axisWeights } from './resample'

/**
 * Turning a coarse matte into a clean cut-out.
 *
 * The model answers on a small grid (320 x 320), far coarser than the photo, so its edges are soft by
 * several photo pixels. A colour guided filter (He, Sun & Tang, "Guided Image Filtering", 2013) moves the
 * soft edge onto the edge that is really in the picture: it fits, in every window, a linear map from the
 * photo's colours to the matte, and applies that map at full resolution ("fast guided filter": the fit is
 * computed on a reduced grid and its coefficients are interpolated up).
 */

/** Mean of every (2r+1)-square window (clamped at the borders) of a `width` x `height` plane. */
export function boxMean(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  const across = new Float32Array(source.length)
  for (let y = 0; y < height; y++) {
    const base = y * width
    let sum = 0
    let hi = Math.min(radius, width - 1)
    for (let x = 0; x <= hi; x++) sum += source[base + x]
    for (let x = 0; x < width; x++) {
      const lo = Math.max(0, x - radius)
      const right = Math.min(width - 1, x + radius)
      if (right > hi) {
        sum += source[base + right]
        hi = right
      }
      if (x - radius - 1 >= 0) sum -= source[base + x - radius - 1]
      across[base + x] = sum / (right - lo + 1)
    }
  }
  const out = new Float32Array(source.length)
  const column = new Float64Array(width)
  let top = Math.min(radius, height - 1)
  for (let y = 0; y <= top; y++) for (let x = 0; x < width; x++) column[x] += across[y * width + x]
  for (let y = 0; y < height; y++) {
    const lo = Math.max(0, y - radius)
    const bottom = Math.min(height - 1, y + radius)
    if (bottom > top) {
      for (let x = 0; x < width; x++) column[x] += across[bottom * width + x]
      top = bottom
    }
    if (y - radius - 1 >= 0) for (let x = 0; x < width; x++) column[x] -= across[(y - radius - 1) * width + x]
    const inverse = 1 / (bottom - lo + 1)
    for (let x = 0; x < width; x++) out[y * width + x] = column[x] * inverse
  }
  return out
}

export interface GuidedCoefficients {
  width: number
  height: number
  /** Window-averaged linear coefficients: matte ≈ a.r·R + a.g·G + a.b·B + b. */
  a: readonly [Float32Array, Float32Array, Float32Array]
  b: Float32Array
}

export interface GuidedOptions {
  /** Window radius in pixels of the reduced grid. */
  radius: number
  /** Regularisation: larger values smooth more and follow the photo's edges less. */
  epsilon: number
}

/**
 * Fits the guided-filter coefficients of `matte` (a `width` x `height` plane on the reduced grid) against
 * `rgb` (the photo on the same grid, interleaved floats 0..1).
 */
export function fitGuidedFilter(
  rgb: Float32Array,
  matte: Float32Array,
  width: number,
  height: number,
  { radius, epsilon }: GuidedOptions,
): GuidedCoefficients {
  const n = width * height
  const r = new Float32Array(n)
  const g = new Float32Array(n)
  const b = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    r[i] = rgb[i * 3]
    g[i] = rgb[i * 3 + 1]
    b[i] = rgb[i * 3 + 2]
  }
  const mean = (plane: Float32Array): Float32Array => boxMean(plane, width, height, radius)
  const product = (x: Float32Array, y: Float32Array): Float32Array => {
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = x[i] * y[i]
    return out
  }

  const meanR = mean(r)
  const meanG = mean(g)
  const meanB = mean(b)
  const meanP = mean(matte)
  const covR = mean(product(r, matte))
  const covG = mean(product(g, matte))
  const covB = mean(product(b, matte))
  const varRR = mean(product(r, r))
  const varRG = mean(product(r, g))
  const varRB = mean(product(r, b))
  const varGG = mean(product(g, g))
  const varGB = mean(product(g, b))
  const varBB = mean(product(b, b))

  const ar = new Float32Array(n)
  const ag = new Float32Array(n)
  const ab = new Float32Array(n)
  const offset = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const mr = meanR[i]
    const mg = meanG[i]
    const mb = meanB[i]
    const mp = meanP[i]
    // Σ = cov(I) + εU, a symmetric 3x3 matrix; a = Σ⁻¹ cov(I, p).
    const rr = varRR[i] - mr * mr + epsilon
    const rg = varRG[i] - mr * mg
    const rb = varRB[i] - mr * mb
    const gg = varGG[i] - mg * mg + epsilon
    const gb = varGB[i] - mg * mb
    const bb = varBB[i] - mb * mb + epsilon
    const cr = covR[i] - mr * mp
    const cg = covG[i] - mg * mp
    const cb = covB[i] - mb * mp
    const c00 = gg * bb - gb * gb
    const c01 = gb * rb - rg * bb
    const c02 = rg * gb - gg * rb
    const c11 = rr * bb - rb * rb
    const c12 = rb * rg - rr * gb
    const c22 = rr * gg - rg * rg
    const inverseDet = 1 / (rr * c00 + rg * c01 + rb * c02)
    const x = (c00 * cr + c01 * cg + c02 * cb) * inverseDet
    const y = (c01 * cr + c11 * cg + c12 * cb) * inverseDet
    const z = (c02 * cr + c12 * cg + c22 * cb) * inverseDet
    ar[i] = x
    ag[i] = y
    ab[i] = z
    offset[i] = mp - x * mr - y * mg - z * mb
  }
  return {
    width,
    height,
    a: [mean(ar), mean(ag), mean(ab)],
    b: mean(offset),
  }
}

export interface AlphaShape {
  /** Matte values at or below `low` become fully transparent, at or above `high` fully opaque. */
  low: number
  high: number
}

export const DEFAULT_SHAPE: AlphaShape = { low: 0.08, high: 0.92 }

/** The smoothstep that clears faint haze near 0 and 1 and keeps a soft edge in between. */
export function shapeAlpha(value: number, { low, high }: AlphaShape): number {
  const t = (value - low) / (high - low)
  if (t <= 0) return 0
  if (t >= 1) return 1
  return t * t * (3 - 2 * t)
}

/**
 * Evaluates the fitted map at full resolution and stores the result as the alpha channel of `rgba`
 * (`width` x `height` pixels). Coefficients are interpolated bilinearly, so no full-size plane is needed
 * besides the picture itself. Returns the fraction of the picture that is foreground (mean alpha, 0..1).
 */
export function writeAlpha(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  fit: GuidedCoefficients,
  shape: AlphaShape = DEFAULT_SHAPE,
): number {
  if (fit.width > width || fit.height > height) throw new RangeError('The guided-filter grid cannot be larger than the picture.')
  const cols = axisWeights(fit.width, width)
  const rows = axisWeights(fit.height, height)
  const [ar, ag, ab] = fit.a
  const rowR = new Float32Array(fit.width)
  const rowG = new Float32Array(fit.width)
  const rowB = new Float32Array(fit.width)
  const rowO = new Float32Array(fit.width)
  let total = 0
  for (let y = 0; y < height; y++) {
    rowR.fill(0)
    rowG.fill(0)
    rowB.fill(0)
    rowO.fill(0)
    for (let t = 0; t < rows.count[y]; t++) {
      const weight = rows.weights[rows.offset[y] + t]
      const base = (rows.start[y] + t) * fit.width
      for (let x = 0; x < fit.width; x++) {
        rowR[x] += weight * ar[base + x]
        rowG[x] += weight * ag[base + x]
        rowB[x] += weight * ab[base + x]
        rowO[x] += weight * fit.b[base + x]
      }
    }
    let sum = 0
    for (let x = 0; x < width; x++) {
      const first = cols.start[x]
      const w0 = cols.weights[cols.offset[x]]
      let r = w0 * rowR[first]
      let g = w0 * rowG[first]
      let b = w0 * rowB[first]
      let o = w0 * rowO[first]
      if (cols.count[x] === 2) {
        const w1 = cols.weights[cols.offset[x] + 1]
        r += w1 * rowR[first + 1]
        g += w1 * rowG[first + 1]
        b += w1 * rowB[first + 1]
        o += w1 * rowO[first + 1]
      }
      const p = (y * width + x) * 4
      const value = (r * rgba[p] + g * rgba[p + 1] + b * rgba[p + 2]) / 255 + o
      const alpha = shapeAlpha(value, shape)
      rgba[p + 3] = Math.round(alpha * 255)
      sum += alpha
    }
    total += sum
  }
  return total / (width * height)
}

/**
 * Softens the alpha channel by `radius` pixels (two box-blur passes, close to a Gaussian). Used for the
 * optional feathered edge; a radius of 0 leaves the matte alone.
 */
export function featherAlpha(rgba: Uint8ClampedArray, width: number, height: number, radius: number): void {
  const r = Math.round(radius)
  if (r < 1) return
  let plane: Float32Array = new Float32Array(width * height)
  for (let i = 0; i < plane.length; i++) plane[i] = rgba[i * 4 + 3]
  for (let pass = 0; pass < 2; pass++) plane = boxMean(plane, width, height, Math.max(1, Math.round(r / 1.4)))
  for (let i = 0; i < plane.length; i++) rgba[i * 4 + 3] = Math.round(plane[i])
}
