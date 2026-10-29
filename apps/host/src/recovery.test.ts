import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { turnBreakOf, turnEndText, type ApprovalDecision, type Provider, type ProviderStatus, type Session, type TranscriptItem, type Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { HttpError, SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";
import { heldNotice, restartTurnEnd, stampTurnEnd } from "./recovery.ts";
import { Kordoc } from "./kordoc.ts";
import { ClaudeAdapter } from "./providers/claude.ts";
import { CodexAdapter } from "./providers/codex.ts";

// "끊기는 길": a turn that is stopped, fails, or whose engine dies still ends — with its cause — so the
// waiting requests stay, a changed working copy becomes a proposal, another session's request is
// settled, and what an engine made says which model, effort and request made it.

type TurnEnd = Extract<TranscriptItem, { kind: "turnEnd" }>;

describe("turn end rules", () => {
  it("names how a turn broke off, and its end line", () => {
    expect(turnBreakOf("completed", null)).toBeNull();
    expect(turnBreakOf("interrupted")).toBe("stop");
    expect(turnBreakOf("failed")).toBe("failure");
    expect(turnBreakOf("failed", "crash")).toBe("crash");
    expect(turnBreakOf("interrupted", "restart")).toBe("restart");
    expect(turnEndText({ status: "failed", cause: "crash" })).toBe("엔진이 멈춰 끊김");
    expect(turnEndText({ status: "interrupted", cause: "restart" })).toBe("앱이 다시 시작되어 끊김");
    expect(turnEndText({ status: "interrupted", cause: "stop" })).toBe("중단됨");
    expect(turnEndText({ status: "failed" })).toBe("응답이 끝나지 못했습니다");
    expect(heldNotice("crash", 2)).toBe("엔진이 멈춰 보낼 예정인 요청 2개를 보내지 않았습니다. 입력창 위에서 보내거나 지울 수 있습니다.");
    expect(heldNotice("stop", 1)).toContain("멈췄기 때문에 보낼 예정인 요청 1개");
  });

  it("stamps a turn end with what the engine last reported, unless the adapter said", () => {
    const end: TurnEnd = { kind: "turnEnd", id: "e", status: "failed", cause: "crash", durationMs: null, at: 5_000 };
    expect(stampTurnEnd(end, { engineModel: "m1", engineEffort: "high" }, 2_000, "r1")).toMatchObject({ model: "m1", effort: "high", requestId: "r1", durationMs: 3_000 });
    // What the adapter gave stays, also an explicit null; a completed turn's duration is the engine's.
    expect(stampTurnEnd({ ...end, model: "m2", requestId: null }, { engineModel: "m1", engineEffort: null }, 2_000, "r1")).toMatchObject({ model: "m2", effort: null, requestId: null });
    expect(stampTurnEnd({ ...end, status: "completed", cause: null }, undefined, 2_000).durationMs).toBeNull();
  });

  it("ends the turn a restart cut after the last thing it recorded; none when it already ended", () => {
    const items: TranscriptItem[] = [
      { kind: "user", id: "user:r1", text: "첫", at: 1_000 },
      { kind: "assistant", id: "a1", text: "답", streaming: false, at: 1_500 },
      { kind: "turnEnd", id: "end:r1", status: "completed", durationMs: 500, at: 1_600 },
      { kind: "user", id: "user:r2", text: "둘", at: 2_000 },
      { kind: "user", id: "user:s", text: "끼어듦", at: 2_100, steered: true },
      { kind: "assistant", id: "a2", text: "반쯤", streaming: true, at: 2_400 },
    ];
    expect(restartTurnEnd(items)).toEqual({ kind: "turnEnd", id: "end:restart:user:r2", status: "interrupted", cause: "restart", durationMs: 400, at: 2_400, requestId: "r2" });
    expect(restartTurnEnd(items.slice(0, 3))).toBeNull();
    expect(restartTurnEnd([])).toBeNull();
  });
});

/** An engine whose turns end when the test says so: completed, stopped, failed, or with its process dying. */
class Engine implements ProviderAdapter {
  readonly provider: Provider;
  sent: { sessionId: string; text: string; key: string; cwd: string }[] = [];
  private readonly running = new Map<string, string>();
  private readonly sink: () => AdapterSink;
  constructor(provider: Provider, sink: () => AdapterSink) {
    this.provider = provider;
    this.sink = sink;
  }
  async init() {}
  status(): ProviderStatus {
    return emptyStatus(this.provider);
  }
  async refreshStatus() {
    return this.status();
  }
  async login() {
    return { url: null, message: "" };
  }
  async send(session: Session, work: Work, text: string, turnKey: string) {
    this.sent.push({ sessionId: session.id, text, key: turnKey, cwd: work.cwd });
    this.running.set(session.id, turnKey);
    this.sink().updateSession(session.id, { status: "running", activity: "응답 중", engineModel: `${this.provider}-model`, engineEffort: "high" });
  }
  /** Write into the working copy the request names (as an engine editing a document would). */
  edit(sessionId: string, line: string) {
    const sent = this.sent.findLast((entry) => entry.sessionId === sessionId)!;
    const named = /작업 사본만 수정하세요: (.+)$/m.exec(sent.text)?.[1];
    if (!named) throw new Error("no working copy in the request");
    const working = resolve(sent.cwd, named);
    writeFileSync(working, `${readFileSync(working, "utf8")}${line}\n`);
  }
  end(sessionId: string, status: "completed" | "interrupted" | "failed", cause?: "stop" | "crash") {
    const key = this.running.get(sessionId)!;
    this.running.delete(sessionId);
    this.sink().upsertItem(sessionId, { kind: "turnEnd", id: `end:${key}`, status, ...(cause ? { cause } : {}), durationMs: null, at: Date.now(), requestId: key });
    this.sink().updateSession(sessionId, { status: "idle", activity: null, ...(cause === "crash" ? { lastError: "엔진이 종료되었습니다" } : {}) });
  }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) {
    return false;
  }
  async shutdown() {}
}

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(dir = mkdtempSync(join(tmpdir(), "wb-recovery-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
  const claude = new Engine("claude", () => manager.sink);
  const codex = new Engine("codex", () => manager.sink);
  manager.registerAdapter(claude);
  manager.registerAdapter(codex);
  const work = manager.createWork({ title: "강의", cwd: join(dir, "project") });
  mkdirSync(work.cwd, { recursive: true });
  return { dir, store, manager, claude, codex, work };
}

const tick = () => new Promise((done) => setTimeout(done, 5));
const sessionOf = (manager: SessionManager, id: string) => manager.snapshot().sessions.find((session) => session.id === id)!;
const proposalFor = (manager: SessionManager, requestId: string) => manager.snapshot().proposals.find((proposal) => proposal.requestId === requestId)!;

describe("a turn that does not complete", () => {
  for (const [label, status, cause, broke] of [
    ["stopped", "interrupted", "stop", "stop"],
    ["failed", "failed", undefined, "failure"],
    ["whose engine died", "failed", "crash", "crash"],
  ] as const) {
    it(`keeps a changed working copy as a proposal and holds the waiting requests (${label})`, async () => {
      const { manager, claude, codex, work } = setup();
      const file = join(work.cwd, "강의.md");
      writeFileSync(file, "도입\n\n본문\n");
      const artifact = manager.openFile(work.id, file);
      const writer = manager.createSession(work.id, { provider: "claude" });
      await manager.send(writer.id, "edit-1", "본문을 고쳐 줘", [{ artifactId: artifact.id, revision: 1, mode: "edit", selection: null }]);
      claude.edit(writer.id, "고친 문단 하나");
      // Written while it works: kept for after the turn.
      expect(await manager.send(writer.id, "later", "끝나면 이것도", [], null, null, "queue")).toMatchObject({ delivery: "queued" });
      claude.end(writer.id, status, cause);
      await tick();
      // Not sent on its own: kept, with a word on why.
      expect(claude.sent.map((entry) => entry.key)).toEqual(["edit-1"]);
      expect(sessionOf(manager, writer.id).queued).toMatchObject([{ id: "later", held: true }]);
      expect(manager.items(writer.id).items.some((item) => item.kind === "notice" && item.text === heldNotice(broke, 1))).toBe(true);
      // The part of the edit made before the end is a proposal to review, marked as such.
      const proposal = proposalFor(manager, "edit-1");
      expect(proposal).toMatchObject({ status: "pending", interruptedBy: broke, added: 1, model: "claude-model", effort: "high" });
      expect(manager.items(writer.id).items.some((item) => item.kind === "proposal" && item.proposalId === proposal.id)).toBe(true);
      // Another session may edit the same document now (it was "running" and blocked it before).
      const other = manager.createSession(work.id, { provider: "codex" });
      await manager.send(other.id, "edit-2", "도입을 고쳐 줘", [{ artifactId: artifact.id, revision: 1, mode: "edit", selection: null }]);
      expect(proposalFor(manager, "edit-2").status).toBe("running");
      codex.end(other.id, "completed");
      // Applied by the user like any other: the revision says what made it.
      const applied = await manager.documents.applyProposal(proposal.id);
      expect(readFileSync(file, "utf8")).toContain("고친 문단 하나");
      expect(applied.proposal).toMatchObject({ status: "applied", closedBy: "user" });
      expect(manager.documents.revisions(artifact.id).at(-1)).toMatchObject({ author: "engine", note: "중단된 턴의 일부 수정안 적용", model: "claude-model", effort: "high", requestId: "edit-1" });
      // The turn end carries the cause and what the engine reported.
      expect(manager.items(writer.id).items.find((item) => item.kind === "turnEnd")).toMatchObject({ status, requestId: "edit-1", model: "claude-model", effort: "high", ...(cause ? { cause } : {}) });
    });
  }

  it("an untouched working copy closes empty, closed by what ended the turn", async () => {
    const { manager, claude, work } = setup();
    writeFileSync(join(work.cwd, "메모.md"), "그대로\n");
    const artifact = manager.openFile(work.id, join(work.cwd, "메모.md"));
    const session = manager.createSession(work.id, { provider: "claude" });
    await manager.send(session.id, "e1", "고쳐 줘", [{ artifactId: artifact.id, revision: 1, mode: "edit", selection: null }]);
    claude.end(session.id, "failed", "crash");
    expect(proposalFor(manager, "e1")).toMatchObject({ status: "empty", closedBy: "crash" });
    await manager.send(session.id, "e2", "고쳐 줘", [{ artifactId: artifact.id, revision: 1, mode: "edit", selection: null }]);
    claude.end(session.id, "completed");
    expect(proposalFor(manager, "e2")).toMatchObject({ status: "empty", closedBy: "turn" });
    await manager.send(session.id, "e3", "고쳐 줘", [{ artifactId: artifact.id, revision: 1, mode: "edit", selection: null }]);
    claude.edit(session.id, "새 줄");
    claude.end(session.id, "completed");
    expect(manager.documents.discardProposal(proposalFor(manager, "e3").id)).toMatchObject({ status: "discarded", closedBy: "user" });
  });

  it("an engine that died between steps (no turn end) keeps the waiting requests too", async () => {
    const { manager, claude, work } = setup();
    const session = manager.createSession(work.id, { provider: "claude" });
    await manager.send(session.id, "r1", "길게");
    await manager.send(session.id, "r2", "다음", [], null, null, "queue");
    manager.sink.updateSession(session.id, { status: "idle", activity: null, lastError: "Claude Code가 끝났습니다" });
    await tick();
    expect(claude.sent).toHaveLength(1);
    expect(sessionOf(manager, session.id).queued).toMatchObject([{ id: "r2", held: true }]);
  });

  it("a request sent to another session whose engine died fails with why, and is sent again as a new one", async () => {
    const { manager, codex, work } = setup();
    const file = join(work.cwd, "강의.md");
    writeFileSync(file, "인용: 김(2024)\n");
    const artifact = manager.openFile(work.id, file);
    const source = manager.createSession(work.id, { provider: "claude" });
    const target = manager.createSession(work.id, { provider: "codex" });
    const attachments = [manager.attachments.save(Buffer.from("표 1: 인용 목록"), "표.txt", "text/plain")];
    await manager.handoff({ requestId: "h1", sourceSessionId: source.id, targetSessionId: target.id, text: "인용 근거 확인", refs: [{ artifactId: artifact.id, revision: 1, mode: "review" }], attachments });
    await expect(manager.resendHandoff("h1", "h2")).rejects.toMatchObject({ code: "handoff_not_failed" });
    codex.end(target.id, "failed", "crash");
    expect(manager.snapshot().handoffs.find((entry) => entry.id === "h1")).toMatchObject({ status: "failed", error: "엔진이 멈춰 응답이 끊겼습니다", attachments });
    const again = await manager.resendHandoff("h1", "h2");
    expect(again).toMatchObject({ id: "h2", status: "sent", text: "인용 근거 확인", resentFrom: "h1", attachments });
    expect(again.refs).toEqual([{ artifactId: artifact.id, revision: 1, mode: "review" }]);
    expect(codex.sent.at(-1)!.text).toContain("인용 근거 확인");
    expect(manager.snapshot().handoffs.find((entry) => entry.id === "h1")!.resentAs).toBe("h2");
    // Asking twice sends once; a new card in the source conversation.
    expect((await manager.resendHandoff("h1", "h3")).id).toBe("h2");
    expect(codex.sent).toHaveLength(2);
    expect(manager.items(source.id).items.filter((item) => item.kind === "handoff").map((item) => (item.kind === "handoff" ? item.handoffId : ""))).toEqual(["h1", "h2"]);
    codex.end(target.id, "completed");
    expect(manager.snapshot().handoffs.find((entry) => entry.id === "h2")!.status).toBe("answered");
    await expect(manager.resendHandoff("nope", "h4")).rejects.toBeInstanceOf(HttpError);
  });

  it("after a restart the cut turn ends: proposal kept with a card, requests held, the other session told", async () => {
    const first = setup();
    const file = join(first.work.cwd, "강의.md");
    writeFileSync(file, "도입\n");
    const artifact = first.manager.openFile(first.work.id, file);
    const writer = first.manager.createSession(first.work.id, { provider: "claude" });
    const asker = first.manager.createSession(first.work.id, { provider: "codex" });
    const reviewer = first.manager.createSession(first.work.id, { provider: "claude" });
    await first.manager.send(writer.id, "edit", "고쳐 줘", [{ artifactId: artifact.id, revision: 1, mode: "edit", selection: null }]);
    first.claude.edit(writer.id, "고친 줄");
    await first.manager.send(writer.id, "later", "다음 것", [], null, null, "queue");
    // Another session's request is being answered when the app closes.
    await first.manager.handoff({ requestId: "ask", sourceSessionId: asker.id, targetSessionId: reviewer.id, text: "검토해 줘" });
    // An older version left a proposal running in an idle session (an engine that died silently).
    const idle = first.manager.createSession(first.work.id, { provider: "codex" });
    writeFileSync(join(first.work.cwd, "메모.md"), "메모\n");
    const memo = first.manager.openFile(first.work.id, join(first.work.cwd, "메모.md"));
    const stuck = await first.manager.documents.prepare({ artifactId: memo.id, revision: 1, mode: "edit" }, idle.id, "stuck", first.work.cwd);
    writeFileSync(stuck.proposal!.workingPath, "메모\n남은 수정\n");
    first.store.close();

    const second = setup(first.dir);
    const items = second.manager.items(writer.id).items;
    expect(items.find((item) => item.kind === "turnEnd" && item.id.startsWith("end:restart:"))).toMatchObject({ status: "interrupted", cause: "restart", requestId: "edit" });
    expect(items.some((item) => item.kind === "notice" && item.text === heldNotice("restart", 1))).toBe(true);
    expect(sessionOf(second.manager, writer.id)).toMatchObject({ status: "idle", queued: [{ id: "later", held: true }] });
    for (const requestId of ["edit", "stuck"]) {
      const proposal = proposalFor(second.manager, requestId);
      expect(proposal).toMatchObject({ status: "pending", interruptedBy: "restart" });
      expect(second.manager.items(proposal.sessionId).items.some((item) => item.kind === "proposal" && item.proposalId === proposal.id)).toBe(true);
    }
    expect(second.manager.snapshot().handoffs.find((entry) => entry.id === "ask")).toMatchObject({ status: "failed", error: "앱이 다시 시작되어 응답이 끊겼습니다" });
    expect(second.manager.items(reviewer.id).items.at(-1)).toMatchObject({ kind: "turnEnd", cause: "restart", requestId: "ask" });
    expect(second.claude.sent).toHaveLength(0);
  });

  it("documents an engine writes carry its model, effort and request; the user's do not", async () => {
    const { manager, claude, work } = setup();
    const session = manager.createSession(work.id, { provider: "claude" });
    await manager.send(session.id, "make", "문서 만들어 줘");
    writeFileSync(join(work.cwd, "새 글.md"), "# 새 글\n");
    manager.sink.upsertItem(session.id, { kind: "tool", id: "t1", tool: "fileChange", title: "새 글.md", detail: null, output: null, status: "completed", at: Date.now(), paths: [join(work.cwd, "새 글.md")] });
    writeFileSync(join(work.cwd, "셸로 쓴 글.md"), "# 셸\n");
    claude.end(session.id, "completed");
    const byName = (name: string) => manager.snapshot().artifacts.find((artifact) => artifact.name === name)!;
    for (const name of ["새 글.md", "셸로 쓴 글.md"]) {
      expect(manager.documents.revisions(byName(name).id)[0]).toMatchObject({ author: "engine", model: "claude-model", effort: "high", requestId: "make" });
    }
    const saved = await manager.documents.saveText(byName("새 글.md").id, 1, "# 고친 글\n");
    expect(manager.documents.revisions(saved.id).at(-1)).not.toHaveProperty("model");
  });
});

describe("Office documents in search (Hangul uses the bundled WASM reader below)", () => {
  /** A text tool the test opens and closes: each read waits until released. */
  function slowTool() {
    const waiting: (() => void)[] = [];
    const reads: string[] = [];
    const tool = {
      available: true,
      runner: "fake",
      cli: "fake",
      read: async (path: string) => {
        reads.push(path);
        await new Promise<void>((done) => waiting.push(done));
        return readFileSync(path, "utf8").replace(/^HWPX:/, "");
      },
      textView: async (path: string) => {
        reads.push(path);
        await new Promise<void>((done) => waiting.push(done));
        return readFileSync(path, "utf8").replace(/^PK/, "");
      },
    };
    return { tool, reads, release: () => waiting.splice(0).forEach((done) => done()) };
  }

  it("indexes each new revision's text in the background, keeping the old entry until it is ready", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-recovery-index-"));
    dirs.push(dir);
    const office = slowTool();
    const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), {
      hostId: "h",
      hostLabel: "노트북",
      managedWorksDir: join(dir, "works"),
      dataDir: dir,
      ieum: office.tool as never,
    });
    const work = manager.createWork({ title: "w", cwd: join(dir, "project") });
    mkdirSync(work.cwd, { recursive: true });
    const found = (word: string) => manager.search(word).documents.map((entry) => entry.artifactId);
    for (const [name, tool, prefix, before, after] of [
      ["발표.pptx", office, "PK", "진달래", "개나리"],
    ] as const) {
      const file = join(work.cwd, name);
      writeFileSync(file, `${prefix}${before} 계획`);
      const first = manager.documents.track(work.id, work.cwd, file, "engine", null, null)!.artifact;
      await tick();
      expect(found(before)).toEqual([]);
      tool.release();
      await manager.documents.textIndex.settled();
      expect(found(before)).toEqual([first.id]);
      // A new revision: found by the old words until its own text is ready, then by the new ones only.
      writeFileSync(file, `${prefix}${after} 일정`);
      manager.documents.track(work.id, work.cwd, file, "engine", null, null);
      await tick();
      expect(found(before)).toEqual([first.id]);
      tool.release();
      await manager.documents.textIndex.settled();
      expect(found(after)).toEqual([first.id]);
      expect(found(before)).toEqual([]);
      // Kept with the revision: "글 보기" reads it without the tool.
      expect((await manager.documents.view(first.id, 2)).trim()).toBe(`${after} 일정`);
    }
    // Without the tool nothing is lost: the entry stays as it was.
    office.tool.available = false;
    const file = join(work.cwd, "발표.pptx");
    writeFileSync(file, "PK장미 목록");
    manager.documents.track(work.id, work.cwd, file, "engine", null, null);
    await manager.documents.textIndex.settled();
    expect(found("개나리").length).toBe(1);
    expect(found("장미")).toEqual([]);
  });
});

