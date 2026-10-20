/**
 * Numbers the dialog shows before anything is made: how long the file is, how large it will be (a heuristic, said to
 * be one), and how much longer an export that has started will take. Also the bitrates the encoders are given.
 */
import type { DocPage } from '@/types/document'
import type { Size } from './geometry'
import { FORMAT_RULES, type VideoOptions, type VideoQuality } from './options'
import { frameCount } from './schedule'
import type { Segment, Timeline } from './timeline'

export type VideoFamily = 'avc' | 'vp9' | 'vp8' | 'av1'

/** Bits per pixel of a frame at 30 fps for each quality, for H.264; the other codecs scale it. */
const BITS_PER_PIXEL: Record<VideoQuality, number> = { small: 0.045, balanced: 0.08, high: 0.14 }
/** How much a codec needs relative to H.264 for the same look. */
const FAMILY_FACTOR: Record<VideoFamily, number> = { avc: 1, vp9: 0.75, vp8: 1.15, av1: 0.6 }

export const AUDIO_BITRATE = { aac: 128_000, opus: 96_000 } as const

const MIN_BITRATE = 200_000
const MAX_BITRATE = 60_000_000

/** Bits per second given to the video encoder. A higher frame rate needs more, but not twice as much per second. */
export function videoBitrate(family: VideoFamily, size: Size, fps: number, quality: VideoQuality): number {
  const perSecond = size.width * size.height * BITS_PER_PIXEL[quality] * 30 * (fps / 30) ** 0.8
  return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, perSecond * FAMILY_FACTOR[family])))
}

/**
 * What an encoder really produces depends far more on the picture than on the bitrate it is given. Measured in
 * Chromium 141 (VP9, software), a deck of flat artwork came out at 40 to 75 per cent of what a "balanced" target
 * asks for at 30 fps (and hardly changed with the quality setting), a photograph with grain at 100 to 190 per cent
 * (the rate control spends what it is given and overshoots), and a deck without any motion at a tenth of the moving
 * one. So the estimate looks at each page: what kind of picture it is, and how much of its time anything moves.
 */
export type ContentClass = 'flat' | 'gradient' | 'photo'

