import { describe, expect, it } from "vitest";
import type { Artifact, Folder, Session, Work } from "@workbench/contracts";
import { initialState, type State } from "./state.ts";
import { EMPTY_OPEN, between, docAgentLabel, purposeText, docOpenTarget, holds, leadAgent, linkPair, moveFor, nowSessions, nudge, pinnedItems, toggleWork, treeRows, workPages, zoneAt, type Row } from "./tree.ts";
import type { BrowserPage } from "@workbench/contracts";

const folder = (id: string, parentId: string | null, sort: number, archivedAt: number | null = null): Folder => ({ id, parentId, name: id, sort, archivedAt });
const work = (id: string, folderId: string | null, sort: number, extra: Partial<Work> = {}): Work => ({
  id,
  title: id,
  titleSource: "user",
  folderId,
  cwd: `/w/${id}`,
  cwdManaged: true,
  activeSessionId: null,
  pinned: false,
  sort,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});
const session = (id: string, workId: string, sort: number, extra: Partial<Session> = {}): Session =>
  ({
    id,
    workId,
    provider: "claude",
    hostId: "h",
    nativeSessionId: null,
    purpose: id,
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
    sort,
    archivedAt: null,
    seenAt: null,
    unread: false,
    queued: [],
    access: null,
    context: null,
    createdAt: sort,
    updatedAt: sort,
    ...extra,
  }) as Session;

function stateOf(folders: Folder[], works: Work[], sessions: Session[], artifacts: Partial<Artifact>[] = []): State {
  const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((entry) => [entry.id, entry]));
  return { ...initialState, ready: true, folders: byId(folders), works: byId(works), sessions: byId(sessions), artifacts: byId(artifacts as Artifact[]) };
}

const ids = (rows: Row[]) => rows.map((row) => `${"  ".repeat(row.depth)}${row.type}:${row.id}`);

describe("tree rows", () => {
  const state = stateOf(
    [folder("강의", null, 0), folder("2026-2", "강의", 0), folder("보관됨", null, 1, 5)],
    [work("7주차", "2026-2", 2), work("8주차", "2026-2", 1), work("숨은", "보관됨", 0), work("메모", null, 0)],
    [session("s1", "7주차", 1), session("s2", "7주차", 2), session("s3", "7주차", 3, { archivedAt: 9 }), session("solo", "8주차", 1)],
    [{ id: "d1", workId: "7주차", name: "강의안.md", path: "/w/7주차/강의안.md", updatedAt: 3 }],
  );

  it("lists folders, works in their order and leaves archived things (and what is inside them) out", () => {
    expect(ids(treeRows(state, EMPTY_OPEN, "manual", null))).toEqual(["folder:강의", "  folder:2026-2", "    work:8주차", "    work:7주차", "section:section:loose", "work:메모"]);
  });

  it("separates project, chat and document rows and exposes even a single conversation", () => {
    const rows = treeRows(state, EMPTY_OPEN, "manual", "7주차");
    expect(ids(rows)).toContain("        session:s2");
    expect(ids(rows)).toContain("      docs:docs:7주차");
    expect(ids(rows)).not.toContain("        session:s3");
    expect(rows.find((row) => row.id === "8주차")).toMatchObject({ expandable: true });
    expect(treeRows(state, EMPTY_OPEN, "manual", "8주차").some((row) => row.type === "session" && row.id === "solo")).toBe(true);
    expect(rows.find((row) => row.id === "chats:7주차")).toMatchObject({ type: "section", kind: "chat", label: "대화", count: 2 });
    const folded = toggleWork(EMPTY_OPEN, "7주차", true);
    expect(ids(treeRows(state, folded, "manual", "7주차"))).not.toContain("        session:s1");
    expect(ids(treeRows(state, toggleWork(folded, "7주차", false), "manual", "7주차"))).toContain("        session:s1");
  });

  it("sorts by name or recent activity when asked", () => {
    const named = ids(treeRows(state, EMPTY_OPEN, "name", null));
    expect(named.indexOf("    work:7주차")).toBeLessThan(named.indexOf("    work:8주차"));
  });

  it("shows what needs the user now, and pinned things", () => {
    const busy = stateOf([], [work("w", null, 0, { pinned: true })], [
      session("ask", "w", 1, { status: "awaitingApproval" }),
      session("run", "w", 2, { status: "running" }),
      session("new", "w", 3, { previewAt: 10, seenAt: 5 }),
      session("read", "w", 4, { previewAt: 10, seenAt: 20, pinned: true }),
    ]);
    const now = nowSessions(busy, null);
    expect([now.attention, now.running, now.unseen].map((list) => list.map((entry) => entry.id))).toEqual([["ask"], ["run"], ["new"]]);
    expect(nowSessions(busy, "new").unseen).toEqual([]);
    expect(pinnedItems(busy)).toMatchObject({ works: [{ id: "w" }], sessions: [{ id: "read" }] });
  });
});

