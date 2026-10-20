/**
 * Voiceover recording with `MediaRecorder`, as a small state machine that can be driven without a browser:
 * everything it touches (the microphone, the recorder, the audio context for the level meter, the clock) is passed in.
 *
 *   idle -> requesting -> countdown (3, 2, 1) -> recording -> recorded
 *      \\________ error (denied, blocked, no-device, busy, unsupported, failed) ________/
 *
 * `begin()` asks for the microphone (the browser shows its own prompt), counts down while the level meter is live and
 * records until `stop()` or the time limit. `retake()` discards a recording and goes straight to the countdown again
 * while the microphone is still open. `dispose()` releases the microphone; the panel calls it whenever the tab closes.
 */

export type RecorderFailure = 'denied' | 'blocked' | 'no-device' | 'busy' | 'unsupported' | 'failed'

export type RecorderState =
  | { status: 'idle' }
  | { status: 'requesting' }
  | { status: 'countdown'; remaining: number; level: number }
  | { status: 'recording'; elapsedMs: number; level: number }
  | { status: 'recorded'; blob: Blob; durationMs: number }
  | { status: 'error'; reason: RecorderFailure; message: string }

export const COUNTDOWN_SECONDS = 3
export const MAX_RECORDING_MS = 10 * 60 * 1000
/** Mime types tried in order: Chromium and Firefox write Opus (WebM or Ogg), Safari writes AAC in MP4. */
export const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'] as const

export interface RecorderDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  createRecorder(stream: MediaStream, mimeType: string | undefined): MediaRecorder
  isTypeSupported(type: string): boolean
  /** An analyser on the stream for the level meter; `null` where audio contexts are missing (the meter then stays flat). */
  createMeter(stream: MediaStream): { read(): number; close(): void } | null
  now(): number
  setTimeout(handler: () => void, ms: number): number
  clearTimeout(handle: number): void
  setInterval(handler: () => void, ms: number): number
  clearInterval(handle: number): void
}

/** The real browser's pieces. */
export function browserDeps(): RecorderDeps | null {
  const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
  if (!media || typeof media.getUserMedia !== 'function' || typeof MediaRecorder === 'undefined') return null
  return {
    getUserMedia: (c) => media.getUserMedia(c),
    createRecorder: (stream, mimeType) => new MediaRecorder(stream, mimeType ? { mimeType } : undefined),
    isTypeSupported: (type) => MediaRecorder.isTypeSupported(type),
    createMeter(stream) {
      const Context = typeof AudioContext === 'undefined' ? undefined : AudioContext
      if (!Context) return null
      const context = new Context()
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      return {
        read: () => {
          analyser.getFloatTimeDomainData(samples)
          let sum = 0
          for (const v of samples) sum += v * v
          return levelFromRms(Math.sqrt(sum / samples.length))
        },
        close: () => void context.close().catch(() => undefined),
      }
    },
    now: () => performance.now(),
    setTimeout: (h, ms) => window.setTimeout(h, ms),
    clearTimeout: (h) => window.clearTimeout(h),
    setInterval: (h, ms) => window.setInterval(h, ms),
    clearInterval: (h) => window.clearInterval(h),
  }
}

/** Maps a signal's RMS to a 0..1 meter position: -60 dBFS is empty, -6 dBFS is full. */
export function levelFromRms(rms: number): number {
  if (!(rms > 0)) return 0
  const db = 20 * Math.log10(rms)
  return Math.min(1, Math.max(0, (db + 60) / 54))
}

const MESSAGES: Record<RecorderFailure, string> = {
  denied: 'Microphone access was blocked. Allow it for this site in your browser’s address bar, then try again.',
  blocked: 'This page is not allowed to use the microphone. Open Doory over HTTPS, or ask the site’s administrator to allow it.',
  'no-device': 'No microphone was found. Plug one in or check your system sound settings, then try again.',
  busy: 'The microphone is in use by another app or tab. Close it there, then try again.',
  unsupported: 'This browser cannot record audio. Try a current version of Chrome, Edge, Firefox or Safari.',
  failed: 'The recording could not be made. Try again.',
}

export function failureOf(error: unknown): RecorderFailure {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'denied'
    case 'SecurityError':
      return 'blocked'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no-device'
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'busy'
    case 'TypeError':
      return 'unsupported'
    default:
      return 'failed'
  }
}

export class VoiceRecorder {
  private state: RecorderState = { status: 'idle' }
  private readonly listeners = new Set<() => void>()
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private meter: { read(): number; close(): void } | null = null
  private chunks: Blob[] = []
  private timers: { timeout: number[]; interval: number[] } = { timeout: [], interval: [] }
  private startedAt = 0
  private generation = 0
  private level = 0

