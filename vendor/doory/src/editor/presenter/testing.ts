/** Test support: two or more in-memory endpoints on one name, standing in for `BroadcastChannel` instances. */
import type { ChannelLike } from './channel'

export function createChannelHub(): { create(): ChannelLike & { closed: boolean } } {
  const ends = new Set<MemoryChannel>()
  class MemoryChannel implements ChannelLike {
    listeners = new Set<(e: MessageEvent) => void>()
    closed = false
    constructor() {
      ends.add(this)
    }
    postMessage(message: unknown): void {
      for (const other of ends) {
        if (other === this || other.closed) continue
        // Blobs and everything else a message carries are passed by reference, like a structured clone would share them.
        for (const listener of other.listeners) listener({ data: message } as MessageEvent)
      }
    }
    addEventListener(_: 'message', listener: (e: MessageEvent) => void): void {
      this.listeners.add(listener)
    }
    removeEventListener(_: 'message', listener: (e: MessageEvent) => void): void {
      this.listeners.delete(listener)
    }
    close(): void {
      this.closed = true
      ends.delete(this)
    }
  }
  return { create: () => new MemoryChannel() }
}
