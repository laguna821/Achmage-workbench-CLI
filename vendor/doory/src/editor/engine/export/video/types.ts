/** The shapes the video pipeline passes around: the job it is given, the progress it reports, the file it returns. */
import type { DocPage, DoryDocument } from '@/types/document'
import type { encodeAudio } from '../../../audio/encoder'
import type { mixAudio } from '../../../audio/mixer'
import type { SourceLoader } from '../../../audio/sources'
import type { LoadContext } from '../../serialization'
import { sanitizeFilename } from '../registry'
import type { CodecApi } from './codecs'
import type { WorkerLike } from './gifSink'
import type { VideoOptions } from './options'
import type { Timeline } from './timeline'

/** Sample rate of the mix; Opus always runs at 48 kHz and AAC at 48 kHz is universal. */
export const AUDIO_RATE = 48_000

export interface VideoHost {
  loadContext: LoadContext
  /** Decodes the files of the audio tracks (the editor's loader reads a guest's `idb://` files too). */
  loadSound: SourceLoader
}

export interface VideoProgress {
  stage: 'sound' | 'frames' | 'finishing'
  /** 0..1 over the whole export. */
  fraction: number
  frame: number
  frames: number
  elapsedMs: number
  /** Time left, once enough frames are done to say. */
  etaMs: number | null
  /** Bytes of the file so far (a GIF only; a video's file is written at the end). */
  bytes: number | null
}

/** Something the person should know about the file they get. */
export type VideoWarning = 'video-fallback' | 'audio-fallback' | 'no-audio' | 'real-time'

export interface VideoResult {
  blob: Blob
  filename: string
  mime: string
  format: VideoOptions['format']
  durationMs: number
  width: number
  height: number
  fps: number
  /** Frames in the file (for a GIF: stored frames, after repeated ones were merged). */
  frames: number
  /** What the picture was made with: `H.264`, `VP9`, `GIF`. */
  video: string
  /** What the sound was made with, or `null` for a file without sound. */
  audio: string | null
  warnings: VideoWarning[]
  elapsedMs: number
}

/** The browser's encoders and the audio mix, replaceable in tests. */
export interface Deps {
  codecs: CodecApi
  mix: typeof mixAudio
  encodeSound: typeof encodeAudio
  now(): number
  /** How the GIF worker is made: `null` keeps the writer on the page's thread; absent uses the browser's own. */
  gifWorker: (() => WorkerLike) | null | undefined
}

export interface VideoJob {
  host: VideoHost
  document: DoryDocument
  /** The chosen pages in the order they play, with their place in the document. */
  pages: { page: DocPage; index: number }[]
  options: VideoOptions
  title: string
  signal: AbortSignal
  onProgress?(progress: VideoProgress): void
  deps?: Partial<Deps>
}

/** Everything about the video that follows from the options and the pages. */
export interface Prepared {
  timeline: Timeline
  frame: { width: number; height: number }
  frames: number
  hasSound: boolean
}

export const fileNameFor = (title: string, extension: string): string => `${sanitizeFilename(title) || 'design'}.${extension}`