/** `photo` when the page shows a picture (a background or an uploaded image, not a QR code or a graphic), `gradient` for a gradient background, else `flat`. */
export function contentClass(page: Pick<DocPage, 'background' | 'objects'>): ContentClass {
  if (page.background.type === 'image') return 'photo'
  const pictured = page.objects.some((o) => o.type === 'image' && o.isPlaceholder !== true && o.qr === undefined && !(typeof o.src === 'string' && /\.svg(\?|#|$)/i.test(o.src)))
  if (pictured) return 'photo'
  return page.background.type === 'gradient' ? 'gradient' : 'flat'
}

/** Bits per second of flat artwork that moves all the time: `FLAT_BPS * pixels^0.69 * (fps / 30)^0.6`, fitted to measured exports. */
const FLAT_BPS = 43.6
const STILL_SHARE = 0.1
const QUALITY_FACTOR: Record<VideoQuality, number> = { small: 0.85, balanced: 1, high: 1.1 }

function flatRate(size: Size, fps: number, quality: VideoQuality): number {
  return FLAT_BPS * (size.width * size.height) ** 0.69 * (fps / 30) ** 0.6 * QUALITY_FACTOR[quality]
}

/** Bits per second of moving picture of this kind. */
function movingRate(kind: ContentClass, family: VideoFamily, size: Size, fps: number, quality: VideoQuality): number {
  const target = videoBitrate(family, size, fps, quality)
  if (kind === 'photo') return target * 1.5
  const flat = flatRate(size, fps, quality) * (family === 'vp9' ? 1 : family === 'av1' ? 0.85 : 1.15)
  return kind === 'gradient' ? Math.min(target, flat * 2.5) : flat
}

/** Frames of one segment in which something changes from one frame to the next (the rest repeat the one before). */
function segmentMovingFrames(s: Segment, fps: number): number {
  const moving = s.transitionMs + Math.min(s.bodyMs, s.settledMs)
  return Math.min(Math.ceil((s.durationMs * fps) / 1000), Math.ceil((moving * fps) / 1000) + (Number.isFinite(s.settledMs) ? 1 : 0))
}

/** Frames of the timeline in which something changes from one frame to the next (the rest are repeats). */
export function movingFrames(timeline: Timeline, fps: number): number {
  return Math.min(
    timeline.segments.reduce((sum, s) => sum + segmentMovingFrames(s, fps), 0),
    frameCount(timeline.totalMs, fps),
  )
}

export interface Estimate {
  durationMs: number
  frames: number
  /** Bytes of the file, roughly. */
  bytes: number
  /** The video is longer than the format's limit. */
  tooLong: boolean
  /** The estimated GIF is larger than `GIF_WARN_BYTES`. */
  large: boolean
}

/** A GIF above this is slow to open and too big for most places that take one. */
export const GIF_WARN_BYTES = 25 * 1024 * 1024

/** Bytes of one stored GIF frame of flat artwork: `9 * pixels^0.55`, fitted to measured exports, a tenth less without dithering. */
const GIF_FRAME_BYTES = 9
const GIF_CLASS_FACTOR: Record<ContentClass, number> = { flat: 1, gradient: 3, photo: 12 }
/** A page that has stopped moving is stored once, and is mostly flat colour and text. */
const GIF_STILL_FRAME = 0.35

export function estimateOutput(timeline: Timeline, options: VideoOptions, frame: Size, withAudio: boolean): Estimate {
  const durationMs = timeline.totalMs
  const frames = frameCount(durationMs, options.fps)
  const pixels = frame.width * frame.height
  let bytes = 0
  for (const s of timeline.segments) {
    const kind = contentClass(s.page)
    if (options.format === 'gif') {
      const moving = Math.max(0, segmentMovingFrames(s, options.fps) - (Number.isFinite(s.settledMs) ? 1 : 0))
      const still = Number.isFinite(s.settledMs) || s.bodyMs > s.settledMs ? GIF_STILL_FRAME : 0
      bytes += (moving + still) * GIF_FRAME_BYTES * pixels ** 0.55 * GIF_CLASS_FACTOR[kind] * (options.dither ? 1 : 0.9)
    } else {
      const total = Math.max(1, Math.ceil((s.durationMs * options.fps) / 1000))
      const share = segmentMovingFrames(s, options.fps) / total
      const rate = movingRate(kind, options.format === 'mp4' ? 'avc' : 'vp9', frame, options.fps, options.quality)
      bytes += ((rate * (STILL_SHARE + (1 - STILL_SHARE) * share)) / 8) * (s.durationMs / 1000)
    }
  }
  if (options.format !== 'gif' && withAudio) bytes += (AUDIO_BITRATE[options.format === 'mp4' ? 'aac' : 'opus'] / 8) * (durationMs / 1000)
  bytes = Math.round(bytes)
  return { durationMs, frames, bytes, tooLong: durationMs > FORMAT_RULES[options.format].maxMs, large: options.format === 'gif' && bytes > GIF_WARN_BYTES }
}

/** `12 MB`, `850 KB`: a size for a label, rounded to what a person can use. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const mb = bytes / (1024 * 1024)
  return mb < 10 ? `${(Math.round(mb * 10) / 10).toString()} MB` : `${Math.round(mb)} MB`
}

/** `0:07`, `1:05`: a length for a label. */
export function formatLength(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Time left of an export, from how long the frames done so far took. Early frames are not typical (the first one pays
 * for fonts and pictures), so the rate is smoothed over the run and nothing is promised before a few frames are done.
 */
export function etaMs(framesDone: number, framesTotal: number, elapsedMs: number): number | null {
  if (framesDone < 3 || elapsedMs <= 0 || framesTotal <= framesDone) return framesTotal <= framesDone && framesDone > 0 ? 0 : null
  return Math.round(((framesTotal - framesDone) * elapsedMs) / framesDone)
}
