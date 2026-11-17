import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalDecision, ProviderStatus, ResourceState, Session, Work } from "@workbench/contracts";
import { EventBus } from "../bus.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "../providers/types.ts";
import { GiB, type MachineFacts } from "./core.ts";

// Every new turn asks the resource manager for a slot. These run the real SessionManager over a stand-in
// engine: what waits, in which order, what starts when a slot frees, a restart in the middle, and what
// never waits. A waiting request is never lost and never started twice.

class Engine implements ProviderAdapter {
  readonly provider = "claude" as const;
  /** Every request the engine was handed, by request id (a second start of one would show twice). */
  started: string[] = [];
  closedIdle = 0;
  private readonly sink: () => AdapterSink;
  private readonly turns = new Map<string, string>();
  constructor(sink: () => AdapterSink) { this.sink = sink; }
  async init() {}
  status(): ProviderStatus { return emptyStatus("claude"); }
  async refreshStatus() { return this.status(); }
  async login() { return { url: null, message: "" }; }
  async send(session: Session, _work: Work, _text: string, turnKey: string) {
    this.started.push(turnKey);
    this.turns.set(session.id, turnKey);
    this.sink().updateSession(session.id, { status: "running", activity: "응답 중" });
  }
  async steer(session: Session) { return this.turns.has(session.id); }
  finish(sessionId: string) {
    const key = this.turns.get(sessionId)!;
    this.turns.delete(sessionId);
    this.sink().upsertItem(sessionId, { kind: "turnEnd", id: `end:${key}`, status: "completed", durationMs: 1, at: Date.now() });
    this.sink().updateSession(sessionId, { status: "idle", activity: null });
  }
  closeIdleEngines() { this.closedIdle++; return 0; }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) { return true; }
  async shutdown() {}
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const roomy: MachineFacts = { totalBytes: 64 * GiB, availableBytes: 48 * GiB, cores: 16 };

function open(dir: string, facts: () => MachineFacts = () => roomy) {
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const states: ResourceState[] = [];
  bus.subscribe((event) => { if (event.type === "resources.changed") states.push(event.state); });
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir, resources: { facts, manualClock: true, trees: async () => [] } });
  const engine = new Engine(() => manager.sink);
  manager.registerAdapter(engine);
  return { store, manager, engine, states };
}

function setup(count: number, facts?: () => MachineFacts) {
  const dir = mkdtempSync(join(tmpdir(), "wb-admission-"));
  dirs.push(dir);
  const opened = open(dir, facts);
  const work = opened.manager.createWork({ title: "강의" });
  mkdirSync(work.cwd, { recursive: true });
  const sessions = Array.from({ length: count }, (_, index) => opened.manager.createSession(work.id, { provider: "claude", purpose: `대화 ${index + 1}` } as never));
  return { dir, work, sessions, ...opened };
}

const session = (manager: SessionManager, id: string) => manager.snapshot().sessions.find((entry) => entry.id === id)!;
const settle = () => new Promise((done) => setTimeout(done, 5));

