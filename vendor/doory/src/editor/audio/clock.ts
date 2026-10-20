/**
 * The clock of a design for audio: pages one after another, each as long as the caller says. A mixdown for a video, the
 * editor's "play all" and the tests all hand in the page lengths they mean; `pageDurationsMs(doc)` gives the editor's
 * own (the time a page stays up under auto-advance). Where a track starts and ends follows from its scope and this clock.
 */
import type { AudioTrack, DoryDocument } from '@/types/document'
import { pageHoldEndMs } from '../animation/timelineMath'
import { MIN_TRIM_MS, trimmedLengthMs } from './model'

export interface PageSpan {
  pageId: string
  startMs: number
  endMs: number
}

export interface Clock {
  pages: readonly PageSpan[]
  totalMs: number
}

/** Longest design a mixdown renders: half an hour. */
export const MAX_CLOCK_MS = 30 * 60 * 1000

/** Pages one after another. A length that is not a positive finite number counts as 0. */
export function buildClock(pageIds: readonly string[], durationsMs: readonly number[]): Clock {
  const pages: PageSpan[] = []
  let at = 0
  pageIds.forEach((pageId, i) => {
    const length = Number.isFinite(durationsMs[i]) && durationsMs[i] > 0 ? Math.round(durationsMs[i]) : 0
    pages.push({ pageId, startMs: at, endMs: at + length })
    at += length
  })
  return { pages, totalMs: at }
}

/** How long each page of the document stays up in the editor's own playback (what the slideshow would use). */
export function pageDurationsMs(doc: Pick<DoryDocument, 'pages'>): number[] {
  return doc.pages.map((page) => pageHoldEndMs(page))
}

export function clockOf(doc: Pick<DoryDocument, 'pages'>, durationsMs: readonly number[] = pageDurationsMs(doc)): Clock {
  return buildClock(
    doc.pages.map((p) => p.id),
    durationsMs,
  )
}

/** Where a track plays on the clock. */
export interface Placement {
  track: AudioTrack
  /** Absolute start and end on the clock, ms. */
  startMs: number
  endMs: number
  /** The scope the track lives in, ms on the clock. */
  scopeStartMs: number
  scopeEndMs: number
  /** Length of one play-through (the trimmed part), ms. */
  windowMs: number
}

/**
 * Where `track` plays, or `null` when it does not: its page is not in the clock, or it would start at or after the end
 * of its scope. A looping track runs to the end of its scope; any other ends after one play-through or at the end of
 * its scope, whichever comes first.
 */
export function placeTrack(track: AudioTrack, clock: Clock): Placement | null {
  let scopeStartMs = 0
  let scopeEndMs = clock.totalMs
  if (track.scope.type === 'page') {
    const pageId = track.scope.pageId
    const page = clock.pages.find((p) => p.pageId === pageId)
    if (!page) return null
    scopeStartMs = page.startMs
    scopeEndMs = page.endMs
  }
  const startMs = scopeStartMs + track.startMs
  if (startMs >= scopeEndMs) return null
  const windowMs = trimmedLengthMs(track)
  const endMs = track.loop ? scopeEndMs : Math.min(scopeEndMs, startMs + windowMs)
  if (endMs - startMs < 1) return null
  return { track, startMs, endMs, scopeStartMs, scopeEndMs, windowMs }
}

/** The smallest sound that is worth scheduling. */
export const MIN_PLAYED_MS = MIN_TRIM_MS / 10
