import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { HttpError, SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

class FakeAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;
  sent: string[] = [];
  private readonly sink: () => AdapterSink;
  constructor(sink: () => AdapterSink) {
    this.sink = sink;
  }
  async init() {}
  status(): ProviderStatus {
    return emptyStatus("claude");
  }
  async refreshStatus() {
    return this.status();
  }
  async login() {
    return { url: null, message: "" };
  }
  async send(session: Session, _work: Work, text: string, turnKey: string) {
    this.sent.push(text);
    this.sink().updateSession(session.id, { nativeSessionId: "native-1", status: "running" });
    this.sink().upsertItem(session.id, { kind: "assistant", id: `a:${turnKey}`, text: "", streaming: true, at: 1 });
    this.sink().delta(session.id, `a:${turnKey}`, "ok");
  }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) {
    return false;
  }
  async shutdown() {}
}

function setup(dir = mkdtempSync(join(tmpdir(), "wb-test-"))) {
  const store = new Store(join(dir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works") });
  const adapter = new FakeAdapter(() => manager.sink);
  manager.registerAdapter(adapter);
  return { dir, store, bus, manager, adapter };
}

describe("SessionManager", () => {
  it("creates a managed folder when a work starts without one", () => {
    const { manager, dir } = setup();
    const work = manager.createWork({ title: "강의" });
    expect(work.cwdManaged).toBe(true);
    expect(work.cwd.startsWith(join(dir, "works"))).toBe(true);
  });

  it("never sends the same requestId twice and rejects a reused id with different text", async () => {
    const { manager, adapter } = setup();
    const work = manager.createWork({ title: "w" });
    const session = manager.createSession(work.id, { provider: "claude" });
    await manager.send(session.id, "r1", "hello");
    manager.sink.updateSession(session.id, { status: "idle" });
    expect(await manager.send(session.id, "r1", "hello")).toEqual({ duplicate: true });
    await expect(manager.send(session.id, "r1", "different")).rejects.toBeInstanceOf(HttpError);
    expect(adapter.sent).toEqual(["hello"]);
  });

  it("refuses a new message while the session is still answering", async () => {
    const { manager } = setup();
    const work = manager.createWork({ title: "w" });
    const session = manager.createSession(work.id, { provider: "claude" });
    await manager.send(session.id, "r1", "first");
    await expect(manager.send(session.id, "r2", "second")).rejects.toMatchObject({ code: "session_busy" });
  });

  it("keeps model and reasoning effort per session and clears them back to the engine default", () => {
    const { manager } = setup();
    const work = manager.createWork({ title: "w" });
    const session = manager.createSession(work.id, { provider: "claude", model: "opus", effort: "high" });
    expect(session).toMatchObject({ model: "opus", effort: "high", purpose: "대화 1" });
    expect(manager.updateSession(session.id, { effort: "max" })).toMatchObject({ model: "opus", effort: "max" });
    expect(manager.updateSession(session.id, { model: null, effort: null })).toMatchObject({ model: null, effort: null });
    expect(() => manager.updateSession(session.id, { purpose: "  " })).toThrow(HttpError);
  });

  it("persists streamed text and shows interrupted work as stopped after a restart", async () => {
    const first = setup();
    const work = first.manager.createWork({ title: "w" });
    const session = first.manager.createSession(work.id, { provider: "claude" });
    await first.manager.send(session.id, "r1", "hello");
    await first.manager.shutdown();
    first.store.close();

    const second = setup(first.dir);
    const restored = second.manager.snapshot().sessions.find((entry) => entry.id === session.id)!;
    expect(restored.status).toBe("idle");
    expect(restored.nativeSessionId).toBe("native-1");
    const items = second.manager.items(session.id).items;
    expect(items.find((item) => item.id === "a:r1")).toMatchObject({ text: "ok" });
    expect(items.at(-1)).toMatchObject({ kind: "notice", level: "info" });
  });
});

describe("EventBus", () => {
  it("replays missed events and asks for a resync when the gap is too old", () => {
    const bus = new EventBus(3);
    for (let index = 0; index < 5; index += 1) bus.publish({ type: "folder.upserted", folder: { id: String(index), parentId: null, name: "f", sort: 0 } });
    expect(bus.replay(3)?.map((event) => event.seq)).toEqual([4, 5]);
    expect(bus.replay(0)).toBeNull();
    expect(bus.replay(5)).toEqual([]);
  });
});