  /** `deps` is `null` in a browser without the pieces: the state then goes straight to "unsupported". */
  constructor(private readonly deps: RecorderDeps | null) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): RecorderState => this.state

  private set(state: RecorderState): void {
    this.state = state
    for (const listener of [...this.listeners]) listener()
  }

  private fail(reason: RecorderFailure): void {
    this.release()
    this.set({ status: 'error', reason, message: MESSAGES[reason] })
  }

  /** Asks for the microphone, counts down and records. Does nothing while a recording is under way. */
  async begin(): Promise<void> {
    const deps = this.deps
    if (!deps) return this.fail('unsupported')
    if (this.state.status === 'requesting' || this.state.status === 'countdown' || this.state.status === 'recording') return
    const generation = ++this.generation
    this.set({ status: 'requesting' })
    try {
      if (!this.stream || !this.stream.active) {
        this.stream = await deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      }
    } catch (error) {
      if (generation === this.generation) this.fail(failureOf(error))
      return
    }
    if (generation !== this.generation) {
      this.release()
      return
    }
    this.meter ??= deps.createMeter(this.stream)
    this.countdown(generation, COUNTDOWN_SECONDS)
  }

  private tickMeter(): void {
    this.level = this.meter?.read() ?? 0
  }

  private countdown(generation: number, remaining: number): void {
    const deps = this.deps as RecorderDeps
    this.clearTimers()
    this.set({ status: 'countdown', remaining, level: this.level })
    this.timers.interval.push(
      deps.setInterval(() => {
        this.tickMeter()
        if (this.state.status === 'countdown') this.set({ ...this.state, level: this.level })
      }, 60),
    )
    this.timers.timeout.push(
      deps.setTimeout(() => {
        if (generation !== this.generation) return
        if (remaining <= 1) this.record(generation)
        else this.countdown(generation, remaining - 1)
      }, 1000),
    )
  }

  private record(generation: number): void {
    const deps = this.deps as RecorderDeps
    const stream = this.stream
    if (!stream || generation !== this.generation) return
    this.clearTimers()
    const mimeType = RECORDER_TYPES.find((type) => deps.isTypeSupported(type))
    let recorder: MediaRecorder
    try {
      recorder = deps.createRecorder(stream, mimeType)
    } catch {
      return this.fail('unsupported')
    }
    this.recorder = recorder
    this.chunks = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    recorder.onerror = () => {
      if (generation === this.generation) this.fail('failed')
    }
    recorder.onstop = () => {
      if (generation !== this.generation) return
      const durationMs = Math.round(deps.now() - this.startedAt)
      this.clearTimers()
      const blob = new Blob(this.chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
      this.chunks = []
      if (blob.size === 0) return this.fail('failed')
      this.set({ status: 'recorded', blob, durationMs })
    }
    this.startedAt = deps.now()
    try {
      recorder.start(250)
    } catch {
      return this.fail('failed')
    }
    this.set({ status: 'recording', elapsedMs: 0, level: this.level })
    this.timers.interval.push(
      deps.setInterval(() => {
        this.tickMeter()
        const elapsedMs = Math.round(deps.now() - this.startedAt)
        if (elapsedMs >= MAX_RECORDING_MS) return this.stop()
        if (this.state.status === 'recording') this.set({ status: 'recording', elapsedMs, level: this.level })
      }, 60),
    )
  }

  /** Ends the recording; the state becomes `recorded` once the recorder has delivered its last data. */
  stop(): void {
    if (this.state.status === 'countdown') {
      this.generation++
      this.clearTimers()
      this.set({ status: 'idle' })
      return
    }
    if (this.state.status !== 'recording' || !this.recorder) return
    this.clearTimers()
    try {
      if (this.recorder.state !== 'inactive') this.recorder.stop()
    } catch {
      this.fail('failed')
    }
  }

  /** Throws the recording away and starts the countdown again. */
  retake(): void {
    if (this.state.status === 'recorded') void this.begin()
  }

  /** Back to the start (the microphone stays open for the next take until `dispose()`). */
  reset(): void {
    this.generation++
    this.clearTimers()
    this.recorder = null
    this.chunks = []
    this.set({ status: 'idle' })
  }

  /** Stops everything and releases the microphone. */
  dispose(): void {
    this.generation++
    this.clearTimers()
    try {
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.onstop = null
        this.recorder.stop()
      }
    } catch {
      // The recorder is being thrown away anyway.
    }
    this.release()
    this.state = { status: 'idle' }
    this.listeners.clear()
  }

  private release(): void {
    this.clearTimers()
    this.recorder = null
    this.meter?.close()
    this.meter = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    this.level = 0
  }

  private clearTimers(): void {
    const deps = this.deps
    if (!deps) return
    this.timers.timeout.forEach((h) => deps.clearTimeout(h))
    this.timers.interval.forEach((h) => deps.clearInterval(h))
    this.timers = { timeout: [], interval: [] }
  }
}

/** A short clock for the recording time: `0:07`. */
export function formatClock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
