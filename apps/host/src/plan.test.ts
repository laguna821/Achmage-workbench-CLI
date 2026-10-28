import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AccessMode, ApprovalDecision, ProviderStatus, Session, TranscriptItem, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

// "계획 먼저": a request that only plans, and the go-ahead that follows.

class PlanEngine implements ProviderAdapter {
  readonly provider = "codex" as const;
  sent: { text: string; plan: boolean; access: AccessMode }[] = [];
  steered: string[] = [];
  private readonly sink: () => AdapterSink;
  private current: { sessionId: string; key: string } | null = null;
  constructor(sink: () => AdapterSink) {
    this.sink = sink;
  }
  async init() {}
  status(): ProviderStatus {
    return emptyStatus("codex");
  }
  async refreshStatus() {
    return this.status();
  }
  async login() {
    return { url: null, message: "" };
  }
  async send(session: Session & { access: AccessMode; plan?: boolean }, _work: Work, text: string, turnKey: string) {
    this.sent.push({ text, plan: Boolean(session.plan), access: session.access });
    this.current = { sessionId: session.id, key: turnKey };
    this.sink().updateSession(session.id, { status: "running", activity: "응답 중" });
  }
  async steer(_session: Session, _work: Work, text: string) {
    if (!this.current) return false;
    this.steered.push(text);
    return true;
  }
  /** The engine answers, optionally asking for the go-ahead itself (as Claude's plan mode does). */
  finish(ownApproval = false) {
    const turn = this.current!;
    this.current = null;
    this.sink().upsertItem(turn.sessionId, { kind: "assistant", id: `a:${turn.key}`, text: "## 계획\n1. 살펴보기", streaming: false, at: Date.now() });
    if (ownApproval) this.sink().upsertItem(turn.sessionId, { kind: "approval", id: `approval:${turn.key}`, title: "계획", detail: "1.", reason: null, decision: "decline", plan: true, at: Date.now() });
    this.sink().upsertItem(turn.sessionId, { kind: "turnEnd", id: `end:${turn.key}`, status: "completed", durationMs: 1, at: Date.now() });
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
  const dir = mkdtempSync(join(tmpdir(), "wb-plan-"));
  dirs.push(dir);
  const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
  const engine = new PlanEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const work = manager.createWork({ title: "w" });
  const session = manager.createSession(work.id, { provider: "codex", access: "auto" });
  return { manager, engine, session };
}

const tick = () => new Promise((done) => setTimeout(done, 5));
const plans = (manager: SessionManager, id: string) =>
  manager.items(id).items.filter((item): item is Extract<TranscriptItem, { kind: "approval" }> => item.kind === "approval" && item.plan === true);

describe("plan first", () => {
  it("asks the engine only to plan, and marks the request", async () => {
    const { manager, engine, session } = setup();
    await manager.send(session.id, "r1", "로그인 화면 고쳐 줘", [], null, null, "auto", [], true);
    expect(engine.sent[0]).toMatchObject({ plan: true, access: "auto" });
    expect(manager.items(session.id).items.find((item) => item.id === "user:r1")).toMatchObject({ plan: true });
  });

  it("waits for the running turn instead of steering, and keeps planning when it goes", async () => {
    const { manager, engine, session } = setup();
    await manager.send(session.id, "r1", "작업해 줘");
    expect((await manager.send(session.id, "r2", "다음 일 계획해 줘", [], null, null, "auto", [], true)).delivery).toBe("queued");
    expect(engine.steered).toHaveLength(0);
    expect(manager.snapshot().sessions.find((entry) => entry.id === session.id)!.queued[0]).toMatchObject({ plan: true });
    engine.finish();
    await tick();
    expect(engine.sent[1]).toMatchObject({ text: "다음 일 계획해 줘", plan: true });
  });

  it("puts the plan to the user when the turn ends, and going ahead is the next request", async () => {
    const { manager, engine, session } = setup();
    await manager.send(session.id, "r1", "계획해 줘", [], null, null, "auto", [], true);
    engine.finish();
    const [card] = plans(manager, session.id);
    expect(card).toMatchObject({ id: "plan:r1", decision: null });
    await manager.answerApproval(session.id, card!.id, "accept");
    expect(plans(manager, session.id)[0]!.decision).toBe("accept");
    expect(engine.sent[1]).toMatchObject({ text: "계획대로 진행해 주세요.", plan: false, access: "auto" });
    await expect(manager.answerApproval(session.id, card!.id, "accept")).rejects.toThrow(/이미 처리/);
  });

  it("keeps planning when the user wants to refine it, and a new request passes a waiting plan over", async () => {
    const { manager, engine, session } = setup();
    await manager.send(session.id, "r1", "계획해 줘", [], null, null, "auto", [], true);
    engine.finish();
    await manager.answerApproval(session.id, "plan:r1", "decline");
    expect(engine.sent).toHaveLength(1);
    await manager.send(session.id, "r2", "2단계를 자세히", [], null, null, "auto", [], true);
    engine.finish();
    await manager.send(session.id, "r3", "됐어, 다른 얘기", [], null, null, "auto", [], false);
    expect(plans(manager, session.id).map((item) => item.decision)).toEqual(["decline", "expired"]);
  });

  it("adds no card when the engine asked for the go-ahead itself", async () => {
    const { manager, engine, session } = setup();
    await manager.send(session.id, "r1", "계획해 줘", [], null, null, "auto", [], true);
    engine.finish(true);
    expect(plans(manager, session.id).map((item) => item.id)).toEqual(["approval:r1"]);
  });
});