describe("Hangul documents an engine writes, with the installed kordoc", () => {
  // Uses the installed kordoc engine; skipped where it is not installed.
  it.runIf(new Kordoc().available)("are found by their text after each new revision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-recovery-kordoc-"));
    dirs.push(dir);
    const { execFileSync } = await import("node:child_process");
    // The runner shipped with the app generates HWPX itself; an installed skill keeps that in its core.
    const runner = new Kordoc().runner!;
    const core = join(runner, "../../core/scripts/run.mjs");
    const coreRunner = existsSync(core) ? core : runner;
    const hwpx = (word: string) => {
      const request = join(dir, `${word}.json`);
      writeFileSync(request, JSON.stringify({ schemaVersion: 1, mode: "generate", markdown: `# 계획\n\n${word} 일정을 정리합니다.`, outputDir: join(dir, word) }));
      const generated = JSON.parse(execFileSync(process.execPath, [coreRunner, request], { encoding: "utf8" })) as { files: { path: string }[] };
      return readFileSync(generated.files.find((file) => file.path.endsWith(".hwpx"))!.path);
    };
    const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir, kordoc: new Kordoc() });
    const work = manager.createWork({ title: "w", cwd: join(dir, "project") });
    mkdirSync(work.cwd, { recursive: true });
    const file = join(work.cwd, "계획서.hwpx");
    const found = (word: string) => manager.search(word).documents.map((entry) => entry.artifactId);
    writeFileSync(file, hwpx("해바라기"));
    const artifact = manager.documents.track(work.id, work.cwd, file, "engine", null, null)!.artifact;
    await manager.documents.textIndex.settled();
    expect(found("해바라기")).toEqual([artifact.id]);
    writeFileSync(file, hwpx("코스모스"));
    manager.documents.track(work.id, work.cwd, file, "engine", null, null);
    expect(found("해바라기")).toEqual([artifact.id]);
    await manager.documents.textIndex.settled();
    expect(found("코스모스")).toEqual([artifact.id]);
    expect(found("해바라기")).toEqual([]);
  }, 60_000);
});

