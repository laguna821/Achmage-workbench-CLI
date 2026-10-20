/**
 * What this browser can encode, and the plan that follows from it: which video codec and which audio codec go into the
 * chosen container, or that the browser can only record in real time (`MediaRecorder`), or not at all.
 *
 * Browsers differ a great deal here, and a headless or open-source build can lack the codec that "MP4" means. So the
 * plan is never assumed: every candidate is asked (`VideoEncoder.isConfigSupported`) with the real frame size and rate,
 * in order of preference, and the first that works is used. The browser is reached through `CodecApi`, so the choice is
 * unit-tested with fakes.
 */
import { canEncode } from '../../../audio/encoder'
import { type VideoFamily, videoBitrate } from './estimate'
import type { Size } from './geometry'
import type { VideoFormat, VideoQuality } from './options'

/** The WebCodecs / MediaRecorder surface the plan depends on. */
export interface CodecApi {
  hasVideoEncoder(): boolean
  /** Whether the browser can encode with this configuration. */
  videoSupported(config: VideoEncoderConfig): Promise<boolean>
  audioCodec(format: 'aac' | 'opus'): Promise<boolean>
  /** Whether `MediaRecorder` records this media type. */
  recorderType(mime: string): boolean
  hasRecorder(): boolean
}

export const browserCodecs: CodecApi = {
  hasVideoEncoder: () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined',
  async videoSupported(config) {
    try {
      return (await VideoEncoder.isConfigSupported(config)).supported === true
    } catch {
      return false
    }
  },
  audioCodec: (format) => canEncode(format),
  recorderType: (mime) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime),
  hasRecorder: () => typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype,
}

/* ------------------------------------------------------------------------------------------------
 * Codec strings: the level a frame size and rate need
 * ---------------------------------------------------------------------------------------------- */

/** H.264 levels: the largest frame (macroblocks) and macroblocks per second each allows. */
const AVC_LEVELS: readonly { hex: string; mbPerSecond: number; frameMbs: number }[] = [
  { hex: '1e', mbPerSecond: 40_500, frameMbs: 1620 },
  { hex: '1f', mbPerSecond: 108_000, frameMbs: 3600 },
  { hex: '20', mbPerSecond: 216_000, frameMbs: 5120 },
  { hex: '28', mbPerSecond: 245_760, frameMbs: 8192 },
  { hex: '2a', mbPerSecond: 522_240, frameMbs: 8704 },
  { hex: '32', mbPerSecond: 589_824, frameMbs: 22_080 },
  { hex: '33', mbPerSecond: 983_040, frameMbs: 36_864 },
  { hex: '34', mbPerSecond: 2_073_600, frameMbs: 36_864 },
]

/** VP9 levels: the largest picture and luma samples per second. */
const VP9_LEVELS: readonly { code: string; pictureSize: number; sampleRate: number }[] = [
  { code: '10', pictureSize: 36_864, sampleRate: 829_440 },
  { code: '11', pictureSize: 73_728, sampleRate: 2_764_800 },
  { code: '20', pictureSize: 122_880, sampleRate: 4_608_000 },
  { code: '21', pictureSize: 245_760, sampleRate: 9_216_000 },
  { code: '30', pictureSize: 552_960, sampleRate: 20_736_000 },
  { code: '31', pictureSize: 983_040, sampleRate: 36_864_000 },
  { code: '40', pictureSize: 2_228_224, sampleRate: 83_558_400 },
  { code: '41', pictureSize: 2_228_224, sampleRate: 160_432_128 },
  { code: '50', pictureSize: 8_912_896, sampleRate: 311_951_360 },
  { code: '51', pictureSize: 8_912_896, sampleRate: 588_251_136 },
  { code: '52', pictureSize: 8_912_896, sampleRate: 1_176_502_272 },
  { code: '60', pictureSize: 35_651_584, sampleRate: 1_069_547_520 },
]

