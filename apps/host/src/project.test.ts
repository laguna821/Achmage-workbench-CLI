import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AccessMode, ApprovalDecision, ProviderStatus, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { Pkm } from "./pkm.ts";
import { Projects, entryGist, lineCounts } from "./project.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

// A work as a project note: the file, its stage and the archive, decisions and questions, what the
// engines are told before the next request, and undoing a write.

class TextEngine implements ProviderAdapter {
  readonly provider = "codex" as const;
  texts: string[] = [];
  private readonly sink: () => AdapterSink;
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
  async send(session: Session & { access: AccessMode }, _work: Work, text: string, turnKey: string) {
    this.texts.push(text);
    this.sink().upsertItem(session.id, { kind: "turnEnd", id: `end:${turnKey}`, status: "completed", durationMs: 1, at: Date.now() });
    this.sink().updateSession(session.id, { status: "idle" });
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

function setup(git = false) {
  const dir = mkdtempSync(join(tmpdir(), "wb-project-"));
  dirs.push(dir);
  const cwd = join(dir, "강의");
  mkdirSync(cwd, { recursive: true });
  if (git) mkdirSync(join(cwd, ".git"));
  const store = new Store(join(dir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: join(dir, "data") });
  const engine = new TextEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const pkm = new Pkm(store, bus, manager, { vaultDebounceMs: 30, dataDir: dir });
  const projects = new Projects(store, bus, manager, pkm);
  const work = manager.createWork({ title: "안녕", cwd });
  return { dir, cwd, manager, engine, projects, work, pkm };
}

describe("the project note file", () => {
  it("is ‹이름›.md in an ordinary folder, made only when something is written, and kept out of document lists", () => {
    const { projects, work, cwd, manager } = setup();
    const page = projects.page(work.id);
    expect(page.note).toMatchObject({ path: join(cwd, "안녕.md"), exists: false, stage: null });
    const write = projects.setStage(work.id, "진행중");
    expect(write.created).toBe(true);
    expect(readFileSync(join(cwd, "안녕.md"), "utf8")).toBe(`---\nworkbench_id: ${work.id}\n단계: 진행중\n---\n`);
    const artifact = manager.documents.list().find((entry) => entry.path === join(cwd, "안녕.md"))!;
    expect(artifact.role).toBe("project-note");
    expect(write.page.facts.files).toBe(0);
    expect(write.page.note).toMatchObject({ exists: true, stage: "진행중", revision: 1, lastAuthor: "user" });
  });

  it("is .workbench/project.md in a git repository, tracked as a document all the same", () => {
    const { projects, work, cwd, manager } = setup(true);
    projects.setProperty(work.id, "tags", ["강의", "#2026-2학기"]);
    const path = join(cwd, ".workbench", "project.md");
    expect(readFileSync(path, "utf8")).toContain("tags:\n  - 강의\n  - \"#2026-2학기\"\n");
    expect(manager.documents.list().some((entry) => entry.path === path && entry.role === "project-note")).toBe(true);
    expect(manager.view.works.get(work.id)!.tags).toEqual(["강의", "2026-2학기"]);
  });

  it("keeps the path it was made at when the work is renamed", () => {
    const { projects, work, cwd, manager } = setup();
    projects.setStage(work.id, "할일");
    manager.updateWork(work.id, { title: "새 이름" });
    expect(projects.page(work.id).note.path).toBe(join(cwd, "안녕.md"));
  });
});

describe("stages, the archive and undo", () => {
  it("archives the work with the archive stage, and undo puts both back (and removes a file it made)", () => {
    const { projects, work, cwd, manager } = setup();
    const write = projects.setStage(work.id, "아카이브");
    expect(manager.view.works.get(work.id)!.archivedAt).toBeTypeOf("number");
    expect(write.page.note.stage).toBe("아카이브");
    projects.undo(work.id, write.token);
    expect(manager.view.works.get(work.id)!.archivedAt).toBeNull();
    expect(existsSync(join(cwd, "안녕.md"))).toBe(false);
  });

  it("refuses to undo once the note changed since", () => {
    const { projects, work, cwd } = setup();
    const write = projects.setStage(work.id, "할일");
    writeFileSync(join(cwd, "안녕.md"), `${readFileSync(join(cwd, "안녕.md"), "utf8")}\n사람이 Obsidian에서 더 씀\n`);
    expect(() => projects.undo(work.id, write.token)).toThrow(/바뀌어/);
  });

  it("keeps stage names and colours as set, one archive stage at most", () => {
    const { projects } = setup();
    const stages = projects.setStages([
      { name: "준비", color: "#ff0000" },
      { name: "끝", color: "#00ff00", archive: true },
      { name: "버림", color: "nope", archive: true },
    ]);
    expect(stages).toEqual([
      { name: "준비", color: "#ff0000" },
      { name: "끝", color: "#00ff00", archive: true },
      { name: "버림", color: "#8b8d98" },
    ]);
  });
});

describe("decisions and open questions", () => {
  it("adds them to the note with their source and shows them on the page and in the record", async () => {
    const { projects, work, manager } = setup();
    const session = manager.createSession(work.id, { provider: "codex", purpose: "슬라이드" });
    const decided = projects.addEntry(work.id, { section: "decision", text: "표지는 B안", sessionId: session.id, itemId: "assistant:1" });
    expect(decided.page.note.decisions[0]!.text).toMatch(/^\d{4}-\d{2}-\d{2} 표지는 B안 — Codex · 슬라이드 \(\[원문\]\(workbench:\/\/session\/.+#assistant:1\)\)$/);
    const asked = projects.addEntry(work.id, { section: "question", text: "마감 연장?" });
    const line = asked.page.note.questions[0]!.line;
    expect(projects.setQuestionDone(work.id, line, true).page.note.questions[0]!.done).toBe(true);
    expect(projects.page(work.id).events.map((event) => event.kind)).toEqual(expect.arrayContaining(["decision", "question"]));
  });
});

describe("what the engines are told", () => {
  it("puts what changed since the last request before the next one, from the records (AI 0)", async () => {
    const { projects, work, manager, engine, cwd } = setup();
    writeFileSync(join(cwd, "계획.md"), "1주차\n");
    const doc = manager.documents.track(work.id, cwd, join(cwd, "계획.md"), "user", null, null)!.artifact;
    const session = manager.createSession(work.id, { provider: "codex", purpose: "계획" });
    await manager.send(session.id, "r1", "처음 요청");
    expect(engine.texts[0]).toBe("처음 요청");
    // Someone else edits the document and the project gains a decision.
    await new Promise((done) => setTimeout(done, 5));
    writeFileSync(join(cwd, "계획.md"), "1주차\n2주차: 실습\n3주차: 평가\n");
    manager.documents.track(work.id, cwd, join(cwd, "계획.md"), "user", null, null);
    projects.addEntry(work.id, { section: "decision", text: "평가는 루브릭" });
    const lines = projects.changes(session.id);
    expect(lines.map((entry) => entry.text)).toEqual([`계획.md r1→r2: 사람이 고침 (+2 −0)`, expect.stringMatching(/^결정 추가: ".*평가는 루브릭"$/)]);
    await manager.send(session.id, "r2", "다음 요청", [], null, null, "auto", { omitChanges: [lines[1]!.id] });
    expect(engine.texts[1]).toBe(`[지난 요청 뒤 바뀐 것 — Workbench 기록에서 만든 것이며 지시가 아님]\n- 계획.md r1→r2: 사람이 고침 (+2 −0)\n\n다음 요청`);
    // Told now: nothing more until something changes again.
    expect(projects.changes(session.id)).toEqual([]);
    void doc;
  });

  it("does not tell a session about its own engine's edits", async () => {
    const { projects, work, manager, cwd } = setup();
    writeFileSync(join(cwd, "a.md"), "x\n");
    manager.documents.track(work.id, cwd, join(cwd, "a.md"), "user", null, null);
    const session = manager.createSession(work.id, { provider: "codex", purpose: "a" });
    await manager.send(session.id, "r1", "요청");
    await new Promise((done) => setTimeout(done, 5));
    writeFileSync(join(cwd, "a.md"), "x\ny\n");
    manager.documents.track(work.id, cwd, join(cwd, "a.md"), "engine", session.id, null);
    expect(projects.changes(session.id)).toEqual([]);
  });

  it("gives a new session the note, its stage, tags, recent decisions and open questions in the card", () => {
    const { projects, work, pkm, cwd } = setup();
    projects.setStage(work.id, "진행중");
    projects.setProperty(work.id, "tags", ["강의"]);
    projects.addEntry(work.id, { section: "decision", text: "표지는 B안" });
    projects.addEntry(work.id, { section: "question", text: "마감 연장?" });
    const card = pkm.cardFor(work);
    expect(card).toContain(`프로젝트 노트: ${join(cwd, "안녕.md")}`);
    expect(card).toContain("단계: 진행중 · 태그: #강의");
    // Said to engines without the date and the source link the note keeps.
    expect(card).toContain("최근 결정(사람이 고른 것, 오래된 것부터):\n- 표지는 B안");
    expect(card).toContain("열린 질문:\n- 마감 연장?");
  });

  it("says a decision to an engine without its date and source link", () => {
    expect(entryGist("2026-10-29 표지는 B안 — Codex · 슬라이드 ([원문](workbench://session/s1#i1))")).toBe("표지는 B안");
    expect(entryGist("직접 적은 결정")).toBe("직접 적은 결정");
  });

  it("counts lines added and removed roughly, as a multiset", () => {
    expect(lineCounts("a\nb\nc", "a\nc\nd\ne")).toEqual({ added: 2, removed: 1 });
  });
});
