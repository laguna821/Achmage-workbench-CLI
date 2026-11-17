import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "./bus.ts";
import { streamEvents, SSE_MAX_BUFFERED } from "./http.ts";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** A response whose reader takes `drains` bytes away only when told (a frozen client takes none). */
function fakeClient() {
  const req = new EventEmitter() as IncomingMessage;
  const res = new EventEmitter() as ServerResponse & { chunks: string[]; buffered: number; destroyed: boolean; drain(): void };
  Object.assign(res, {
    chunks: [] as string[], buffered: 0, destroyed: false,
    writeHead() { return res; },
    write(chunk: string) { res.chunks.push(chunk); res.buffered += Buffer.byteLength(chunk); return res.buffered < 64 * 1024; },
    destroy() { res.destroyed = true; req.emit("close"); return res; },
    drain() { res.buffered = 0; res.emit("drain"); },
  });
  Object.defineProperty(res, "writableLength", { get: () => res.buffered });
  return { req, res };
}

describe("the event stream (B8)", () => {
  it("serialises each event once for all clients", () => {
    const bus = new EventBus();
    const a = fakeClient(), b = fakeClient();
    streamEvents(a.req, a.res, bus, 0);
    streamEvents(b.req, b.res, bus, 0);
    const stringify = vi.spyOn(JSON, "stringify");
    bus.publish({ type: "item.delta", sessionId: "s", itemId: "i", textDelta: "안녕" });
    expect(stringify.mock.calls.filter(([value]) => (value as { type?: string })?.type === "item.delta")).toHaveLength(1);
    expect(a.res.chunks.at(-1)).toBe(b.res.chunks.at(-1));
  });

  it("a client that does not drain is dropped (its reconnect replays or resyncs) instead of growing the gateway", () => {
    const bus = new EventBus();
    const frozen = fakeClient(), live = fakeClient();
    streamEvents(frozen.req, frozen.res, bus, 0);
    streamEvents(live.req, live.res, bus, 0);
    const text = "가".repeat(20_000);
    for (let index = 0; index < 400 && !frozen.res.destroyed; index++) {
      bus.publish({ type: "item.delta", sessionId: "s", itemId: "i", textDelta: text });
      live.res.drain();
    }
    expect(frozen.res.destroyed).toBe(true);
    expect(frozen.res.buffered).toBeLessThanOrEqual(SSE_MAX_BUFFERED + 200_000);
    // Dropped: it gets nothing more; the live one keeps going.
    const before = frozen.res.chunks.length;
    bus.publish({ type: "item.delta", sessionId: "s", itemId: "i", textDelta: "끝" });
    expect(frozen.res.chunks.length).toBe(before);
    expect(live.res.destroyed).toBe(false);
    expect(live.res.chunks.at(-1)).toContain("끝");
  });

  it("a client that stays behind (not draining for a while) is dropped even below the limit", () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const slow = fakeClient();
    streamEvents(slow.req, slow.res, bus, 0);
    // Fill past the socket's own buffer so a write says "wait".
    bus.publish({ type: "item.delta", sessionId: "s", itemId: "i", textDelta: "가".repeat(30_000) });
    expect(slow.res.destroyed).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(slow.res.destroyed).toBe(true);
  });

  it("a client that drains in time stays", () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const ok = fakeClient();
    streamEvents(ok.req, ok.res, bus, 0);
    bus.publish({ type: "item.delta", sessionId: "s", itemId: "i", textDelta: "가".repeat(30_000) });
    vi.advanceTimersByTime(5_000);
    ok.res.drain();
    vi.advanceTimersByTime(120_000);
    expect(ok.res.destroyed).toBe(false);
  });
});
