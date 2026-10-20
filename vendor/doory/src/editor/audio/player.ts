/**
 * Playback of the design's sound in the editor: "play page" and "play all", sample-accurate and on the same plan as the
 * mixdown (`plan.ts`). Everything is scheduled up front on the audio clock; pausing suspends the context, so the schedule
 * simply waits. Seeking, or a change to the tracks while playing, reschedules from the current position.
 *
 * Browsers only let sound start after a user gesture, so the context is created inside `play()` (called from a click or
 * a key press) and resumed there; when the browser still refuses, the state says `blocked` and a second press works.
 */
import type { AudioTrack } from '@/types/document'
import { type Clock, buildClock } from './clock'
import { type Bus, type RunningVoice, createBus, applyCurve, curveFrom, startVoice } from './graph'
import { isAudible } from './model'
import { type Voice, duckCurve, planMix, sourcePositionMs } from './plan'
import type { SourceLoader } from './sources'

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused'

export type PlayRange = { mode: 'all' } | { mode: 'page'; pageId: string }

export interface PlayerState {
  status: PlayerStatus
  /** The part of the design that plays and where in it the playhead is, ms on the design clock. */
  startMs: number
  endMs: number
  positionMs: number
  range: PlayRange | null
  /** The sound did not start because the browser wants another gesture. */
  blocked: boolean
  /** Names of tracks whose file could not be loaded (the others play). */
  failed: readonly string[]
  error: string | null
  soloId: string | null
}

const IDLE: PlayerState = { status: 'idle', startMs: 0, endMs: 0, positionMs: 0, range: null, blocked: false, failed: [], error: null, soloId: null }

export interface PlayerDeps {
  tracks(): readonly AudioTrack[]
  pageIds(): readonly string[]
  pageDurationsMs(): readonly number[]
  load: SourceLoader
  createContext(): AudioContext
  setInterval(handler: () => void, ms: number): number
  clearInterval(handle: number): void
}

/** Seconds between "now" and the first scheduled sound, so scheduling never starts in the past. */
const LEAD_SEC = 0.06
const TICK_MS = 50

interface Running {
  voice: Voice
  node: RunningVoice
}

export class AudioPlayer {
  private state: PlayerState = IDLE
  private readonly listeners = new Set<() => void>()
  private context: AudioContext | null = null
  private bus: Bus | null = null
  private running: Running[] = []
  private timer = 0
  /** The design-clock position that context time `base` corresponds to. */
  private origin = 0
  private base = 0
  private token = 0
  private signature = ''

  constructor(private readonly deps: PlayerDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): PlayerState => this.state

