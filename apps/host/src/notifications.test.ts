import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AttentionPayload, Session, TranscriptItem } from "@workbench/contracts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { Notifications } from "./notifications.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(deliver?: (payload: AttentionPayload) => Promise<{ status: "sent" | "unavailable" | "unknown" }>) {
  const dir = mkdtempSync(join(tmpdir(), "wb-attention-")), store = new Store(join(dir, "state.sqlite")), bus = new EventBus();
  let now = 1000, hidden = false, enabled = true;
  const session: Session = { id: "child", workId: "work", workspaceId: "space", hostId: "host", nativeSessionId: "native-child", provider: "codex",
    purpose: "PRIVATE DOCUMENT NAME", purposeSource: "user", model: null, effort: null, engineModel: null, engineEffort: null, preview: "PRIVATE REPLY", previewAt: null,
    status: "running", activity: "실행 중", lastError: null, pinned: false, sort: 0, archivedAt: null, seenAt: null, unread: false,
    queued: [], access: null, context: null, createdAt: 1, updatedAt: 2, documentAgent: { artifactId: "artifact", parentSessionId: "main" } };
  const items: TranscriptItem[] = [{ kind: "user", id: "user:request", text: "PRIVATE PROMPT", at: 1 }];
  const hooks = { hostId: "host", session: (id: string) => id === session.id ? session : undefined, items: () => items,
    hidden: () => hidden, enabled: () => enabled, now: () => now, deliver };
  store.setMeta("task-parent:child/request", JSON.stringify("main/parent-request"));
  const service = new Notifications(store, bus, hooks);
  cleanup.push(() => { service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const publish = async (item: TranscriptItem) => {
    const index = items.findIndex(value => value.id === item.id);
    if (index < 0) items.push(item); else items[index] = item;
    bus.publish({ type: "item.upserted", sessionId: session.id, item }); await settle();
  };
  const end = (id = "done", status: "completed" | "failed" = "completed") => publish({ kind: "turnEnd", id, status, durationMs: 5, requestId: "request", at: now });
  return { store, bus, service, session, hooks, items, publish, end, advance: () => { now += 41_000; }, hide: () => { hidden = true; }, disable: () => { enabled = false; } };
}

it("produces once with no UI, keeps exact child/run identity and sends no sensitive text", async () => {
  const deliver = vi.fn(async (_payload: AttentionPayload) => ({ status: "sent" as const }));
  const f = fixture(deliver), sequence: number[] = [];
  f.bus.subscribe(event => sequence.push(event.seq));
  await f.end(); await f.end();
  expect(f.service.list().events).toHaveLength(1);
  expect(deliver).toHaveBeenCalledTimes(1);
  const row = f.service.list().events[0]!;
  expect(row).toMatchObject({ delivery: "sent", readAt: null, taskRef: { runId: "child/request", parentRunId: "main/parent-request", executorKind: "office" } });
  expect(JSON.stringify(deliver.mock.calls[0])).not.toContain("PRIVATE");
  expect(f.service.target(row.id)).toMatchObject({ artifactId: "artifact", sessionId: "child", itemId: "done", hostId: "host" });
  expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
  f.service.close();
  const restored = new Notifications(f.store, f.bus, f.hooks); cleanup.push(() => restored.close());
  await f.end(); expect(restored.list().unread).toBe(1); expect(deliver).toHaveBeenCalledTimes(1);
});

it("expires screen presence and keeps pending approval after an idempotent read", async () => {
  const deliver = vi.fn(async (_payload: AttentionPayload) => ({ status: "sent" as const }));
  const f = fixture(deliver);
  f.service.observe({ clientId: "window-1", sessionId: "child", visible: true });
  await f.end("visible"); expect(f.service.list().events[0]).toMatchObject({ delivery: "suppressed", readAt: 1000 });
  f.advance();
  const approval: TranscriptItem = { kind: "approval", id: "approval", title: "PRIVATE COMMAND", detail: null, reason: null, decision: null, at: 42000 };
  await f.publish(approval);
  const row = f.service.list().events.find(value => value.kind === "input_needed")!;
  expect(deliver).toHaveBeenCalledTimes(1);
  const first = f.service.read(row.id); f.advance();
  expect(f.service.read(row.id)).toEqual(first);
  expect(first.resolvedAt).toBeNull(); expect(f.items.find(item => item.kind === "approval")).toMatchObject({ decision: null });
  await f.publish({ ...approval, decision: "accept" });
  expect(f.service.list().events.find(value => value.id === row.id)?.resolvedAt).not.toBeNull();
  expect(deliver).toHaveBeenCalledTimes(1);
});

it("does not retry uncertain OS delivery after restart and admits one unavailable fallback", async () => {
  const deliver = vi.fn((_payload: AttentionPayload) => new Promise<{ status: "sent" }>(() => {}));
  const f = fixture(deliver); await f.end();
  expect(f.service.list().events[0]?.delivery).toBe("pending"); f.service.close();
  const restored = new Notifications(f.store, f.bus, f.hooks); cleanup.push(() => restored.close());
  const row = restored.list().events[0]!;
  expect(row.delivery).toBe("unknown"); expect(restored.claim(row.id, "window-2").claimed).toBe(false);
  await f.end(); expect(deliver).toHaveBeenCalledTimes(1);
  const g = fixture(); await g.end();
  const fallback = g.service.list().events[0]!;
  expect(g.service.claim(fallback.id, "one")).toMatchObject({ claimed: true, payload: { attentionId: fallback.id } });
  expect(g.service.claim(fallback.id, "two")).toEqual({ claimed: false, payload: null });
});

it("honours muted/off settings, ignores archived imports and refuses hidden or foreign targets", async () => {
  const deliver = vi.fn(async (_payload: AttentionPayload) => ({ status: "sent" as const }));
  const f = fixture(deliver); f.session.muted = true; await f.end("muted");
  f.session.muted = false; f.disable(); await f.end("off", "failed");
  expect(deliver).not.toHaveBeenCalled();
  expect(f.service.list().events.map(row => row.delivery)).toEqual(["suppressed", "suppressed"]);
  f.session.importedHistory = { kind: "archive", provider: "codex", nativeSessionId: "archive", sourceUpdatedAt: 1, importedAt: 2, continuedAt: null };
  await f.end("archived-import"); expect(f.service.list().events).toHaveLength(2);
  const id = f.service.list().events[0]!.id;
  f.session.hostId = "foreign"; expect(() => f.service.target(id)).toThrow("이 호스트");
  f.session.hostId = "host"; f.hide(); expect(f.service.list().events).toEqual([]); expect(() => f.service.read(id)).toThrow("이 호스트");
});