/** AV1 levels (`seq_level_idx`): the largest picture and display rate. */
const AV1_LEVELS: readonly { index: number; pictureSize: number; displayRate: number }[] = [
  { index: 0, pictureSize: 147_456, displayRate: 4_423_680 },
  { index: 1, pictureSize: 278_784, displayRate: 8_363_520 },
  { index: 4, pictureSize: 665_856, displayRate: 19_975_680 },
  { index: 5, pictureSize: 1_065_024, displayRate: 31_950_720 },
  { index: 8, pictureSize: 2_359_296, displayRate: 70_778_880 },
  { index: 9, pictureSize: 2_359_296, displayRate: 141_557_760 },
  { index: 12, pictureSize: 8_912_896, displayRate: 267_386_880 },
  { index: 13, pictureSize: 8_912_896, displayRate: 534_773_760 },
  { index: 14, pictureSize: 8_912_896, displayRate: 1_069_547_520 },
  { index: 15, pictureSize: 35_651_584, displayRate: 1_069_547_520 },
]

/** The first entry of a table that holds the frame, or the last (the largest) when none does. */
function firstFitting<T>(table: readonly T[], fits: (entry: T) => boolean): T {
  return table.find(fits) ?? table[table.length - 1]
}

/** `avc1.PPCCLL` for a profile (`64` High, `4d` Main, `42` Baseline) and the lowest level the frame fits. */
export function avcCodec(profile: 'high' | 'main' | 'baseline', size: Size, fps: number): string {
  const mbs = Math.ceil(size.width / 16) * Math.ceil(size.height / 16)
  const level = firstFitting(AVC_LEVELS, (l) => mbs <= l.frameMbs && mbs * fps <= l.mbPerSecond)
  const head = profile === 'high' ? '6400' : profile === 'main' ? '4d00' : '42e0'
  return `avc1.${head}${level.hex}`
}

/** `vp09.00.LL.08` (profile 0, 8 bit) for the lowest level the frame fits. */
export function vp9Codec(size: Size, fps: number): string {
  const pixels = size.width * size.height
  const level = firstFitting(VP9_LEVELS, (l) => pixels <= l.pictureSize && pixels * fps <= l.sampleRate)
  return `vp09.00.${level.code}.08`
}

/** `av01.0.LLM.08` (main profile, main tier, 8 bit) for the lowest level the frame fits. */
export function av1Codec(size: Size, fps: number): string {
  const pixels = size.width * size.height
  const level = firstFitting(AV1_LEVELS, (l) => pixels <= l.pictureSize && pixels * fps <= l.displayRate)
  return `av01.0.${String(level.index).padStart(2, '0')}M.08`
}

/* ------------------------------------------------------------------------------------------------
 * The plan
 * ---------------------------------------------------------------------------------------------- */

export interface VideoPlan {
  family: VideoFamily
  /** The WebCodecs codec string that was accepted. */
  codec: string
  config: VideoEncoderConfig
  /** What a person calls it. */
  label: string
}

export interface AudioPlan {
  format: 'aac' | 'opus'
  label: string
}

/** Why a plan carries a caveat the dialog should say out loud. */
export type PlanNote = 'video-fallback' | 'audio-fallback' | 'no-audio'

export type EncodingPlan =
  | { engine: 'webcodecs'; video: VideoPlan; audio: AudioPlan | null; notes: PlanNote[] }
  | { engine: 'recorder'; mime: string; notes: PlanNote[] }
  | { engine: 'none'; reason: 'no-encoder' | 'no-codec' }

const LABEL: Record<VideoFamily, string> = { avc: 'H.264', vp9: 'VP9', vp8: 'VP8', av1: 'AV1' }

interface Candidate {
  family: VideoFamily
  codec: string
}

/** The video codecs a container takes, best first. MP4 prefers what players everywhere open; the others are fallbacks. */
function candidates(format: 'mp4' | 'webm', size: Size, fps: number): Candidate[] {
  if (format === 'mp4') {
    return [
      { family: 'avc', codec: avcCodec('high', size, fps) },
      { family: 'avc', codec: avcCodec('main', size, fps) },
      { family: 'avc', codec: avcCodec('baseline', size, fps) },
      { family: 'vp9', codec: vp9Codec(size, fps) },
      { family: 'av1', codec: av1Codec(size, fps) },
    ]
  }
  return [
    { family: 'vp9', codec: vp9Codec(size, fps) },
    { family: 'vp8', codec: 'vp8' },
    { family: 'av1', codec: av1Codec(size, fps) },
  ]
}

