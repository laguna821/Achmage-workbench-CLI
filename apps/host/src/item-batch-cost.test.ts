import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, TranscriptItem, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";
import { BATCH_MS } from "./item-batch.ts";
import { installScrubber } from "./credentials/install.ts";
import { TranscriptScrubber } from "./credentials/scrubber.ts";

// 0.5.4 (resman2 point 3): the gateway's own cost of many running conversations. 40 conversations run at once, out of
// sight (one more is on screen); each engine reports 40 tool steps (each twice: started, finished), streamed answer
// pieces and its end. Counted: the database's write commits (a write outside a transaction commits on its own), and
// the gateway's time. WB_BATCH_COST_LOG=1 prints the numbers (the report's before/after).

class Engine implements ProviderAdapter {
  readonly provider = "claude" as const;
  private readonly sink: () => AdapterSink;
  constructor(sink: () => AdapterSink) { this.sink = sink; }
  async init() {}
  status(): ProviderStatus { return emptyStatus("claude"); }
  async refreshStatus() { return this.status(); }
  async login() { return { url: null, message: "" }; }
  async send(session: Session, _work: Work, _text: string) { this.sink().updateSession(session.id, { status: "running", activity: "응답 중" }); }
  async steer() { return false; }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) { return true; }
  async shutdown() {}
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const RUNNING = 40, STEPS = 40;

function countCommits(store: Store) {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const counts = { autocommit: 0, transactions: 0 };
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) {
      const run = statement.run.bind(statement);
      statement.run = ((...args: Parameters<typeof run>) => { if (!db.isTransaction) { counts.autocommit++; if (process.env.WB_BATCH_COST_SQL) (counts as Record<string, number>)[sql.slice(0, 60)] = ((counts as Record<string, number>)[sql.slice(0, 60)] ?? 0) + 1; } return run(...args); }) as typeof statement.run;
    }
    return statement;
  }) as typeof db.prepare;
  const exec = db.exec.bind(db);
  db.exec = ((sql: string) => { if (/^\s*BEGIN/i.test(sql)) counts.transactions++; return exec(sql); }) as typeof db.exec;
  return counts;
}