describe("adapters when the engine process dies mid-turn (stand-in engines)", () => {
  /** A sink that records what the adapter reports, in order. */
  function recorder() {
    const events: ({ type: "item"; item: TranscriptItem } | { type: "session"; patch: Partial<Session> })[] = [];
    const sink: AdapterSink = {
      upsertItem: (_sessionId, item) => events.push({ type: "item", item }),
      delta: () => undefined,
      updateSession: (_sessionId, patch) => events.push({ type: "session", patch }),
      providerStatus: () => undefined,
      steerDropped: () => undefined,
      toolImages: () => undefined,
    };
    return { events, sink };
  }
  const session = (provider: Provider): Session & { access: "full" } => ({
    id: `s-${provider}`,
    workId: "w",
    provider,
    hostId: "h",
    nativeSessionId: null,
    purpose: "끊김",
    purposeSource: "user",
    model: null,
    effort: null,
    engineModel: null,
    engineEffort: null,
    preview: null,
    previewAt: null,
    status: "idle",
    activity: null,
    lastError: null,
    pinned: false,
    sort: 0,
    archivedAt: null,
    seenAt: null,
    unread: false,
    queued: [],
    access: "full",
    context: null,
    createdAt: 0,
    updatedAt: 0,
  });
  const work = (cwd: string): Work => ({ id: "w", title: "w", titleSource: "user", folderId: null, cwd, cwdManaged: false, activeSessionId: null, pinned: false, sort: 0, archivedAt: null, createdAt: 0, updatedAt: 0 });
  const until = async (what: () => boolean, timeout = 15_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end && !what()) await new Promise((done) => setTimeout(done, 50));
    return what();
  };

  for (const provider of ["codex", "claude"] as const) {
    it(`${provider}: the turn ends with its cause before the session goes idle, with the error kept`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), `wb-recovery-${provider}-`));
      dirs.push(cwd);
      vi.stubEnv("WORKBENCH_CODEX_BIN", resolve("scripts/fixtures/fake-codex.mjs"));
      vi.stubEnv("WORKBENCH_CLAUDE_BIN", resolve("scripts/fixtures/fake-claude.mjs"));
      vi.stubEnv("CLAUDE_CONFIG_DIR", cwd);
      const { events, sink } = recorder();
      const adapter = provider === "codex" ? new CodexAdapter(sink, { idleMs: 60_000 }) : new ClaudeAdapter(sink, { idleMs: 60_000 });
      try {
        await adapter.send(session(provider), work(cwd), "길게 써 줘 [[crash]]", "req-crash");
        expect(await until(() => events.some((event) => event.type === "item" && event.item.kind === "turnEnd"))).toBe(true);
        const end = events.findIndex((event) => event.type === "item" && event.item.kind === "turnEnd");
        expect(events[end]).toMatchObject({ item: { status: "failed", cause: "crash", requestId: "req-crash" } });
        const idle = events.findIndex((event) => event.type === "session" && event.patch.status === "idle");
        expect(idle).toBeGreaterThan(end);
        expect(events[idle]).toMatchObject({ patch: { lastError: expect.stringMatching(provider === "codex" ? /Codex 엔진이 종료되었습니다/ : /Claude 실행이 중단되었습니다/) } });
        // A notice in the conversation says so, and part of the answer was kept.
        expect(events.some((event) => event.type === "item" && event.item.kind === "notice" && event.item.level === "error")).toBe(true);
      } finally {
        await adapter.shutdown();
      }
    }, 30_000);
  }
});
