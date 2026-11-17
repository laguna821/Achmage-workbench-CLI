import { describe, expect, it } from "vitest";
import type { SequencedEvent } from "@workbench/contracts";
import { createEventPump } from "./live-events.ts";

const delta = (seq: number, sessionId = "s1", text = String(seq)) => ({ type: "item.delta", sessionId, itemId: "a", textDelta: text, seq, at: seq }) as unknown as SequencedEvent;
const status = (seq: number, sessionId = "s1") => ({ type: "session.upserted", session: { id: sessionId, status: "idle" }, seq, at: seq }) as unknown as SequencedEvent;

/** A hand-run frame clock: `tick()` runs what was scheduled. */
function clock() {
  let pending: (() => void) | null = null;
  return { schedule: (run: () => void) => { pending = run; return () => { pending = null; }; }, tick: () => { const run = pending; pending = null; run?.(); }, get waiting() { return pending !== null; } };
}

describe("createEventPump (A4: one apply per frame; point 5: a conversation off screen gets status only)", () => {
  it("applies every event of a frame once, in arrival order", () => {
    const frame = clock(), applied: number[][] = [];
    const pump = createEventPump({ apply: (events) => applied.push(events.map((event) => event.seq)), parked: () => false, schedule: frame.schedule });
    for (const seq of [1, 2, 3]) pump.push(delta(seq));
    pump.push(status(4));
    expect(applied).toEqual([]);
    frame.tick();
    expect(applied).toEqual([[1, 2, 3, 4]]);
    pump.push(delta(5)); frame.tick();
    expect(applied).toEqual([[1, 2, 3, 4], [5]]);
  });

  it("flush() applies what is waiting at once (the end of a turn is not held back)", () => {
    const frame = clock(), applied: number[][] = [];
    const pump = createEventPump({ apply: (events) => applied.push(events.map((event) => event.seq)), parked: () => false, schedule: frame.schedule });
    pump.push(delta(1)); pump.push(status(2));
    pump.flush();
    expect(applied).toEqual([[1, 2]]);
    frame.tick();
    expect(applied).toEqual([[1, 2]]);
  });

  it("keeps the items of a conversation off screen aside; its status goes through", () => {
    const frame = clock(), applied: number[][] = [];
    const hidden = new Set(["s2"]);
    const pump = createEventPump({ apply: (events) => applied.push(events.map((event) => event.seq)), parked: (id) => hidden.has(id), schedule: frame.schedule });
    pump.push(delta(1, "s2")); pump.push(delta(2, "s1")); pump.push(delta(3, "s2")); pump.push(status(4, "s2"));
    frame.tick();
    expect(applied).toEqual([[2, 4]]);
    expect(pump.isParked("s2")).toBe(true);
    expect(pump.isParked("s1")).toBe(false);
    // Shown again: everything that arrived is applied, in its order, before what came after.
    hidden.delete("s2");
    pump.push(delta(5, "s1"));
    pump.unpark("s2");
    expect(applied).toEqual([[2, 4], [1, 3, 5]]);
    expect(pump.isParked("s2")).toBe(false);
    expect(frame.waiting).toBe(false);
  });

  it("says once when a conversation's items start to wait, and which one is shown again", () => {
    const frame = clock(), asides: string[] = [], shown: (string | undefined)[] = [];
    let hidden = true;
    const pump = createEventPump({ apply: (_events, id) => shown.push(id), parked: () => hidden, onAside: (id) => asides.push(id), schedule: frame.schedule });
    pump.push(delta(1)); pump.push(delta(2));
    expect(asides).toEqual(["s1"]);
    hidden = false; pump.unpark("s1");
    expect(shown).toEqual(["s1"]);
  });

  it("an event of a parked conversation that arrives after it is shown goes the normal way", () => {
    const frame = clock(), applied: number[][] = [];
    let hidden = true;
    const pump = createEventPump({ apply: (events) => applied.push(events.map((event) => event.seq)), parked: () => hidden, schedule: frame.schedule });
    pump.push(delta(1)); frame.tick();
    hidden = false; pump.unpark("s1");
    pump.push(delta(2)); frame.tick();
    expect(applied).toEqual([[1], [2]]);
  });

  it("reset() forgets what was parked (a resync reloads everything)", () => {
    const frame = clock(), applied: number[][] = [];
    const pump = createEventPump({ apply: (events) => applied.push(events.map((event) => event.seq)), parked: () => true, schedule: frame.schedule });
    pump.push(delta(1)); pump.reset(); pump.unpark("s1"); frame.tick();
    expect(applied).toEqual([]);
    expect(pump.isParked("s1")).toBe(false);
  });

  it("a long hidden run is applied in one batch every `limit` events, so the waiting list stays bounded", () => {
    const frame = clock(), applied: number[][] = [];
    const pump = createEventPump({ apply: (events) => applied.push(events.map((event) => event.seq)), parked: () => true, schedule: frame.schedule, limit: 3 });
    for (const seq of [1, 2, 3, 4]) pump.push(delta(seq));
    frame.tick();
    expect(applied).toEqual([[1, 2, 3]]);
    expect(pump.isParked("s1")).toBe(true);
  });

  it("an apply that throws loses nothing that came after it", () => {
    const frame = clock(), applied: number[][] = [];
    let fail = true;
    const pump = createEventPump({ apply: (events) => { if (fail) { fail = false; throw new Error("x"); } applied.push(events.map((event) => event.seq)); }, parked: () => false, schedule: frame.schedule });
    pump.push(delta(1));
    expect(() => frame.tick()).toThrow("x");
    pump.push(delta(2)); frame.tick();
    expect(applied).toEqual([[2]]);
  });
});
