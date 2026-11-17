import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalDecision, ProviderStatus, ResourceState, Session, Work } from "@workbench/contracts";
import { EventBus } from "../bus.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "../providers/types.ts";
import { DEFAULT_COST, GiB, MiB, type MachineFacts } from "./core.ts";
import { LADDER_STEP_MS } from "./ladder.ts";
import type { EngineSource } from "../app-memory.ts";
import type { EngineTree } from "./measure.ts";

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

type Extra = Partial<Pick<import("./manager.ts").ResourceOptions, "now" | "reclaim" | "probe" | "oom">>;

function open(dir: string, facts: () => MachineFacts = () => roomy, trees: (engines: EngineSource[]) => Promise<EngineTree[]> = async () => [], extra: Extra = {}) {
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const states: ResourceState[] = [];
  bus.subscribe((event) => { if (event.type === "resources.changed") states.push(event.state); });
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir, resources: { facts, manualClock: true, trees, probe: async () => null, ...extra } });
  const engine = new Engine(() => manager.sink);
  manager.registerAdapter(engine);
  return { store, manager, engine, states };
}

function setup(count: number, facts?: () => MachineFacts, trees?: (engines: EngineSource[]) => Promise<EngineTree[]>, extra?: Extra) {
  const dir = mkdtempSync(join(tmpdir(), "wb-admission-"));
  dirs.push(dir);
  const opened = open(dir, facts, trees, extra);
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
  it("in order, one rung per step: stops admitting (but never below one), closes idle engines, sleeps tabs, relieves the least urgent turn; recovers", async () => {
    let available = 300 * 1024 * 1024;
    let clock = 1_000;
    const reclaimed: { pid: number; bytes: number }[] = [];
    const trees = async (engines: EngineSource[]): Promise<EngineTree[]> => engines.map((source, index) => ({ source, pid: 500 + index, pids: [500 + index], bytes: 400 * MiB }));
    const { manager, engine, sessions } = setup(3, () => ({ totalBytes: 8 * GiB, availableBytes: available, cores: 8 }), trees, {
      now: () => clock,
      reclaim: async (pid, bytes) => { reclaimed.push({ pid, bytes }); return 200 * MiB; },
    });
    vi.spyOn(manager as unknown as { engineSources(): EngineSource[] }, "engineSources").mockImplementation(() => [{ provider: "claude", sessions: [{ id: sessions[0]!.id, title: "1" }], pid: 500, marker: null, idle: false }]);
    // Nothing runs: one may start even now. Rung 1 only: nothing closed, no tab slept yet.
    expect((await manager.send(sessions[0]!.id, "r1", "요청 1")).delivery).toBe("turn");
    expect(manager.resources.state()).toMatchObject({ pressure: true, stage: 1, sleepNow: 0 });
    expect(engine.closedIdle).toBe(0);
    expect((await manager.send(sessions[1]!.id, "r2", "요청 2")).delivery).toBe("queued");
    // Each rung after the step's time, never two at once.
    clock += LADDER_STEP_MS; manager.resources.sample();
    expect(manager.resources.state()).toMatchObject({ stage: 2, sleepNow: 0 });
    expect(engine.closedIdle).toBe(1);
    clock += LADDER_STEP_MS; manager.resources.sample();
    expect(manager.resources.state()).toMatchObject({ stage: 3, sleepNow: 1 });
    await manager.resources.measureTrees();
    clock += LADDER_STEP_MS; manager.resources.sample();
    await vi.waitFor(() => expect(manager.resources.state().running.find((turn) => turn.sessionId === sessions[0]!.id)?.relieved).toBe(true));
    expect(manager.resources.state().stage).toBe(4);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.pid).toBe(500);
    // Held at the top: nothing more happens while it stays there.
    clock += LADDER_STEP_MS * 3; manager.resources.sample();
    expect(engine.closedIdle).toBe(1);
    expect(manager.resources.state().sleepNow).toBe(1);
    expect(manager.resources.state().reason).toBe("메모리가 부족해 잠시 기다립니다");
    // Memory is back (above the low mark with its margin): the line goes on by itself.
    available = 6 * GiB;
    manager.resources.sample();
    await vi.waitFor(() => expect(engine.started).toEqual(["r1", "r2"]));
    expect(manager.resources.state()).toMatchObject({ pressure: false, stage: 0 });
  });
  it("the turn on screen is never the one picked to give memory back", async () => {
    const clock = 1_000;
    const reclaimed: number[] = [];
    const trees = async (engines: EngineSource[]): Promise<EngineTree[]> => engines.map((source, index) => ({ source, pid: 600 + index, pids: [600 + index], bytes: 300 * MiB }));
    const engines = (ids: string[]): EngineSource[] => ids.map((id, index) => ({ provider: "claude", sessions: [{ id, title: id }], pid: 600 + index, marker: null, idle: false }));
    const { manager, sessions } = setup(2, () => ({ totalBytes: 8 * GiB, availableBytes: 8 * GiB, cores: 8 }), trees, { now: () => clock, reclaim: async (pid) => { reclaimed.push(pid); return 0; } });
    vi.spyOn(manager as unknown as { engineSources(): EngineSource[] }, "engineSources").mockImplementation(() => engines(sessions.map((entry) => entry.id)));
    await manager.send(sessions[0]!.id, "r1", "요청 1");
    await manager.send(sessions[1]!.id, "r2", "요청 2");
    manager.setShown("window", [sessions[1]!.id]);
    await manager.resources.measureTrees();
    await manager.resources.relieve();
    expect(reclaimed).toEqual([600]);
    expect(manager.resources.state().running.filter((turn) => turn.relieved).map((turn) => turn.sessionId)).toEqual([sessions[0]!.id]);
  });
});

