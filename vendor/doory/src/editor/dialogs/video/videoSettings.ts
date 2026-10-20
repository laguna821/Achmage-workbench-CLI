/**
 * What the video part of the Download dialog remembers and says: the options chosen last time for this design, and the
 * small pieces of text (time left, loop choice) that follow from numbers. No React, so it is tested without a browser.
 */
import { type VideoFormat, type VideoOptions, defaultVideoOptions, readVideoOptions, withFormat } from '../../engine/export/video/options'
import { t } from '../../strings'

const KEY_PREFIX = 'doory.editor.video.v1.'

/** The choice made last time for this design (for `format`); the defaults when there is none or storage is not available. */
export function loadVideoSettings(designId: string, format: VideoFormat): VideoOptions {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + designId)
    return withFormat(raw ? readVideoOptions(JSON.parse(raw), format) : defaultVideoOptions(format), format)
  } catch {
    return defaultVideoOptions(format)
  }
}

export function saveVideoSettings(designId: string, options: VideoOptions): void {
  try {
    localStorage.setItem(KEY_PREFIX + designId, JSON.stringify(options))
  } catch {
    /* storage is full or blocked (private window): the choice is simply not remembered */
  }
}

export type LoopChoice = 'forever' | 'once' | 'three'

export const LOOP_COUNTS: Record<LoopChoice, number> = { forever: 0, once: 1, three: 3 }

export const loopChoiceOf = (loops: number): LoopChoice => (loops === 0 ? 'forever' : loops === 1 ? 'once' : 'three')

/** `under a second`, `12 s`, `1 min 5 s`: how long is left. */
export function describeEta(ms: number): string {
  const p = t.video
  const seconds = Math.round(ms / 1000)
  if (seconds < 1) return p.lessThanSecond
  if (seconds < 60) return p.seconds(seconds)
  return p.minutes(Math.floor(seconds / 60), seconds % 60)
}
