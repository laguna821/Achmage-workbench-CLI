import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDecision, CreateTarget, ProviderStatus, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { parseCreate, reservePath } from "./create.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

class ScriptedAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;
  prompts: string[] = [];
  finish = true;
  action: (prompt: string) => void | Promise<void> = () => {};
  private readonly sink: () => AdapterSink;
  constructor(sink: () => AdapterSink) {
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
    await this.action(text);
    if (!this.finish) return;
    this.sink().upsertItem(session.id, { kind: "turnEnd", id: `end:${turnKey}`, status: "completed", durationMs: 5, at: Date.now() });
    this.sink().updateSession(session.id, { status: "idle" });
  }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) {
    return false;
  }
  async shutdown() {}
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-create-"));
  const store = new Store(join(dir, "state.sqlite"));
  const options = { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir, skillHomeDir: join(dir, "home") };
  const manager = new SessionManager(store, new EventBus(), options);
  const claude = new ScriptedAdapter(() => manager.sink);
  manager.registerAdapter(claude);
  const work = manager.createWork({ title: "특강", cwd: join(dir, "project") });
  mkdirSync(work.cwd, { recursive: true });
  cleanup.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, manager, claude, work, store, options };
}

async function template(manager: SessionManager) {
  const folder = join(manager.userSkills.appDir, "meeting"), original = join(folder, "assets/form.md");
  mkdirSync(join(folder, "assets"), { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), "---\nname: meeting\ndescription: Meeting form\nmetadata:\n  ieum-title: 회의 양식\n  ieum-template: assets/form.md\n---\nKeep the headings.\n");
  writeFileSync(original, "# 회의록\n\n## 참석자\n");
  const skill = (await manager.userSkills.list())[0]!; await manager.userSkills.setState(skill.id, { enabled: true, invoke: "manual" });
  const snap = await manager.userSkills.templateSnapshot(skill.id);
  const target: CreateTarget = { format: "markdown", name: "회의 결과", template: { skillId: skill.id, title: skill.title, sha256: snap.sha256, skillSha256: snap.skillSha256 } };
  return { original, snap, target };
}

const reservedIn = (prompt: string, cwd: string) => resolve(cwd, /\[새 문서\] .*?: (.+)$/m.exec(prompt)![1]);

