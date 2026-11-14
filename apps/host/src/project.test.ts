import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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
import { makeFixtureVault, put } from "./vault-fixture.ts";

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

const searchManagers: SessionManager[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const manager of searchManagers.splice(0)) await manager.finder.close();
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
  searchManagers.push(manager);
  const engine = new TextEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const pkm = new Pkm(store, bus, manager, { vaultDebounceMs: 30, dataDir: dir });
  const projects = new Projects(store, bus, manager, pkm);
  const work = manager.createWork({ title: "안녕", cwd });
  return { dir, cwd, manager, engine, projects, work, pkm };
}

describe("the project note file", () => {
  it("shares edit ownership between the project body and the same file opened as a document", () => {
    const { projects, work, manager } = setup();
    const original = projects.setBodyText(work.id, "Original\n", null).page.note;
    const owner = manager.documents.registry.open(original.artifactId!, { viewId: "document", windowId: "other-window", claim: true });
    expect(() => projects.setBodyText(work.id, "Project stale editor", original.revision)).toThrow(/다른 탭/);
    expect(() => projects.setProperty(work.id, "stage", ["changed"])).toThrow(/다른 탭/);
    const access = { viewId: owner.view.viewId, writeToken: owner.writeToken };
    expect(projects.setBodyText(work.id, "Owned edit\n", original.revision, access).page.note.body).toBe("Owned edit\n");
  });

  it("rejects external changes and deletion even before a watcher has recorded a newer revision", () => {
    const { projects, work } = setup();
    const original = projects.setBodyText(work.id, "Original body\n", null).page.note;
    const external = readFileSync(original.path, "utf8") + "\nExternal edit\n";
    writeFileSync(original.path, external);
    expect(() => projects.setBodyText(work.id, "Stale draft\n", original.revision)).toThrow(/바뀌거나 삭제/);
    expect(readFileSync(original.path, "utf8")).toBe(external);
    const refreshed = projects.page(work.id).note;
    expect(refreshed.revision).toBe(original.revision! + 1);
    expect(refreshed.lastAuthor).toBe("external");
    expect(refreshed.body).toContain("External edit");
    expect(() => projects.setBodyText(work.id, "Still stale\n", original.revision)).toThrow(/바뀌거나 삭제/);
    const saved = projects.setBodyText(work.id, "Reconciled\n", refreshed.revision).page.note;
    expect(saved.body).toBe("Reconciled\n");
    unlinkSync(saved.path);
    expect(() => projects.setBodyText(work.id, "Must not recreate\n", saved.revision)).toThrow(/바뀌거나 삭제/);
    expect(existsSync(saved.path)).toBe(false);
  });

  it("does not replace a file created externally while an empty project note is being edited", () => {
    const { projects, work, cwd } = setup(true);
    const empty = projects.page(work.id).note;
    mkdirSync(join(cwd, ".workbench"), { recursive: true });
    writeFileSync(empty.path, "External new note\n");
    expect(() => projects.setBodyText(work.id, "My new note\n", empty.revision)).toThrow(/바뀌거나 삭제/);
    expect(readFileSync(empty.path, "utf8")).toBe("External new note\n");
    const reloaded = projects.page(work.id).note;
    expect(reloaded.revision).toBe(1);
    expect(projects.setBodyText(work.id, "Reviewed new note\n", reloaded.revision).page.note.body).toBe("Reviewed new note\n");
  });

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

describe("project thumbnails", () => {
  it("exports a new .base file without ever replacing an existing human file", () => {
    const { projects, cwd } = setup();
    const path = join(cwd, "내 보기.base");
    projects.exportBase(path, "views: []\n");
    expect(() => projects.exportBase(path, "replacement")).toThrow(/새 이름/);
    expect(readFileSync(path, "utf8")).toBe("views: []\n");
    expect(() => projects.exportBase(join(cwd, "노트.md"), "bad")).toThrow(/base/);
  });
  it("prefers a cover property, supports encoded local images, and versions changed image bytes without editing the note", () => {
    const { projects, work, cwd } = setup();
    writeFileSync(join(cwd, "표 지.png"), "image fixture");
    projects.setBodyText(work.id, "![표지](%ED%91%9C%20%EC%A7%80.png)", null);
    const before = projects.summaries()[0]!;
    expect(before.thumb).toEqual({ project: work.id, src: "%ED%91%9C%20%EC%A7%80.png" });
    expect(projects.image(work.id, "%ED%91%9C%20%EC%A7%80.png")).toBe(join(cwd, "표 지.png"));
    const stamp = new Date(Date.now() + 2000);
    utimesSync(join(cwd, "표 지.png"), stamp, stamp);
    expect(projects.summaries()[0]!.thumbUpdatedAt).toBeGreaterThan(before.thumbUpdatedAt!);
    projects.setProperty(work.id, "cover", ["https://example.test/signed-image?token=x"]);
    expect(projects.summaries()[0]!.thumb).toEqual({ url: "https://example.test/signed-image?token=x" });
    projects.setProperty(work.id, "thumbnail", ["javascript:alert(1)"]);
    expect(projects.summaries()[0]!.thumb).toBeNull();
  });

  it("rejects traversal, absolute paths, bad encoding and symlinks outside a work", () => {
    const { projects, work, cwd, dir } = setup();
    projects.initializeNote(work.id);
    writeFileSync(join(dir, "secret.png"), "private");
    symlinkSync(join(dir, "secret.png"), join(cwd, "escape.png"));
    for (const src of ["../secret.png", "%2e%2e/secret.png", join(dir, "secret.png"), "escape.png", "%ZZ.png", "file:///tmp/secret.png"]) {
      expect(() => projects.image(work.id, src)).toThrow(/그림/);
    }
  });

  it("resolves vault embeds while excluding hidden folders and filenames from both thumbnails and direct reads", () => {
    const { projects, work, pkm, dir, manager } = setup();
    const vault = join(dir, "vault");
    makeFixtureVault(vault);
    put(vault, "00. Inbox/cover.png", "visible image");
    put(vault, "Secret/hidden.png", "hidden image");
    put(vault, "00. Inbox/omit.png", "hidden name");
    put(vault, ".obsidian/plugins/notebook-navigator/data.json", JSON.stringify({ vaultProfiles: [{ id: "default", hiddenFolders: ["Secret"], hiddenFileNames: ["omit.png"] }], vaultProfile: "default" }));
    pkm.vault.attach(vault);
    try {
      projects.setProperty(work.id, "cover", ["[[cover.png]]"]);
      expect(projects.summaries()[0]!.thumb).toEqual({ vault: "00. Inbox/cover.png" });
      for (const name of ["hidden.png", "omit.png"]) {
        projects.setProperty(work.id, "cover", [`[[${name}]]`]);
        expect(projects.summaries()[0]!.thumb).toBeNull();
      }
      expect(() => pkm.vaultImage("Secret/hidden.png")).toThrow();
      expect(() => pkm.vaultImage("00. Inbox/omit.png")).toThrow();
      expect(() => pkm.workImage(work.id, projects.notePath(work), "../vault/Secret/hidden.png")).toThrow();
      const inside = manager.createWork({ title: "보관함 프로젝트", cwd: vault });
      projects.initializeNote(inside.id);
      expect(projects.image(inside.id, "00.%20Inbox/cover.png")).toBe(join(vault, "00. Inbox/cover.png"));
      expect(() => projects.image(inside.id, "Secret/hidden.png")).toThrow();
      expect(() => projects.image(inside.id, "00.%20Inbox/omit.png")).toThrow();
    } finally { pkm.close(); }
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
  it("inherits folder note templates, preserves their original bytes and never overwrites an existing note", () => {
    const { projects, manager, work, cwd } = setup();
    const parent = manager.createFolder("강의", null);
    const child = manager.createFolder("2026", parent.id);
    manager.updateWork(work.id, { folderId: child.id });
    const markdown = '---\r\n"DIKM_단계:": "🔵 I"\r\ntags: [Workflow_Engineering]\r\n마감일:\r\n종류:\r\n  - 강의\r\n---\r\n# 목표\r\n\r\n원문  공백\r\n';
    projects.setFolderTemplate(parent.id, markdown);
    expect(projects.folderTemplate(child.id)).toMatchObject({ own: null, effective: { folderId: parent.id, markdown } });
    expect(projects.page(work.id).rows!.find((field) => field.key === "DIKM_단계:")).toMatchObject({ fromTemplate: true, present: false });
    expect(existsSync(join(cwd, "안녕.md"))).toBe(false);
    const result = projects.initializeNote(work.id);
    const written = readFileSync(result.page.note.path, "utf8");
    expect(written.replace(`workbench_id: ${work.id}\r\n`, "")).toBe(markdown);
    expect(result.page.note.tags).toEqual(["Workflow_Engineering"]);
    projects.setFolderTemplate(parent.id, "# 새 템플릿\n");
    expect(() => projects.initializeNote(work.id)).toThrow(/덮어쓰지/);
    expect(readFileSync(result.page.note.path, "utf8")).toBe(written);
  });

  it("lets a child override or opt out, resets to its ancestor, and applies only when a note is first written", () => {
    const { projects, manager, work } = setup();
    const parent = manager.createFolder("상위", null), child = manager.createFolder("하위", parent.id);
    manager.updateWork(work.id, { folderId: child.id });
    projects.setFolderTemplate(parent.id, "---\n종류: 연구\n---\n# 연구 계획\n");
    projects.setFolderTemplate(child.id, "");
    expect(projects.folderTemplate(child.id).effective?.markdown).toBe("");
    projects.setFolderTemplate(child.id, "# 하위 계획\n");
    expect(projects.folderTemplate(child.id).effective?.folderId).toBe(child.id);
    projects.setFolderTemplate(child.id, null);
    expect(projects.folderTemplate(child.id).effective?.folderId).toBe(parent.id);
    const write = projects.setProperty(work.id, "목표", ["발표"]);
    expect(write.page.note.body).toBe("# 연구 계획\n");
    expect(write.page.note.properties).toContainEqual(["종류", ["연구"]]);
    projects.setFolderTemplate(child.id, "# 다른 내용\n");
    projects.setProperty(work.id, "목표", ["논문"]);
    expect(projects.page(work.id).note.body).toBe("# 연구 계획\n");
  });

  it("rejects unknown folders and incomplete front matter without changing the saved template", () => {
    const { projects, manager } = setup();
    const folder = manager.createFolder("분류", null);
    projects.setFolderTemplate(folder.id, "# 안전한 본문\n");
    expect(() => projects.setFolderTemplate(folder.id, "---\n종류: 강의")).toThrow(/닫히지/);
    expect(() => projects.setFolderTemplate("missing", "")).toThrow(/폴더가 없습니다/);
    expect(projects.folderTemplate(folder.id).own).toBe("# 안전한 본문\n");
  });

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
  const found = async (manager: SessionManager, query: string, scope: "decision" | "project") =>
    (await manager.search(query, { scope })).groups.flatMap((group) => group.hits.map((hit) => ({ kind: hit.kind, title: hit.title, workId: hit.workId, sessionId: hit.sessionId, itemId: hit.itemId })));

  it("finds decisions and open questions in the 결정 scope, by their words, opening where they came from", async () => {
    const { manager, projects, work } = setup();
    const session = manager.createSession(work.id, { provider: "codex", purpose: "초안" });
    projects.addEntry(work.id, { section: "decision", text: "표지는 파란 B안으로", sessionId: session.id, itemId: "i1" });
    projects.addEntry(work.id, { section: "question", text: "마감을 연장할까?" });
    expect((await found(manager, "표지", "decision"))).toEqual([{ kind: "decision", title: "표지는 파란 B안으로", workId: work.id, sessionId: session.id, itemId: "i1" }]);
    expect((await found(manager, "마감", "decision"))).toEqual([{ kind: "question", title: "마감을 연장할까?", workId: work.id, sessionId: null, itemId: null }]);
    // Ticked or removed: the entry follows the note.
    const line = projects.page(work.id).note.questions[0]!.line;
    projects.setQuestionDone(work.id, line, true);
    expect((await found(manager, "마감", "decision"))).toHaveLength(1);
    projects.setBodyText(work.id, "", projects.page(work.id).note.revision);
    expect((await found(manager, "표지", "decision"))).toEqual([]);
  });

  it("finds a work by its note's aliases, properties and words, also after the note is edited outside", async () => {
    const { manager, projects, work, cwd } = setup();
    projects.setProperty(work.id, "aliases", ["가을 특강"]);
    expect((await found(manager, "가을 특강", "project"))).toEqual([{ kind: "work", title: "안녕", workId: work.id, sessionId: null, itemId: null }]);
    // Edited in another editor: noticed when the lists read the note.
    const path = join(cwd, "안녕.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n형성평가 루브릭을 붙인다.\n\n## 결정\n\n- 2026-10-01 발표는 15분\n`);
    projects.summaries();
    expect((await found(manager, "루브릭", "project")).map((hit) => hit.workId)).toEqual([work.id]);
    expect((await found(manager, "발표는", "decision"))).toMatchObject([{ kind: "decision", title: "발표는 15분" }]);
    // The note's sections are found as decisions, not again as the work's words.
    expect((await found(manager, "발표는", "project"))).toEqual([]);
  });

  it("starts from the notes it knows, after a restart", async () => {
    const { dir, manager, projects, work } = setup();
    projects.addEntry(work.id, { section: "decision", text: "평가는 루브릭으로" });
    const store = new Store(join(dir, "state.sqlite"));
    store.search.removePrefix("decision:");
    const bus = new EventBus();
    const again = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: join(dir, "data") });
  searchManagers.push(again);
    new Projects(store, bus, again, new Pkm(store, bus, again, { vaultDebounceMs: 30, dataDir: dir }));
    expect((await found(again, "루브릭", "decision")).map((hit) => hit.title)).toEqual(["평가는 루브릭으로"]);
    expect((await found(manager, "루브릭", "decision"))).toHaveLength(1);
  });
});

// Review round 1: the user's note file is never damaged by the page.
describe("writes that keep the note whole", () => {
  const seeded = (text: string) => {
    const context = setup();
    const page = context.projects.setBodyText(context.work.id, "본문\n", null).page;
    writeFileSync(page.note.path, text);
    return { ...context, path: page.note.path, page: context.projects.page(context.work.id) };
  };

  it("refuses to edit a block scalar or a map, leaves the file as it was, and marks them not editable", () => {
    const text = "---\nworkbench_id: x\nsummary: |\n  첫 줄\n\n  셋째 줄\nmeta:\n  owner: 나\n종류: 강의\n---\n본문\n";
    const { projects, work, path, page } = seeded(text);
    expect(page.rows!.find((row) => row.key === "summary")!.editable).toBe(false);
    expect(page.rows!.find((row) => row.key === "meta")!.editable).toBe(false);
    expect(page.rows!.find((row) => row.key === "종류")!.editable).toBe(true);
    expect(() => projects.setProperty(work.id, "summary", ["새 값"])).toThrow(/원문에서/);
    expect(() => projects.setProperty(work.id, "meta", ["owner: 너"])).toThrow(/원문에서/);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("says in the notice the value it wrote, not what was typed", () => {
    const { projects, work } = seeded("---\nworkbench_id: x\n마감일: 2026-11-20\n---\n본문\n");
    const write = projects.setProperty(work.id, "마감일", ["2026-11-27"], "date");
    expect(write.summary).toBe("마감일: 2026-11-20 → 2026-11-27");
  });

  it("writes one run of the body and leaves the front matter, the sections and the other run byte for byte", () => {
    const text = "---\r\nworkbench_id: x\r\n---\r\n머리말\r\n\r\n## 결정\r\n- 2026-11-12 정함\r\n\r\n## 메모\r\n메모\r\n";
    const { projects, work, path, page } = seeded(text);
    const [, memo] = page.note.runs!;
    const written = projects.setRun(work.id, { index: 1, expected: memo!.text, text: "## 메모\r\n고친 메모\r\n" }, page.note.revision);
    expect(memo!.end).toBe(text.length);
    expect(readFileSync(path, "utf8")).toBe(text.slice(0, memo!.start) + "## 메모\r\n고친 메모\r\n");
    expect(written.page.note.revision).toBe(page.note.revision! + 1);
    // Words that are no longer that run's are refused, and the file stays.
    const now = readFileSync(path, "utf8");
    expect(() => projects.setRun(work.id, { index: 1, expected: memo!.text, text: "x" }, written.page.note.revision)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(now);
  });

  it("shows the last readable revision's properties when the front matter breaks, and reverts to it whoever broke it", () => {
    const good = "---\nworkbench_id: x\n단계: 진행중\n종류: 강의\n---\n본문\n";
    const { projects, work, path } = seeded(good);
    const readable = projects.page(work.id);
    expect(readable.note.problem).toBeNull();
    const broken = "---\nworkbench_id: x\n단계: 진행중\n종류: [강의\n---\n본문\n";
    writeFileSync(path, broken);
    const page = projects.page(work.id);
    expect(page.note.problem).toMatch(/YAML/);
    expect(page.lastReadable).toMatchObject({ revision: readable.note.revision, author: "external", text: good, current: broken });
    expect(page.lastReadable!.rows.find((row) => row.key === "종류")!.values).toEqual(["강의"]);
    // Writes are refused on the broken note; the revert puts the readable bytes back as a new revision.
    expect(() => projects.setProperty(work.id, "종류", ["세미나"])).toThrow();
    const reverted = projects.revertTo(work.id, page.lastReadable!.revision);
    expect(readFileSync(path, "utf8")).toBe(good);
    expect(reverted.page.note.problem).toBeNull();
    expect(reverted.token).not.toBe("");
  });

  it("writes the whole source only when its front matter reads", () => {
    const { projects, work, path, page } = seeded("---\nworkbench_id: x\n---\n본문\n");
    expect(() => projects.setSource(work.id, "---\nworkbench_id: x\na: [\n---\n본문\n", page.note.revision)).toThrow(/YAML/);
    expect(readFileSync(path, "utf8")).toBe("---\nworkbench_id: x\n---\n본문\n");
    projects.setSource(work.id, "---\nworkbench_id: x\na: 1\n---\n새 본문\n", page.note.revision);
    expect(readFileSync(path, "utf8")).toBe("---\nworkbench_id: x\na: 1\n---\n새 본문\n");
  });
});

// Review round 3: one writer, one base. A write whose base is not the current revision is refused,
// always, after the bytes on disk are recorded; nothing is re-applied.
describe("writes against what the person saw", () => {
  const seeded = (text: string) => {
    const context = setup();
    const page = context.projects.setBodyText(context.work.id, "본문\n", null).page;
    writeFileSync(page.note.path, text);
    return { ...context, path: page.note.path, seen: context.projects.page(context.work.id).note.revision! };
  };
  const texts = (manager: SessionManager, artifact: string) => manager.documents.revisions(artifact).map((revision) => readFileSync(manager.documents.revisionPath(artifact, revision.revision), "utf8"));

  it("refuses a same-key change made outside since, and keeps that outside change in the history first", () => {
    const { projects, work, path, seen, manager } = seeded("---\nworkbench_id: x\n마감일: 2026-11-20\n---\n본문\n");
    const outside = "---\nworkbench_id: x\n마감일: 2026-12-01\n---\n본문\n";
    writeFileSync(path, outside);
    expect(() => projects.setProperty(work.id, "마감일", ["2026-11-27"], "date", undefined, seen)).toThrow(/바뀌/);
    expect(readFileSync(path, "utf8")).toBe(outside);
    const artifact = projects.page(work.id).note.artifactId!;
    expect(texts(manager, artifact).at(-1)).toBe(outside);
    expect(manager.documents.revisions(artifact).at(-1)!.author).toBe("external");
  });

  it("refuses a write to another key too: nothing is re-applied", () => {
    const { projects, work, path, seen } = seeded("---\nworkbench_id: x\n종류: 강의\n마감일: 2026-11-20\n---\n본문\n");
    const outside = "---\nworkbench_id: x\n종류: 세미나\n마감일: 2026-11-20\n---\n본문\n";
    writeFileSync(path, outside);
    expect(() => projects.setProperty(work.id, "마감일", ["2026-11-27"], "date", undefined, seen)).toThrow(/바뀌/);
    expect(readFileSync(path, "utf8")).toBe(outside);
  });

  it("refuses stale first words in a sections-only note instead of splicing them into another paragraph", () => {
    const { projects, work, path } = seeded("---\nworkbench_id: x\n단계: 진행중\n---\n## 결정\n- a\n\n## 열린 질문\n- [ ] q\n");
    const page = projects.page(work.id);
    const outside = "---\nworkbench_id: x\n단계: 끝\n---\n엔진이 쓴 요약 문단입니다.\n\n## 결정\n- a\n\n## 열린 질문\n- [ ] q\n";
    writeFileSync(path, outside);
    expect(() => projects.setRun(work.id, { index: 0, expected: "", text: "첫 문장" }, page.note.revision)).toThrow(/바뀌/);
    expect(readFileSync(path, "utf8")).toBe(outside);
  });

  it("refuses a stale body run even when its words are unchanged", () => {
    const { projects, work, path } = seeded("---\nworkbench_id: x\n---\nA 문단\n\n## 결정\n- a\n");
    const page = projects.page(work.id);
    const outside = "---\nworkbench_id: x\n종류: 회의\n---\nA 문단\n\n## 결정\n- a\n";
    writeFileSync(path, outside);
    expect(() => projects.setRun(work.id, { index: 0, expected: "A 문단\n\n", text: "A2\n" }, page.note.revision)).toThrow(/바뀌/);
    expect(readFileSync(path, "utf8")).toBe(outside);
  });

  it("writes first words after a properties-only note with no final newline on their own line", () => {
    const { projects, work, path } = seeded("---\nworkbench_id: x\n---");
    const page = projects.page(work.id);
    projects.setRun(work.id, { index: 0, expected: "", text: "첫 문장" }, page.note.revision);
    expect(readFileSync(path, "utf8")).toBe("---\nworkbench_id: x\n---\n첫 문장");
    expect(projects.page(work.id).note.problem).toBeNull();
  });

  it("records an outside change before any write, even one that is then refused", () => {
    const { projects, work, path, manager, seen } = seeded("---\nworkbench_id: x\n---\n본문\n");
    const outside = "---\nworkbench_id: x\n---\n본문 (Obsidian)\n";
    writeFileSync(path, outside);
    expect(() => projects.addEntry(work.id, { section: "decision", text: "정함", baseRevision: seen })).toThrow(/바뀌/);
    expect(texts(manager, projects.page(work.id).note.artifactId!)).toContain(outside);
    expect(readFileSync(path, "utf8")).toBe(outside);
  });

  it("refuses a revert, the engine-edit 되돌리기 and an undo when the note changed after the person looked", () => {
    const good = "---\nworkbench_id: x\n단계: 진행중\n---\n본문\n";
    const { projects, work, path } = seeded(good);
    writeFileSync(path, "---\nworkbench_id: x\n단계: [진행중\n---\n본문2\n");
    const page = projects.page(work.id);
    const later = "---\nworkbench_id: x\n단계: [진행중\n---\n본문3\n";
    writeFileSync(path, later);
    expect(() => projects.revertTo(work.id, page.lastReadable!.revision, undefined, page.note.revision)).toThrow(/바뀌/);
    expect(() => projects.revertEngineEdit(work.id, undefined, page.note.revision)).toThrow(/바뀌|되돌릴/);
    expect(readFileSync(path, "utf8")).toBe(later);
  });

  it("refuses an undo whose base is not the revision its write made", () => {
    const { projects, work, path, seen } = seeded("---\nworkbench_id: x\n종류: 강의\n---\n본문\n");
    const write = projects.setProperty(work.id, "종류", ["세미나"], "text", undefined, seen);
    expect(() => projects.undo(work.id, write.token, undefined, seen)).toThrow(/바뀌/);
    projects.undo(work.id, write.token, undefined, write.page.note.revision);
    expect(readFileSync(path, "utf8")).toContain("종류: 강의");
  });

  it("ticks the open question the person saw at the current revision, and refuses a stale tick", () => {
    const { projects, work, path, seen } = seeded("---\nworkbench_id: x\n---\n## 열린 질문\n- [ ] 언제?\n");
    const question = projects.page(work.id).note.questions[0]!;
    const ticked = projects.setQuestionDone(work.id, question.line, true, undefined, seen, question.text);
    expect(readFileSync(path, "utf8")).toBe("---\nworkbench_id: x\n---\n## 열린 질문\n- [x] 언제?\n");
    writeFileSync(path, "---\nworkbench_id: x\n---\n머리말\n\n## 열린 질문\n- [x] 언제?\n");
    expect(() => projects.setQuestionDone(work.id, question.line, false, undefined, ticked.page.note.revision, question.text)).toThrow(/바뀌/);
  });

  it("adds two tags one after the other, each against the revision the last one returned", () => {
    const { projects, work, path, seen } = seeded('---\nworkbench_id: x\ntags: ["#회의", 강의]\n---\n본문\n');
    const first = projects.setProperty(work.id, "tags", null, "tags", undefined, seen, { add: "가" });
    projects.setProperty(work.id, "tags", null, "tags", undefined, first.page.note.revision, { add: "나" });
    expect(readFileSync(path, "utf8")).toBe('---\nworkbench_id: x\ntags: ["#회의", 강의, 가, 나]\n---\n본문\n');
  });

  it("keeps a tag written with # when another is added through the page's own row values", () => {
    const { projects, work, path, seen } = seeded('---\nworkbench_id: x\ntags: ["#회의", 강의]\n---\n본문\n');
    const row = projects.page(work.id).rows!.find((entry) => entry.key === "tags")!;
    projects.setProperty(work.id, "tags", [...row.values!, "새값"], "tags", undefined, seen);
    expect(readFileSync(path, "utf8")).toBe('---\nworkbench_id: x\ntags: ["#회의", 강의, 새값]\n---\n본문\n');
  });

  it("refuses through the service a key write the guard catches (a column-0 list), leaving the file", () => {
    const text = "---\nworkbench_id: x\na:\n- x\n- y\n---\n본문\n";
    const { projects, work, path } = seeded(text);
    expect(() => projects.setProperty(work.id, "a", ["x", "y", "z"], "list")).toThrow();
    expect(readFileSync(path, "utf8")).toBe(text);
  });
});

describe("a note the person saw as not there", () => {
  it("writes when the person saw no file and there still is none (after an undone first write)", () => {
    const { projects, work } = setup();
    const first = projects.setProperty(work.id, "종류", ["강의"], "list", undefined, null);
    projects.undo(work.id, first.token);
    const page = projects.page(work.id);
    expect(page.note.exists).toBe(false);
    const again = projects.setProperty(work.id, "종류", ["세미나"], "list", undefined, null);
    expect(readFileSync(again.page.note.path, "utf8")).toContain("세미나");
  });

  it("refuses when the person saw no file but one was made meanwhile", () => {
    const { projects, work } = setup();
    const path = projects.page(work.id).note.path;
    const made = `---\nworkbench_id: ${work.id}\n종류: 회의\n---\n`;
    writeFileSync(path, made);
    expect(() => projects.setProperty(work.id, "종류", ["세미나"], "list", undefined, null)).toThrow(/바뀌/);
    expect(readFileSync(path, "utf8")).toBe(made);
  });

});

// Review round 4: the note is synced by Dropbox and open in Obsidian while the app writes it.
describe("the note is replaced whole, never rewritten in place", () => {
  const seeded = (text: string) => {
    const context = setup();
    const page = context.projects.setBodyText(context.work.id, "본문\n", null).page;
    writeFileSync(page.note.path, text);
    return { ...context, path: page.note.path, seen: context.projects.page(context.work.id).note.revision! };
  };
  const TEXT = "---\nworkbench_id: x\n종류: 강의\n---\n본문\n";
  /** What a reader that opened the note before a write still reads from it afterwards. */
  const heldOpen = (path: string, write: () => void) => {
    const reader = openSync(path, "r");
    try {
      write();
      return readFileSync(reader, "utf8");
    } finally {
      closeSync(reader);
    }
  };

  it("leaves a reader that already opened the note with the whole old note, and keeps the file's mode", () => {
    const { projects, work, path, seen } = seeded(TEXT);
    chmodSync(path, 0o600);
    let write!: ReturnType<typeof projects.setProperty>;
    expect(heldOpen(path, () => { write = projects.setProperty(work.id, "종류", ["세미나"], "text", undefined, seen); })).toBe(TEXT);
    expect(readFileSync(path, "utf8")).toBe(TEXT.replace("강의", "세미나"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The undo replaces it the same way.
    expect(heldOpen(path, () => projects.undo(work.id, write.token, undefined, write.page.note.revision))).toBe(TEXT.replace("강의", "세미나"));
    expect(readFileSync(path, "utf8")).toBe(TEXT);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(path, "..")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("writes through a linked note: the link stays a link and its target holds the new note", () => {
    const { projects, work, path, dir } = seeded(TEXT);
    const real = join(dir, "vault", "실제 노트.md");
    mkdirSync(join(dir, "vault"));
    renameSync(path, real);
    symlinkSync(real, path);
    const seen = projects.page(work.id).note.revision!;
    expect(heldOpen(real, () => projects.setProperty(work.id, "종류", ["세미나"], "text", undefined, seen))).toBe(TEXT);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(lstatSync(real).isSymbolicLink()).toBe(false);
    expect(readFileSync(real, "utf8")).toBe(TEXT.replace("강의", "세미나"));
    // The temporary file was made beside the target, and is gone.
    expect(readdirSync(join(dir, "vault"))).toEqual(["실제 노트.md"]);
    expect(readdirSync(join(path, "..")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves the note's bytes and no temporary file when the write fails", () => {
    const { projects, work, path, seen } = seeded(TEXT);
    const folder = join(path, "..");
    const before = readdirSync(folder).sort();
    // A folder that takes no new file: the replacement cannot be made.
    chmodSync(folder, 0o555);
    try {
      // Said as a refusal in a plain sentence (which note, nothing changed), not a raw system error.
      expect(() => projects.setProperty(work.id, "종류", ["세미나"], "text", undefined, seen)).toThrow(/안녕\.md.*쓸 수 없습니다.*바꾸지 않았습니다/);
      expect(readFileSync(path, "utf8")).toBe(TEXT);
      expect(readdirSync(folder).sort()).toEqual(before);
    } finally {
      chmodSync(folder, 0o755);
    }
    // Nothing was recorded as written: the same base still writes once the folder allows it.
    projects.setProperty(work.id, "종류", ["세미나"], "text", undefined, seen);
    expect(readFileSync(path, "utf8")).toBe(TEXT.replace("강의", "세미나"));
  });

  // Review round 5.
  it("refuses a note whose file is read-only, as before this unit, and leaves it read-only", () => {
    const { projects, work, path, seen } = seeded(TEXT);
    chmodSync(path, 0o444);
    try {
      expect(() => projects.setProperty(work.id, "종류", ["세미나"], "text", undefined, seen)).toThrow(/쓸 수 없습니다.*바꾸지 않았습니다/);
      expect(readFileSync(path, "utf8")).toBe(TEXT);
      expect(statSync(path).mode & 0o777).toBe(0o444);
      expect(readdirSync(join(path, "..")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      chmodSync(path, 0o644);
    }
    // Nothing was recorded as written: the same base writes once the file allows it.
    projects.setProperty(work.id, "종류", ["세미나"], "text", undefined, seen);
    expect(readFileSync(path, "utf8")).toBe(TEXT.replace("강의", "세미나"));
  });

  it("refuses a note that is a link to nothing, and leaves the link", () => {
    const { projects, work, cwd } = setup();
    const path = projects.page(work.id).note.path;
    symlinkSync(join(cwd, "없는 곳", "실제 노트.md"), path);
    expect(() => projects.setProperty(work.id, "종류", ["세미나"], "text", undefined, null)).toThrow(/링크.*바꾸지 않았습니다/);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses through the service a body run that would give a note without front matter one", () => {
    const { projects, work, path } = seeded("본문\n");
    const page = projects.page(work.id);
    expect(() => projects.setRun(work.id, { index: 0, expected: "본문\n", text: "---\nk: v\n---\n본문\n" }, page.note.revision)).toThrow(/속성 부분이 바뀌어/);
    expect(readFileSync(path, "utf8")).toBe("본문\n");
  });
});

// Review round 4 (I4): what the sidebar's "태그 더하기" sends.
describe("tags added from the sidebar", () => {
  const seeded = (text: string) => {
    const context = setup();
    const page = context.projects.setBodyText(context.work.id, "본문\n", null).page;
    writeFileSync(page.note.path, text);
    return { ...context, path: page.note.path };
  };

  it("takes one add per tag, the first onto the note as it is and the next from the revision returned, leaving a # tag as written", () => {
    const { projects, work, path } = seeded('---\nworkbench_id: x\ntags: ["#회의"]\n---\n본문\n');
    const first = projects.setProperty(work.id, "tags", null, "tags", undefined, undefined, { add: "가" });
    projects.setProperty(work.id, "tags", null, "tags", undefined, first.page.note.revision, { add: "나" });
    expect(readFileSync(path, "utf8")).toBe('---\nworkbench_id: x\ntags: ["#회의", 가, 나]\n---\n본문\n');
    expect(projects.page(work.id).note.tags).toEqual(["회의", "가", "나"]);
  });

  it("refuses the whole list the sidebar used to send (the # stripped, or two tags at once), leaving the file", () => {
    const text = '---\nworkbench_id: x\ntags: ["#회의"]\n---\n본문\n';
    const { projects, work, path } = seeded(text);
    expect(() => projects.setProperty(work.id, "tags", ["회의", "가"], "tags")).toThrow(/한 번에 한 항목/);
    expect(() => projects.setProperty(work.id, "tags", ["#회의", "가", "나"], "tags")).toThrow(/한 번에 한 항목/);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("gives a note that keeps its tags under `tag:` a `tags:` list beside it, the old key as written", () => {
    const { projects, work, path } = seeded("---\nworkbench_id: x\ntag: 회의\n---\n본문\n");
    projects.setProperty(work.id, "tags", null, "tags", undefined, undefined, { add: "가" });
    expect(readFileSync(path, "utf8")).toBe("---\nworkbench_id: x\ntag: 회의\ntags:\n  - 가\n---\n본문\n");
    expect(projects.page(work.id).note.tags).toEqual(["가", "회의"]);
  });
});

