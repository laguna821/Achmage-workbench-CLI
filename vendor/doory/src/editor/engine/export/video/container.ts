/**
 * The file around the encoded pictures and sound: MP4 (`mp4-muxer`) and WebM (`webm-muxer`), both MIT and both loaded
 * only when a file is made. The encoders hand their output to a `Container` as plain bytes, so the rest of the pipeline
 * does not know which of the two it is writing, and the tests can feed it chunks made without a browser.
 *
 * The muxers keep the compressed file in memory until `finish`, which is the one thing that grows during an export (a
 * frame is encoded and closed at once). MP4 is written "fast start" (the index first), so it plays while it downloads.
 */
import type { VideoFamily } from './estimate'

export interface VideoChunkData {
  data: Uint8Array
  key: boolean
  timestampUs: number
  durationUs: number
}

export interface AudioChunkData {
  data: Uint8Array
  timestampUs: number
  durationUs: number
}

export interface AudioTrackSetup {
  codec: 'aac' | 'opus'
  sampleRate: number
  numberOfChannels: number
  /** AAC: the AudioSpecificConfig. Opus: the identification header, made when the encoder does not supply one. */
  description?: Uint8Array
}

export interface ContainerSetup {
  kind: 'mp4' | 'webm'
  family: VideoFamily
  width: number
  height: number
  fps: number
  audio: AudioTrackSetup | null
}

export interface Container {
  readonly mime: string
  addVideo(chunk: VideoChunkData, meta?: EncodedVideoChunkMetadata): void
  addAudio(chunk: AudioChunkData): void
  /** Ends the file and returns it. */
  finish(): Blob
}

/**
 * The Opus identification header ("OpusHead", RFC 7845) for a stream made by `AudioEncoder`: version 1, the channel
 * count, the usual 312-sample pre-skip of libopus at 48 kHz, the original rate, no gain, channel mapping family 0.
 */
export function opusHead(channels: number, inputRate = 48_000): Uint8Array {
  const head = new Uint8Array(19)
  const view = new DataView(head.buffer)
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64])
  head[8] = 1
  head[9] = channels
  view.setUint16(10, 312, true)
  view.setUint32(12, inputRate, true)
  view.setUint16(16, 0, true)
  head[18] = 0
  return head
}

const audioMeta = (setup: AudioTrackSetup): EncodedAudioChunkMetadata => ({
  decoderConfig: {
    codec: setup.codec === 'aac' ? 'mp4a.40.2' : 'opus',
    sampleRate: setup.sampleRate,
    numberOfChannels: setup.numberOfChannels,
    ...(setup.description ? { description: setup.description as Uint8Array<ArrayBuffer> } : {}),
  },
})

async function mp4(setup: ContainerSetup): Promise<Container> {
  const { ArrayBufferTarget, Muxer } = await import('mp4-muxer')
  const target = new ArrayBufferTarget()
  const codec = setup.family === 'avc' ? 'avc' : setup.family === 'av1' ? 'av1' : 'vp9'
  if (setup.family === 'vp8') throw new Error('MP4 cannot hold VP8 video.')
  const muxer = new Muxer({
    target,
    video: { codec, width: setup.width, height: setup.height, frameRate: setup.fps },
    ...(setup.audio ? { audio: { codec: setup.audio.codec, numberOfChannels: setup.audio.numberOfChannels, sampleRate: setup.audio.sampleRate } } : {}),
    fastStart: 'in-memory',
  })
  let firstAudio = true
  return {
    mime: 'video/mp4',
    addVideo: (chunk, meta) => muxer.addVideoChunkRaw(chunk.data, chunk.key ? 'key' : 'delta', chunk.timestampUs, chunk.durationUs, meta),
    addAudio: (chunk) => {
      if (!setup.audio) return
      muxer.addAudioChunkRaw(chunk.data, 'key', chunk.timestampUs, chunk.durationUs, firstAudio ? audioMeta(setup.audio) : undefined)
      firstAudio = false
    },
    finish: () => {
      muxer.finalize()
      return new Blob([target.buffer], { type: 'video/mp4' })
    },
  }
}

const WEBM_CODEC: Record<VideoFamily, string> = { avc: 'V_MPEG4/ISO/AVC', vp9: 'V_VP9', vp8: 'V_VP8', av1: 'V_AV1' }

async function webm(setup: ContainerSetup): Promise<Container> {
  const { ArrayBufferTarget, Muxer } = await import('webm-muxer')
  const target = new ArrayBufferTarget()
  if (setup.family === 'avc') throw new Error('WebM cannot hold H.264 video.')
  if (setup.audio && setup.audio.codec !== 'opus') throw new Error('WebM holds Opus sound only.')
  const muxer = new Muxer({
    target,
    video: { codec: WEBM_CODEC[setup.family], width: setup.width, height: setup.height, frameRate: setup.fps },
    ...(setup.audio ? { audio: { codec: 'A_OPUS', numberOfChannels: setup.audio.numberOfChannels, sampleRate: setup.audio.sampleRate } } : {}),
  })
  let firstAudio = true
  return {
    mime: 'video/webm',
    addVideo: (chunk, meta) => muxer.addVideoChunkRaw(chunk.data, chunk.key ? 'key' : 'delta', chunk.timestampUs, meta),
    addAudio: (chunk) => {
      if (!setup.audio) return
      const description = setup.audio.description ?? opusHead(setup.audio.numberOfChannels, setup.audio.sampleRate)
      muxer.addAudioChunkRaw(chunk.data, 'key', chunk.timestampUs, firstAudio ? audioMeta({ ...setup.audio, description }) : undefined)
      firstAudio = false
    },
    finish: () => {
      muxer.finalize()
      return new Blob([target.buffer], { type: 'video/webm' })
    },
  }
}

/** Opens a container for the chosen codecs. Loads the muxer of the kind on first use. */
export function createContainer(setup: ContainerSetup): Promise<Container> {
  return setup.kind === 'mp4' ? mp4(setup) : webm(setup)
}