describe("new documents from a request", () => {
  it("reserves a free name and accepts only known formats", () => {
    const { work } = setup();
    writeFileSync(join(work.cwd, "요약.md"), "x");
    expect(reservePath(work.cwd, { format: "markdown", name: "요약" })).toBe(join(work.cwd, "요약 2.md"));
    expect(reservePath(work.cwd, { format: "hwpx", name: "../보고서.hwpx" })).toBe(join(work.cwd, ".._보고서.hwpx"));
    expect(reservePath(work.cwd, { format: "design", name: "" })).toBe(join(work.cwd, "새 문서.design.json"));
    expect(reservePath(work.cwd, { format: "xlsx", name: "사본.xlsm", extension: ".xlsm" })).toBe(join(work.cwd, "사본.xlsm"));
    expect(() => reservePath(work.cwd, { format: "xlsx", name: "사본", extension: ".exe" })).toThrow(/형식/);
    expect(parseCreate({ format: "exe", name: "a" })).toBeNull();
    expect(parseCreate({ format: "pptx", name: "발표" })).toEqual({ format: "pptx", name: "발표" });
  });

  it("tracks the new document with the documents it came from", async () => {
    const { manager, claude, work } = setup();
    writeFileSync(join(work.cwd, "강의.md"), "# 가을 특강\n\n질문에서 시작하는 글쓰기\n");
    const source = manager.openFile(work.id, "강의.md");
    const session = manager.createSession(work.id, { provider: "claude" });
    claude.action = (prompt) => writeFileSync(reservedIn(prompt, work.cwd), "# 가을 특강 요약\n\n한 줄 요약\n");
    await manager.send(session.id, "c1", "이걸 한 쪽 요약으로", [{ artifactId: source.id, revision: 1, mode: "review" }], null, { format: "markdown", name: "강의 요약" });

    expect(claude.prompts[0]).toContain("[새 문서] 이 요청의 결과는 새 마크다운 문서로 만드세요: 강의 요약.md");
    const created = manager.documents.list().find((artifact) => artifact.name === "강의 요약.md")!;
    expect(created).toMatchObject({ format: "markdown", revision: 1 });
    expect(manager.documents.revisions(created.id)[0]).toMatchObject({ author: "engine", derivedFrom: [{ artifactId: source.id, revision: 1 }], note: "새 문서 · 강의.md에서" });
    const items = manager.items(session.id).items;
    expect(items.find((item) => item.kind === "user")).toMatchObject({ create: { format: "markdown", name: "강의 요약.md" } });
    expect(items.filter((item) => item.kind === "artifact" && item.artifactId === created.id)).toHaveLength(1);
    expect(existsSync(join(work.cwd, "강의.md"))).toBe(true);
  });

  it("says so when the engine did not make the document, and warns about a broken one", async () => {
    const { manager, claude, work } = setup();
    const session = manager.createSession(work.id, { provider: "claude" });
    await manager.send(session.id, "c2", "포스터 만들어 줘", [], null, { format: "design", name: "포스터" });
    expect(manager.items(session.id).items.find((item) => item.kind === "notice")).toMatchObject({ text: "새 문서 포스터.design.json이(가) 만들어지지 않았습니다." });

    claude.action = (prompt) => writeFileSync(reservedIn(prompt, work.cwd), "{ not json");
    await manager.send(session.id, "c3", "다시 포스터", [], null, { format: "design", name: "포스터" });
    await new Promise((done) => setTimeout(done, 20));
    expect(manager.items(session.id).items.find((item) => item.kind === "notice" && item.id === "create-problem:c3")).toMatchObject({ text: expect.stringContaining("JSON") });
  });

  it("copies the exact chosen template and sends a simultaneous repeated request only once", async () => {
    const { manager, claude, work } = setup(); const { target, original } = await template(manager);
    const session = manager.createSession(work.id, { provider: "claude" });
    claude.action = async (prompt) => {
      const copy = reservedIn(prompt, work.cwd); expect(readFileSync(copy, "utf8")).toBe(readFileSync(original, "utf8"));
      await new Promise((done) => setTimeout(done, 15)); writeFileSync(copy, "# 회의록\n\n## 참석자\n홍길동\n");
    };
    const results = await Promise.all(Array.from({ length: 4 }, () => manager.send(session.id, "once", "회의 내용을 채워 줘", [], null, target)));
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1); expect(claude.prompts).toHaveLength(1);
    expect(claude.prompts[0]).toContain("사본을 편집하세요"); expect(claude.prompts[0]).toContain("template-instructions");
    expect(readFileSync(original, "utf8")).toBe("# 회의록\n\n## 참석자\n");
    expect(manager.creations.get("once")).toMatchObject({ state: "completed", target, path: join(work.cwd, "회의 결과.md") });
    expect(readdirSync(work.cwd).filter((name) => name.startsWith("회의 결과"))).toEqual(["회의 결과.md"]);
    expect(manager.items(session.id).items.filter((item) => item.kind === "user")).toHaveLength(1);
    await expect(manager.send(session.id, "once", "다른 요청", [], null, target)).rejects.toMatchObject({ code: "request_id_conflict" });
  });

  it("gives concurrent sessions distinct names before their engines write anything", async () => {
    const { manager, claude, work } = setup(); const { target } = await template(manager);
    const sessions = [manager.createSession(work.id, { provider: "claude" }), manager.createSession(work.id, { provider: "claude" })];
    claude.action = async () => { await new Promise((done) => setTimeout(done, 15)); };
    await Promise.all(sessions.map((session, i) => manager.send(session.id, `parallel-${i}`, "채워 줘", [], null, target)));
    expect(new Set(claude.prompts.map((prompt) => reservedIn(prompt, work.cwd))).size).toBe(2);
    expect(readdirSync(work.cwd).filter((name) => name.startsWith("회의 결과")).sort()).toEqual(["회의 결과 2.md", "회의 결과.md"]);
  });

  it("rejects a changed template before reserving a copy or sending a request", async () => {
    const { manager, claude, work } = setup(); const { target, original } = await template(manager);
    const session = manager.createSession(work.id, { provider: "claude" }); writeFileSync(original, "changed after preview");
    await expect(manager.send(session.id, "stale", "채워 줘", [], null, target)).rejects.toMatchObject({ code: "template_changed" });
    expect(claude.prompts).toHaveLength(0); expect(manager.creations.get("stale")).toBeNull();
    expect(readdirSync(work.cwd)).not.toContain("회의 결과.md");
  });

  it("recovers an interrupted copy after restart without another file or engine request", async () => {
    const { manager, claude, work, store, options } = setup(); const { target, original } = await template(manager);
    const session = manager.createSession(work.id, { provider: "claude" }); claude.finish = false;
    await manager.send(session.id, "interrupted", "채워 줘", [], null, target); await manager.shutdown();
    const restarted = new SessionManager(store, new EventBus(), options); cleanup.push(() => restarted.shutdown());
    const other = new ScriptedAdapter(() => restarted.sink); restarted.registerAdapter(other);
    expect(restarted.creations.get("interrupted")).toMatchObject({ state: "interrupted", artifactId: expect.any(String) });
    expect(restarted.items(session.id).items.some((item) => item.kind === "notice" && item.id === "create-recovered:interrupted")).toBe(true);
    expect(await restarted.send(session.id, "interrupted", "채워 줘", [], null, target)).toMatchObject({ duplicate: true });
    expect(other.prompts).toHaveLength(0); expect(readdirSync(work.cwd).filter((name) => name.startsWith("회의 결과"))).toEqual(["회의 결과.md"]);
    expect(readFileSync(join(work.cwd, "회의 결과.md"), "utf8")).toBe(readFileSync(original, "utf8"));
  });
});
