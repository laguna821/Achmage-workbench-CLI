import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

// Writing while the engine works: steering into the running turn, or waiting for it to end.

class HeldEngine implements ProviderAdapter {
  readonly provider = "claude" as const;
  sent: string[] = [];
  steered: string[] = [];
  canSteer = true;
  private readonly sink: () => AdapterSink;
  private current: { sessionId: string; key: string } | null = null;
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
    this.current = { sessionId: session.id, key: turnKey };
    this.sink().updateSession(session.id, { status: "running", activity: "응답 중" });
  }
  steeredKeys: string[] = [];
  async steer(_session: Session, _work: Work, text: string, turnKey: string) {
    if (!this.canSteer || !this.current) return false;
    this.steered.push(text);
    this.steeredKeys.push(turnKey);
    return true;
  }
  /** The running turn ends (as the engine reports it). */
  finish(status: "completed" | "interrupted" | "failed" = "completed") {
    const turn = this.current!;
    this.current = null;
    this.sink().upsertItem(turn.sessionId, { kind: "turnEnd", id: `end:${turn.key}`, status, durationMs: 1, at: Date.now() });
    this.sink().updateSession(turn.sessionId, { status: "idle", activity: null });
  }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) {
    return false;
  }
  async shutdown() {}
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-steer-"));
  dirs.push(dir);
  const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works") });
  const engine = new HeldEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const work = manager.createWork({ title: "w" });
  const session = manager.createSession(work.id, { provider: "claude" });
  return { manager, engine, session };
}

const tick = () => new Promise((done) => setTimeout(done, 5));
const sessionOf = (manager: SessionManager, id: string) => manager.snapshot().sessions.find((entry) => entry.id === id)!;

describe("writing while the engine works", () => {
  it("steers a request into the running turn and shows it in the conversation", async () => {
    const { manager, engine, session } = setup();
    await manager.send(session.id, "r1", "보고서를 써 줘");
    const result = await manager.send(session.id, "r2", "표는 빼고 써 줘");
    expect(result).toEqual({ duplicate: false, delivery: "steered" });
    expect(engine.steered).toEqual(["표는 빼고 써 줘"]);
    expect(manager.items(session.id).items.find((item) => item.id === "user:r2")).toMatchObject({ kind: "user", steered: true });
    expect(await manager.send(session.id, "r2", "표는 빼고 써 줘")).toMatchObject({ duplicate: true });
  });

  it("queues a request for after the turn and sends it as the next turn", async () => {
    const { manager, engine, session } = setup();
    await manager.send(session.id, "r1", "첫 요청");
    expect(await manager.send(session.id, "r2", "끝나면 이것도", [], null, null, "queue")).toEqual({ duplicate: false, delivery: "queued" });
    expect(sessionOf(manager, session.id).queued.map((entry) => entry.text)).toEqual(["끝나면 이것도"]);
    engine.finish();
    await tick();
    expect(engine.sent).toEqual(["첫 요청", "끝나면 이것도"]);
    expect(sessionOf(manager, session.id).queued).toEqual([]);
  });

  it("waits when the engine cannot steer, or while an approval is pending", async () => {
    const { manager, engine, session } = setup();
    engine.canSteer = false;
    await manager.send(session.id, "r1", "첫 요청");
    expect((await manager.send(session.id, "r2", "덧붙임")).delivery).toBe("queued");
    engine.canSteer = true;
    manager.sink.updateSession(session.id, { status: "awaitingApproval" });
    expect((await manager.send(session.id, "r3", "승인 중 덧붙임")).delivery).toBe("queued");
    expect(sessionOf(manager, session.id).queued.map((entry) => entry.id)).toEqual(["r2", "r3"]);
  });

  it("keeps waiting requests after a stop until the user sends them; they can be edited or dropped", async () => {
    const { manager, engine, session } = setup();
    await manager.send(session.id, "r1", "첫 요청");
    await manager.send(session.id, "r2", "둘째", [], null, null, "queue");
    await manager.send(session.id, "r3", "셋째", [], null, null, "queue");
    engine.finish("interrupted");
    await tick();
    expect(engine.sent).toEqual(["첫 요청"]);
    expect(manager.items(session.id).items.some((item) => item.kind === "notice" && item.text.includes("보낼 예정인 요청 2개"))).toBe(true);
    manager.updateQueued(session.id, "r2", "둘째(고침)");
    manager.cancelQueued(session.id, "r3");
    expect((await manager.sendQueued(session.id, "r2")).delivery).toBe("turn");
    expect(engine.sent).toEqual(["첫 요청", "둘째(고침)"]);
    expect(sessionOf(manager, session.id).queued).toEqual([]);
  });

  it("kept requests stay kept when the user goes on: only requests queued since follow the turn", async () => {
    const { manager, engine, session } = setup();
    await manager.send(session.id, "r1", "첫 요청");
    await manager.send(session.id, "r2", "멈추기 전에 예약", [], null, null, "queue");
    engine.finish("interrupted");
    await tick();
    expect(sessionOf(manager, session.id).queued).toMatchObject([{ id: "r2", held: true }]);
    // The user goes on with something else and queues one more behind it.
    await manager.send(session.id, "r3", "다른 요청");
    await manager.send(session.id, "r4", "이것도 끝나면", [], null, null, "queue");
    engine.finish();
    await tick();
    expect(engine.sent).toEqual(["첫 요청", "다른 요청", "이것도 끝나면"]);
    engine.finish();
    await tick();
    expect(sessionOf(manager, session.id).queued.map((entry) => entry.id)).toEqual(["r2"]);
    expect(engine.sent).toHaveLength(3);
  });

  it("a stop that drops a steered request marks it and keeps it waiting above the input", async () => {
    const { manager, engine, session } = setup();
    await manager.send(session.id, "r1", "첫 요청");
    await manager.send(session.id, "r2", "방향을 바꿔 줘");
    // The engine reports the steered request it dropped when the turn stopped.
    manager.sink.steerDropped(session.id, engine.steeredKeys);
    engine.finish("interrupted");
    await tick();
    expect(manager.items(session.id).items.find((item) => item.id === "user:r2")).toMatchObject({ steered: true, undelivered: true });
    const waiting = sessionOf(manager, session.id).queued;
    expect(waiting.map((entry) => entry.text)).toEqual(["방향을 바꿔 줘"]);
    expect(manager.items(session.id).items.some((item) => item.kind === "notice" && item.text.includes("작업 중에 보낸 요청 1개"))).toBe(true);
    // Held, not sent on its own; sent again by hand under a new request id.
    expect(engine.sent).toEqual(["첫 요청"]);
    expect((await manager.sendQueued(session.id, waiting[0]!.id)).delivery).toBe("turn");
    expect(engine.sent).toEqual(["첫 요청", "방향을 바꿔 줘"]);
    // Unknown keys (never steered, or from an earlier turn) are ignored.
    manager.sink.steerDropped(session.id, ["nope", "r2"]);
    expect(sessionOf(manager, session.id).queued).toEqual([]);
  });
});
