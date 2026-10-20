import { isApiError } from '@/lib/api'
import { formatBytes } from '@/lib/time'
import type { Asset } from '@/types/api'

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error'

export interface UploadItem {
  id: string
  name: string
  size: number
  status: UploadStatus
  /** 0..1 */
  progress: number
  error?: string
}

export type Uploader = (file: File, handlers: { signal: AbortSignal; onProgress(fraction: number): void }) => Promise<Asset>

export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml'] as const
export const ACCEPT_ATTRIBUTE = [...ACCEPTED_IMAGE_TYPES, '.svg'].join(',')

/** Client-side pre-check (the server re-validates by content). Returns a message, or null when fine. */
export function validateUpload(file: Pick<File, 'name' | 'type' | 'size'>, maxBytes: number): string | null {
  const isSvg = file.type === 'image/svg+xml' || (file.type === '' && /\.svg$/i.test(file.name))
  const allowed = isSvg || (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)
  if (!allowed) return 'Only PNG, JPG, WebP, GIF, AVIF and SVG images can be uploaded.'
  if (file.size === 0) return 'This file is empty.'
  if (file.size > maxBytes) return `This file is ${formatBytes(file.size)}. The limit is ${formatBytes(maxBytes)}.`
  return null
}

export interface UploadQueueOptions {
  uploader: Uploader
  maxBytes: number
  concurrency?: number
  onUploaded?: (asset: Asset) => void
}

/** Framework-free upload queue with bounded concurrency, per-file progress and retry. */
export class UploadQueue {
  private items: UploadItem[] = []
  private readonly files = new Map<string, File>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly listeners = new Set<() => void>()
  private running = 0
  private counter = 0

  constructor(private readonly options: UploadQueueOptions) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): UploadItem[] => this.items

  add(files: Iterable<File>): void {
    for (const file of files) {
      this.counter += 1
      const id = `upload-${this.counter}`
      const problem = validateUpload(file, this.options.maxBytes)
      this.items = [...this.items, { id, name: file.name, size: file.size, status: problem ? 'error' : 'queued', progress: 0, error: problem ?? undefined }]
      if (!problem) this.files.set(id, file)
    }
    this.emit()
    this.pump()
  }

  retry(id: string): void {
    const item = this.items.find((entry) => entry.id === id)
    if (!item || item.status !== 'error' || !this.files.has(id)) return
    this.patch(id, { status: 'queued', progress: 0, error: undefined })
    this.pump()
  }

  /** Cancels an in-flight upload or removes a finished/failed/queued entry. */
  remove(id: string): void {
    this.controllers.get(id)?.abort()
    this.files.delete(id)
    this.items = this.items.filter((entry) => entry.id !== id)
    this.emit()
  }

  /** Aborts every in-flight upload (e.g. when leaving the page). */
  dispose(): void {
    this.controllers.forEach((controller) => controller.abort())
  }

  clearFinished(): void {
    for (const item of this.items) if (item.status === 'done' || item.status === 'error') this.files.delete(item.id)
    this.items = this.items.filter((item) => item.status === 'queued' || item.status === 'uploading')
    this.emit()
  }

  private pump(): void {
    const concurrency = this.options.concurrency ?? 2
    while (this.running < concurrency) {
      const next = this.items.find((item) => item.status === 'queued')
      if (!next) return
      void this.start(next.id)
    }
  }

  private async start(id: string): Promise<void> {
    const file = this.files.get(id)
    if (!file) return
    this.running += 1
    const controller = new AbortController()
    this.controllers.set(id, controller)
    this.patch(id, { status: 'uploading', progress: 0 })
    try {
      const asset = await this.options.uploader(file, { signal: controller.signal, onProgress: (fraction) => this.patch(id, { progress: Math.min(1, Math.max(0, fraction)) }) })
      this.patch(id, { status: 'done', progress: 1 })
      this.options.onUploaded?.(asset)
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.patch(id, { status: 'error', error: isApiError(error) ? (error.isNetwork ? 'The connection dropped. Try again.' : error.message) : 'The upload failed.' })
      }
    } finally {
      this.controllers.delete(id)
      this.running -= 1
      this.pump()
    }
  }

  private patch(id: string, change: Partial<UploadItem>): void {
    if (!this.items.some((item) => item.id === id)) return
    this.items = this.items.map((item) => (item.id === id ? { ...item, ...change } : item))
    this.emit()
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener())
  }
}
