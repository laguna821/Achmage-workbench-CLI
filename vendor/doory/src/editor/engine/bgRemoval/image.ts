import { BackgroundRemovalError } from '../bgRemoval'
import { fitPixels } from './resample'

/** A cut-out is never larger than this (about 24 megapixels), which keeps the work inside a phone's memory. */
const MAX_OUTPUT_PIXELS = 24_000_000

export interface DecodedImage {
  rgba: Uint8ClampedArray<ArrayBuffer>
  width: number
  height: number
}

/** Decodes `blob` into straight RGBA bytes; a picture over `MAX_OUTPUT_PIXELS` is reduced to fit. */
export async function decodeImage(blob: Blob, maxPixels = MAX_OUTPUT_PIXELS): Promise<DecodedImage> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    throw new BackgroundRemovalError('This image cannot be decoded.')
  }
  try {
    const { width, height } = fitPixels(bitmap.width, bitmap.height, maxPixels)
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new BackgroundRemovalError('A canvas could not be created for this image.')
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, width, height)
    const { data } = context.getImageData(0, 0, width, height)
    return { rgba: data, width, height }
  } finally {
    bitmap.close()
  }
}

export async function encodePng(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new BackgroundRemovalError('A canvas could not be created for the result.')
  context.putImageData(new ImageData(rgba, width, height), 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}
