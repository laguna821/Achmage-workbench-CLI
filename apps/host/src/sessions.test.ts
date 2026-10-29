import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { HttpError, SessionManager, previewOf } from "./sessions.ts";
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
    expect(await manager.send(session.id, "r1", "hello")).toMatchObject({ duplicate: true });
    await expect(manager.send(session.id, "r1", "different")).rejects.toBeInstanceOf(HttpError);
    expect(adapter.sent).toEqual(["hello"]);
  });

  it("keeps a new message for after the turn while the session is still answering (an engine that cannot steer)", async () => {
    const { manager, adapter } = setup();
    const work = manager.createWork({ title: "w" });
    const session = manager.createSession(work.id, { provider: "claude" });
    await manager.send(session.id, "r1", "first");
    expect(await manager.send(session.id, "r2", "second")).toEqual({ duplicate: false, delivery: "queued" });
    expect(adapter.sent).toEqual(["first"]);
  });

  it("keeps model and reasoning effort per session and clears them back to the engine default", () => {
    const { manager } = setup();
    const work = manager.createWork({ title: "w" });
    const session = manager.createSession(work.id, { provider: "claude", model: "opus", effort: "high" });
    expect(session).toMatchObject({ model: "opus", effort: "high", purpose: "대화 1" });
    expect(manager.updateSession(session.id, { effort: "max" })).toMatchObject({ model: "opus", effort: "max" });
    expect(manager.updateSession(session.id, { model: null, effort: null })).toMatchObject({ model: null, effort: null });
    expect(manager.updateSession(session.id, { purpose: "  " }).purposeSource).toBe("auto");
  });

  it("titles sessions and works from their requests until a name is typed by hand", async () => {
    const { manager } = setup();
    const work = manager.createWork({ title: "임시 제목" });
    const session = manager.createSession(work.id, { provider: "claude" });
    const finish = (id: string) => {
      manager.sink.upsertItem(session.id, { kind: "turnEnd", id: `end:${id}`, status: "completed", durationMs: 1, at: Date.now() });
      manager.sink.updateSession(session.id, { status: "idle" });
    };
    await manager.send(session.id, "r1", "## 미디어 리터러시 과목 업데이트 계획을 세워보자");
    finish("r1");
    manager.sink.upsertItem(session.id, { kind: "assistant", id: "a:done", text: "**계획**은 `세 단계`입니다.", streaming: false, at: 2 });
    const snapshot = () => manager.snapshot();
    const current = () => snapshot().sessions.find((entry) => entry.id === session.id)!;
    expect(current()).toMatchObject({ purpose: "미디어 리터러시 과목 업데이트 계획", purposeSource: "auto", preview: "계획은 세 단계입니다." });
    expect(snapshot().works.find((entry) => entry.id === work.id)!.title).toBe("미디어 리터러시 과목 업데이트 계획");

    manager.updateSession(session.id, { purpose: "강의 개편" });
    await manager.send(session.id, "r2", "수업 계획서 초안 써줘");
    finish("r2");
    expect(current()).toMatchObject({ purpose: "강의 개편", purposeSource: "user" });

    // Clearing the name gives it back to the automatic title.
    expect(manager.updateSession(session.id, { purpose: "" }).purposeSource).toBe("auto");
    manager.updateWork(work.id, { title: "내 작업" });
    await manager.send(session.id, "r3", "수업 계획서 평가 기준 추가");
    finish("r3");
    expect(snapshot().works.find((entry) => entry.id === work.id)!).toMatchObject({ title: "내 작업", titleSource: "user" });
    expect(previewOf("a".repeat(400)).length).toBe(181);
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
    expect(items.find((item) => item.id === "a:r1")).toMatchObject({ text: "ok", streaming: false });
    expect(items.at(-2)).toMatchObject({ kind: "notice", level: "info" });
    // The cut turn ends with its cause (after the last thing it recorded), closing request r1.
    expect(items.at(-1)).toMatchObject({ kind: "turnEnd", status: "interrupted", cause: "restart", requestId: "r1" });
  });
});

describe("EventBus", () => {
  it("replays missed events and asks for a resync when the gap is too old", () => {
    const bus = new EventBus(3);
    for (let index = 0; index < 5; index += 1) bus.publish({ type: "folder.upserted", folder: { id: String(index), parentId: null, name: "f", sort: 0, archivedAt: null } });
    expect(bus.replay(3)?.map((event) => event.seq)).toEqual([4, 5]);
    expect(bus.replay(0)).toBeNull();
    expect(bus.replay(5)).toEqual([]);
  });
});