  private set(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  clock(): Clock {
    return buildClock(this.deps.pageIds(), this.deps.pageDurationsMs())
  }

  private spanOf(range: PlayRange, clock: Clock): { startMs: number; endMs: number } {
    if (range.mode === 'all') return { startMs: 0, endMs: clock.totalMs }
    const page = clock.pages.find((p) => p.pageId === range.pageId)
    return page ? { startMs: page.startMs, endMs: page.endMs } : { startMs: 0, endMs: 0 }
  }

  /** Whether anything would sound in `range`. */
  hasAudio(range: PlayRange): boolean {
    const clock = this.clock()
    const { startMs, endMs } = this.spanOf(range, clock)
    return planMix(this.deps.tracks().filter(isAudible), clock).voices.some((v) => v.placement.endMs > startMs && v.placement.startMs < endMs)
  }

  /** Starts playing `range` from its start, or from `fromMs` (design clock) when given. Call from a user gesture. */
  async play(range: PlayRange, fromMs?: number): Promise<void> {
    const clock = this.clock()
    const span = this.spanOf(range, clock)
    const position = Math.min(Math.max(fromMs ?? span.startMs, span.startMs), Math.max(span.startMs, span.endMs - 1))
    this.set({ range, startMs: span.startMs, endMs: span.endMs, positionMs: position, blocked: false, error: null, failed: [] })
    await this.start(position)
  }

  /** Reschedules from `positionMs` on the design clock (a seek, or the tracks changed). */
  private async start(positionMs: number): Promise<void> {
    const token = ++this.token
    this.clearSources()
    const range = this.state.range
    if (!range) return
    let context: AudioContext
    try {
      context = this.context ?? this.deps.createContext()
    } catch {
      this.set({ status: 'idle', error: 'This browser cannot play audio.' })
      return
    }
    if (this.context !== context) {
      this.context = context
      this.bus = createBus(context)
    }
    const bus = this.bus as Bus
    const clock = this.clock()
    const plan = planMix(this.deps.tracks().filter(isAudible), clock, { soloId: this.state.soloId })
    const wanted = plan.voices.filter((v) => v.placement.endMs > positionMs && v.placement.startMs < this.state.endMs)
    this.signature = signatureOf(wanted, this.state.endMs)
    this.set({ status: 'loading', positionMs })

    const failed: string[] = []
    const loaded = await Promise.all(
      wanted.map(async (voice) => {
        try {
          return { voice, buffer: await this.deps.load(voice.track) }
        } catch {
          failed.push(voice.track.name || voice.track.src)
          return null
        }
      }),
    )
    if (token !== this.token) return

    try {
      if (context.state === 'suspended') await context.resume()
    } catch {
      // The browser refused; the state below says so.
    }
    if (token !== this.token) return
    if (context.state === 'suspended') {
      this.set({ status: 'idle', blocked: true })
      return
    }

    this.origin = positionMs
    this.base = context.currentTime + LEAD_SEC
    const endSec = this.base + (this.state.endMs - positionMs) / 1000
    for (const item of loaded) {
      if (!item) continue
      this.running.push({ voice: item.voice, node: this.schedule(bus, item.voice, item.buffer, positionMs, endSec) })
    }
    // Ducking: the curve of the merged voiceovers, from the playhead on.
    bus.duck.gain.cancelScheduledValues(0)
    const curve = plan.voiceovers.length > 0 ? curveFrom(duckCurve(plan.voiceovers, clock.totalMs), positionMs) : [{ t: positionMs, gain: 1 }]
    applyCurve(bus.duck.gain, curve.map((p) => ({ at: this.base + (p.t - positionMs) / 1000, gain: p.gain })))
    this.set({ status: 'playing', failed, blocked: false })
    this.deps.clearInterval(this.timer)
    this.timer = this.deps.setInterval(() => this.tick(), TICK_MS)
  }

  private schedule(bus: Bus, voice: Voice, buffer: AudioBuffer, positionMs: number, rangeEndSec: number): RunningVoice {
    const { placement, track } = voice
    const startsLater = placement.startMs > positionMs
    const at = this.base + Math.max(0, placement.startMs - positionMs) / 1000
    const into = startsLater ? 0 : positionMs - placement.startMs
    const endSec = Math.min(this.base + (placement.endMs - positionMs) / 1000, rangeEndSec)
    const fade = curveFrom(voice.fade, startsLater ? placement.startMs : positionMs).map((p) => ({ at: this.base + (p.t - positionMs) / 1000, gain: p.gain }))
    return startVoice(bus, {
      buffer,
      loop: track.loop,
      trimStartSec: track.trimStartMs / 1000,
      trimEndSec: track.trimEndMs / 1000,
      volume: voice.volume,
      ducks: voice.duck !== null,
      at,
      offsetSec: sourcePositionMs(placement, placement.startMs + into) / 1000,
      playSec: endSec - at,
      fade,
    })
  }

  private clearSources(): void {
    for (const { node } of this.running) node.dispose()
    this.running = []
    this.deps.clearInterval(this.timer)
  }

  private tick(): void {
    const context = this.context
    if (!context || this.state.status !== 'playing') return
    const positionMs = this.origin + (context.currentTime - this.base) * 1000
    if (positionMs >= this.state.endMs) {
      this.stop()
      return
    }
    this.set({ positionMs: Math.max(this.state.startMs, positionMs) })
  }

  async pause(): Promise<void> {
    if (this.state.status !== 'playing' || !this.context) return
    this.set({ status: 'paused' })
    await this.context.suspend()
  }

  async resume(): Promise<void> {
    if (this.state.status !== 'paused' || !this.context) return
    try {
      await this.context.resume()
      this.set({ status: 'playing' })
    } catch {
      this.set({ blocked: true })
    }
  }

  async toggle(range: PlayRange): Promise<void> {
    if (this.state.status === 'playing') await this.pause()
    else if (this.state.status === 'paused') await this.resume()
    else await this.play(range)
  }

  /** Moves the playhead (design clock). Keeps playing, or stays paused at the new position. */
  async seek(positionMs: number): Promise<void> {
    if (!this.state.range) return
    const p = Math.min(Math.max(positionMs, this.state.startMs), Math.max(this.state.startMs, this.state.endMs - 1))
    const wasPaused = this.state.status === 'paused'
    this.set({ positionMs: p })
    if (this.state.status === 'idle') return
    await this.start(p)
    if (wasPaused) await this.pause()
  }

  stop(): void {
    this.token++
    this.clearSources()
    this.set({ status: 'idle', positionMs: this.state.startMs, blocked: false })
    if (this.context && this.context.state === 'suspended') void this.context.resume().catch(() => undefined)
  }

  /** Plays only this track (`null`: everything). While playing, the schedule is rebuilt at once. */
  setSolo(id: string | null): void {
    if (this.state.soloId === id) return
    this.set({ soloId: id })
    this.refresh()
  }

  /** The tracks (or the pages' lengths) changed: reschedule from the playhead if the sound is different now. */
  refresh(): void {
    if (this.state.status !== 'playing' && this.state.status !== 'paused') return
    const clock = this.clock()
    const plan = planMix(this.deps.tracks().filter(isAudible), clock, { soloId: this.state.soloId })
    const wanted = plan.voices.filter((v) => v.placement.endMs > this.state.positionMs && v.placement.startMs < this.state.endMs)
    if (signatureOf(wanted, this.state.endMs) === this.signature) {
      // Only volumes changed (or nothing audible): follow them without a gap.
      for (const entry of this.running) {
        const now = wanted.find((v) => v.track.id === entry.voice.track.id)
        if (now && this.context) entry.node.level.gain.setTargetAtTime(now.volume, this.context.currentTime, 0.015)
      }
      return
    }
    const wasPaused = this.state.status === 'paused'
    void this.start(this.state.positionMs).then(() => (wasPaused ? this.pause() : undefined))
  }

  /** Releases the audio context (the editor is closing). */
  dispose(): void {
    this.token++
    this.clearSources()
    this.listeners.clear()
    const context = this.context
    this.context = null
    this.bus = null
    if (context) void context.close().catch(() => undefined)
    this.state = IDLE
  }
}

/** Everything about the voices that a restart is needed for if it changes (volume is left out: it follows live). */
function signatureOf(voices: readonly Voice[], endMs: number): string {
  return JSON.stringify([
    endMs,
    voices.map((v) => [v.track.id, v.track.src, v.placement.startMs, v.placement.endMs, v.track.trimStartMs, v.track.trimEndMs, v.track.loop, v.track.fadeInMs, v.track.fadeOutMs, v.duck !== null]),
  ])
}
