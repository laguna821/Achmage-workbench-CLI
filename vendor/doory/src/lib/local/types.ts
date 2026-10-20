import type { DoryDocument } from '@/types/document'

/** A guest design kept in this browser (IndexedDB `designs` store). */
export interface LocalDesign {
  id: string
  title: string
  document: DoryDocument
  thumbnail?: Blob
  createdAt: number
  updatedAt: number
}

/** Lightweight listing entry (no document body). */
export interface LocalDesignSummary {
  id: string
  title: string
  thumbnail?: Blob
  width: number
  height: number
  pageCount: number
  createdAt: number
  updatedAt: number
}

/** A guest upload kept in this browser (IndexedDB `assets` store). */
export interface LocalAsset {
  id: string
  blob: Blob
  name: string
  mime: string
  width: number
  height: number
  createdAt: number
}

export interface StorageUsage {
  /** Bytes used by this origin, when the browser can tell. */
  usage: number | null
  quota: number | null
  /** Bytes held by guest uploads (always known). */
  assetBytes: number
}

export type StorageMode = 'indexeddb' | 'memory'

export class LocalStorageFullError extends Error {
  constructor(message = 'Your browser has no space left for Doory designs.') {
    super(message)
    this.name = 'LocalStorageFullError'
  }
}

export class LocalStorageError extends Error {
  constructor(message = 'Doory could not write to this browser’s storage.', options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LocalStorageError'
  }
}
