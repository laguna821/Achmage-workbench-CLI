import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { parseCreate, reservePath } from "./create.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

class ScriptedAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;
  prompts: string[] = [];
  action: (prompt: string) => void = () => {};
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
    this.action(text);
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
  const dir = mkdtempSync(join(tmpdir(), "wb-create-"));
  const store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
  const claude = new ScriptedAdapter(() => manager.sink);
  manager.registerAdapter(claude);
  const work = manager.createWork({ title: "특강", cwd: join(dir, "project") });
  mkdirSync(work.cwd, { recursive: true });
  return { dir, manager, claude, work };
}

const reservedIn = (prompt: string, cwd: string) => resolve(cwd, /\[새 문서\] .*?: (.+)$/m.exec(prompt)![1]);

describe("new documents from a request", () => {
  it("reserves a free name and accepts only known formats", () => {
    const { work } = setup();
    writeFileSync(join(work.cwd, "요약.md"), "x");
    expect(reservePath(work.cwd, { format: "markdown", name: "요약" })).toBe(join(work.cwd, "요약 2.md"));
    expect(reservePath(work.cwd, { format: "hwpx", name: "../보고서.hwpx" })).toBe(join(work.cwd, ".._보고서.hwpx"));
    expect(reservePath(work.cwd, { format: "design", name: "" })).toBe(join(work.cwd, "새 문서.design.json"));
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
});
