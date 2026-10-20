/**
 * The presenter view's pure helpers: what the clocks read between two messages, which picture width to ask for and
 * which picture to show while the right one is still on its way.
 */
import { isRunning, remainingMs, type SlideshowConfig, type SlideshowState } from '../machine'
import type { PagePreview } from '../channel'

/** The view re-reads the clock this often. */
export const VIEW_TICK_MS = 250
/** No message for this long (the show sends one every second) means the audience window is gone. */
export const SIGNAL_LOST_MS = 4500
/** A clock never runs ahead of its last message by more than this: if the show stops talking, the numbers stop too. */
const MAX_EXTRAPOLATION_MS = 5000

export function configOf(pages: readonly PagePreview[]): SlideshowConfig {
  return { count: pages.length, durations: pages.map((p) => p.durationSec) }
}

/**
 * The state as it stands `sinceMs` after the show sent it: the total clock and (while the countdown is running) the
 * page clock have moved on; the page itself has not, because only the show decides when a page changes.
 */
export function extrapolate(config: SlideshowConfig, state: SlideshowState, sinceMs: number): SlideshowState {
  const dt = Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, sinceMs))
  if (state.ended || dt === 0) return state
  const sec = config.durations[state.index] ?? null
  const pageMs = isRunning(config, state) && sec !== null ? Math.min(sec * 1000, state.pageMs + dt) : state.pageMs
  return { ...state, totalMs: state.totalMs + dt, pageMs }
}

export type PageClock = { kind: 'off' } | { kind: 'paused' } | { kind: 'waits' } | { kind: 'running'; remainingMs: number; progress: number }

/** What the current page's timer shows. */
export function pageClock(config: SlideshowConfig, state: SlideshowState): PageClock {
  if (!state.autoAdvance || state.ended) return { kind: 'off' }
  if (state.paused) return { kind: 'paused' }
  const left = remainingMs(config, state)
  const sec = config.durations[state.index] ?? null
  if (left === null || sec === null) return { kind: 'waits' }
  return { kind: 'running', remainingMs: left, progress: Math.min(1, state.pageMs / (sec * 1000)) }
}

export const FRAME_STEP = 160
export const FRAME_MIN = 160
export const FRAME_MAX = 1600

/** The picture width to ask for a box of `cssWidth` px: device pixels, rounded up to a step so small resizes reuse pictures. */
export function frameWidthFor(cssWidth: number, devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  const wanted = Math.ceil((Math.max(0, cssWidth) * dpr) / FRAME_STEP) * FRAME_STEP
  return Math.min(FRAME_MAX, Math.max(FRAME_MIN, wanted))
}

export interface ReceivedFrame {
  width: number
  url: string
}

/** The picture to show for a page: the requested width, else the nearest larger one, else the largest smaller one. */
export function bestFrame(frames: readonly ReceivedFrame[], wanted: number): ReceivedFrame | null {
  if (frames.length === 0) return null
  const exact = frames.find((f) => f.width === wanted)
  if (exact) return exact
  const larger = frames.filter((f) => f.width > wanted).sort((a, b) => a.width - b.width)[0]
  if (larger) return larger
  return [...frames].sort((a, b) => b.width - a.width)[0]
}
