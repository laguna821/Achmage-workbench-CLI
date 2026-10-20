import type { ModelInput } from './model'
import { resample } from './resample'

/**
 * Turns an RGB picture (interleaved floats 0..1) into the model's input tensor: resized to `size` x `size`,
 * rescaled and normalised, laid out as planar `1 x 3 x size x size`.
 */
export function buildModelInput(rgb: Float32Array, width: number, height: number, input: ModelInput): Float32Array {
  const { size, mean, std, rescale } = input
  const resized = resample({ data: rgb, width, height, stride: 3 }, 3, size, size)
  let divisor = 1
  if (rescale === 'max') {
    let largest = 0
    for (let i = 0; i < resized.length; i++) if (resized[i] > largest) largest = resized[i]
    divisor = Math.max(largest, 1e-6)
  }
  const plane = size * size
  const tensor = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) tensor[c * plane + i] = (resized[i * 3 + c] / divisor - mean[c]) / std[c]
  }
  return tensor
}

/**
 * The model's foreground probabilities stretched to the full 0..1 range (the reference implementation's
 * min-max normalisation). A flat output carries no contrast to stretch and is returned as it is, clamped.
 */
export function normalizeMatte(output: Float32Array): Float32Array {
  let low = Infinity
  let high = -Infinity
  for (let i = 0; i < output.length; i++) {
    const v = output[i]
    if (v < low) low = v
    if (v > high) high = v
  }
  const matte = new Float32Array(output.length)
  const range = high - low
  if (!(range > 1e-3)) {
    for (let i = 0; i < output.length; i++) matte[i] = Math.min(1, Math.max(0, output[i]))
    return matte
  }
  for (let i = 0; i < output.length; i++) matte[i] = (output[i] - low) / range
  return matte
}
