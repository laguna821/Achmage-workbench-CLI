/**
 * A recording stand-in for the Web Audio objects the players use, so scheduling can be tested without a browser:
 * every node remembers how it was connected, every parameter its automation events, and `valueAt` evaluates them the
 * way the browser would (steps and linear ramps).
 */

type ParamEvent = { type: 'set' | 'ramp'; time: number; value: number }

export class FakeParam {
  value: number
  events: ParamEvent[] = []
  constructor(initial: number) {
    this.value = initial
  }
  setValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'set', time, value })
    return this
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'ramp', time, value })
    return this
  }
  setTargetAtTime(value: number): this {
    this.value = value
    return this
  }
  cancelScheduledValues(from: number): this {
    this.events = this.events.filter((e) => e.time < from)
    return this
  }
  /** The value at `time` given the events scheduled so far. */
  valueAt(time: number): number {
    let value = this.events.length > 0 ? this.events[0].value : this.value
    let previous: { time: number; value: number } | null = null
    for (const event of this.events) {
      if (event.time > time) {
        if (event.type === 'ramp' && previous) return previous.value + ((event.value - previous.value) * (time - previous.time)) / (event.time - previous.time)
        return value
      }
      value = event.value
      previous = { time: event.time, value: event.value }
    }
    return value
  }
}

export class FakeNode {
  connections: FakeNode[] = []
  disconnected = false
  connect<T extends FakeNode>(node: T): T {
    this.connections.push(node)
    return node
  }
  disconnect(): void {
    this.disconnected = true
  }
}

export class FakeGain extends FakeNode {
  gain = new FakeParam(1)
}

export class FakeSource extends FakeNode {
  buffer: unknown = null
  loop = false
  loopStart = 0
  loopEnd = 0
  started: { when: number; offset: number; duration: number | undefined } | null = null
  stopped: number | null = null
  start(when = 0, offset = 0, duration?: number): void {
    this.started = { when, offset, duration }
  }
  stop(when = 0): void {
    this.stopped = when
  }
}

export class FakeContext {
  currentTime = 0
  state: 'running' | 'suspended' | 'closed' = 'running'
  destination = new FakeNode()
  gains: FakeGain[] = []
  sources: FakeSource[] = []
  /** When true, `resume()` leaves the context suspended (the browser wants a gesture). */
  refuseResume = false
  calls: string[] = []
  createGain(): FakeGain {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource()
    this.sources.push(source)
    return source
  }
  async resume(): Promise<void> {
    this.calls.push('resume')
    if (!this.refuseResume) this.state = 'running'
  }
  async suspend(): Promise<void> {
    this.calls.push('suspend')
    this.state = 'suspended'
  }
  async close(): Promise<void> {
    this.calls.push('close')
    this.state = 'closed'
  }
}

/** A decoded sound of `seconds` that the players can schedule (they only read `duration`). */
export function fakeBuffer(seconds: number): AudioBuffer {
  return { duration: seconds, length: Math.round(seconds * 48000), numberOfChannels: 2, sampleRate: 48000, getChannelData: () => new Float32Array(1) } as unknown as AudioBuffer
}
