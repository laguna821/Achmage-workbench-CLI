import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AccessMode, ApprovalDecision, ProviderStatus, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { Pkm } from "./pkm.ts";
import { Projects, agreedWords, entryGist, lineCounts } from "./project.ts";
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
    // Tags are written without '#', as Obsidian keeps them in YAML.
    expect(readFileSync(path, "utf8")).toContain("tags:\n  - 강의\n  - 2026-2학기\n");
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

describe("the record (기록)", () => {
  it("shows stage changes, worktree applies, answered hand-overs and ended links, each opening its place", async () => {
    const { projects, work, manager } = setup();
    const draft = manager.createSession(work.id, { provider: "codex", purpose: "초안" });
    const review = manager.createSession(work.id, { provider: "codex", purpose: "검토" });
    projects.setStage(work.id, "진행중");
    // The same stage again writes nothing and records nothing.
    projects.setStage(work.id, "진행중");
    manager.sink.upsertItem(draft.id, { kind: "notice", id: "worktree-applied:1", level: "info", text: "적용했습니다.", at: Date.now() });
    await manager.handoff({ requestId: "h1", sourceSessionId: draft.id, targetSessionId: review.id, text: "표지를 검토해 줘" });
    await new Promise((done) => setTimeout(done, 20));
    const link = await manager.links.start({ requestId: "l1", participants: [draft.id, review.id], goal: "표지 합의", maxRounds: 2, maxMinutes: 10 });
    await manager.links.stop(link.id);
    const events = projects.page(work.id).events;
    const of = (kind: string) => events.filter((event) => event.kind === kind).map((event) => ({ text: event.text, sessionId: event.sessionId }));
    expect(of("stage")).toEqual([{ text: "단계 값 없음 → 진행중", sessionId: null }]);
    expect(of("worktree")).toEqual([{ text: "격리 사본의 변경을 원래 폴더에 적용 · 초안", sessionId: draft.id }]);
    expect(of("handoff")).toEqual([{ text: "초안 → 검토: 표지를 검토해 줘 · 답 받음", sessionId: draft.id }]);
    // How many hand-overs happened before the stop depends on timing; who, why and where do not.
    expect(of("link")).toEqual([{ text: expect.stringMatching(/^세션 잇기 끝 · 초안 ⇄ 검토 · 끊음 · \d+번 주고받음$/), sessionId: draft.id }]);
    // A stage change taken back with "되돌리기" leaves no record line.
    const undone = projects.setStage(work.id, "보류");
    projects.undo(work.id, undone.token);
    expect(projects.page(work.id).events.filter((event) => event.kind === "stage").map((event) => event.text)).toEqual(["단계 값 없음 → 진행중"]);
    // Archiving from the archive (not the stage menu) is a stage change too.
    manager.updateWork(work.id, { archived: true });
    projects.workArchived(manager.view.works.get(work.id)!, true);
    expect(projects.page(work.id).events.filter((event) => event.kind === "stage").map((event) => event.text)[0]).toBe("단계 진행중 → 아카이브 (보관함에서)");
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

  it("says what a linked exchange agreed on: the line with the mark, else the one before it", () => {
    expect(agreedWords("검토했습니다.\n\n- **루브릭은 3단계로** 합니다. [[합의]]")).toBe("루브릭은 3단계로 합니다.");
    expect(agreedWords("평가는 루브릭 3단계로 정리합니다.\n\n[[합의]]")).toBe("평가는 루브릭 3단계로 정리합니다.");
    expect(agreedWords("합의하지 않았습니다.")).toBe("");
  });

  it("says a decision to an engine without its date and source link", () => {
    expect(entryGist("2026-10-29 표지는 B안 — Codex · 슬라이드 ([원문](workbench://session/s1#i1))")).toBe("표지는 B안");
    expect(entryGist("직접 적은 결정")).toBe("직접 적은 결정");
  });

  it("counts lines added and removed roughly, as a multiset", () => {
    expect(lineCounts("a\nb\nc", "a\nc\nd\ne")).toEqual({ added: 2, removed: 1 });
  });
});

describe("properties (Obsidian-like)", () => {
  it("show the template's fields on every page, empty until filled, written in their kind", () => {
    const { projects, work, cwd, manager } = setup();
    const page = projects.page(work.id);
    expect(page.rows!.map((row) => [row.key, row.type, row.present])).toEqual([
      ["단계", "stage", false],
      ["tags", "tags", false],
      ["종류", "list", false],
      ["시작일", "date", false],
      ["마감일", "date", false],
      ["중요도", "text", false],
      ["목표", "text", false],
      ["관련", "links", false],
    ]);
    expect(existsSync(join(cwd, "안녕.md"))).toBe(false);
    projects.setProperty(work.id, "종류", ["강의"], "list");
    projects.setProperty(work.id, "시작일", ["10-29-2026"], "date");
    projects.setProperty(work.id, "회차", ["3"], "number");
    const text = readFileSync(join(cwd, "안녕.md"), "utf8");
    expect(text).toContain("종류:\n  - 강의\n");
    expect(text).toContain("시작일: 2026-10-29\n");
    expect(text).toContain("회차: 3\n");
    const rows = projects.page(work.id).rows!;
    expect(rows.find((row) => row.key === "회차")).toMatchObject({ type: "number", values: ["3"], fromTemplate: false });
    expect(rows.find((row) => row.key === "시작일")).toMatchObject({ present: true, values: ["2026-10-29"] });
    expect(() => projects.setProperty(work.id, "마감일", ["언젠가"], "date")).toThrow(/날짜로 읽지 못했습니다/);
    // Lists (the sidebar's and home's groups) get every property with its kind, the note's time and first words.
    writeFileSync(join(cwd, "안녕.md"), `${text}\n## 목표\n\n- **루브릭**을 [[가을 특강]]에 붙인다\n`);
    const summary = projects.summaries().find((entry) => entry.workId === work.id)!;
    expect(summary.properties).toEqual([
      { key: "종류", type: "list", values: ["강의"] },
      { key: "시작일", type: "date", values: ["2026-10-29"] },
      { key: "회차", type: "number", values: ["3"] },
    ]);
    expect(summary.preview).toBe("루브릭을 가을 특강에 붙인다");
    expect(summary.noteUpdatedAt).toBeGreaterThan(Date.now() - 60_000);
    const bare = manager.createWork({ title: "빈 프로젝트", cwd: join(cwd, "..", "빈") });
    expect(projects.summaries().find((entry) => entry.workId === bare.id)).toMatchObject({ properties: [], noteUpdatedAt: null, preview: null });
  });

  it("keep the kind the person picks for a name, and the template the person saves (or the default again)", () => {
    const { projects, work, cwd } = setup();
    projects.setProperty(work.id, "공개", ["예"]);
    expect(projects.page(work.id).rows!.find((row) => row.key === "공개")!.type).toBe("text");
    projects.setPropertyType("공개", "checkbox");
    projects.setProperty(work.id, "공개", ["예"]);
    expect(readFileSync(join(cwd, "안녕.md"), "utf8")).toContain("공개: true\n");
    expect(projects.page(work.id).rows!.find((row) => row.key === "공개")!.type).toBe("checkbox");
    expect(() => projects.setPropertyType("단계", "text")).toThrow(/형식은 바꿀 수 없습니다/);

    projects.setTemplate([{ key: "단계", type: "stage" }, { key: "학기", type: "text", hint: "예: 2026-2" }]);
    expect(projects.page(work.id).rows!.map((row) => row.key)).toEqual(["단계", "학기", "공개"]);
    const imported = projects.importTemplate(["---", "tags: []", "마감: 2026-12-01", "---"].join("\n"));
    expect(imported).toEqual([{ key: "tags", type: "tags" }, { key: "마감", type: "date" }]);
    expect(projects.setTemplate(null).map((field) => field.key)).toEqual(["단계", "tags", "종류", "시작일", "마감일", "중요도", "목표", "관련"]);
  });
});

describe("rules fill a project (P3)", () => {
  it("fill the stage only while a project has none, say so in the record, and keep the note's tags with the work's", () => {
    const { pkm, manager, projects, work, dir } = setup();
    mkdirSync(join(dir, "논문"), { recursive: true });
    const other = manager.createWork({ title: "논문", cwd: join(dir, "논문") });
    projects.setStage(other.id, "보류");
    pkm.saveRules([{ id: "r", name: "모두", enabled: true, when: { cwdPrefix: null, engine: null, format: null }, then: { folder: null, tag: "수업", pin: false, stage: "진행중" } }]);
    const preview = pkm.previewRules();
    expect(preview.find((change) => change.workId === work.id)).toMatchObject({ stage: "진행중", tag: "수업" });
    expect(preview.find((change) => change.workId === other.id)).toMatchObject({ stage: null, tag: "수업" });
    expect(pkm.applyRules([work.id, other.id])).toEqual({ applied: 2 });
    expect(projects.page(work.id).note).toMatchObject({ exists: true, stage: "진행중", tags: ["수업"] });
    expect(projects.page(other.id).note).toMatchObject({ stage: "보류", tags: ["수업"] });
    expect(projects.page(work.id).events.find((event) => event.kind === "stage")?.text).toBe("단계 값 없음 → 진행중 (규칙 「모두」)");
  });
});

describe("멈춘 곳 (what breaks left for the person)", () => {
  it("lists a session whose last turn broke off or that keeps unsent requests, not a stop the person made", () => {
    const { manager, projects, work } = setup();
    const draft = manager.createSession(work.id, { provider: "codex", purpose: "초안" });
    const review = manager.createSession(work.id, { provider: "codex", purpose: "검토" });
    const end = (sessionId: string, id: string, status: "completed" | "interrupted" | "failed", cause: "stop" | "crash" | "restart" | null, at: number) =>
      manager.sink.upsertItem(sessionId, { kind: "turnEnd", id, status, durationMs: 1, at, cause });
    end(draft.id, "e1", "interrupted", "crash", 1000);
    end(review.id, "e2", "interrupted", "stop", 2000);
    expect(projects.page(work.id).facts.stopped).toEqual([{ kind: "session", text: "Codex · 초안 — 엔진이 멈춰 끊김", sessionId: draft.id, at: 1000 }]);
    // Kept requests make even the person's own stop a place to come back to.
    manager.sink.updateSession(review.id, { queued: [{ id: "q1", text: "다음 요청", refs: [], create: null, at: 2500, held: true }] });
    expect(projects.page(work.id).facts.stopped.map((place) => place.text)).toEqual(["Codex · 검토 — 보내지 않은 요청 1개", "Codex · 초안 — 엔진이 멈춰 끊김"]);
    // A turn that went on and completed: no longer stopped there.
    end(draft.id, "e3", "completed", null, 3000);
    end(review.id, "e4", "failed", null, 4000);
    expect(projects.page(work.id).facts.stopped.map((place) => place.text)).toEqual(["Codex · 검토 — 응답이 끝나지 못했습니다 · 보내지 않은 요청 1개"]);
  });
});

describe("a project in search (찾는 길)", () => {
  const found = (manager: SessionManager, query: string, scope: "decision" | "project") =>
    manager.search(query, { scope }).groups.flatMap((group) => group.hits.map((hit) => ({ kind: hit.kind, title: hit.title, workId: hit.workId, sessionId: hit.sessionId, itemId: hit.itemId })));

  it("finds decisions and open questions in the 결정 scope, by their words, opening where they came from", () => {
    const { manager, projects, work } = setup();
    const session = manager.createSession(work.id, { provider: "codex", purpose: "초안" });
    projects.addEntry(work.id, { section: "decision", text: "표지는 파란 B안으로", sessionId: session.id, itemId: "i1" });
    projects.addEntry(work.id, { section: "question", text: "마감을 연장할까?" });
    expect(found(manager, "표지", "decision")).toEqual([{ kind: "decision", title: "표지는 파란 B안으로", workId: work.id, sessionId: session.id, itemId: "i1" }]);
    expect(found(manager, "마감", "decision")).toEqual([{ kind: "question", title: "마감을 연장할까?", workId: work.id, sessionId: null, itemId: null }]);
    // Ticked or removed: the entry follows the note.
    const line = projects.page(work.id).note.questions[0]!.line;
    projects.setQuestionDone(work.id, line, true);
    expect(found(manager, "마감", "decision")).toHaveLength(1);
    projects.setBodyText(work.id, "", projects.page(work.id).note.revision);
    expect(found(manager, "표지", "decision")).toEqual([]);
  });

  it("finds a work by its note's aliases, properties and words, also after the note is edited outside", () => {
    const { manager, projects, work, cwd } = setup();
    projects.setProperty(work.id, "aliases", ["가을 특강"]);
    expect(found(manager, "가을 특강", "project")).toEqual([{ kind: "work", title: "안녕", workId: work.id, sessionId: null, itemId: null }]);
    // Edited in another editor: noticed when the lists read the note.
    const path = join(cwd, "안녕.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n형성평가 루브릭을 붙인다.\n\n## 결정\n\n- 2026-10-01 발표는 15분\n`);
    projects.summaries();
    expect(found(manager, "루브릭", "project").map((hit) => hit.workId)).toEqual([work.id]);
    expect(found(manager, "발표는", "decision")).toMatchObject([{ kind: "decision", title: "발표는 15분" }]);
    // The note's sections are found as decisions, not again as the work's words.
    expect(found(manager, "발표는", "project")).toEqual([]);
  });

  it("starts from the notes it knows, after a restart", () => {
    const { dir, manager, projects, work } = setup();
    projects.addEntry(work.id, { section: "decision", text: "평가는 루브릭으로" });
    const store = new Store(join(dir, "state.sqlite"));
    store.search.removePrefix("decision:");
    const bus = new EventBus();
    const again = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: join(dir, "data") });
    new Projects(store, bus, again, new Pkm(store, bus, again, { vaultDebounceMs: 30, dataDir: dir }));
    expect(found(again, "루브릭", "decision").map((hit) => hit.title)).toEqual(["평가는 루브릭으로"]);
    expect(found(manager, "루브릭", "decision")).toHaveLength(1);
  });
});