describe("admission and the line", () => {
  it("limit 2: five asked → two run, three wait in order with their places; one ends → the next starts", async () => {
    const { manager, engine, sessions } = setup(5);
    manager.resources.updateSettings({ mode: "manual", manual: 2 });
    const results = [];
    for (const [index, entry] of sessions.entries()) results.push(await manager.send(entry.id, `r${index + 1}`, `요청 ${index + 1}`));
    expect(results.map((result) => result.delivery)).toEqual(["turn", "turn", "queued", "queued", "queued"]);
    expect(results[2]!.waitingFor).toBe("slot");
    expect(engine.started).toEqual(["r1", "r2"]);
    const state = manager.resources.state();
    expect(state.limit).toBe(2);
    expect(state.running.map((turn) => turn.sessionId)).toEqual([sessions[0]!.id, sessions[1]!.id]);
    expect(state.waiting.map((entry) => [entry.requestId, entry.position])).toEqual([["r3", 1], ["r4", 2], ["r5", 3]]);
    expect(state.reason).toBe("지금 동시에 2개까지 돌리고 있습니다");
    expect(session(manager, sessions[2]!.id).queued).toMatchObject([{ id: "r3", slot: true }]);

    engine.finish(sessions[0]!.id);
    await vi.waitFor(() => expect(engine.started).toEqual(["r1", "r2", "r3"]));
    await settle();
    expect(session(manager, sessions[2]!.id).queued).toEqual([]);
    expect(manager.resources.state().waiting.map((entry) => entry.requestId)).toEqual(["r4", "r5"]);
    // 활동 › 기록: the request that waited in the line says how long (the ones that started at once say nothing).
    const waited = manager.items(sessions[2]!.id).items.find((item) => item.kind === "user");
    expect(waited?.kind === "user" && typeof waited.waitedMs).toBe("number");
    expect(manager.items(sessions[0]!.id).items.find((item) => item.kind === "user")).not.toHaveProperty("waitedMs");
    // Nothing more than the limit started.
    expect(engine.started).toHaveLength(3);
  });

  it("the conversation on screen goes first; then the order asked", async () => {
    const { manager, engine, sessions } = setup(4);
    manager.resources.updateSettings({ mode: "manual", manual: 1 });
    for (const [index, entry] of sessions.entries()) await manager.send(entry.id, `r${index + 1}`, `요청 ${index + 1}`);
    manager.setShown("window-1", [sessions[3]!.id]);
    expect(manager.resources.state().waiting.map((entry) => entry.requestId)).toEqual(["r4", "r2", "r3"]);
    engine.finish(sessions[0]!.id);
    await vi.waitFor(() => expect(engine.started).toEqual(["r1", "r4"]));
  });

  it("지금 바로 실행 starts at once, counts as running, and is the person's key only", async () => {
    const { manager, engine, sessions } = setup(3);
    manager.resources.updateSettings({ mode: "manual", manual: 1 });
    for (const [index, entry] of sessions.entries()) await manager.send(entry.id, `r${index + 1}`, `요청 ${index + 1}`);
    // The ordinary "지금 보내기" asks for a slot like any start: it keeps waiting.
    expect((await manager.sendQueued(sessions[2]!.id, "r3")).delivery).toBe("queued");
    expect(engine.started).toEqual(["r1"]);
    const result = await manager.runNow(sessions[2]!.id, "r3");
    expect(result.delivery).toBe("turn");
    expect(engine.started).toEqual(["r1", "r3"]);
    expect(manager.resources.state().running).toMatchObject([{ sessionId: sessions[0]!.id, forced: false }, { sessionId: sessions[2]!.id, forced: true }]);
    // r2 still waits: the forced one holds a slot too.
    engine.finish(sessions[0]!.id);
    await settle();
    expect(engine.started).toEqual(["r1", "r3"]);
    engine.finish(sessions[2]!.id);
    await vi.waitFor(() => expect(engine.started).toEqual(["r1", "r3", "r2"]));
  });

  it("a restart in the middle: the waiting are still waiting, in order, then they run — each once", async () => {
    const first = setup(4);
    first.manager.resources.updateSettings({ mode: "manual", manual: 2 });
    for (const [index, entry] of first.sessions.entries()) await first.manager.send(entry.id, `r${index + 1}`, `요청 ${index + 1}`);
    expect(first.engine.started).toEqual(["r1", "r2"]);
    first.store.close();
    // The app comes back: the running turns are stopped by the restart, the two waiting are not held.
    const again = open(first.dir);
    await vi.waitFor(() => expect(again.engine.started).toEqual(["r3", "r4"]));
    await settle();
    for (const entry of first.sessions) expect(session(again.manager, entry.id).queued).toEqual([]);
    const users = first.sessions.map((entry) => again.manager.items(entry.id).items.filter((item) => item.kind === "user").map((item) => item.id));
    expect(users).toEqual([["user:r1"], ["user:r2"], ["user:r3"], ["user:r4"]]);
    // The limit came back with the settings.
    expect(again.manager.resources.settings()).toMatchObject({ mode: "manual", manual: 2 });
  });

  it("stopping all work (the app closing): nothing more starts, and the waiting keep their place for the restart", async () => {
    const first = setup(3);
    first.manager.resources.updateSettings({ mode: "manual", manual: 1 });
    for (const [index, entry] of first.sessions.entries()) await first.manager.send(entry.id, `r${index + 1}`, `요청 ${index + 1}`);
    first.manager.resources.suspend();
    first.engine.finish(first.sessions[0]!.id);
    await settle();
    expect(first.engine.started).toEqual(["r1"]);
    expect(session(first.manager, first.sessions[1]!.id).queued).toMatchObject([{ id: "r2", slot: true }]);
    expect(session(first.manager, first.sessions[1]!.id).queued[0]!.held).toBeFalsy();
    first.store.close();
    const again = open(first.dir);
    await vi.waitFor(() => expect(again.engine.started).toEqual(["r2"]));
  });

  it("a request kept behind a conversation's own turn is still held after a restart, as before", async () => {
    const first = setup(1);
    await first.manager.send(first.sessions[0]!.id, "r1", "요청 1");
    expect((await first.manager.send(first.sessions[0]!.id, "r2", "요청 2", [], null, null, "queue")).delivery).toBe("queued");
    first.store.close();
    const again = open(first.dir);
    await settle();
    expect(again.engine.started).toEqual([]);
    expect(session(again.manager, first.sessions[0]!.id).queued).toMatchObject([{ id: "r2", held: true }]);
  });

  it("never twice: a turn end of the waiting conversation's neighbour and the line racing for the same request", async () => {
    const { manager, engine, sessions } = setup(3);
    manager.resources.updateSettings({ mode: "manual", manual: 1 });
    for (const [index, entry] of sessions.entries()) await manager.send(entry.id, `r${index + 1}`, `요청 ${index + 1}`);
    manager.resources.updateSettings({ mode: "manual", manual: 3 });
    manager.resources.pumpSoon();
    await manager.sendQueued(sessions[1]!.id, "r2").catch(() => null);
    await vi.waitFor(() => expect(new Set(engine.started)).toEqual(new Set(["r1", "r2", "r3"])));
    await settle();
    expect(engine.started).toHaveLength(3);
  });

  it("edit and drop of a waiting request work as before; the line moves", async () => {
    const { manager, engine, sessions } = setup(3);
    manager.resources.updateSettings({ mode: "manual", manual: 1 });
    for (const [index, entry] of sessions.entries()) await manager.send(entry.id, `r${index + 1}`, `요청 ${index + 1}`);
    manager.updateQueued(sessions[2]!.id, "r3", "고친 요청 3");
    manager.cancelQueued(sessions[1]!.id, "r2");
    expect(manager.resources.state().waiting.map((entry) => entry.requestId)).toEqual(["r3"]);
    engine.finish(sessions[0]!.id);
    await vi.waitFor(() => expect(engine.started).toEqual(["r1", "r3"]));
    expect(manager.items(sessions[2]!.id).items.find((item) => item.kind === "user")).toMatchObject({ text: "고친 요청 3" });
  });

  it("a new request of a conversation whose requests wait goes behind them", async () => {
    const { manager, engine, sessions } = setup(2);
    manager.resources.updateSettings({ mode: "manual", manual: 1 });
    await manager.send(sessions[0]!.id, "r1", "요청 1");
    await manager.send(sessions[1]!.id, "r2", "요청 2");
    expect((await manager.send(sessions[1]!.id, "r3", "요청 3")).delivery).toBe("queued");
    expect(session(manager, sessions[1]!.id).queued.map((entry) => entry.id)).toEqual(["r2", "r3"]);
    engine.finish(sessions[0]!.id);
    await vi.waitFor(() => expect(engine.started).toEqual(["r1", "r2"]));
    engine.finish(sessions[1]!.id);
    await vi.waitFor(() => expect(engine.started).toEqual(["r1", "r2", "r3"]));
  });
});

