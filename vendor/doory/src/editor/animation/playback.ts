/**
 * Playback of the active page in the editor: the playhead of the timeline and the preview over the page share this one
 * state. It lives outside the document store on purpose (a playhead is not part of the design: nothing here is saved,
 * synced to collaborators or undoable) and per editor, like the notes bar's flag.
 *
 *  - `active`: the preview is up (the page is drawn by the frame renderer over the canvas and editing is held back).
 *  - `playing`: the clock moves the playhead. A paused preview shows the frame at `timeMs`.
 *  - `stop()` takes the preview down and puts the playhead back at 0.
 */
import { useSyncExternalStore } from 'react'
import { useEditor } from '../context'
import type { EditorEngine } from '../engine/editor'

export const SPEEDS = [0.5, 1, 1.5, 2] as const
export type Speed = (typeof SPEEDS)[number]

export interface PlaybackState {
  active: boolean
  playing: boolean
  /** The playhead, ms on the page clock. */
  timeMs: number
  speed: Speed
  loop: boolean
}

const INITIAL: PlaybackState = { active: false, playing: false, timeMs: 0, speed: 1, loop: false }

/** The longest span one clock tick advances: a tab that slept must not skip the whole page on waking up. */
export const MAX_FRAME_MS = 100

export class Playback {
  private current: PlaybackState = INITIAL
  private readonly listeners = new Set<() => void>()

  get state(): PlaybackState {
    return this.current
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): PlaybackState => this.current

  private set(patch: Partial<PlaybackState>): void {
    const next = { ...this.current, ...patch }
    if ((Object.keys(next) as (keyof PlaybackState)[]).every((k) => next[k] === this.current[k])) return
    this.current = next
    for (const listener of [...this.listeners]) listener()
  }

  /** Starts playing from the playhead, or from the start when it is at the end. */
  play(lengthMs: number): void {
    const atEnd = this.current.timeMs >= lengthMs
    this.set({ active: true, playing: true, timeMs: atEnd ? 0 : this.current.timeMs })
  }

  pause(): void {
    if (this.current.active) this.set({ playing: false })
  }

  toggle(lengthMs: number): void {
    if (this.current.playing) this.pause()
    else this.play(lengthMs)
  }

  stop(): void {
    this.set({ active: false, playing: false, timeMs: 0 })
  }

  /** Puts the playhead at `ms` and shows the frame there (the preview comes up paused if it was not). */
  seek(ms: number, lengthMs: number): void {
    const t = Number.isFinite(ms) ? Math.min(lengthMs, Math.max(0, ms)) : 0
    this.set({ active: true, timeMs: t })
  }

  setSpeed(speed: Speed): void {
    this.set({ speed })
  }

  setLoop(loop: boolean): void {
    this.set({ loop })
  }

  /** The clock: `dtMs` of real time went by. At the end the page starts over (loop) or the preview ends. */
  advance(dtMs: number, lengthMs: number): void {
    if (!this.current.playing || !(dtMs > 0)) return
    const next = this.current.timeMs + Math.min(dtMs, MAX_FRAME_MS) * this.current.speed
    if (next < lengthMs) this.set({ timeMs: next })
    else if (this.current.loop) this.set({ timeMs: next % Math.max(1, lengthMs) })
    else this.stop()
  }
}

const playbacks = new WeakMap<EditorEngine, Playback>()

export function playbackOf(editor: EditorEngine): Playback {
  let playback = playbacks.get(editor)
  if (!playback) {
    playback = new Playback()
    playbacks.set(editor, playback)
  }
  return playback
}

export function usePlayback(): PlaybackState {
  const playback = playbackOf(useEditor())
  return useSyncExternalStore(playback.subscribe, playback.getSnapshot)
}

/** One value of the playback state; the component re-renders only when that value changes. */
export function usePlaybackValue<T>(select: (state: PlaybackState) => T): T {
  const playback = playbackOf(useEditor())
  return useSyncExternalStore(playback.subscribe, () => select(playback.getSnapshot()))
}
