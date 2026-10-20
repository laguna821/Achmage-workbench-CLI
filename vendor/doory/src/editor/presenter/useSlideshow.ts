import { useEffect, useReducer, useRef } from 'react'
import { initialState, isRunning, reduce, type SlideshowAction, type SlideshowConfig, type SlideshowState } from './machine'

/** How often the clock ticks the state machine while a page countdown is running (smooth progress, prompt page changes). */
export const TICK_MS = 100
/** How often it ticks otherwise: only the total clock moves then, and it is only shown once a second. */
export const IDLE_TICK_MS = 1000

interface UseSlideshowOptions {
  index?: number
  autoAdvance?: boolean
  loop?: boolean
  /** Millisecond clock; `performance.now` by default (a browser test clock fakes it too). */
  now?: () => number
}

/**
 * Runs a slideshow: the state of `machine.ts` plus the clock that feeds it. `config` must not change for the
 * lifetime of the hook (a presentation works on the snapshot of the design taken when it started).
 */
export function useSlideshow(config: SlideshowConfig, options: UseSlideshowOptions = {}): [SlideshowState, (action: SlideshowAction) => void] {
  const [state, dispatch] = useReducer((s: SlideshowState, a: SlideshowAction) => reduce(config, s, a), undefined, () => initialState(config, options))
  const clock = useRef(options.now ?? (() => performance.now()))
  const last = useRef<number | null>(null)
  const running = isRunning(config, state)
  useEffect(() => {
    const t0 = clock.current()
    // Time that passed while only the total clock was ticking must not count towards the page that starts running now.
    if (running && last.current !== null) dispatch({ type: 'tick', dt: t0 - last.current, countdown: false })
    last.current = t0
    const timer = window.setInterval(
      () => {
        const t = clock.current()
        dispatch({ type: 'tick', dt: t - (last.current ?? t) })
        last.current = t
      },
      running ? TICK_MS : IDLE_TICK_MS,
    )
    return () => window.clearInterval(timer)
  }, [running])
  return [state, dispatch]
}
