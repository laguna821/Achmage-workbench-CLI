/** A WAVE file writer: 16-bit PCM, or 32-bit float when the exact samples matter. No DOM, so it runs in tests. */

export interface PcmLike {
  sampleRate: number
  numberOfChannels: number
  length: number
  getChannelData(channel: number): Float32Array
}

export type WavSampleFormat = 'pcm16' | 'float32'

/** Largest WAVE file the 32-bit size fields can describe. */
const MAX_WAV_BYTES = 0xffffffff - 8

export function wavByteLength(buffer: Pick<PcmLike, 'length' | 'numberOfChannels'>, format: WavSampleFormat = 'pcm16'): number {
  return 44 + buffer.length * buffer.numberOfChannels * (format === 'pcm16' ? 2 : 4)
}

/** The bytes of `buffer` as a WAVE file. Samples are clipped to [-1, 1] for 16-bit PCM and dithered by rounding only. */
export function encodeWav(buffer: PcmLike, format: WavSampleFormat = 'pcm16'): Uint8Array<ArrayBuffer> {
  const channels = buffer.numberOfChannels
  const frames = buffer.length
  const bytesPerSample = format === 'pcm16' ? 2 : 4
  const total = wavByteLength(buffer, format)
  if (total > MAX_WAV_BYTES) throw new RangeError('The audio is too long for a WAVE file.')
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  const text = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  const dataBytes = frames * channels * bytesPerSample
  text(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, format === 'pcm16' ? 1 : 3, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bytesPerSample * 8, true)
  text(36, 'data')
  view.setUint32(40, dataBytes, true)
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c))
  let offset = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = data[c][i]
      if (format === 'pcm16') {
        const clipped = sample > 1 ? 1 : sample < -1 ? -1 : sample
        view.setInt16(offset, Math.round(clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff), true)
      } else {
        view.setFloat32(offset, sample, true)
      }
      offset += bytesPerSample
    }
  }
  return out
}