/** The media types `MediaRecorder` may offer for each container, best first. */
const RECORDER_TYPES: Record<'mp4' | 'webm', readonly string[]> = {
  mp4: ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'],
  webm: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
}

export interface PlanInput {
  format: Exclude<VideoFormat, 'gif'>
  size: Size
  fps: number
  quality: VideoQuality
  /** The design has sound and the person wants it. */
  audio: boolean
}

/** The audio codec the container can take and this browser can encode: MP4 prefers AAC, then Opus; WebM takes Opus. */
export async function planAudio(format: 'mp4' | 'webm', api: CodecApi): Promise<AudioPlan | null> {
  if (format === 'mp4' && (await api.audioCodec('aac'))) return { format: 'aac', label: 'AAC' }
  if (await api.audioCodec('opus')) return { format: 'opus', label: 'Opus' }
  return null
}

/**
 * Decides how the file is made: with WebCodecs when the browser has a video encoder for the container (the first
 * candidate it accepts), by recording in real time when it has only `MediaRecorder`, otherwise not at all. A candidate
 * after the first of its container is a fallback and the plan says so (`video-fallback`), as it does for audio.
 */
export async function planEncoding(input: PlanInput, api: CodecApi = browserCodecs): Promise<EncodingPlan> {
  if (api.hasVideoEncoder()) {
    const list = candidates(input.format, input.size, input.fps)
    for (const candidate of list) {
      const config: VideoEncoderConfig = {
        codec: candidate.codec,
        width: input.size.width,
        height: input.size.height,
        bitrate: videoBitrate(candidate.family, input.size, input.fps, input.quality),
        framerate: input.fps,
        latencyMode: 'quality',
        bitrateMode: 'variable',
        ...(candidate.family === 'avc' ? { avc: { format: 'avc' as const } } : {}),
      }
      if (!(await api.videoSupported(config))) continue
      const notes: PlanNote[] = []
      // Anything but the container's first choice is a fallback, except the other H.264 profiles (same codec).
      if (candidate.family !== list[0].family) notes.push('video-fallback')
      const audio = input.audio ? await planAudio(input.format, api) : null
      if (input.audio && !audio) notes.push('no-audio')
      else if (audio && input.format === 'mp4' && audio.format !== 'aac') notes.push('audio-fallback')
      return { engine: 'webcodecs', video: { family: candidate.family, codec: candidate.codec, config, label: LABEL[candidate.family] }, audio, notes }
    }
  }
  if (api.hasRecorder()) {
    const mime = RECORDER_TYPES[input.format].find((type) => api.recorderType(type))
    if (mime) return { engine: 'recorder', mime, notes: [] }
  }
  return { engine: 'none', reason: api.hasVideoEncoder() ? 'no-codec' : 'no-encoder' }
}

/* ------------------------------------------------------------------------------------------------
 * The capability table
 * ---------------------------------------------------------------------------------------------- */

export interface FormatSupport {
  engine: 'webcodecs' | 'recorder' | null
  video: string | null
  audio: string | null
  notes: PlanNote[]
}

export interface Capabilities {
  webCodecs: boolean
  recorder: boolean
  mp4: FormatSupport
  webm: FormatSupport
}

async function supportOf(format: 'mp4' | 'webm', size: Size, fps: number, api: CodecApi): Promise<FormatSupport> {
  const plan = await planEncoding({ format, size, fps, quality: 'balanced', audio: true }, api)
  if (plan.engine === 'webcodecs') return { engine: 'webcodecs', video: plan.video.label, audio: plan.audio?.label ?? null, notes: plan.notes }
  if (plan.engine === 'recorder') return { engine: 'recorder', video: plan.mime.split(';')[0], audio: null, notes: plan.notes }
  return { engine: null, video: null, audio: null, notes: [] }
}

/** What this browser makes of each container at 1080p30: the answer behind the dialog's format cards. */
export async function detectCapabilities(api: CodecApi = browserCodecs): Promise<Capabilities> {
  const size = { width: 1920, height: 1080 }
  const [mp4, webm] = await Promise.all([supportOf('mp4', size, 30, api), supportOf('webm', size, 30, api)])
  return { webCodecs: api.hasVideoEncoder(), recorder: api.hasRecorder(), mp4, webm }
}
