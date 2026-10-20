/**
 * The mix plan: for every audible track where it plays and how loud it is at each moment. The plan is the one
 * description of what a design sounds like. The editor's preview, the presenter and the mixdown for a video all
 * read it, so they cannot disagree; the loudness curves are plain breakpoints, which Web Audio can schedule as ramps
 * and the offline renderer evaluates sample by sample.
 *
 * Gain of a track at time t = volume x fade(t) x duck(t). Fades are linear in gain. Ducking lowers a track to
 * `DUCK_GAIN` while a voiceover plays: the level falls over `DUCK_ATTACK_MS` from the voiceover's start and rises over
 * `DUCK_RELEASE_MS` from its end; voiceovers closer than both ramps together hold the track down in between.
 */
import type { AudioTrack } from '@/types/document'
import { type Clock, type Placement, placeTrack } from './clock'
import { DUCK_ATTACK_MS, DUCK_GAIN, DUCK_RELEASE_MS, ducks, isAudible } from './model'

/** A point of a piecewise-linear gain curve: absolute time on the clock (ms) and gain. */
export interface GainPoint {
  t: number
  gain: number
}

export interface Voice {
  track: AudioTrack
  placement: Placement
  /** `track.volume`. */
  volume: number
  /** The fade in and out as a curve over [start, end] (always starts and ends at the track's edges). */
  fade: readonly GainPoint[]
  /** The ducking curve, or `null` when nothing lowers this track. */
  duck: readonly GainPoint[] | null
}

export interface MixPlan {
  clock: Clock
  voices: readonly Voice[]
  /** Time spans where a voiceover is heard (merged), ms. */
  voiceovers: readonly { startMs: number; endMs: number }[]
}

/** Fade lengths that fit inside a sound of `lengthMs`: when both together are longer, they share it in proportion. */
export function fitFades(fadeInMs: number, fadeOutMs: number, lengthMs: number): { fadeIn: number; fadeOut: number } {
  const wanted = fadeInMs + fadeOutMs
  if (wanted <= lengthMs || wanted === 0) return { fadeIn: Math.min(fadeInMs, lengthMs), fadeOut: Math.min(fadeOutMs, lengthMs) }
  const k = lengthMs / wanted
  return { fadeIn: fadeInMs * k, fadeOut: fadeOutMs * k }
}

export function fadeCurve(placement: Placement): GainPoint[] {
  const { track, startMs, endMs } = placement
  const length = endMs - startMs
  const { fadeIn, fadeOut } = fitFades(track.fadeInMs, track.fadeOutMs, length)
  const points: GainPoint[] = []
  points.push({ t: startMs, gain: fadeIn > 0 ? 0 : 1 })
  if (fadeIn > 0) points.push({ t: startMs + fadeIn, gain: 1 })
  if (fadeOut > 0) points.push({ t: endMs - fadeOut, gain: 1 })
  points.push({ t: endMs, gain: fadeOut > 0 ? 0 : 1 })
  return points
}

/** Merges spans that touch or overlap, or whose gap is too short for the level to come back before the next one. */
export function mergeSpans(spans: readonly { startMs: number; endMs: number }[], gapMs = 0): { startMs: number; endMs: number }[] {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs)
  const out: { startMs: number; endMs: number }[] = []
  for (const span of sorted) {
    const last = out[out.length - 1]
    if (last && span.startMs <= last.endMs + gapMs) last.endMs = Math.max(last.endMs, span.endMs)
    else out.push({ ...span })
  }
  return out
}

/** The ducking curve for the merged voiceover spans, over the whole clock. */
export function duckCurve(spans: readonly { startMs: number; endMs: number }[], totalMs: number): GainPoint[] {
  const points: GainPoint[] = [{ t: 0, gain: 1 }]
  for (const span of spans) {
    points.push({ t: span.startMs, gain: 1 }, { t: span.startMs + DUCK_ATTACK_MS, gain: DUCK_GAIN }, { t: span.endMs, gain: DUCK_GAIN }, { t: span.endMs + DUCK_RELEASE_MS, gain: 1 })
  }
  points.push({ t: Math.max(totalMs, points[points.length - 1].t), gain: 1 })
  // Several points may share a time (a voiceover starting at 0): keep the later one, which is where the curve goes.
  return points.filter((p, i) => i === points.length - 1 || p.t !== points[i + 1].t)
}

/** Value of a piecewise-linear curve at `t` (constant before the first and after the last point). */
export function valueAt(curve: readonly GainPoint[], t: number): number {
  if (curve.length === 0) return 1
  if (t <= curve[0].t) return curve[0].gain
  for (let i = 1; i < curve.length; i++) {
    const b = curve[i]
    if (t <= b.t) {
      const a = curve[i - 1]
      return b.t === a.t ? b.gain : a.gain + ((b.gain - a.gain) * (t - a.t)) / (b.t - a.t)
    }
  }
  return curve[curve.length - 1].gain
}

/** Everything that makes a sound, in document order, with the ducking curve the voiceovers imply. */
export function planMix(tracks: readonly AudioTrack[], clock: Clock, options: { soloId?: string | null } = {}): MixPlan {
  const placed: Placement[] = []
  for (const track of tracks) {
    if (!isAudible(track)) continue
    if (options.soloId && track.id !== options.soloId) continue
    const placement = placeTrack(track, clock)
    if (placement) placed.push(placement)
  }
  const voiceovers = mergeSpans(
    placed.filter((p) => p.track.kind === 'voiceover').map((p) => ({ startMs: p.startMs, endMs: p.endMs })),
    DUCK_ATTACK_MS + DUCK_RELEASE_MS,
  )
  const curve = voiceovers.length > 0 ? duckCurve(voiceovers, clock.totalMs) : null
  const voices = placed.map<Voice>((placement) => ({
    track: placement.track,
    placement,
    volume: placement.track.volume,
    fade: fadeCurve(placement),
    duck: curve && ducks(placement.track) && placement.track.kind !== 'voiceover' ? curve : null,
  }))
  return { clock, voices, voiceovers }
}

/** Gain of a voice at absolute time `t`, ms. */
export function voiceGainAt(voice: Voice, t: number): number {
  if (t < voice.placement.startMs || t >= voice.placement.endMs) return 0
  return voice.volume * valueAt(voice.fade, t) * (voice.duck ? valueAt(voice.duck, t) : 1)
}

/**
 * Where in the source the sound is at `t` ms after the voice started: the trimmed part, repeated while it loops.
 * Returns ms inside the source.
 */
export function sourcePositionMs(placement: Placement, t: number): number {
  const elapsed = Math.max(0, t - placement.startMs)
  const within = placement.track.loop ? elapsed % placement.windowMs : Math.min(elapsed, placement.windowMs)
  return placement.track.trimStartMs + within
}
