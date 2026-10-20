/**
 * The state of the upload dialog and the way its files are sent. Each file goes in a request of its own, one after
 * another: the server stores a request's files as one all-or-nothing family, so a single bad file would otherwise
 * sink the good ones, and a request per file gives each row its own progress and its own error. Files of the same
 * family land in the same family on the server because they carry the same name.
 */
import type { FontFamily, UserFontUploadInput, UserFontUploadOptions } from '@/types/api'
import { type FontFileInfo, MAX_FONT_FILES } from './fontFile'
import { type UploadFailure, type UploadFailureKind, describeUploadFailure, isSystemicFailure } from './uploadFailure'

export type UploadStatus = 'reading' | 'ready' | 'uploading' | 'done' | 'error'

export interface UploadItem {
  id: string
  file: File
  status: UploadStatus
  /** Facts read from the file in the browser; `null` until read, or when only the server can tell (WOFF2). */
  info: FontFileInfo | null
  /** The CSS family the dialog draws this file's sample with (a face made from the file itself). */
  previewFamily: string | null
  /** Upload progress, 0..1. */
  progress: number
  /** Why the file is not going to be (or was not) uploaded. */
  message: string | null
  failure: UploadFailureKind | 'file' | null
  /** The family the server answered with. */
  result: FontFamily | null
}

export type UploadAction =
  | { type: 'add'; items: UploadItem[] }
  | { type: 'read'; id: string; info: FontFileInfo; previewFamily: string | null }
  | { type: 'reject'; id: string; message: string }
  | { type: 'remove'; id: string }
  | { type: 'start'; id: string }
  | { type: 'progress'; id: string; fraction: number }
  | { type: 'done'; id: string; family: FontFamily }
  | { type: 'fail'; id: string; failure: UploadFailure }
  | { type: 'retry' }

export function newItem(id: string, file: File): UploadItem {
  return { id, file, status: 'reading', info: null, previewFamily: null, progress: 0, message: null, failure: null, result: null }
}

function patch(items: readonly UploadItem[], id: string, change: Partial<UploadItem>): UploadItem[] {
  return items.map((item) => (item.id === id ? { ...item, ...change } : item))
}

export function uploadReducer(items: readonly UploadItem[], action: UploadAction): UploadItem[] {
  switch (action.type) {
    case 'add':
      return [...items, ...action.items].slice(0, MAX_FONT_FILES)
    case 'read':
      return patch(items, action.id, { status: 'ready', info: action.info, previewFamily: action.previewFamily })
    case 'reject':
      return patch(items, action.id, { status: 'error', message: action.message, failure: 'file' })
    case 'remove':
      return items.filter((item) => item.id !== action.id)
    case 'start':
      return patch(items, action.id, { status: 'uploading', progress: 0, message: null, failure: null })
    case 'progress':
      return patch(items, action.id, { progress: Math.min(1, Math.max(0, action.fraction)) })
    case 'done':
      return patch(items, action.id, { status: 'done', progress: 1, result: action.family, message: null, failure: null })
    case 'fail':
      return patch(items, action.id, { status: 'error', message: action.failure.message, failure: action.failure.kind })
    case 'retry':
      return items.map((item) => (item.status === 'error' && item.failure !== 'file' ? { ...item, status: 'ready', progress: 0, message: null, failure: null } : item))
  }
}

/** Files that will be sent when the user presses Upload: read and not yet stored. */
export function pendingItems(items: readonly UploadItem[]): UploadItem[] {
  return items.filter((item) => item.status === 'ready' || (item.status === 'error' && item.failure !== 'file'))
}

export function isBusy(items: readonly UploadItem[]): boolean {
  return items.some((item) => item.status === 'reading' || item.status === 'uploading')
}

/** The one family name all read files agree on, if they do. */
export function detectedFamily(items: readonly UploadItem[]): string {
  const names = new Set<string>()
  for (const item of items) if (item.status !== 'error' && item.info?.family) names.add(item.info.family)
  return names.size === 1 ? [...names][0] : ''
}

/** Distinct family names read from the files (more than one means the files are not variants of one family). */
export function detectedFamilies(items: readonly UploadItem[]): string[] {
  const names = new Set<string>()
  for (const item of items) if (item.status !== 'error' && item.info?.family) names.add(item.info.family)
  return [...names]
}

export interface UploadEvents {
  onStart(id: string): void
  onProgress(id: string, fraction: number): void
  onDone(id: string, family: FontFamily): void
  onFail(id: string, failure: UploadFailure): void
}

export type UploadFn = (input: UserFontUploadInput, options: UserFontUploadOptions) => Promise<FontFamily>

/**
 * Sends the files one by one. A failure that every file would meet (limits, signed out, offline) stops the run so the
 * remaining files stay untouched; returns `true` when the run was stopped that way or aborted.
 */
export async function uploadSequentially(
  items: readonly Pick<UploadItem, 'id' | 'file'>[],
  family: string,
  upload: UploadFn,
  events: UploadEvents,
  signal: AbortSignal,
): Promise<boolean> {
  for (const item of items) {
    if (signal.aborted) return true
    events.onStart(item.id)
    try {
      const result = await upload({ files: [item.file], family: family || undefined }, { signal, onProgress: (fraction) => events.onProgress(item.id, fraction) })
      events.onDone(item.id, result)
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return true
      const failure = describeUploadFailure(error, item.file.name)
      events.onFail(item.id, failure)
      if (isSystemicFailure(failure)) return true
    }
  }
  return false
}