describe("what 활동 shows of a running turn (0.5.4)", () => {
  it("when it started and what its engine holds now (measured), else null", async () => {
    const clock = 42_000;
    const trees = async (engines: EngineSource[]): Promise<EngineTree[]> => engines.filter((source) => source.pid === 700).map((source) => ({ source, pid: 700, pids: [700], bytes: 380 * MiB }));
    const { manager, sessions } = setup(2, undefined, trees, { now: () => clock });
    vi.spyOn(manager as unknown as { engineSources(): EngineSource[] }, "engineSources").mockImplementation(() => [{ provider: "claude", sessions: [{ id: sessions[0]!.id, title: "1" }], pid: 700, marker: null, idle: false }]);
    await manager.send(sessions[0]!.id, "r1", "요청 1");
    await manager.send(sessions[1]!.id, "r2", "요청 2");
    await manager.resources.measureTrees();
    const running = manager.resources.state().running;
    expect(running.find((turn) => turn.sessionId === sessions[0]!.id)).toMatchObject({ since: clock, bytes: 380 * MiB });
    expect(running.find((turn) => turn.sessionId === sessions[1]!.id)).toMatchObject({ since: clock, bytes: null });
  });
});

describe("대화당 메모리 상한 (0.5.4)", () => {
  it("off by default; only a listed size is taken; kept across a restart; says what this computer can do", async () => {
    const { manager, dir } = setup(0, undefined, undefined, { probe: async () => ({ cgroup2: true, memory: true, systemdRun: true }) });
    await vi.waitFor(() => expect(manager.resources.state().capSupport).toBe(process.platform === "linux" ? "enforced" : process.platform === "win32" || process.platform === "darwin" ? "advised" : "unavailable"));
    expect(manager.resources.settings().cap).toBeNull();
    expect(() => manager.resources.updateSettings({ cap: 1234 })).toThrow(/목록/);
    manager.resources.updateSettings({ cap: 2 * GiB });
    await manager.shutdown();
    const again = open(dir, undefined, undefined, { probe: async () => ({ cgroup2: true, memory: true, systemdRun: false }) });
    expect(again.manager.resources.settings().cap).toBe(2 * GiB);
    if (process.platform === "linux") await vi.waitFor(() => expect(again.manager.resources.state().capSupport).toBe("unavailable"));
    await again.manager.shutdown();
  });
});

