import type { AssetRef } from '@/types/adapter'

export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml'] as const

export interface ImageInfo {
  width: number
  height: number
  kind: AssetRef['kind']
  mime: string
}

export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedImageError'
  }
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/** Reads width/height from the root `<svg>` (width/height attributes, else viewBox). */
export function parseSvgSize(text: string): { width: number; height: number } | null {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return null
  const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  const attr = (name: string): number => {
    const raw = root.getAttribute(name)
    return raw && !raw.trim().endsWith('%') ? positive(Number.parseFloat(raw)) : 0
  }
  const width = attr('width') || (viewBox && viewBox.length === 4 ? positive(viewBox[2]) : 0)
  const height = attr('height') || (viewBox && viewBox.length === 4 ? positive(viewBox[3]) : 0)
  return width && height ? { width, height } : { width: width || 512, height: height || 512 }
}

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

function isSvg(blob: Blob): boolean {
  return blob.type === 'image/svg+xml' || (blob instanceof File && /\.svg$/i.test(blob.name))
}

/** Decodes the image to learn its size; rejects non-images so bad files never reach storage. */
export async function readImageInfo(blob: Blob): Promise<ImageInfo> {
  if (isSvg(blob)) {
    const size = parseSvgSize(await readBlobText(blob))
    if (!size) throw new UnsupportedImageError("That SVG file couldn't be read.")
    return { ...size, kind: 'svg', mime: 'image/svg+xml' }
  }
  if (!blob.type.startsWith('image/') || !(ALLOWED_IMAGE_TYPES as readonly string[]).includes(blob.type)) {
    throw new UnsupportedImageError('Only PNG, JPG, WebP, GIF, AVIF and SVG images can be uploaded.')
  }
  try {
    const bitmap = await createImageBitmap(blob)
    const info = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return { ...info, kind: 'image', mime: blob.type }
  } catch {
    throw new UnsupportedImageError("That image couldn't be read. It may be damaged.")
  }
}
