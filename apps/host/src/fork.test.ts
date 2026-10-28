import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AccessMode, ApprovalDecision, ProviderStatus, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

// "이 요청 전으로": a new session with the conversation up to a request, the original untouched.

class ForkEngine implements ProviderAdapter {
  readonly provider = "codex" as const;
  forks: { from: string | null; keep: { turns: number; requests: number } }[] = [];
  private readonly sink: () => AdapterSink;
  private turn = 0;
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
  /** Answers at once, like a short turn. */
  async send(session: Session, _work: Work, text: string, turnKey: string) {
    this.turn += 1;
    if (!session.nativeSessionId) this.sink().updateSession(session.id, { nativeSessionId: "thr_main" });
    this.sink().upsertItem(session.id, { kind: "assistant", id: `a:${turnKey}`, text: `${text}에 답합니다.`, streaming: false, at: Date.now() });
    this.sink().upsertItem(session.id, { kind: "turnEnd", id: `end:${turnKey}`, status: "completed", durationMs: 1, at: Date.now() });
    this.sink().updateSession(session.id, { status: "idle", activity: null });
  }
  async forkNative(session: Session & { access: AccessMode }, _work: Work, keep: { turns: number; requests: number }) {
    this.forks.push({ from: session.nativeSessionId, keep });
    return "thr_fork";
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

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-fork-"));
  dirs.push(dir);
  const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
  const engine = new ForkEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const work = manager.createWork({ title: "w" });
  const session = manager.createSession(work.id, { provider: "codex", purpose: "강의 준비" });
  for (const [index, text] of ["첫째 질문", "둘째 질문", "셋째 질문"].entries()) await manager.send(session.id, `r${index + 1}`, text);
  return { manager, engine, session };
}

const texts = (manager: SessionManager, id: string) =>
  manager.items(id).items.map((item) => (item.kind === "user" || item.kind === "assistant" ? item.text : item.kind === "notice" ? `notice` : item.kind));

describe("이 요청 전으로", () => {
  it("keeps the conversation up to that request in a new session, and gives the request back", async () => {
    const { manager, engine, session } = await setup();
    const { session: forked, text } = await manager.forkBefore(session.id, "user:r2");
    expect(text).toBe("둘째 질문");
    expect(engine.forks).toEqual([{ from: "thr_main", keep: { turns: 1, requests: 1 } }]);
    expect(forked).toMatchObject({ workId: session.workId, nativeSessionId: "thr_fork", purpose: "강의 준비 · 갈래", provider: "codex" });
    expect(texts(manager, forked.id)).toEqual(["첫째 질문", "첫째 질문에 답합니다.", "turnEnd", "notice"]);
    expect(texts(manager, session.id).filter((entry) => entry.endsWith("질문"))).toEqual(["첫째 질문", "둘째 질문", "셋째 질문"]);
  });

  it("starts empty before the first request (nothing for the engine to keep)", async () => {
    const { manager, engine, session } = await setup();
    const { session: forked, text } = await manager.forkBefore(session.id, "user:r1");
    expect(text).toBe("첫째 질문");
    expect(engine.forks).toHaveLength(0);
    expect(forked.nativeSessionId).toBeNull();
    expect(texts(manager, forked.id)).toEqual(["notice"]);
  });

  it("refuses while the engine works, and for what is not a request", async () => {
    const { manager, session } = await setup();
    await expect(manager.forkBefore(session.id, "a:r1")).rejects.toThrow(/요청을 찾지 못했습니다/);
    manager.sink.updateSession(session.id, { status: "running" });
    await expect(manager.forkBefore(session.id, "user:r2")).rejects.toThrow(/응답이 끝난 뒤에/);
  });
});
