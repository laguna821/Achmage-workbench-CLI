/**
 * Getting the sound of a track into memory: fetch (with the library's offline copy), decode, remember. The decoded
 * buffers are shared by the waveform, the preview, the presenter and the mixdown, so a file is decoded once however
 * many of them ask, at the same time or later. Memory is bounded: the least recently used buffers go first.
 */
import type { AudioTrack } from '@/types/document'
import { MAX_AUDIO_BYTES, MAX_SOURCE_MS } from './model'
import { fetchAudio, FetchError } from './cache'

/** Decoded buffers are 48 kHz whatever the file's rate; the browser resamples at decoding. */
export const DECODE_RATE = 48000
/** About 190 MB of decoded float samples are kept. */
export const MEMORY_BUDGET_BYTES = 190 * 1024 * 1024

export type LoadFailure = 'network' | 'missing' | 'decode' | 'unsupported' | 'too-long' | 'blocked'

/** A file that could not be fetched or decoded; `code` says why and `message` is fit for the person. */
export class AudioLoadError extends Error {
  constructor(
    readonly code: LoadFailure,
    message: string,
  ) {
    super(message)
    this.name = 'AudioLoadError'
  }
}

export type SourceLoader = (track: Pick<AudioTrack, 'id' | 'src' | 'name'>, signal?: AbortSignal) => Promise<AudioBuffer>

export interface SourceStoreOptions {
  /** `idb://…` and the like to a URL `fetch` understands; the default leaves the address as it is. */
  resolveSrc?(src: string): Promise<string>
  /** Decodes bytes; defaults to a shared `OfflineAudioContext` at 48 kHz. */
  decode?(bytes: ArrayBuffer): Promise<AudioBuffer>
  fetchBytes?(url: string, signal?: AbortSignal): Promise<ArrayBuffer>
  budgetBytes?: number
}

let decodingContext: BaseAudioContext | null = null

function defaultDecode(bytes: ArrayBuffer): Promise<AudioBuffer> {
  if (!decodingContext) {
    if (typeof OfflineAudioContext === 'function') decodingContext = new OfflineAudioContext(2, 1, DECODE_RATE)
    else if (typeof AudioContext === 'function') decodingContext = new AudioContext({ sampleRate: DECODE_RATE })
    else throw new AudioLoadError('unsupported', 'This browser cannot play or mix audio.')
  }
  return decodingContext.decodeAudioData(bytes)
}

/** Decodes the bytes of an audio file with the shared 48 kHz context. Rejects when the browser cannot read them. */
export function decodeBytes(bytes: ArrayBuffer): Promise<AudioBuffer> {
  return defaultDecode(bytes)
}

const sizeOf = (buffer: AudioBuffer): number => buffer.length * buffer.numberOfChannels * 4

export class SourceStore {
  private readonly buffers = new Map<string, AudioBuffer>()
  private readonly inflight = new Map<string, Promise<AudioBuffer>>()
  private bytes = 0

  constructor(private readonly options: SourceStoreOptions = {}) {}

  /** Replaces how addresses are resolved (guest to account migration swaps the adapter). */
  setResolver(resolveSrc: (src: string) => Promise<string>): void {
    this.options.resolveSrc = resolveSrc
    this.buffers.clear()
    this.bytes = 0
  }

  /** The buffer if it is already in memory. */
  peek(src: string): AudioBuffer | undefined {
    const buffer = this.buffers.get(src)
    if (buffer) {
      this.buffers.delete(src)
      this.buffers.set(src, buffer)
    }
    return buffer
  }

  load: SourceLoader = (track, signal) => this.loadSrc(track.src, track.name, signal)

  /** Fetches and decodes `src` once; later and simultaneous requests share the result. */
  loadSrc(src: string, name = '', signal?: AbortSignal): Promise<AudioBuffer> {
    const hit = this.peek(src)
    if (hit) return Promise.resolve(hit)
    let pending = this.inflight.get(src)
    if (!pending) {
      pending = this.fetchAndDecode(src, name).then((buffer) => {
        this.remember(src, buffer)
        return buffer
      })
      this.inflight.set(src, pending)
      const forget = (): void => void this.inflight.delete(src)
      pending.then(forget, forget)
    }
    return signal ? raceAbort(pending, signal) : pending
  }

  clear(): void {
    this.buffers.clear()
    this.bytes = 0
  }

  private remember(src: string, buffer: AudioBuffer): void {
    this.buffers.set(src, buffer)
    this.bytes += sizeOf(buffer)
    const budget = this.options.budgetBytes ?? MEMORY_BUDGET_BYTES
    for (const [key, old] of this.buffers) {
      if (this.bytes <= budget || key === src) break
      this.buffers.delete(key)
      this.bytes -= sizeOf(old)
    }
  }

  private async fetchAndDecode(src: string, name: string): Promise<AudioBuffer> {
    const label = name ? `“${name}”` : 'The audio file'
    let url: string
    try {
      url = this.options.resolveSrc ? await this.options.resolveSrc(src) : src
    } catch {
      throw new AudioLoadError('missing', `${label} is no longer stored in this browser.`)
    }
    if (url.startsWith('idb://')) throw new AudioLoadError('unsupported', `${label} is stored in this browser; open the design in the editor to use it.`)
    let bytes: ArrayBuffer
    try {
      bytes = await (this.options.fetchBytes ?? fetchAudio)(url)
    } catch (error) {
      if (error instanceof FetchError) {
        throw new AudioLoadError(error.status === 404 || error.status === 410 ? 'missing' : 'network', error.status === 404 ? `${label} is missing from the server.` : `${label} could not be loaded (${error.message}).`)
      }
      throw new AudioLoadError('network', `${label} could not be loaded. Check your connection.`)
    }
    if (bytes.byteLength > MAX_AUDIO_BYTES * 1.2) throw new AudioLoadError('too-long', `${label} is larger than ${Math.round(MAX_AUDIO_BYTES / 1048576)} MB.`)
    let buffer: AudioBuffer
    try {
      buffer = await (this.options.decode ?? defaultDecode)(bytes)
    } catch (error) {
      if (error instanceof AudioLoadError) throw error
      throw new AudioLoadError('decode', `${label} could not be decoded. This browser may not support its format.`)
    }
    if (buffer.duration * 1000 > MAX_SOURCE_MS) throw new AudioLoadError('too-long', `${label} is longer than ${MAX_SOURCE_MS / 60000} minutes.`)
    return buffer
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

const shared = new SourceStore()

/** A loader that fetches `https://` and same-site `/media/…` sources with the shared cache (no `idb://`). */
export const defaultSourceLoader: SourceLoader = shared.load