describe("what a running turn holds when its engine's memory is not known (0.5.4)", () => {
  // The memory available now already lacks what running engines hold; the estimate gives it back. A turn
  // whose tree is not known (macOS and Windows read no trees; on Linux before the first measurement) holds
  // the cost figure — the default until this computer has learned its own — not nothing.
  const cost = Math.max(DEFAULT_COST.claude, DEFAULT_COST.codex);

  it("unknown trees: \"약 N개\" stays where it was as turns start and take their memory", async () => {
    let running = 0;
    // 16 GiB, 4 GiB free before any turn; each running engine takes the default figure from what is free.
    const facts = () => ({ totalBytes: 16 * GiB, availableBytes: 4 * GiB - running * cost, cores: 16 });
    const { manager, sessions } = setup(2, facts);
    const before = manager.resources.state().estimate.comfortable;
    expect(before).toBe(Math.floor((4 * GiB - Math.round(16 * GiB * 0.1)) / cost));
    for (const [index, entry] of sessions.entries()) await manager.send(entry.id, `r${index + 1}`, `요청 ${index + 1}`);
    running = 2;
    manager.resources.sample();
    await manager.resources.measureTrees();
    expect(manager.resources.state().running).toHaveLength(2);
    expect(manager.resources.state().estimate.comfortable).toBe(before);
  });

  it("a measured tree counts as measured, not again with the figure", async () => {
    let running = 0;
    const held = 700 * MiB;
    const facts = () => ({ totalBytes: 16 * GiB, availableBytes: 4 * GiB - running * held, cores: 16 });
    const trees = async (engines: EngineSource[]): Promise<EngineTree[]> => engines.map((source, index) => ({ source, pid: 100 + index, pids: [100 + index], bytes: held }));
    const { manager, sessions } = setup(1, facts, trees);
    const engines = (): EngineSource[] => [{ provider: "claude", sessions: [{ id: sessions[0]!.id, title: "대화 1" }], pid: 100, marker: null, idle: false }];
    (manager.resources as unknown as { hooks: { engines: () => EngineSource[] } }).hooks.engines = engines;
    const before = manager.resources.state().estimate.comfortable;
    await manager.send(sessions[0]!.id, "r1", "요청 1");
    running = 1;
    manager.resources.sample();
    // Before the first measurement: the figure (450 MiB) stands in for the 700 MiB it holds.
    expect(manager.resources.state().estimate.comfortable).toBe(Math.floor((4 * GiB - held + cost - Math.round(16 * GiB * 0.1)) / cost));
    await manager.resources.measureTrees();
    expect(manager.resources.state().estimate.comfortable).toBe(before);
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

describe("a waiting 문서 AI request and a gateway restart (0.5.4)", () => {
  it("kept on disk while it waits; after the restart it is in its conversation's waiting list (held, with its document), said once, never twice", async () => {
    const { manager, sessions, dir, work } = setup(2);
    manager.resources.updateSettings({ mode: "manual", manual: 1 });
    await manager.send(sessions[0]!.id, "r1", "요청 1");
    const file = join(work.cwd, "보고서.md");
    writeFileSync(file, "# 제목\n");
    const artifact = manager.openFile(work.id, file);
    const artifactId = artifact.id;
    const editor = new AbortController();
    const waiting = manager.resources.waitDocument(sessions[1]!.id, editor.signal, { artifactId, turnId: "turn-1", text: "표를 정리해 줘" });
    expect(waiting).toBeInstanceOf(Promise);
    // A cancelled one (its editor closed while the app runs) is gone for good.
    const closed = new AbortController();
    const cancelled = manager.resources.waitDocument(sessions[1]!.id, closed.signal, { artifactId, turnId: "turn-2", text: "지운 요청" });
    closed.abort();
    await expect(cancelled).rejects.toThrow(/취소/);
    // "Stop all work" (SIGTERM, an update): nothing more is admitted; the editor's connection closes with the gateway.
    manager.resources.suspend();
    editor.abort();
    await expect(waiting).rejects.toThrow();
    await manager.shutdown();
    const again = open(dir);
    const kept = again.manager.snapshot().sessions.find((entry) => entry.id === sessions[1]!.id)!;
    expect(kept.queued).toMatchObject([{ id: "document-turn-1", text: "표를 정리해 줘", held: true }]);
    expect(kept.queued).toHaveLength(1);
    expect(kept.queued[0]!.refs).toMatchObject([{ artifactId, mode: "edit" }]);
    expect(again.manager.items(sessions[1]!.id).items.filter((item) => item.id === "document-waited:turn-1")).toHaveLength(1);
    await again.manager.shutdown();
    // A second restart adds nothing (read once).
    const third = open(dir);
    expect(third.manager.snapshot().sessions.find((entry) => entry.id === sessions[1]!.id)!.queued).toHaveLength(1);
    await third.manager.shutdown();
  });
});
