/**
 * Image/asset plumbing between the canvas and `EditorAdapter`: `src` resolution (cached), upload with
 * validation, and the safety net that turns `data:` / `blob:` srcs into durable assets before saving.
 */
import type { AssetRef, EditorAdapter } from '@/types/adapter'
import type { DocObject, DoryDocument } from '@/types/document'
import { walkObjects } from './docOps'

export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml'] as const
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export class UploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadError'
  }
}

export function validateImageFile(file: File | Blob, maxBytes = MAX_UPLOAD_BYTES): void {
  const type = file.type
  if (!ACCEPTED_IMAGE_TYPES.includes(type as (typeof ACCEPTED_IMAGE_TYPES)[number])) {
    throw new UploadError('That file type is not supported. Use PNG, JPG, WebP, GIF, AVIF or SVG.')
  }
  if (file.size > maxBytes) {
    throw new UploadError(`That image is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`)
  }
}

export function isInlineSrc(src: string): boolean {
  return src.startsWith('data:') || src.startsWith('blob:')
}

export class AssetManager {
  private readonly resolved = new Map<string, Promise<string>>()
  private readonly uploaded = new Map<string, Promise<AssetRef>>()

  constructor(private adapter: EditorAdapter) {}

  setAdapter(adapter: EditorAdapter): void {
    this.adapter = adapter
    this.resolved.clear()
  }

  resolve(src: string): Promise<string> {
    if (isInlineSrc(src)) return Promise.resolve(src)
    let p = this.resolved.get(src)
    if (!p) {
      p = this.adapter.resolveSrc(src)
      this.resolved.set(src, p)
      p.catch(() => this.resolved.delete(src))
    }
    return p
  }

  async upload(file: File | Blob, name?: string): Promise<AssetRef> {
    validateImageFile(file)
    return this.adapter.uploadAsset(file, name ? { name } : undefined)
  }

  /** Uploads the bytes behind a `data:`/`blob:` URL once and returns the durable reference. */
  private async uploadInline(src: string): Promise<AssetRef> {
    let p = this.uploaded.get(src)
    if (!p) {
      p = fetch(src)
        .then((r) => r.blob())
        .then((blob) => this.upload(blob))
      this.uploaded.set(src, p)
      p.catch(() => this.uploaded.delete(src))
    }
    return p
  }

  /**
   * Returns a copy of `doc` in which every inline image src (data:/blob:) has been replaced with an
   * uploaded asset. Documents without inline srcs are returned as-is (same reference).
   */
  async persistInline(doc: DoryDocument): Promise<DoryDocument> {
    const inline = new Set<string>()
    const collect = (o: DocObject): void => {
      if (typeof o.src === 'string' && isInlineSrc(o.src)) inline.add(o.src)
    }
    for (const page of doc.pages) {
      walkObjects(page.objects, collect)
      if (page.background.type === 'image' && isInlineSrc(page.background.src)) inline.add(page.background.src)
    }
    if (inline.size === 0) return doc
    const refs = new Map<string, AssetRef>()
    await Promise.all([...inline].map(async (src) => refs.set(src, await this.uploadInline(src))))
    const rewrite = (o: DocObject): DocObject => {
      const next: DocObject = { ...o }
      if (typeof o.src === 'string') {
        const ref = refs.get(o.src)
        if (ref) {
          next.src = ref.url
          next.assetId = ref.id
        }
      }
      if (Array.isArray(o.objects)) next.objects = (o.objects as DocObject[]).map(rewrite)
      return next
    }
    return {
      ...doc,
      pages: doc.pages.map((page) => {
        const bg = page.background
        const background = bg.type === 'image' && refs.has(bg.src) ? { ...bg, src: refs.get(bg.src)?.url ?? bg.src } : bg
        return { ...page, background, objects: page.objects.map(rewrite) }
      }),
    }
  }
}

const MAX_INLINE_DATA_BYTES = 64 * 1024

export class UnsaveableDocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsaveableDocumentError'
  }
}

/**
 * Last line of defence before a save: the server rejects `blob:` strings anywhere and `data:` strings over
 * 64 KB (`inline_asset_not_allowed`). Throws with the offending location instead of sending a doomed request.
 * Iterative and depth-bounded, like the server's own walk.
 */
export function assertSaveable(doc: DoryDocument): void {
  const stack: { value: unknown; path: string; depth: number }[] = [
    { value: doc.pages, path: 'pages', depth: 0 },
    { value: doc.audioTracks, path: 'audioTracks', depth: 0 },
  ]
  while (stack.length > 0) {
    const { value, path, depth } = stack.pop() as { value: unknown; path: string; depth: number }
    if (typeof value === 'string') {
      if (value.startsWith('blob:')) throw new UnsaveableDocumentError(`A local blob URL is still referenced at ${path}.`)
      if (value.startsWith('data:') && value.length > MAX_INLINE_DATA_BYTES) throw new UnsaveableDocumentError(`An inline image at ${path} is too large to save.`)
    } else if (value !== null && typeof value === 'object' && depth < 64) {
      for (const [k, v] of Object.entries(value)) stack.push({ value: v, path: `${path}.${k}`, depth: depth + 1 })
    }
  }
}

/** Natural size of an image file, via an off-DOM <img>. */
export function readImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 })
    img.onerror = () => reject(new Error('The image could not be read.'))
    img.src = url
  })
}
