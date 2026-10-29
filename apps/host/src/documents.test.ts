import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { Kordoc } from "./kordoc.ts";
import { HttpError, SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";
import { editHwp } from "./hwp-ops.mjs";
import { Documents } from "./artifacts.ts";

/** Engine stand-in: records prompts and runs a per-test action, then ends the turn. */
class ScriptedAdapter implements ProviderAdapter {
  readonly provider: "claude" | "codex";
  prompts: string[] = [];
  action: (prompt: string, sessionId: string, turnKey: string) => void | Promise<void> = () => {};
  private readonly sink: () => AdapterSink;
  constructor(provider: "claude" | "codex", sink: () => AdapterSink) {
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
  async send(session: Session, _work: Work, text: string, turnKey: string) {
    this.prompts.push(text);
    this.sink().updateSession(session.id, { status: "running" });
    await this.action(text, session.id, turnKey);
    this.sink().upsertItem(session.id, { kind: "turnEnd", id: `end:${turnKey}`, status: "completed", durationMs: 5, at: Date.now() });
    this.sink().updateSession(session.id, { status: "idle" });
  }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) {
    return false;
  }
  async shutdown() {}
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-docs-"));
  const store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), kordoc: new Kordoc() });
  const claude = new ScriptedAdapter("claude", () => manager.sink);
  const codex = new ScriptedAdapter("codex", () => manager.sink);
  manager.registerAdapter(claude);
  manager.registerAdapter(codex);
  const work = manager.createWork({ title: "강의", cwd: join(dir, "project") });
  writeFileSync(join(dir, ".keep"), "");
  return { dir, manager, claude, codex, work, store };
}

const workingPathIn = (prompt: string) => /작업 사본만 수정하세요: (.+)$/m.exec(prompt)?.[1];