describe("kinds under a project", () => {
  // The user's case: six documents, four of them with a document AI, one main chat, one web tab.
  const docs = ["a", "b", "c", "d", "e", "f"].map((id, index) => ({ id: `doc-${id}`, workId: "w", name: `${id}.md`, path: `/w/${id}.md`, format: "markdown", revision: 1, updatedAt: 10 - index }) as Partial<Artifact>);
  const agent = (id: string, artifactId: string, sort: number, extra: Partial<Session> = {}) =>
    session(id, "w", sort, { purpose: `${artifactId} · 문서 AI`, documentAgent: { artifactId, parentSessionId: "main" }, ...extra });
  const state = stateOf([], [work("w", null, 0)], [
    session("main", "w", 1),
    agent("ai-a", "doc-a", 2, { previewAt: 10, seenAt: 5 }),
    agent("ai-b", "doc-b", 3, { provider: "codex" }),
    agent("ai-c", "doc-c", 4),
    agent("ai-d", "doc-d", 5, { status: "running" }),
    agent("gone", "doc-gone", 6, { purpose: "옛 메모.md · 문서 AI" }),
    session("web", "w", 7, { pageAgent: { pageId: "p", parentSessionId: "main" } }),
  ], docs);
  const open = { ...EMPTY_OPEN, openWorks: ["w"], openDocs: ["w"] };
  const rows = treeRows(state, open, "manual", null);

  it("groups a project as 대화 · 문서 · 웹, in that order, with counts", () => {
    const groups = rows.filter((row) => row.type === "section" || row.type === "docs").map((row) => (row.type === "section" ? `${row.label} ${row.count}` : `문서 ${row.count}`));
    expect(groups).toEqual(["대화 2", "문서 6", "웹 1"]);
  });

  it("draws six document rows and no row of their own for the four document AIs", () => {
    const docRows = rows.filter((row) => row.type === "doc");
    expect(docRows).toHaveLength(6);
    expect(docRows.filter((row) => row.type === "doc" && row.agents.length).map((row) => row.id)).toEqual(["doc-a", "doc-b", "doc-c", "doc-d"]);
    for (const id of ["ai-a", "ai-b", "ai-c", "ai-d"]) expect(rows.some((row) => row.id === id)).toBe(false);
  });

  it("keeps a document AI whose document is gone under 대화, named after its document", () => {
    const orphan = rows.find((row) => row.id === "gone");
    expect(orphan).toMatchObject({ type: "session" });
    // Release unit A: no middle dot in what a person reads (the stored purpose keeps the gateway's form).
    expect(docAgentLabel(state.sessions.gone!)).toBe("옛 메모.md 문서 AI");
    expect(docAgentLabel({ ...state.sessions.gone!, purpose: "요약" })).toBe("요약 문서 AI");
    expect(purposeText({ ...state.sessions.gone!, purpose: "평가 안내 · 웹 AI" })).toBe("평가 안내 웹 AI");
    const chats = rows.slice(rows.findIndex((row) => row.id === "chats:w") + 1, rows.findIndex((row) => row.type === "docs")).map((row) => row.id);
    expect(chats).toEqual(["main", "gone"]);
  });

  it("puts a web AI on its web row", () => {
    const at = rows.findIndex((row) => row.id === "pages:w");
    expect(rows[at + 1]).toMatchObject({ type: "session", id: "web" });
  });

  it("shows the most pressing AI of a document: 확인 › 오류 › 진행 › 새 답 › 쉼", () => {
    const of = (...sessions: Session[]) => leadAgent(sessions, null);
    const s = (id: string, extra: Partial<Session>) => agent(id, "doc-a", 1, extra);
    expect(of(s("idle", {}), s("new", { previewAt: 9, seenAt: 1 }))).toMatchObject({ session: { id: "new" }, tone: "new" });
    expect(of(s("new", { previewAt: 9, seenAt: 1 }), s("run", { status: "running" }))).toMatchObject({ session: { id: "run" }, tone: "active" });
    expect(of(s("run", { status: "running" }), s("err", { status: "error" }))).toMatchObject({ session: { id: "err" }, tone: "error" });
    expect(of(s("err", { status: "error" }), s("ask", { status: "awaitingApproval" }))).toMatchObject({ session: { id: "ask" }, tone: "attention" });
    expect(of(s("old", {}), s("fresh", { createdAt: 50 }))).toMatchObject({ session: { id: "fresh" }, tone: null });
    // An answer on screen is not new.
    expect(leadAgent([s("new", { previewAt: 9, seenAt: 1 })], "new")).toMatchObject({ tone: null });
  });

  it("a folded 문서 group still carries its documents' AIs", () => {
    const folded = treeRows(state, { ...open, openDocs: [] }, "manual", null);
    expect(folded.find((row) => row.type === "docs")).toMatchObject({ agents: expect.arrayContaining([expect.objectContaining({ id: "ai-a" })]) });
  });
});