describe("what never waits", () => {
  it("a steer into a running turn and the plan's go-ahead pass while the line is full", async () => {
    const { manager, engine, sessions } = setup(3);
    manager.resources.updateSettings({ mode: "manual", manual: 1 });
    await manager.send(sessions[0]!.id, "r1", "요청 1");
    await manager.send(sessions[1]!.id, "r2", "요청 2");
    expect((await manager.send(sessions[0]!.id, "s1", "덧붙임")).delivery).toBe("steered");
    expect((await manager.send(sessions[2]!.id, "go-plan1", "계획대로 진행해 주세요.")).delivery).toBe("turn");
    expect(engine.started).toEqual(["r1", "go-plan1"]);
  });
});

describe("memory pressure", () => {
  it("stops admitting (but never below one), closes idle engines, asks the window to sleep tabs, recovers", async () => {
    let available = 300 * 1024 * 1024;
    const { manager, engine, sessions } = setup(3, () => ({ totalBytes: 8 * GiB, availableBytes: available, cores: 8 }));
    // Nothing runs: one may start even now.
    expect((await manager.send(sessions[0]!.id, "r1", "요청 1")).delivery).toBe("turn");
    expect(manager.resources.state()).toMatchObject({ pressure: true, sleepNow: 1 });
    expect(engine.closedIdle).toBe(1);
    expect((await manager.send(sessions[1]!.id, "r2", "요청 2")).delivery).toBe("queued");
    expect(manager.resources.state().reason).toBe("메모리가 부족해 잠시 기다립니다");
    // Memory is back (above the low mark with its margin): the line goes on by itself.
    available = 6 * GiB;
    manager.resources.sample();
    await vi.waitFor(() => expect(engine.started).toEqual(["r1", "r2"]));
    expect(manager.resources.state().pressure).toBe(false);
  });
});

