import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { Kordoc } from "./kordoc.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";
import { GEMINI_PERSON_ONLY } from "./providers/gemini.ts";
import { tempDir } from "./test-temp.ts";

// Where Gemini may run (brief 0.5.6 point 4; study § G rule 6): only what a person sends — refused for schedules,
// the automation API and hand-overs between conversations, with one line. Subscription login only (the owner,
// 2026-11-21), so this holds for every Gemini sign-in. Document AI keeps its engines.

class Scripted implements ProviderAdapter {
  readonly provider: "claude" | "codex" | "gemini";
  sent: string[] = [];
  google = true;
  private readonly sink: () => AdapterSink;
  constructor(provider: "claude" | "codex" | "gemini", sink: () => AdapterSink) { this.provider = provider; this.sink = sink; }
  personOnly() { return this.provider === "gemini" && this.google; }
  async init() {}
  status(): ProviderStatus { return { ...emptyStatus(this.provider), installed: true, loggedIn: true }; }
  async refreshStatus() { return this.status(); }
  async login() { return { url: null, message: "" }; }
  async send(session: Session, _work: Work, text: string, turnKey: string) {
    this.sent.push(text);
    this.sink().upsertItem(session.id, { kind: "turnEnd", id: `end:${turnKey}`, status: "completed", durationMs: 1, at: Date.now() });
    this.sink().updateSession(session.id, { status: "idle" });
  }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) { return false; }
  async shutdown() {}
}

function setup() {
  const dir = tempDir("wb-gemini-person-");
  const store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), kordoc: new Kordoc() });
  const gemini = new Scripted("gemini", () => manager.sink);
  for (const adapter of [new Scripted("claude", () => manager.sink), new Scripted("codex", () => manager.sink), gemini]) manager.registerAdapter(adapter);
  const work = manager.createWork({ title: "강의", cwd: join(dir, "project") });
  const session = manager.createSession(work.id, { provider: "gemini" });
  return { manager, gemini, work, session };
}

describe("Gemini is for a person only", () => {
  it("a person's request goes", async () => {
    const { manager, gemini, session } = setup();
    await manager.send(session.id, "r1", "안녕", [], null, null, "auto", { draft: true });
    expect(gemini.sent).toEqual(["안녕"]);
  });

  it("a schedule is refused with the line", () => {
    const { manager, session } = setup();
    expect(() => manager.schedules.create({ sessionId: session.id, text: "매일 정리", when: { kind: "daily", time: "09:00" } as never })).toThrow(GEMINI_PERSON_ONLY);
  });

  it("the automation API is refused with the line", async () => {
    const { manager, gemini, session } = setup();
    const receipt = await manager.tasks.submit({ commandId: "c1", hostId: session.hostId, workspaceId: session.workspaceId!, sessionId: session.id, text: "자동 요청" }).catch((error: Error) => ({ status: "thrown", detail: error.message }));
    expect(receipt.detail ?? "").toContain(GEMINI_PERSON_ONLY);
    expect(gemini.sent).toEqual([]);
  });

  it("an automated request that waits in the queue (accepted while Gemini was not person-only, e.g. by an older build) is checked again when it is sent (review 3)", async () => {
    const { manager, gemini, session } = setup();
    gemini.google = false;
    // The conversation is working: the automation's request waits in its queue.
    manager.sink.updateSession(session.id, { status: "running" });
    await manager.tasks.submit({ commandId: "c-queued", hostId: session.hostId, workspaceId: session.workspaceId!, sessionId: session.id, text: "자동 요청", mode: "queue" });
    expect(manager.view.sessions.get(session.id)!.queued.map((entry) => entry.text)).toEqual(["자동 요청"]);
    // Gemini is person-only now; the turn ends and the queue drains.
    gemini.google = true;
    manager.sink.updateSession(session.id, { status: "idle" });
    await new Promise((done) => setTimeout(done, 50));
    expect(gemini.sent).toEqual([]);
    expect(manager.items(session.id).items.some((item) => item.kind === "notice" && item.text.includes(GEMINI_PERSON_ONLY))).toBe(true);
    // A request the person typed and queued still goes.
    manager.sink.updateSession(session.id, { status: "running" });
    await manager.send(session.id, "typed-1", "직접 쓴 요청", [], null, null, "queue", { draft: true });
    manager.sink.updateSession(session.id, { status: "idle" });
    await new Promise((done) => setTimeout(done, 50));
    expect(gemini.sent).toEqual(["직접 쓴 요청"]);
  });

  it("a Gemini request carries the person's text, not Workbench's status dumps; Claude's still does (study § H+)", async () => {
    const { manager, gemini, work } = setup();
    manager.changeHook = () => "[지난 요청 뒤 바뀐 것] notes.md";
    (manager.office as unknown as { nativeContext: () => { text: string; accept: () => void } }).nativeContext = () => ({ text: "프로젝트의 독립 문서 AI 작업 현황입니다.\n<document-agents>[]</document-agents>\n\n", accept: () => undefined });
    const session = manager.createSession(work.id, { provider: "gemini" });
    await manager.send(session.id, "lean-1", "안녕", [], null, null, "auto", { draft: true });
    expect(gemini.sent.at(-1)).toBe("안녕");
    const claude = manager.createSession(work.id, { provider: "claude" });
    const claudeAdapter = (manager as unknown as { adapters: Map<string, Scripted> }).adapters.get("claude")!;
    await manager.send(claude.id, "lean-2", "안녕", [], null, null, "auto", { draft: true });
    expect(claudeAdapter.sent.at(-1)).toContain("document-agents");
    expect(claudeAdapter.sent.at(-1)).toContain("지난 요청 뒤 바뀐 것");
  });

  it("Claude and Codex conversations are not affected", () => {
    const { manager, work } = setup();
    const claude = manager.createSession(work.id, { provider: "claude" });
    expect(manager.personOnly(claude)).toBeNull();
    expect(manager.schedules.create({ sessionId: claude.id, text: "매일", when: { kind: "daily", time: "09:00" } as never }).sessionId).toBe(claude.id);
  });

  it("document AI of a Gemini conversation's document keeps Claude / Codex", () => {
    const { manager, work, session } = setup();
    mkdirSync(work.cwd, { recursive: true });
    writeFileSync(join(work.cwd, "강의.md"), "# 강의\n");
    const doc = manager.openFile(work.id, join(work.cwd, "강의.md"));
    const agent = manager.documentSession(doc.id, session.id);
    expect(agent.provider).not.toBe("gemini");
    expect(() => manager.documentSession(doc.id, session.id, true, "gemini")).toThrow();
  });
});
