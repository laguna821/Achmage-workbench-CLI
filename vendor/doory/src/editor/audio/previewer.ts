/**
 * One-at-a-time preview of a file with a plain `<audio>` element: the library's rows, uploads and a fresh recording.
 * An element streams, needs no decoding first and reports its own position, which is all a preview needs. (The design
 * itself is played by `player.ts` with Web Audio, which is what loops and mixes exactly.)
 */

export type PreviewStatus = 'idle' | 'loading' | 'playing' | 'paused'

export interface PreviewState {
  /** What is loaded: the key the caller gave (a catalogue id, a track id …). */
  key: string | null
  status: PreviewStatus
  positionMs: number
  durationMs: number
  error: 'unsupported' | 'failed' | 'blocked' | null
}

const IDLE: PreviewState = { key: null, status: 'idle', positionMs: 0, durationMs: 0, error: null }

export class Previewer {
  private state: PreviewState = IDLE
  private audio: HTMLAudioElement | null = null
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private range: { fromMs: number; toMs: number } | null = null
  private poll = 0

  constructor(private readonly createAudio: () => HTMLAudioElement = () => new Audio()) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): PreviewState => this.state

  private set(patch: Partial<PreviewState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  private element(): HTMLAudioElement {
    if (this.audio) return this.audio
    const audio = this.createAudio()
    audio.preload = 'auto'
    audio.addEventListener('timeupdate', () => this.set({ positionMs: Math.round(audio.currentTime * 1000) }))
    audio.addEventListener('durationchange', () => {
      if (Number.isFinite(audio.duration)) this.set({ durationMs: Math.round(audio.duration * 1000) })
    })
    audio.addEventListener('playing', () => {
      this.set({ status: 'playing', error: null })
      this.watch(audio)
    })
    audio.addEventListener('pause', () => {
      if (!audio.ended && this.state.status !== 'idle') this.set({ status: 'paused' })
    })
    audio.addEventListener('ended', () => {
      window.clearInterval(this.poll)
      this.set({ status: 'idle', positionMs: 0 })
    })
    audio.addEventListener('error', () => {
      if (!audio.src) return
      this.set({ status: 'idle', error: audio.error?.code === 4 ? 'unsupported' : 'failed' })
    })
    this.audio = audio
    return audio
  }

  /**
   * Plays `url` under `key`, or pauses / resumes when `key` is already loaded. `resolve` turns a stored address into
   * something an element can play (`idb://…` to a blob URL). Call from a click or a key press.
   */
  async toggle(key: string, resolve: () => Promise<string>, options: { loop?: boolean; durationMs?: number; range?: { fromMs: number; toMs: number } } = {}): Promise<void> {
    const audio = this.element()
    if (this.state.key === key && this.state.status === 'playing') {
      audio.pause()
      return
    }
    if (this.state.key === key && this.state.status === 'paused') {
      await this.play(audio)
      return
    }
    const generation = ++this.generation
    audio.pause()
    this.set({ key, status: 'loading', positionMs: 0, durationMs: options.durationMs ?? 0, error: null })
    let url: string
    try {
      url = await resolve()
    } catch {
      if (generation === this.generation) this.set({ status: 'idle', error: 'failed' })
      return
    }
    if (generation !== this.generation) return
    this.range = options.range ?? null
    audio.loop = options.loop === true && !this.range
    audio.src = url
    if (this.range) {
      const from = this.range.fromMs / 1000
      const seek = (): void => {
        audio.currentTime = from
      }
      if (audio.readyState >= 1) seek()
      else audio.addEventListener('loadedmetadata', seek, { once: true })
    }
    await this.play(audio)
  }

  /** Keeps a range preview inside its range: at the end it stops, or starts over when looping. */
  private watch(audio: HTMLAudioElement): void {
    window.clearInterval(this.poll)
    const range = this.range
    if (!range) return
    this.poll = window.setInterval(() => {
      if (audio.currentTime * 1000 < range.toMs) return
      if (audio.loop || this.state.key === null) return
      audio.pause()
      audio.currentTime = range.fromMs / 1000
      this.set({ status: 'idle', positionMs: range.fromMs })
    }, 30)
  }

  private async play(audio: HTMLAudioElement): Promise<void> {
    try {
      await audio.play()
    } catch (error) {
      const name = error instanceof DOMException ? error.name : ''
      if (name === 'AbortError') return
      this.set({ status: 'idle', error: name === 'NotAllowedError' ? 'blocked' : name === 'NotSupportedError' ? 'unsupported' : 'failed' })
    }
  }

  /** Moves to `ms` in the loaded file (for a click on the waveform). */
  seek(ms: number): void {
    const audio = this.audio
    if (!audio || !this.state.key) return
    audio.currentTime = Math.max(0, ms) / 1000
    this.set({ positionMs: Math.max(0, ms) })
  }

  stop(): void {
    this.generation++
    window.clearInterval(this.poll)
    this.range = null
    const audio = this.audio
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
    this.set({ key: null, status: 'idle', positionMs: 0, durationMs: 0, error: null })
  }

  /** Stops, and releases the element. */
  dispose(): void {
    this.stop()
    this.audio = null
    this.listeners.clear()
  }
}