describe("moving rows", () => {
  const state = stateOf(
    [folder("a", null, 0), folder("b", null, 1), folder("a1", "a", 0)],
    [work("w1", "a", 1), work("w2", "a", 2), work("w3", null, 1)],
    [session("s1", "w1", 1), session("s2", "w1", 2), session("s3", "w1", 3), session("x", "w2", 1)],
  );
  const rows = Object.fromEntries(
    treeRows(state, { ...EMPTY_OPEN, openWorks: ["w1"] }, "manual", null).map((row) => [row.id, row]),
  ) as Record<string, Row>;

  it("finds the zone from where the pointer is on the row", () => {
    expect([zoneAt(2, 32, true), zoneAt(16, 32, true), zoneAt(30, 32, true), zoneAt(10, 32, false)]).toEqual(["before", "inside", "after", "before"]);
  });

  it("puts a work into a folder (first) or between two works", () => {
    expect(moveFor(state, rows.w3!, rows.b!, "inside", "manual")).toEqual({ kind: "work", id: "w3", folderId: "b", sort: 0 });
    expect(moveFor(state, rows.w3!, rows.w2!, "before", "manual")).toEqual({ kind: "work", id: "w3", folderId: "a", sort: 1.5 });
    expect(moveFor(state, rows.w1!, rows.w2!, "after", "manual")).toEqual({ kind: "work", id: "w1", folderId: "a", sort: 3 });
  });

  it("never moves a folder into itself or below itself", () => {
    expect(moveFor(state, rows.a!, rows.a1!, "inside", "manual")).toBeNull();
    expect(moveFor(state, rows.b!, rows.a!, "inside", "manual")).toMatchObject({ kind: "folder", parentId: "a" });
    expect(moveFor(state, rows.b!, rows.a!, "before", "manual")).toMatchObject({ kind: "folder", parentId: null, sort: -1 });
  });

  it("reorders sessions only within their own work", () => {
    expect(moveFor(state, rows.s3!, rows.s1!, "before", "manual")).toEqual({ kind: "session", id: "s3", sort: 0 });
    expect(moveFor(state, rows.s1!, rows.s2!, "after", "manual")).toEqual({ kind: "session", id: "s1", sort: 2.5 });
    expect(moveFor(state, rows.s1!, rows.w2!, "before", "manual")).toBeNull();
  });

  it("links two sessions dropped on a row's middle; every other drop keeps its meaning", () => {
    // Session on session (also of another work), session on a single-session work and back.
    expect(linkPair(rows.s1!, rows.s2!)?.map((entry) => entry.id)).toEqual(["s1", "s2"]);
    expect(linkPair(rows.s3!, rows.w2!)?.map((entry) => entry.id)).toEqual(["s3", "x"]);
    expect(linkPair(rows.w2!, rows.s1!)?.map((entry) => entry.id)).toEqual(["x", "s1"]);
    // Work on work only moves; a work of several sessions, a folder or the same session never links.
    expect(linkPair(rows.w2!, rows.w3!)).toBeNull();
    expect(linkPair(rows.s1!, rows.w1!)).toBeNull();
    expect(linkPair(rows.s1!, rows.a!)).toBeNull();
    expect(linkPair(rows.s1!, rows.s1!)).toBeNull();
    // The middle of a session row is the link zone; its edges still reorder.
    const zone = (offset: number) => zoneAt(offset, 32, holds(rows.s2!, rows.s1!) || Boolean(linkPair(rows.s1!, rows.s2!)));
    expect([zone(4), zone(16), zone(28)]).toEqual(["before", "inside", "after"]);
    expect(moveFor(state, rows.s1!, rows.s2!, "inside", "manual")).toBeNull();
  });

  it("swaps a row with its neighbour from the keyboard", () => {
    expect(nudge(state, rows.s1!, 1, "manual")).toEqual({ kind: "session", id: "s1", sort: 2.5 });
    expect(nudge(state, rows.s1!, -1, "manual")).toBeNull();
    expect(nudge(state, rows.w2!, -1, "manual")).toEqual({ kind: "work", id: "w2", folderId: "a", sort: 0 });
    expect(between(undefined, undefined)).toBe(0);
  });
});

