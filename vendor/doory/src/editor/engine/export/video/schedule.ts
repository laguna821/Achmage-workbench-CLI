/**
 * The frame scheduler: which moments of the timeline become frames, with timestamps that never drift.
 *
 * Frame `i` of a video at `fps` is shown at `i / fps` seconds. Everything here is computed from `i` directly (never by
 * adding a rounded frame length again and again), so frame 1 000 000 of a 24 fps video is exactly as accurate as frame 1,
 * and the question "which segment is frame `i` in" is answered with integers: a boundary of the timeline is a whole
 * number of milliseconds `B`, frame `i` is at `i * 1000 / fps` ms, and `i * 1000 >= B * fps` compares two integers.
 */
import type { Segment, Timeline } from './timeline'

/** Frames needed to cover `totalMs`: the last frame starts before the end, so the file is never shorter than the design. */
export function frameCount(totalMs: number, fps: number): number {
  if (!(totalMs > 0) || !(fps > 0)) return 0
  return Math.max(1, Math.ceil((totalMs * fps) / 1000))
}

/** When frame `i` starts, in ms (a fraction when `fps` does not divide 1000). */
export const frameStartMs = (i: number, fps: number): number => (i * 1000) / fps

/** Timestamp of frame `i` in microseconds: the exact start, rounded once. */
export const frameTimestampUs = (i: number, fps: number): number => Math.round((i * 1_000_000) / fps)

/** Length of frame `i` in microseconds; the sum over all frames is exactly the timestamp of the last frame plus its length. */
export const frameDurationUs = (i: number, fps: number): number => frameTimestampUs(i + 1, fps) - frameTimestampUs(i, fps)

/**
 * The delay of GIF frame `i` in centiseconds (the unit of the format). A frame lasts until the next one starts, the last
 * until the end of the timeline; each end is rounded on its own, so the delays add up to the total (to a centisecond).
 */
export function gifDelayCs(i: number, fps: number, totalMs: number): number {
  const end = Math.min(((i + 1) * 1000) / fps, totalMs)
  return Math.round(end / 10) - Math.round(frameStartMs(i, fps) / 10)
}

/** What is on screen at a frame: a transition at some progress, or a page at some time of its clock. */
export type FramePlan =
  | { kind: 'transition'; segment: Segment; /** 0..1, linear in time */ progress: number }
  | { kind: 'page'; segment: Segment; /** ms on the page clock */ pageMs: number }

/**
 * Walks the frames in order and says what each one shows. A cursor, not a search: frames are asked for in sequence, so
 * the segment pointer only moves forward. `at(i)` for any `i` (even out of order) is also correct, just not as quick.
 */
export class FrameCursor {
  private segment = 0

  constructor(
    private readonly timeline: Timeline,
    private readonly fps: number,
  ) {}

  at(i: number): FramePlan {
    const { segments } = this.timeline
    const scaled = i * 1000
    // Rewind when asked for an earlier frame than the one the pointer is on.
    while (this.segment > 0 && scaled < segments[this.segment].startMs * this.fps) this.segment--
    while (this.segment < segments.length - 1 && scaled >= segments[this.segment].endMs * this.fps) this.segment++
    const segment = segments[this.segment]
    if (scaled < segment.bodyStartMs * this.fps) {
      const into = scaled - segment.startMs * this.fps
      return { kind: 'transition', segment, progress: into / (segment.transitionMs * this.fps) }
    }
    const pageMs = (scaled - segment.bodyStartMs * this.fps) / this.fps
    return { kind: 'page', segment, pageMs: Math.min(pageMs, segment.bodyMs) }
  }
}

/** Plans for every frame, as an iterator (used by tests and by the size estimate; the pipeline walks a cursor itself). */
export function* framePlans(timeline: Timeline, fps: number): Generator<FramePlan> {
  const cursor = new FrameCursor(timeline, fps)
  const count = frameCount(timeline.totalMs, fps)
  for (let i = 0; i < count; i++) yield cursor.at(i)
}

/**
 * True when the frame at `plan` looks the same as the one before it, so a GIF can lengthen the previous frame instead
 * of storing another one: a page whose animations are over (and that does not loop) after its first settled frame.
 */
export function repeatsPrevious(plan: FramePlan, previous: FramePlan | null): boolean {
  if (!previous || plan.kind !== 'page' || previous.kind !== 'page' || plan.segment !== previous.segment) return false
  return previous.pageMs >= plan.segment.settledMs
}
