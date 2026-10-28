import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isUnseen, type ApprovalDecision, type ProviderStatus, type Session, type Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { HttpError, SessionManager, snippetOf } from "./sessions.ts";
import { Store } from "./store.ts";
import { headingOf, sessionMarkdown, tidyMessage } from "./export-md.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

// The meta-session layer: folders, archive, pins, order, read state, search and Markdown export.

class Engine implements ProviderAdapter {
  readonly provider = "claude" as const;
  private readonly sink: () => AdapterSink;
  reply = "답";
  constructor(sink: () => AdapterSink) {
    this.sink = sink;
  }
  async init() {}
  status(): ProviderStatus {
    return emptyStatus("claude");
  }
  async refreshStatus() {
    return this.status();
  }
  async login() {
    return { url: null, message: "" };
  }
  async send(session: Session, _work: Work, _text: string, turnKey: string) {
    const sink = this.sink();
    sink.updateSession(session.id, { status: "running" });
    sink.upsertItem(session.id, { kind: "assistant", id: `a:${turnKey}`, text: this.reply, streaming: false, at: Date.now() });
    sink.upsertItem(session.id, { kind: "turnEnd", id: `end:${turnKey}`, status: "completed", durationMs: 1, at: Date.now() });
    sink.updateSession(session.id, { status: "idle" });
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
  const dir = mkdtempSync(join(tmpdir(), "wb-meta-"));
  dirs.push(dir);
  const store = new Store(join(dir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works") });
  const engine = new Engine(() => manager.sink);
  manager.registerAdapter(engine);
  return { dir, store, bus, manager, engine };
}

let request = 0;
const send = (manager: SessionManager, sessionId: string, text: string) => manager.send(sessionId, `r${++request}`, text);

describe("folders and listing", () => {
  it("moves, reorders and archives folders, and never moves one inside itself", () => {
    const { manager } = setup();
    const lecture = manager.createFolder("강의", null);
    const term = manager.createFolder("2026-2", lecture.id);
    expect(manager.updateFolder(term.id, { name: "2학기" }).name).toBe("2학기");
    expect(() => manager.updateFolder(lecture.id, { parentId: term.id })).toThrowError(HttpError);
    expect(manager.updateFolder(term.id, { parentId: null, sort: 0.5 })).toMatchObject({ parentId: null, sort: 0.5 });
    expect(manager.updateFolder(lecture.id, { archived: true }).archivedAt).toBeTypeOf("number");
    expect(manager.updateFolder(lecture.id, { archived: false }).archivedAt).toBeNull();
  });

  it("pins, orders and notes the session looked at without making the work recent", async () => {
    const { manager } = setup();
    const work = manager.createWork({ title: "w" });
    const a = manager.createSession(work.id, { provider: "claude" });
    const b = manager.createSession(work.id, { provider: "claude" });
    const before = manager.snapshot().works.find((entry) => entry.id === work.id)!.updatedAt;
    await new Promise((done) => setTimeout(done, 5));
    const looked = manager.updateWork(work.id, { activeSessionId: a.id, pinned: true, sort: 3.5 });
    expect(looked).toMatchObject({ activeSessionId: a.id, pinned: true, sort: 3.5, updatedAt: before });
    expect(b.sort).toBeGreaterThanOrEqual(a.sort);
    expect(manager.updateSession(b.id, { pinned: true, sort: 1 })).toMatchObject({ pinned: true, sort: 1, updatedAt: b.updatedAt });
  });

  it("keeps read state in the gateway: a new reply is unseen until looked at, and can be marked unread", async () => {
    const { manager } = setup();
    const work = manager.createWork({ title: "w" });
    const session = manager.createSession(work.id, { provider: "claude" });
    await send(manager, session.id, "질문");
    const answered = manager.snapshot().sessions.find((entry) => entry.id === session.id)!;
    expect(isUnseen(answered)).toBe(true);
    const seen = manager.updateSession(session.id, { seen: true });
    expect(isUnseen(seen)).toBe(false);
    expect(isUnseen(manager.updateSession(session.id, { seen: false }))).toBe(true);
  });

  it("refuses to archive what is still working", () => {
    const { manager } = setup();
    const work = manager.createWork({ title: "w" });
    const session = manager.createSession(work.id, { provider: "claude" });
    manager.sink.updateSession(session.id, { status: "running" });
    expect(() => manager.updateSession(session.id, { archived: true })).toThrowError(/멈춘 뒤/);
    expect(() => manager.updateWork(work.id, { archived: true })).toThrowError(/진행 중/);
    manager.sink.updateSession(session.id, { status: "idle" });
    expect(manager.updateWork(work.id, { archived: true }).archivedAt).toBeTypeOf("number");
  });
});

describe("search", () => {
  it("finds Korean words of any length in requests and replies, newest first, and leaves archived ones out", async () => {
    const { manager, engine } = setup();
    const work = manager.createWork({ title: "강의" });
    const session = manager.createSession(work.id, { provider: "claude" });
    engine.reply = "학생이 고른 질문마다 근거 정리 표를 붙였습니다.";
    await send(manager, session.id, "자료 찾기 다음에 근거 정리 단계를 따로 두고 예시를 넣어 줘");
    const other = manager.createSession(manager.createWork({ title: "논문" }).id, { provider: "claude" });
    engine.reply = "Citation 범위를 확인했습니다.";
    await send(manager, other.id, "인용 근거를 확인해 줘");

    const three = manager.search("근거 정리");
    expect(three.sessions.map((entry) => entry.sessionId)).toEqual([session.id]);
    expect(three.sessions[0]!.total).toBe(2);
    const hit = three.sessions[0]!.hits[0]!;
    expect(hit.snippet.slice(hit.ranges[0]![0], hit.ranges[0]![1])).toBe("근거");

    expect(manager.search("근거").sessions).toHaveLength(2);
    expect(manager.search("citation").sessions.map((entry) => entry.sessionId)).toEqual([other.id]);

    manager.updateSession(other.id, { archived: true });
    expect(manager.search("근거").sessions.map((entry) => entry.sessionId)).toEqual([session.id]);
    expect(manager.search("근거", { archived: true }).sessions).toHaveLength(2);
  });

  it("indexes the conversations that were stored before search existed", async () => {
    const { manager, dir } = setup();
    const work = manager.createWork({ title: "w" });
    const session = manager.createSession(work.id, { provider: "claude" });
    await send(manager, session.id, "오래된 대화의 핵심 문장");
    const reopened = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works") });
    expect(reopened.search("핵심 문장").sessions).toHaveLength(1);
  });

  it("marks every match in a snippet", () => {
    const { snippet, ranges } = snippetOf("앞 문장입니다. 근거 정리는 근거를 정리하는 일입니다.", ["근거"]);
    expect(ranges.map(([from, to]) => snippet.slice(from, to))).toEqual(["근거", "근거"]);
  });
});

describe("Markdown export", () => {
  it("is the same file every time, with a heading per request and messages tidied", async () => {
    const { manager, engine } = setup();
    const folder = manager.createFolder("강의", null);
    const work = manager.createWork({ title: "7주차 강의 자료", titleSource: "user", folderId: folder.id });
    const session = manager.createSession(work.id, { provider: "claude", purpose: "문서 수정" });
    engine.reply = "# 도입부\n\n두 문단으로 썼습니다.\n\n\n\n```py\n# 주석은 그대로\n\n\n\nprint(1)\n```";
    await send(manager, session.id, "**도입부**를 다시 써 줘\n둘째 줄");
    await send(manager, session.id, "고마워");

    const first = manager.exportMarkdown(session.id, { target: "text" }).markdown;
    const second = manager.exportMarkdown(session.id, { target: "text" }).markdown;
    expect(second).toBe(first);
    expect(first).toMatch(/^---\ntitle: "문서 수정"\nwork: "7주차 강의 자료"\nfolder: "강의"\nengine: Claude\n/);
    expect(first).toContain("\n# 문서 수정\n");
    expect(first).toContain("\n## 1. 도입부를 다시 써 줘\n");
    expect(first).toContain("\n## 2. 고마워\n");
    expect(first).toContain("\n### 도입부\n");
    expect(first).toContain("```py\n# 주석은 그대로\n\n\n\nprint(1)\n```");
    expect(first).not.toMatch(/두 문단으로 썼습니다\.\n\n\n/);
  });

  it("saves into the work folder as a document, and a later export updates the same file", async () => {
    const { manager } = setup();
    const work = manager.createWork({ title: "w" });
    const session = manager.createSession(work.id, { provider: "claude", purpose: "정리" });
    await send(manager, session.id, "첫 요청");
    const saved = manager.exportMarkdown(session.id, { target: "work" });
    expect(saved.path).toContain(join(work.cwd, "세션 기록"));
    expect(existsSync(saved.path!)).toBe(true);
    expect(saved.artifactId).not.toBeNull();
    const again = manager.exportMarkdown(session.id, { target: "work" });
    expect(again.path).toBe(saved.path);
    expect(again.artifactId).toBe(saved.artifactId);
    await send(manager, session.id, "둘째 요청");
    const updated = manager.exportMarkdown(session.id, { target: "work" });
    expect(updated.path).toBe(saved.path);
    expect(readFileSync(updated.path!, "utf8")).toContain("## 2. 둘째 요청");
    expect(manager.documents.get(updated.artifactId!).revision).toBe(2);
  });

  it("keeps the outline: headings move down two levels, never inside code", () => {
    expect(tidyMessage("# 하나\n## 둘\n##### 다섯\n```\n# 코드\n```")).toBe("### 하나\n#### 둘\n###### 다섯\n```\n# 코드\n```");
    expect(headingOf("\n\n## **굵은** [링크](https://x)  \n본문")).toBe("굵은 링크");
  });

  it("leaves out reasoning and folds tool calls into one line", () => {
    const session = { id: "s", workId: "w", provider: "codex", purpose: "p", createdAt: 0, updatedAt: 0, engineModel: null, nativeSessionId: null } as unknown as Session;
    const work = { id: "w", title: "t" } as unknown as Work;
    const markdown = sessionMarkdown({
      session,
      work,
      folders: [],
      items: [
        { kind: "user", id: "u", text: "해 줘", at: 1 },
        { kind: "reasoning", id: "r", text: "속으로 생각", at: 2 },
        { kind: "tool", id: "t1", tool: "command", title: "npm test", detail: null, output: "ok", status: "completed", at: 3 },
        { kind: "tool", id: "t2", tool: "command", title: "ls", detail: null, output: "", status: "completed", at: 4 },
        { kind: "assistant", id: "a", text: "했습니다", streaming: false, at: 5 },
      ],
      artifactName: () => null,
      proposal: () => null,
      handoff: () => null,
      sessionLabel: () => null,
    });
    expect(markdown).not.toContain("속으로 생각");
    expect(markdown).toContain("_명령 2_");
    expect(markdown).toContain("**Codex**");
  });
});