describe("a document's AI (the editor's own 문서 AI) takes part", () => {
  it("waits for a slot in its turn-start, shows in the line, starts when one frees; a closed editor leaves the line", async () => {
    const { manager, engine, sessions } = setup(3);
    manager.resources.updateSettings({ mode: "manual", manual: 1 });
    // A free slot: given at once, synchronously.
    const free = manager.resources.waitDocument(sessions[2]!.id);
    expect(typeof free).toBe("function");
    (free as () => void)();
    await manager.send(sessions[0]!.id, "r1", "요청 1");
    const waiting = manager.resources.waitDocument(sessions[1]!.id);
    expect(waiting).toBeInstanceOf(Promise);
    const gone = new AbortController();
    const left = manager.resources.waitDocument(sessions[2]!.id, gone.signal);
    expect(manager.resources.state().waiting).toMatchObject([{ sessionId: sessions[1]!.id, kind: "document", requestId: null, position: 1 }, { sessionId: sessions[2]!.id, position: 2 }]);
    gone.abort();
    await expect(left).rejects.toThrow(/취소/);
    expect(manager.resources.state().waiting).toHaveLength(1);
    let admitted = false;
    void (waiting as Promise<() => void>).then(() => { admitted = true; });
    await settle();
    expect(admitted).toBe(false);
    engine.finish(sessions[0]!.id);
    await vi.waitFor(() => expect(admitted).toBe(true));
    // It holds the slot until its turn has started (then its conversation's status counts it).
    expect((await manager.send(sessions[2]!.id, "r3", "요청 3")).delivery).toBe("queued");
  });
});