describe("the gateway's cost of 40 conversations running out of sight", () => {
  it("their steps are written in batches; the turn's end and an approval are on disk at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-batch-cost-")); dirs.push(dir);
    const dataDir = join(dir, "data"); mkdirSync(dataDir, { recursive: true });
    const store = new Store(join(dataDir, "state.sqlite"));
    const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "PC", managedWorksDir: join(dataDir, "works"), dataDir, resources: { manualClock: true, probe: async () => null } });
    manager.registerAdapter(new Engine(() => manager.sink));
    const work = manager.createWork({ title: "부하" });
    mkdirSync(work.cwd, { recursive: true });
    const sessions = Array.from({ length: RUNNING + 1 }, (_, index) => manager.createSession(work.id, { provider: "claude", purpose: `대화 ${index + 1}` } as never));
    for (const [index, session] of sessions.entries()) await manager.send(session.id, `r${index}`, "일해 줘");
    // Stand-ins all running (the line would keep some waiting on a machine where 40 do not fit).
    for (const session of sessions) manager.sink.updateSession(session.id, { status: "running", activity: "응답 중" });
    manager.setShown("window", [sessions[RUNNING]!.id]);
    const counts = countCommits(store);
    const started = performance.now(), cpu = process.cpuUsage();
    const sink = manager.sink;
    for (let step = 0; step < STEPS; step++) {
      for (const session of sessions.slice(0, RUNNING)) {
        const tool: TranscriptItem = { kind: "tool", id: `t${step}`, tool: "command", title: `npm test ${step}`, detail: null, output: null, status: "running", at: Date.now() };
        sink.upsertItem(session.id, tool);
        sink.upsertItem(session.id, { ...tool, output: "ok\n".repeat(40), status: "completed" });
        sink.upsertItem(session.id, { kind: "assistant", id: "answer", text: `단계 ${step}`, streaming: true, at: Date.now() });
      }
    }
    // A question in one of them, then every turn ends.
    const asking = sessions[0]!.id;
    sink.upsertItem(asking, { kind: "approval", id: "ask", title: "실행할까요?", detail: null, reason: null, decision: null, at: Date.now() });
    const approvalOnDisk = store.items(asking).some((item) => item.id === "ask");
    for (const session of sessions.slice(0, RUNNING)) sink.upsertItem(session.id, { kind: "turnEnd", id: "end", status: "completed", durationMs: 1, at: Date.now() });
    const endsOnDisk = sessions.slice(0, RUNNING).every((session) => store.items(session.id).some((item) => item.id === "end"));
    const wallMs = Math.round(performance.now() - started), cpuMs = Math.round((process.cpuUsage(cpu).user + process.cpuUsage(cpu).system) / 1000);
    const commits = counts.autocommit + counts.transactions;
    if (process.env.WB_BATCH_COST_LOG) console.log(JSON.stringify({ running: RUNNING, upserts: RUNNING * STEPS * 3 + RUNNING + 1, commits, ...counts, wallMs, cpuMs }));
    // Nothing lost, in order: every step and the end of each conversation, the answer's last piece.
    for (const session of sessions.slice(0, RUNNING)) {
      const items = store.items(session.id).filter((item) => item.kind !== "user" && item.kind !== "notice");
      expect(items.map((item) => item.id)).toEqual([...Array.from({ length: STEPS }, (_, step) => `t${step}`).flatMap((id, index) => (index === 0 ? [id, "answer"] : [id])), ...(session.id === asking ? ["ask"] : []), "end"]);
      expect(items.find((item) => item.id === "answer")).toMatchObject({ text: `단계 ${STEPS - 1}` });
      expect(items.find((item) => item.id === `t${STEPS - 1}`)).toMatchObject({ status: "completed" });
    }
    expect(approvalOnDisk).toBe(true);
    expect(endsOnDisk).toBe(true);
    // Before 0.5.4 every upsert was a commit of its own (4,961 here). Now only the growth of the streaming answer
    // waits (1,560 versions → a few batches); each command's first version and its finished version stay at once.
    expect(commits).toBeLessThan(4_961 * 0.75);
    await manager.shutdown();
  });

  it("with no window attached (visibility unknown) every item is written at once, as before", async () => {
    const { manager, store, sessions } = await open(2);
    const counts = countCommits(store);
    for (let step = 0; step < 5; step++) manager.sink.upsertItem(sessions[0]!.id, { kind: "assistant", id: "answer", text: `조각 ${step}`, streaming: true, at: 1 });
    expect(counts.autocommit).toBe(5);
    expect(store.items(sessions[0]!.id).find((item) => item.id === "answer")).toMatchObject({ text: "조각 4" });
    await manager.shutdown();
  });

  it("a running command's output and a streaming answer are on disk from their first version; only their growth waits", async () => {
    const { manager, store, sessions } = await open(2);
    manager.setShown("window", [sessions[1]!.id]);
    const id = sessions[0]!.id;
    manager.sink.upsertItem(id, { kind: "tool", id: "cmd", tool: "command", title: "make", detail: null, output: "1단계", status: "running", at: 1 });
    manager.sink.upsertItem(id, { kind: "assistant", id: "a", text: "처음", streaming: true, at: 1 });
    expect(store.items(id).find((item) => item.id === "cmd")).toMatchObject({ output: "1단계" });
    expect(store.items(id).find((item) => item.id === "a")).toMatchObject({ text: "처음" });
    manager.sink.upsertItem(id, { kind: "tool", id: "cmd", tool: "command", title: "make", detail: null, output: "1단계\n2단계", status: "running", at: 1 });
    expect(store.items(id).find((item) => item.id === "cmd")).toMatchObject({ output: "1단계" }); // its growth waits (at most BATCH_MS)
    manager.sink.upsertItem(id, { kind: "tool", id: "cmd", tool: "command", title: "make", detail: null, output: "1단계\n2단계\n끝", status: "completed", at: 1 });
    expect(store.items(id).find((item) => item.id === "cmd")).toMatchObject({ output: "1단계\n2단계\n끝", status: "completed" }); // finished: at once
    await manager.shutdown();
  });

  it("a value handed to the scrubber while pieces wait in the batch is scrubbed from them before they are stored", async () => {
    const { manager, store, sessions } = await open(2);
    const scrubber = new TranscriptScrubber();
    installScrubber(store, manager, scrubber);
    manager.setShown("window", [sessions[1]!.id]);
    const id = sessions[0]!.id, secret = "zz-batch-secret-77aa99bb";
    manager.sink.upsertItem(id, { kind: "assistant", id: "a", text: "시작", streaming: true, at: 1 });
    manager.sink.upsertItem(id, { kind: "assistant", id: "a", text: `시작 ${secret} 끝`, streaming: true, at: 1 });
    // Handed over while that version waits in memory.
    scrubber.set("e0", "열쇠", [secret]);
    await new Promise((done) => setTimeout(done, BATCH_MS + 300));
    const row = JSON.stringify(store.items(id).find((item) => item.id === "a"));
    expect(row).toContain("끝");
    expect(row).not.toContain(secret);
    await manager.shutdown();
  });
});

async function open(count: number) {
  const dir = mkdtempSync(join(tmpdir(), "wb-batch-")); dirs.push(dir);
  const dataDir = join(dir, "data"); mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(dataDir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "PC", managedWorksDir: join(dataDir, "works"), dataDir, resources: { manualClock: true, probe: async () => null } });
  manager.registerAdapter(new Engine(() => manager.sink));
  const work = manager.createWork({ title: "부하" });
  mkdirSync(work.cwd, { recursive: true });
  const sessions = Array.from({ length: count }, (_, index) => manager.createSession(work.id, { provider: "claude", purpose: `대화 ${index + 1}` } as never));
  for (const [index, session] of sessions.entries()) { await manager.send(session.id, `r${index}`, "일해 줘"); manager.sink.updateSession(session.id, { status: "running", activity: "응답 중" }); }
  return { manager, store, sessions };
}
