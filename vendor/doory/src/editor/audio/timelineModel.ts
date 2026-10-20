/**
 * What the timeline shows of the audio, and what a drag does to a track. Pure arithmetic on the page's clock (0 is the
 * moment the page comes up), so it is tested without a DOM. Times in the document stay what they always are: a track's
 * `startMs` is relative to its scope, `trimStartMs` / `trimEndMs` are positions in the sound file.
 */
import type { AudioTrack } from '@/types/document'
import { type Clock, placeTrack } from './clock'
import { MAX_TIME_MS, MIN_TRIM_MS, clampNumber } from './model'

export interface TimelineItem {
  track: AudioTrack
  /** Where the sound begins on the page's clock, ms. Negative for a track of the whole design that began on an earlier page. */
  startMs: number
  /** Where it ends (a loop runs to the end of its scope), ms. For a track of the whole design this can lie beyond the page. */
  endMs: number
  /** Where the first play-through of the trimmed sound ends, ms: before `endMs` when the track loops, beyond the page when it is cut. */
  fullEndMs: number
  /** The end of the page, ms: what the timeline draws is cut here. */
  scopeEndMs: number
}

/** The tracks that sound on page `pageId`: those of the whole design that reach it, then its own, each group earliest first. */
export function timelineItems(tracks: readonly AudioTrack[], clock: Clock, pageId: string): TimelineItem[] {
  const page = clock.pages.find((p) => p.pageId === pageId)
  if (!page) return []
  const items: TimelineItem[] = []
  for (const track of tracks) {
    if (track.scope.type === 'page' && track.scope.pageId !== pageId) continue
    const placement = placeTrack(track, clock)
    if (!placement || placement.endMs <= page.startMs || placement.startMs >= page.endMs) continue
    items.push({
      track,
      startMs: placement.startMs - page.startMs,
      endMs: placement.endMs - page.startMs,
      fullEndMs: placement.startMs + placement.windowMs - page.startMs,
      scopeEndMs: page.endMs - page.startMs,
    })
  }
  // Tracks of the whole design on top (the music under everything), then by where they start; ties stay in document order.
  const rank = (item: TimelineItem): number => (item.track.scope.type === 'design' ? 0 : 1)
  return items.sort((a, b) => rank(a) - rank(b) || a.startMs - b.startMs)
}

/** The fields of a track that a drag changes. */
export interface TrackTimes {
  startMs: number
  trimStartMs: number
  trimEndMs: number
}

export type TrackEdit = Partial<TrackTimes>

export const timesOf = (track: AudioTrack): TrackTimes => ({ startMs: track.startMs, trimStartMs: track.trimStartMs, trimEndMs: track.trimEndMs })

/** The whole bar moves by `deltaMs`; it cannot start before its scope does. */
export function moveEdit(from: TrackTimes, deltaMs: number): TrackEdit {
  return { startMs: clampNumber(Math.round(from.startMs + deltaMs), 0, MAX_TIME_MS) }
}

/**
 * The left edge moves by `deltaMs`: the sound before the new edge is cut off (or, dragging left, given back) and the
 * rest stays where it was on the clock, so `startMs` moves with `trimStartMs`.
 */
export function trimStartEdit(from: TrackTimes, deltaMs: number): TrackEdit {
  const lowest = Math.max(-from.trimStartMs, -from.startMs)
  const highest = from.trimEndMs - MIN_TRIM_MS - from.trimStartMs
  const d = Math.round(clampNumber(deltaMs, lowest, Math.max(lowest, highest)))
  return { startMs: from.startMs + d, trimStartMs: from.trimStartMs + d }
}

/** The right edge moves by `deltaMs`: the part of the file that plays gets longer or shorter. `sourceMs` is the length of the file. */
export function trimEndEdit(from: TrackTimes, deltaMs: number, sourceMs: number): TrackEdit {
  const longest = Math.max(sourceMs, from.trimEndMs)
  return { trimEndMs: Math.round(clampNumber(from.trimEndMs + deltaMs, from.trimStartMs + MIN_TRIM_MS, longest)) }
}
