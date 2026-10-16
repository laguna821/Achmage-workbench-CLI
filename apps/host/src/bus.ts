import type { SequencedEvent, WorkbenchEvent } from "@workbench/contracts";

// Ordered event stream with a replay window so clients can reconnect with `since=seq`
// without missing or duplicating events. Older gaps force a snapshot reload.

type Listener = (event: SequencedEvent) => void;

export class EventBus {
  private seq = 0;
  private readonly buffer: SequencedEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly capacity: number;

  constructor(capacity = 5000) {
    this.capacity = capacity;
  }

  get currentSeq() {
    return this.seq;
  }

  publish(event: WorkbenchEvent): SequencedEvent {
    const sequenced = { ...event, seq: ++this.seq, at: Date.now() } as SequencedEvent;
    this.buffer.push(sequenced);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    for (const listener of this.listeners) {
      listener(sequenced);
    }
    return sequenced;
  }

  /** Events after `since`, or null when the window no longer covers that point. */
  replay(since: number): SequencedEvent[] | null {
    if (since >= this.seq) {
      return [];
    }
    const oldest = this.buffer[0]?.seq ?? this.seq + 1;
    if (since + 1 < oldest) {
      return null;
    }
    return this.buffer.filter((event) => event.seq > since);
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
