import { BackgroundRemovalError } from '../bgRemoval'
import { DEFAULT_SHAPE, featherAlpha, fitGuidedFilter, writeAlpha, type AlphaShape } from './matte'
import type { ModelInput } from './model'
import { fitLongSide, resample } from './resample'
import { buildModelInput, normalizeMatte } from './tensor'

export interface PipelineOptions {
  /** Feather the edge of the cut-out by this many pixels (0: none). */
  feather?: number
  /** The matte is refined against the photo reduced to this many pixels on its longer side. */
  guideLongSide?: number
  shape?: AlphaShape
  /** Guided-filter regularisation (see `fitGuidedFilter`). */
  epsilon?: number
}

export interface PipelineHooks {
  /** Runs the model on a planar `1 x 3 x size x size` tensor and returns the `size x size` probabilities. */
  infer(input: Float32Array): Promise<Float32Array>
  /** Called between stages with the progress so far (0..100); it may throw to cancel. */
  step(percent: number): Promise<void>
}

const GUIDE_LONG_SIDE = 1024
const DEFAULT_EPSILON = 1e-3
/** Below this share of foreground the model found no subject (a flat, empty answer). */
export const MIN_COVERAGE = 0.0005

/**
 * Cuts the background out of `rgba` (`width` x `height`, straight alpha) in place: only the alpha channel
 * changes. Returns the share of the picture that was kept (0..1).
 *
 * The photo is reduced once to a guide grid (`guideLongSide`), the model sees it at its own size, and the
 * soft matte it answers with is refined against the guide and applied at full resolution, so a 12-megapixel
 * photo costs one small inference and a handful of linear passes.
 */
export async function cutOut(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  model: ModelInput,
  hooks: PipelineHooks,
  options: PipelineOptions = {},
): Promise<number> {
  const grid = fitLongSide(width, height, options.guideLongSide ?? GUIDE_LONG_SIDE)
  const guide = resample({ data: rgba, width, height, stride: 4 }, 3, grid.width, grid.height, 1 / 255)
  await hooks.step(20)

  const input = buildModelInput(guide, grid.width, grid.height, model)
  await hooks.step(30)

  const output = await hooks.infer(input)
  if (output.length !== model.size * model.size) {
    throw new BackgroundRemovalError('The model returned an unexpected result.')
  }
  await hooks.step(75)

  const coarse = normalizeMatte(output)
  const matte = resample({ data: coarse, width: model.size, height: model.size, stride: 1 }, 1, grid.width, grid.height)
  const radius = Math.min(12, Math.max(2, Math.round(Math.max(grid.width, grid.height) / 128)))
  const fit = fitGuidedFilter(guide, matte, grid.width, grid.height, { radius, epsilon: options.epsilon ?? DEFAULT_EPSILON })
  await hooks.step(85)

  const coverage = writeAlpha(rgba, width, height, fit, options.shape ?? DEFAULT_SHAPE)
  if (coverage < MIN_COVERAGE) throw new BackgroundRemovalError('No subject was found in the image.', 'no-subject')
  await hooks.step(92)

  if (options.feather) featherAlpha(rgba, width, height, options.feather)
  return coverage
}
