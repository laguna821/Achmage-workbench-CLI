import type { TranscriptItem } from "@workbench/contracts";

// 0.5.4: the gateway's own cost of many running conversations. Each item an engine reports was written to the
// database on its own (one write transaction per item). For a conversation that is running and out of sight of
// every attached window, a NEW VERSION OF AN ITEM ALREADY ON DISK THAT IS STILL IN PROGRESS — a streaming answer
// growing, a running command's output growing — may wait in this batch: one transaction per BATCH_MS or BATCH_MAX.
// Everything else is written at once, together with what its conversation has waiting (order kept): every item's
// first appearance (so a running command's output and an interrupted answer are on disk from their first piece),
// every finished item, the turn's end, an approval or a question, the person's request, a notice. With no window
// attached, or visibility unknown, nothing waits. A crash can lose at most the last BATCH_MS of such growth (the
// earlier version stays on disk) — the same as a streamed answer's text already could (`markDirty`).

export const BATCH_MS = 500;
export const BATCH_MAX = 200;

/** May this version wait? Only a newer version of an item already stored that is still in progress. */
export const mayWait = (item: TranscriptItem, stored: boolean) =>
  stored && ((item.kind === "assistant" && item.streaming) || (item.kind === "tool" && item.status === "running"));

type Timer = { cancel(): void };
export type BatchOptions = { setTimer?: (run: () => void, ms: number) => Timer };

export class ItemBatch {
  private readonly pending = new Map<string, [string, TranscriptItem]>();
  private readonly sessions = new Map<string, number>();
  private timer: Timer | null = null;
  private readonly write: (entries: [string, TranscriptItem][]) => void;
  private readonly setTimer: (run: () => void, ms: number) => Timer;
  constructor(write: (entries: [string, TranscriptItem][]) => void, options: BatchOptions = {}) {
    this.write = write;
    this.setTimer = options.setTimer ?? ((run, ms) => { const handle = setTimeout(run, ms); handle.unref?.(); return { cancel: () => clearTimeout(handle) }; });
  }
  get size() { return this.pending.size; }
  /** Pieces of this conversation wait to be written (its transcript must stay in the cache). */
  has(sessionId: string) { return (this.sessions.get(sessionId) ?? 0) > 0; }
  add(sessionId: string, item: TranscriptItem) {
    const key = `${sessionId}\u0000${item.id}`;
    const known = this.pending.get(key);
    // The latest copy, in the place it was first seen.
    if (known) known[1] = item;
    else { this.pending.set(key, [sessionId, item]); this.sessions.set(sessionId, (this.sessions.get(sessionId) ?? 0) + 1); }
    if (this.pending.size >= BATCH_MAX) { this.flush(); return; }
    this.timer ??= this.setTimer(() => { this.timer = null; this.flush(); }, BATCH_MS);
  }
  /** Everything waiting, emptied: the caller writes it (with its own item, in one transaction). */
  take(): [string, TranscriptItem][] {
    this.timer?.cancel();
    this.timer = null;
    const entries = [...this.pending.values()];
    this.pending.clear();
    this.sessions.clear();
    return entries;
  }
  /** What waits of one conversation, emptied (the rest keeps waiting). */
  takeSession(sessionId: string): [string, TranscriptItem][] {
    const entries: [string, TranscriptItem][] = [];
    for (const [key, entry] of this.pending) if (entry[0] === sessionId) { entries.push(entry); this.pending.delete(key); }
    this.sessions.delete(sessionId);
    if (!this.pending.size) { this.timer?.cancel(); this.timer = null; }
    return entries;
  }
  flush() {
    const entries = this.take();
    if (entries.length) this.write(entries);
  }
}
