import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { FontFamily } from '@/types/api'
import { t } from '../strings'
import { FontFileError, MAX_FONT_BYTES, MAX_FONT_FILES, readFileBytes, readFontInfo } from './fontFile'
import { describeFileProblem } from './uploadFailure'
import {
  type UploadFn,
  type UploadItem,
  detectedFamilies,
  detectedFamily,
  isBusy,
  newItem,
  pendingItems,
  uploadReducer,
  uploadSequentially,
} from './uploadQueue'

const fileKey = (f: File): string => `${f.name}|${f.size}|${f.lastModified}`

let previewCounter = 0

/** Makes the file drawable in a dialog without uploading it: a face built from its own bytes (no network, no CSP rule involved). */
async function addPreviewFace(buffer: ArrayBuffer): Promise<{ family: string | null; face: FontFace | null }> {
  if (typeof FontFace === 'undefined' || !document.fonts) return { family: null, face: null }
  const family = `doory-preview-${++previewCounter}`
  const face = new FontFace(family, buffer)
  await face.load()
  document.fonts.add(face)
  return { family, face }
}

export interface FontUploads {
  items: UploadItem[]
  family: string
  setFamily(name: string): void
  running: boolean
  /** The run stopped because of a problem every file would meet; the remaining files were not sent. */
  stopped: boolean
  /** A hint about the last files that were dropped (too many, already in the list). */
  notice: string | null
  addFiles(files: File[]): void
  remove(item: UploadItem): void
  /** Sends the files that are ready, or that failed before. */
  send(): Promise<void>
  /** Stops a running upload (the file in flight is cancelled). */
  abort(): void
  busy: boolean
  pending: UploadItem[]
  uploaded: UploadItem[]
  failed: UploadItem[]
  /** Every file is stored. */
  allDone: boolean
  /** The families the server answered with. */
  results: FontFamily[]
  /** The one family name the files agree on, or ''. */
  detected: string
  /** Different family names read from the files. */
  differing: string[]
  /** The last run left failed files that can be sent again. */
  retrying: boolean
  /** The server said a built-in font has the family name. */
  nameTaken: boolean
}

/**
 * The state of an upload dialog, independent of how it looks: reads and previews the dropped files, keeps their
 * statuses, and sends them one by one through `upload`. Used by the editor's dialog and the dashboard's.
 */
export function useFontUploads(upload: UploadFn): FontUploads {
  const [items, dispatch] = useReducer(uploadReducer, [])
  const [family, setFamily] = useState('')
  const [running, setRunning] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const faces = useRef(new Map<string, FontFace>())
  const seen = useRef(new Set<string>())
  const counter = useRef(0)
  const uploadRef = useRef(upload)
  useEffect(() => {
    uploadRef.current = upload
  })

  useEffect(() => {
    const live = faces.current
    return () => {
      abortRef.current?.abort()
      for (const face of live.values()) document.fonts.delete(face)
      live.clear()
    }
  }, [])

  const read = useCallback(async (item: UploadItem): Promise<void> => {
    try {
      if (item.file.size > MAX_FONT_BYTES) throw new FontFileError('too-large')
      const buffer = await readFileBytes(item.file)
      const info = await readFontInfo(buffer)
      let preview: { family: string | null; face: FontFace | null }
      try {
        preview = await addPreviewFace(buffer)
      } catch {
        dispatch({ type: 'reject', id: item.id, message: t.userFonts.problems.undecodable })
        return
      }
      if (preview.face) faces.current.set(item.id, preview.face)
      dispatch({ type: 'read', id: item.id, info, previewFamily: preview.family })
    } catch (error) {
      dispatch({ type: 'reject', id: item.id, message: describeFileProblem(error instanceof FontFileError ? error.problem : 'corrupt') })
    }
  }, [])

  const addFiles = useCallback(
    (files: File[]): void => {
      if (files.length === 0) return
      const fresh = files.filter((f) => !seen.current.has(fileKey(f)))
      const room = Math.max(0, MAX_FONT_FILES - items.length)
      const taken = fresh.slice(0, room)
      setNotice(fresh.length < files.length ? t.userFonts.dialog.duplicate : fresh.length > room ? t.userFonts.dialog.tooMany(MAX_FONT_FILES) : null)
      if (taken.length === 0) return
      setStopped(false)
      const added = taken.map((file) => {
        seen.current.add(fileKey(file))
        counter.current += 1
        return newItem(`font-${counter.current}`, file)
      })
      dispatch({ type: 'add', items: added })
      for (const item of added) void read(item)
    },
    [items.length, read],
  )

  const remove = useCallback((item: UploadItem): void => {
    seen.current.delete(fileKey(item.file))
    const face = faces.current.get(item.id)
    if (face) document.fonts.delete(face)
    faces.current.delete(item.id)
    dispatch({ type: 'remove', id: item.id })
    setNotice(null)
  }, [])

  const pending = pendingItems(items)

  const send = async (): Promise<void> => {
    if (pending.length === 0 || running) return
    dispatch({ type: 'retry' })
    setStopped(false)
    setRunning(true)
    const controller = new AbortController()
    abortRef.current = controller
    const halted = await uploadSequentially(
      pending,
      family.trim(),
      (data, options) => uploadRef.current(data, options),
      {
        onStart: (id) => dispatch({ type: 'start', id }),
        onProgress: (id, fraction) => dispatch({ type: 'progress', id, fraction }),
        onDone: (id, result) => dispatch({ type: 'done', id, family: result }),
        onFail: (id, failure) => dispatch({ type: 'fail', id, failure }),
      },
      controller.signal,
    )
    abortRef.current = null
    setRunning(false)
    setStopped(halted && !controller.signal.aborted)
  }

  const uploaded = items.filter((i) => i.status === 'done')
  const failed = items.filter((i) => i.status === 'error')
  return {
    items,
    family,
    setFamily,
    running,
    stopped,
    notice,
    addFiles,
    remove,
    send,
    abort: () => abortRef.current?.abort(),
    busy: isBusy(items),
    pending,
    uploaded,
    failed,
    allDone: items.length > 0 && uploaded.length === items.length,
    results: uploaded.map((i) => i.result).filter((r): r is FontFamily => r !== null),
    detected: detectedFamily(items),
    differing: detectedFamilies(items),
    retrying: !running && failed.some((i) => i.failure !== 'file') && pending.every((i) => i.status === 'error'),
    nameTaken: items.some((i) => i.failure === 'name-taken'),
  }
}