describe("documents and revisions", () => {
  it("keeps same-name documents and request-prefix collisions in distinct immutable copies", async () => {
    const { manager, work } = setup();
    for (const folder of ["a", "b"]) mkdirSync(join(work.cwd, folder), { recursive: true });
    const name = `${"한글".repeat(60)}.md`;
    // Keep original names below the platform's byte limit while exercising long pinned names.
    const filename = name.slice(0, 70) + ".md";
    const files = [join(work.cwd, "a", filename), join(work.cwd, "b", filename)];
    files.forEach((file, index) => writeFileSync(file, `different ${index}`));
    const docs = files.map((file) => manager.openFile(work.id, file));
    const refs = manager.documents.resolveReferences(docs.map((doc) => ({ artifactId: doc.id, mode: "edit" })));
    const session = manager.createSession(work.id, { provider: "claude" });
    const first = await manager.documents.prepare(refs[0]!, session.id, "samehead-first", work.cwd);
    const second = await manager.documents.prepare(refs[1]!, session.id, "samehead-first", work.cwd);
    const third = await manager.documents.prepare(refs[0]!, session.id, "samehead-second", work.cwd);
    expect(first.pinned).not.toBe(second.pinned);
    expect(readFileSync(first.pinned, "utf8")).toBe("different 0");
    expect(readFileSync(second.pinned, "utf8")).toBe("different 1");
    expect(first.proposal?.workingPath).not.toBe(third.proposal?.workingPath);
    await expect(manager.documents.prepare({ ...refs[0]!, sha256: "0".repeat(64) }, session.id, "bad", work.cwd)).rejects.toMatchObject({ code: "reference_changed" });
    chmodSync(first.pinned, 0o644); writeFileSync(first.pinned, "changed copy");
    await expect(manager.documents.prepare(refs[0]!, session.id, "bad-copy", work.cwd)).rejects.toMatchObject({ code: "pinned_copy_changed" });
    expect(readFileSync(files[0]!, "utf8")).toBe("different 0");
  });

  it("requires dirty-reference acknowledgement, pins saved bytes, and follows later disk changes only when requested", async () => {
    const { manager, work } = setup();
    mkdirSync(work.cwd, { recursive: true });
    const file = join(work.cwd, "reference.md"); writeFileSync(file, "saved one");
    const doc = manager.openFile(work.id, file);
    const view = { viewId: "typing", windowId: "window", claim: true, dirty: true };
    manager.documents.registry.open(doc.id, view);
    expect(() => manager.documents.resolveReferences([{ artifactId: doc.id, mode: "review" }])).toThrow(/저장하지 않은/);
    const [pinned] = manager.documents.resolveReferences([{ artifactId: doc.id, mode: "review", savedSnapshot: true }]);
    expect(pinned).toMatchObject({ revision: 1, sha256: doc.sha256, savedSnapshot: true });
    manager.documents.registry.open(doc.id, { ...view, dirty: false });
    writeFileSync(file, "external two");
    expect(() => manager.documents.resolveReferences([{ artifactId: doc.id, revision: 1, mode: "edit" }])).toThrow(/판이 바뀌/);
    expect(manager.documents.resolveReferences([pinned!])[0]).toMatchObject({ revision: 1, sha256: doc.sha256 });
    const [latest] = manager.documents.resolveReferences([{ artifactId: doc.id, mode: "review" }]);
    expect(latest).toMatchObject({ revision: 2 }); expect(latest?.sha256).not.toBe(doc.sha256);
    const session = manager.createSession(work.id, { provider: "claude" });
    await manager.send(session.id, "saved-reference", "read this saved revision", [pinned!]);
    const user = manager.items(session.id).items.find((item) => item.kind === "user");
    expect(user).toMatchObject({ refs: [{ artifactId: doc.id, revision: 1, sha256: doc.sha256, savedSnapshot: true }] });
    expect(readFileSync(file, "utf8")).toBe("external two");
  });

  it("turns an engine's file write into a tracked document with a card", async () => {
    const { manager, claude, work } = setup();
    const session = manager.createSession(work.id, { provider: "claude" });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(work.cwd, { recursive: true });
    claude.action = (_prompt, sessionId) => {
      writeFileSync(join(work.cwd, "강의.md"), "# 질문에서 시작하는 지식 생산\n\n우리는 자료를 읽고 질문을 만듭니다.\n");
      manager.sink.upsertItem(sessionId, { kind: "tool", id: "t1", tool: "fileChange", title: "강의.md", detail: null, output: null, status: "completed", at: 1, paths: [join(work.cwd, "강의.md")] });
    };
    await manager.send(session.id, "r1", "강의 초안 써줘");
    const snapshot = manager.snapshot();
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.artifacts[0]).toMatchObject({ name: "강의.md", format: "markdown", revision: 1 });
    expect(manager.items(session.id).items.find((item) => item.kind === "artifact")).toMatchObject({ change: "created", revision: 1 });
  });

  it("keeps AI edits in a working copy until applied, and never applies onto a newer revision", async () => {
    const { manager, claude, codex, work } = setup();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(work.cwd, { recursive: true });
    const file = join(work.cwd, "강의.md");
    writeFileSync(file, "첫 문단\n\n둘째 문단\n");
    const artifact = manager.openFile(work.id, file);
    const writer = manager.createSession(work.id, { provider: "claude" });

    // The engine edits only its working copy; the real file stays as it was.
    claude.action = (prompt) => {
      const workingPath = workingPathIn(prompt)!;
      expect(prompt).toContain("판 r1");
      writeFileSync(join(work.cwd, workingPath), "첫 문단\n\n고친 둘째 문단\n");
    };
    await manager.send(writer.id, "edit-1", "둘째 문단을 고쳐줘", [{ artifactId: artifact.id, revision: 1, mode: "edit", selection: null }]);
    expect(readFileSync(file, "utf8")).toBe("첫 문단\n\n둘째 문단\n");
    const proposal = manager.snapshot().proposals[0];
    expect(proposal).toMatchObject({ status: "pending", baseRevision: 1, added: 1, removed: 1 });
    expect(manager.snapshot().artifacts[0].readBy[writer.id]).toBe(1);

    // A second proposal, then the user edits: the old-revision proposal is refused.
    claude.action = (prompt) => writeFileSync(join(work.cwd, workingPathIn(prompt)!), "첫 문단\n\n다르게 고친 둘째 문단\n");
    await manager.send(writer.id, "edit-2", "다르게도 고쳐줘", [{ artifactId: artifact.id, revision: 1, mode: "edit", selection: null }]);
    const second = manager.snapshot().proposals.find((entry) => entry.requestId === "edit-2")!;
    const saved = await manager.documents.saveText(artifact.id, 1, "첫 문단(사용자 수정)\n\n둘째 문단\n");
    expect(saved.revision).toBe(2);
    await expect(manager.documents.applyProposal(second.id)).rejects.toThrow(/r1 기준인데 문서는 지금 r2/);
    expect(readFileSync(file, "utf8")).toBe("첫 문단(사용자 수정)\n\n둘째 문단\n");

    // Asked again on the latest revision, the proposal applies and becomes r3.
    claude.action = (prompt) => {
      expect(prompt).toContain("판 r2");
      writeFileSync(join(work.cwd, workingPathIn(prompt)!), "첫 문단(사용자 수정)\n\n고친 둘째 문단\n");
    };
    await manager.send(writer.id, "edit-3", "최신 판으로 다시", [{ artifactId: artifact.id, revision: 2, mode: "edit", selection: null }]);
    const third = manager.snapshot().proposals.find((entry) => entry.requestId === "edit-3")!;
    const applied = await manager.documents.applyProposal(third.id);
    expect(applied.artifact.revision).toBe(3);
    expect(readFileSync(file, "utf8")).toBe("첫 문단(사용자 수정)\n\n고친 둘째 문단\n");

    // While Claude holds an edit, another session may only review.
    claude.action = () => {};
    const reviewer = manager.createSession(work.id, { provider: "codex" });
    const running = await manager.documents.prepare({ artifactId: artifact.id, revision: 3, mode: "edit" }, writer.id, "hold", work.cwd);
    expect(running.proposal?.status).toBe("running");
    await expect(manager.send(reviewer.id, "edit-4", "나도 고칠래", [{ artifactId: artifact.id, revision: 3, mode: "edit", selection: null }])).rejects.toMatchObject({
      code: "artifact_busy",
    });
    codex.action = (prompt) => expect(prompt).toContain("파일은 고치지 마세요");
    await manager.send(reviewer.id, "review-1", "검토해줘", [{ artifactId: artifact.id, revision: 3, mode: "review", selection: null }]);
  });

  it("refuses to save over an external change and keeps it when adopted", async () => {
    const { manager, work } = setup();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(work.cwd, { recursive: true });
    const file = join(work.cwd, "메모.md");
    writeFileSync(file, "원래\n");
    const artifact = manager.openFile(work.id, file);
    writeFileSync(file, "다른 프로그램이 바꿈\n");
    await expect(manager.documents.saveText(artifact.id, 1, "내 수정\n")).rejects.toBeInstanceOf(HttpError);
    expect(readFileSync(file, "utf8")).toBe("다른 프로그램이 바꿈\n");
    const adopted = manager.documents.adoptDisk(artifact.id);
    expect(adopted).toMatchObject({ revision: 2, diskState: "same" });
    expect(manager.documents.revert(artifact.id, 1).revision).toBe(3);
    expect(readFileSync(file, "utf8")).toBe("원래\n");
  });

  it("sends a pinned revision to another session once and brings the answer back", async () => {
    const { manager, codex, work } = setup();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(work.cwd, { recursive: true });
    const file = join(work.cwd, "강의.md");
    writeFileSync(file, "인용: 김(2024)\n");
    const artifact = manager.openFile(work.id, file);
    const source = manager.createSession(work.id, { provider: "claude" });
    const target = manager.createSession(work.id, { provider: "codex" });
    codex.action = (prompt, sessionId) => {
      expect(prompt).toContain("[다른 세션에서 온 요청]");
      expect(prompt).toContain("판 r1");
      manager.sink.upsertItem(sessionId, { kind: "assistant", id: "a:review", text: "인용 근거 1건 확인 필요", streaming: false, at: 2 });
    };
    const request = { requestId: "handoff-1", sourceSessionId: source.id, targetSessionId: target.id, text: "인용 근거 확인해줘", refs: [{ artifactId: artifact.id, revision: 1, mode: "edit" as const }] };
    await manager.handoff(request);
    await manager.handoff(request);
    expect(codex.prompts).toHaveLength(1);
    const handoff = manager.snapshot().handoffs[0];
    expect(handoff).toMatchObject({ status: "answered", reply: "인용 근거 1건 확인 필요" });
    // Handoffs are review only: the target never gets a working copy.
    expect(handoff.refs[0].mode).toBe("review");
    expect(manager.items(source.id).items.find((item) => item.kind === "handoff")).toBeTruthy();
    expect(manager.items(target.id).items.find((item) => item.kind === "user")).toMatchObject({ from: { sessionId: source.id } });
  });

  // Uses the kordoc engine shipped in third_party/kordoc.
  it("recovers legacy Markdown edits and creates new HWPX proposals as binary editor documents", async () => {
    const { manager, claude, work, dir, store } = setup();
    const { mkdirSync, execFileSync } = await import("node:child_process").then(async (child) => ({ ...(await import("node:fs")), execFileSync: child.execFileSync }));
    mkdirSync(work.cwd, { recursive: true });
    // Make a real HWPX with the same engine.
    const request = join(dir, "generate.json");
    writeFileSync(request, JSON.stringify({ schemaVersion: 1, mode: "generate", markdown: "# 강의 개요\n\n우리는 자료를 읽고 질문을 만듭니다.\n\n자료의 결론보다 조건을 살핍니다.", outputDir: join(dir, "gen") }));
    const coreRunner = new Kordoc().runner!;
    expect(new Kordoc().bundled).toBe(true);
    const generated = JSON.parse(execFileSync(process.execPath, [coreRunner, request], { encoding: "utf8" })) as { files: { path: string }[] };
    const source = generated.files.find((file) => file.path.endsWith(".hwpx"))!.path;
    const file = join(work.cwd, "강의.hwpx");
    writeFileSync(file, readFileSync(source));
    const artifact = manager.openFile(work.id, file);
    expect(artifact.format).toBe("hwpx");

    const view = await manager.documents.text(artifact.id);
    expect(view.view).toBe(true);
    expect(view.text).toContain("우리는 자료를 읽고 질문을 만듭니다.");
    expect(view.editable).toBe(false);
    const legacyText = await new Kordoc().read(file);
    const saved = await manager.documents.saveText(artifact.id, 1, legacyText.replace("질문을 만듭니다.", "질문을 함께 만듭니다."));
    expect(saved.revision).toBe(2);
    expect((await manager.documents.text(artifact.id)).text).toContain("질문을 함께 만듭니다.");

    const writer = manager.createSession(work.id, { provider: "claude" });
    claude.action = async (prompt) => {
      expect(prompt).toContain("workbench-hwp catalog");
      const working = join(work.cwd, workingPathIn(prompt)!);
      expect(working).toMatch(/\.hwpx$/);
      const edited = await editHwp(readFileSync(working), "hwpx", [{ op: "replace_text", find: "조건을 살핍니다.", replace: "성립 조건부터 살핍니다." }]);
      writeFileSync(working, edited.bytes);
    };
    await manager.send(writer.id, "hwpx-edit", "둘째 문단을 고쳐줘", [{ artifactId: artifact.id, revision: 2, mode: "edit", selection: null }]);
    const proposal = manager.snapshot().proposals.find((entry) => entry.requestId === "hwpx-edit")!;
    expect(proposal.status).toBe("pending");
    expect((await manager.documents.text(artifact.id)).text).not.toContain("성립 조건부터");
    expect((await manager.documents.proposalTexts(proposal.id)).proposed).toContain("성립 조건부터");
    const applied = await manager.documents.applyProposal(proposal.id);
    expect(applied.artifact.revision).toBe(3);
    expect((await manager.documents.text(artifact.id)).text).toContain("성립 조건부터 살핍니다.");
    // A proposal saved by v0.22 remains a Markdown patch after restart. Its old cache is
    // separate from the new WASM text view and must not be reinterpreted as a binary.
    const oldView = await new Kordoc().read(file);
    writeFileSync(join(dir, "artifacts", artifact.id, "r3.view.md"), oldView);
    const oldWorking = join(work.cwd, ".workbench", "drafts", "legacy.hwpx.md");
    writeFileSync(oldWorking, oldView.replace("질문을 함께 만듭니다.", "질문을 서로 나눕니다."));
    const legacy = { ...proposal, id: "legacy-proposal", workingPath: oldWorking, baseRevision: 3, status: "running" as const, appliedRevision: null };
    store.saveProposal(legacy);
    const resumed = new Documents(store, new EventBus(), dir, new Kordoc());
    expect(resumed.finishProposal(legacy.id).status).toBe("pending");
    expect((await resumed.proposalTexts(legacy.id)).base).toBe(oldView);
    expect((await resumed.applyProposal(legacy.id)).artifact.revision).toBe(4);
    expect((await resumed.text(artifact.id)).text).toContain("질문을 서로 나눕니다.");
  }, 60_000);
});
