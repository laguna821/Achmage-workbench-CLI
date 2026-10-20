/**
 * Encoding a mix for a video file: `encodeAudio(buffer, 'aac' | 'opus' | 'wav')`.
 *
 * AAC and Opus use WebCodecs' `AudioEncoder` and come back as encoded frames plus the decoder configuration a muxer
 * needs (an MP4 muxer takes the AAC frames and their `description`, a WebM or Ogg muxer the Opus frames). Where the browser
 * has no encoder for the format (open-source Chromium builds have no AAC, Firefox before 130 has no AudioEncoder at all)
 * the result is a WAVE file instead and says so in `format`; the caller decides whether that is acceptable. Opus is
 * always encoded at 48 kHz, so a buffer at another rate is resampled first.
 */
import { type PcmLike, encodeWav } from './wav'

export type AudioFormat = 'aac' | 'opus' | 'wav'

export interface EncodedChunk {
  data: Uint8Array
  /** Start of the frame in microseconds from the start of the audio. */
  timestampUs: number
  durationUs: number
}

export interface EncodedAudio {
  /** The format asked for. */
  requested: AudioFormat
  /** The format delivered: `wav` when the browser cannot encode the one asked for. */
  format: AudioFormat
  /** Media type of the data: `audio/wav`, or the codec string a muxer needs (`mp4a.40.2`, `opus`). */
  mime: string
  /** The codec string of WebCodecs (`mp4a.40.2`, `opus`); absent for WAVE. */
  codec?: string
  sampleRate: number
  numberOfChannels: number
  durationMs: number
  /** AAC: the AudioSpecificConfig a decoder (and an MP4 `esds` box) needs. */
  description?: Uint8Array
  /** The encoded frames in order. For `wav`, one chunk holding the whole file. */
  chunks: EncodedChunk[]
}

export interface EncodeOptions {
  /** Bits per second; defaults to 128 000 for AAC and 96 000 for Opus. */
  bitrate?: number
  signal?: AbortSignal
  onProgress?(fraction: number): void
}

const CODECS = { aac: 'mp4a.40.2', opus: 'opus' } as const
const BITRATES = { aac: 128_000, opus: 96_000 } as const
/** Frames handed to the encoder at a time (one second at 48 kHz). */
const SLICE = 48_000

/** A copy of the bytes of an ArrayBuffer or a view on one. */
function bytesOf(source: AllowSharedBufferSource): Uint8Array {
  const view = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source)
  return view.slice()
}

const durationOf = (buffer: PcmLike): number => Math.round((buffer.length / buffer.sampleRate) * 1000)

function wavResult(buffer: PcmLike, requested: AudioFormat): EncodedAudio {
  const file = encodeWav(buffer)
  const durationMs = durationOf(buffer)
  return {
    requested,
    format: 'wav',
    mime: 'audio/wav',
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    durationMs,
    chunks: [{ data: file, timestampUs: 0, durationUs: durationMs * 1000 }],
  }
}

async function resampled(buffer: AudioBuffer, rate: number): Promise<AudioBuffer> {
  if (buffer.sampleRate === rate) return buffer
  const context = new OfflineAudioContext(buffer.numberOfChannels, Math.max(1, Math.ceil((buffer.length * rate) / buffer.sampleRate)), rate)
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  source.start()
  return context.startRendering()
}

/** Whether this browser can encode `format` (WAVE always). */
export async function canEncode(format: AudioFormat, sampleRate = 48000, channels = 2): Promise<boolean> {
  if (format === 'wav') return true
  if (typeof AudioEncoder === 'undefined') return false
  try {
    const support = await AudioEncoder.isConfigSupported({ codec: CODECS[format], sampleRate, numberOfChannels: channels, bitrate: BITRATES[format] })
    return support.supported === true
  } catch {
    return false
  }
}

/**
 * Encodes `buffer`. Never rejects because a format is unavailable (see the module comment); it rejects with an
 * `AbortError` when aborted and with the encoder's own error when encoding itself fails.
 */
export async function encodeAudio(buffer: AudioBuffer, format: AudioFormat, options: EncodeOptions = {}): Promise<EncodedAudio> {
  if (format === 'wav') return wavResult(buffer, format)
  const source = format === 'opus' ? await resampled(buffer, 48000) : buffer
  const bitrate = options.bitrate ?? BITRATES[format]
  const config: AudioEncoderConfig = { codec: CODECS[format], sampleRate: source.sampleRate, numberOfChannels: Math.min(2, source.numberOfChannels), bitrate }
  if (format === 'aac') (config as AudioEncoderConfig & { aac?: { format: 'aac' } }).aac = { format: 'aac' }
  if (typeof AudioEncoder === 'undefined' || !(await canEncodeConfig(config))) return wavResult(buffer, format)

  const chunks: EncodedChunk[] = []
  let description: Uint8Array | undefined
  let failure: unknown = null
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      chunks.push({ data, timestampUs: chunk.timestamp, durationUs: chunk.duration ?? 0 })
      const d = metadata?.decoderConfig?.description
      if (d && !description) description = bytesOf(d)
    },
    error: (error) => {
      failure = error
    },
  })
  encoder.configure(config)
  const channels = config.numberOfChannels
  for (let start = 0; start < source.length; start += SLICE) {
    if (options.signal?.aborted) {
      encoder.close()
      throw new DOMException('Aborted', 'AbortError')
    }
    if (failure) break
    const frames = Math.min(SLICE, source.length - start)
    const planar = new Float32Array(frames * channels)
    for (let c = 0; c < channels; c++) planar.set(source.getChannelData(Math.min(c, source.numberOfChannels - 1)).subarray(start, start + frames), c * frames)
    const data = new AudioData({ format: 'f32-planar', sampleRate: source.sampleRate, numberOfFrames: frames, numberOfChannels: channels, timestamp: Math.round((start / source.sampleRate) * 1e6), data: planar })
    encoder.encode(data)
    data.close()
    options.onProgress?.(Math.min(0.95, (start + frames) / source.length))
    // Let the encoder's queue drain so a long mix does not hold the whole file in memory twice.
    if (encoder.encodeQueueSize > 8) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  await encoder.flush()
  encoder.close()
  if (failure) throw failure instanceof Error ? failure : new Error('The audio could not be encoded.')
  options.onProgress?.(1)
  return {
    requested: format,
    format,
    mime: format === 'aac' ? 'audio/mp4; codecs="mp4a.40.2"' : 'audio/ogg; codecs=opus',
    codec: CODECS[format],
    sampleRate: source.sampleRate,
    numberOfChannels: channels,
    durationMs: durationOf(source),
    description,
    chunks,
  }
}

async function canEncodeConfig(config: AudioEncoderConfig): Promise<boolean> {
  try {
    return (await AudioEncoder.isConfigSupported(config)).supported === true
  } catch {
    return false
  }
}

/** A WAVE file as a Blob, from a result with `format: 'wav'`. */
export function wavBlob(encoded: EncodedAudio): Blob {
  if (encoded.format !== 'wav') throw new TypeError('Only a WAVE result is a file; muxing other formats needs a container.')
  return new Blob([encoded.chunks[0].data as Uint8Array<ArrayBuffer>], { type: 'audio/wav' })
}