describe("opening a document row", () => {
  const agent = (id: string, extra: Partial<Session> = {}) => session(id, "w", 1, { documentAgent: { artifactId: "d", parentSessionId: null }, ...extra });
  it("opens the AI whose state the row shows, in every state", () => {
    const ask = agent("ask", { status: "awaitingApproval", createdAt: 1 }), fresh = agent("fresh", { createdAt: 9 });
    expect(docOpenTarget([fresh, ask], null)).toBe(ask);
    expect(docOpenTarget([fresh, agent("run", { status: "running", createdAt: 2 })], null)?.id).toBe("run");
    expect(docOpenTarget([fresh, agent("old", { createdAt: 2 })], null)).toBe(fresh);
    expect(docOpenTarget([], null)).toBeNull();
  });
});


// Skin 2 · B, item 4: the 웹 section lists the project's browser pages — open ones and those whose tab
// was closed — each with its AI's state if it has one. A row and its tab are one item: `browser:<pageId>`.
describe("a project's web pages (workPages)", () => {
  const page = (pageId: string, workId: string, extra: Partial<BrowserPage> = {}): BrowserPage => ({
    pageId, profileId: "default", workId, workspaceId: `${workId}-space`, driverId: "driver", url: `https://${pageId}.example`, title: `${pageId} 제목`,
    status: "ready", sessionId: null, control: { generation: 0, owner: "human" }, native: null, createdAt: 1, updatedAt: 1, error: null, ...extra });
  const ai = session("page-ai", "강의", 4, { pageAgent: { pageId: "p-open", parentSessionId: "main" }, status: "running" } as Partial<Session>);
  const closedAi = session("closed-ai", "강의", 5, { pageAgent: { pageId: "p-closed", parentSessionId: "main" }, archivedAt: 50 } as Partial<Session>);
  const orphan = session("orphan-ai", "강의", 6, { pageAgent: { pageId: "p-unknown", parentSessionId: "main" } } as Partial<Session>);
  const state = stateOf([], [work("강의", null, 0), work("다른", null, 1)], [session("main", "강의", 1), ai, closedAi, orphan]);
  const browser = {
    pages: [page("p-open", "강의", { sessionId: "page-ai", createdAt: 2 }), page("p-blank", "강의", { createdAt: 3 }), page("p-other", "다른")],
    closedPages: [page("p-closed", "강의", { status: "closed", closedAt: 40 }), page("p-closed-older", "강의", { status: "closed", closedAt: 20 })],
  };

  it("lists open pages (with or without an AI), then pages whose tab was closed, newest first; never another project's", () => {
    const items = workPages(state, "강의", browser);
    expect(items.map((item) => [item.id, item.open])).toEqual([
      ["browser:p-open", true], ["browser:p-blank", true], ["browser:p-closed", false], ["browser:p-closed-older", false], ["orphan-ai", true],
    ]);
  });
  it("carries each page's AI (also the one archived when its page was closed) and names the page by its title", () => {
    const items = workPages(state, "강의", browser);
    expect(items[0]).toMatchObject({ pageId: "p-open", title: "p-open 제목", agent: { id: "page-ai" } });
    expect(items[1]!.agent).toBeNull();
    // A blank page is named in words, not by its address.
    expect(workPages(state, "강의", { pages: [page("blank", "강의", { url: "about:blank", title: "" })] })[0]!.title).toBe("빈 웹 페이지");
    expect(items[2]).toMatchObject({ pageId: "p-closed", closedAt: 40, agent: { id: "closed-ai" } });
  });
  it("a page AI whose page this window does not know (the phone, an older record) stays a row of its own", () => {
    expect(workPages(state, "강의", { pages: [], closedPages: [] }).map((item) => [item.id, item.pageId, item.agent?.id])).toEqual([
      ["page-ai", "p-open", "page-ai"], ["orphan-ai", "p-unknown", "orphan-ai"],
    ]);
  });
});
