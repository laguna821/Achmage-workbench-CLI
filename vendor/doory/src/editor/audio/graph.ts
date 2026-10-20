/**
 * The Web Audio graph both players share:
 *
 *   source -> fade -> level --+--> direct ------------+--> master -> destination
 *                             +--> duck (automated) --+
 *
 * `fade` carries the fade-in and fade-out of one voice, `level` its volume. Voices that duck under a voiceover go
 * through the shared `duck` gain, which the player lowers while a voiceover plays. Everything is plain gain automation:
 * no compressor or limiter, so what the editor plays is what `mixAudio` renders.
 */

export interface Bus {
  context: BaseAudioContext
  master: GainNode
  direct: GainNode
  duck: GainNode
}

export function createBus(context: BaseAudioContext, destination: AudioNode = context.destination): Bus {
  const master = context.createGain()
  const direct = context.createGain()
  const duck = context.createGain()
  direct.connect(master)
  duck.connect(master)
  master.connect(destination)
  return { context, master, direct, duck }
}

/** A gain point at an absolute time on the context's clock, seconds. */
export interface TimedGain {
  at: number
  gain: number
}

/** Schedules a piecewise-linear curve on `param` (points sharing a time are steps). */
export function applyCurve(param: AudioParam, points: readonly TimedGain[]): void {
  if (points.length === 0) return
  param.setValueAtTime(points[0].gain, points[0].at)
  for (let i = 1; i < points.length; i++) {
    if (points[i].at <= points[i - 1].at) param.setValueAtTime(points[i].gain, points[i].at)
    else param.linearRampToValueAtTime(points[i].gain, points[i].at)
  }
}

/** The part of a curve (absolute ms) from `fromMs` on, as a curve that starts at `fromMs` with its value there. */
export function curveFrom(curve: readonly { t: number; gain: number }[], fromMs: number): { t: number; gain: number }[] {
  if (curve.length === 0) return []
  let first = curve[0].gain
  const rest: { t: number; gain: number }[] = []
  for (let i = 0; i < curve.length; i++) {
    const point = curve[i]
    if (point.t <= fromMs) {
      first = point.gain
      const next = curve[i + 1]
      if (next && next.t > fromMs && next.t !== point.t) first = point.gain + ((next.gain - point.gain) * (fromMs - point.t)) / (next.t - point.t)
      continue
    }
    rest.push(point)
  }
  return [{ t: fromMs, gain: first }, ...rest]
}

export interface VoiceStart {
  buffer: AudioBuffer
  /** Plays the trimmed part over and over. */
  loop: boolean
  trimStartSec: number
  trimEndSec: number
  volume: number
  ducks: boolean
  /** Context time to start at (>= currentTime), and where in the buffer to begin (seconds). */
  at: number
  offsetSec: number
  /** Seconds to play from `at`, or null for "until stopped". */
  playSec: number | null
  /** Fade curve in context time; starts with the value at `at`. */
  fade: readonly TimedGain[]
}

export interface RunningVoice {
  source: AudioBufferSourceNode
  fade: GainNode
  level: GainNode
  /** Fades out over `fadeSec` from `at` and stops. */
  stop(at: number, fadeSec: number): void
  /** Disconnects the nodes immediately. */
  dispose(): void
}

export function startVoice(bus: Bus, o: VoiceStart): RunningVoice {
  const context = bus.context
  const source = context.createBufferSource()
  source.buffer = o.buffer
  if (o.loop) {
    source.loop = true
    source.loopStart = o.trimStartSec
    source.loopEnd = Math.max(o.trimStartSec + 0.001, Math.min(o.buffer.duration, o.trimEndSec))
  }
  const fade = context.createGain()
  applyCurve(fade.gain, o.fade)
  const level = context.createGain()
  level.gain.value = o.volume
  source.connect(fade).connect(level).connect(o.ducks ? bus.duck : bus.direct)
  const windowSec = Math.max(0.001, Math.min(o.buffer.duration, o.trimEndSec) - o.trimStartSec)
  if (o.playSec === null) source.start(o.at, o.offsetSec)
  else source.start(o.at, o.offsetSec, o.loop ? o.playSec : Math.min(o.playSec, Math.max(0.001, o.trimStartSec + windowSec - o.offsetSec)))
  let ended = false
  return {
    source,
    fade,
    level,
    stop(at, fadeSec) {
      if (ended) return
      ended = true
      const from = Math.max(at, context.currentTime)
      fade.gain.cancelScheduledValues(from)
      fade.gain.setValueAtTime(fade.gain.value, from)
      if (fadeSec > 0) fade.gain.linearRampToValueAtTime(0, from + fadeSec)
      try {
        source.stop(from + Math.max(fadeSec, 0.005))
      } catch {
        // Already stopped.
      }
    },
    dispose() {
      ended = true
      try {
        source.stop()
      } catch {
        // Not started, or already stopped.
      }
      source.disconnect()
      fade.disconnect()
      level.disconnect()
    },
  }
}
