import { describe, expect, it } from "vitest";
import type { Artifact, Folder, Proposal, Session, Work } from "@workbench/contracts";
import { initialState, type State } from "./state.ts";
import {
  boardColumns,
  bucketOf,
  docEntries,
  lastExchange,
  mapSections,
  mindmapSource,
  nodeText,
  nowGroups,
  readHomeMode,
  resumeSessions,
} from "./overview.ts";
import { excerpt } from "./thumbs.ts";

// Home overview modes: the same sessions grouped five ways, no model involved.

const NOW = new Date(2026, 9, 28, 15, 0, 0).getTime();
const folder = (id: string, parentId: string | null, sort: number, extra: Partial<Folder> = {}): Folder => ({ id, parentId, name: id, sort, archivedAt: null, ...extra });
const work = (id: string, folderId: string | null, sort = 0, extra: Partial<Work> = {}): Work => ({
  id,
  title: id,
  titleSource: "user",
  folderId,
  cwd: `/w/${id}`,
  cwdManaged: false,
  activeSessionId: null,
  pinned: false,
  sort,
  archivedAt: null,
  createdAt: 0,
  updatedAt: NOW - 3600_000,
  ...extra,
});
const session = (id: string, workId: string, extra: Partial<Session> = {}): Session => ({
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
  preview: "답",
  previewAt: NOW - 7200_000,
  status: "idle",
  activity: null,
  lastError: null,
  pinned: false,
  sort: 0,
  archivedAt: null,
  seenAt: NOW,
  unread: false,
  queued: [],
  access: null,
  context: null,
  createdAt: 0,
  updatedAt: NOW - 7200_000,
  ...extra,
});
const artifact = (id: string, workId: string, extra: Partial<Artifact> = {}): Artifact => ({
  id,
  workId,
  path: `/w/${workId}/${id}.md`,
  name: `${id}.md`,
  format: "markdown",
  revision: 1,
  sha256: "",
  size: 1,
  diskState: "same",
  readBy: {},
  createdAt: 0,
  updatedAt: NOW - 600_000,
  ...extra,
});
const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((entry) => [entry.id, entry]));
const stateOf = (parts: { folders?: Folder[]; works?: Work[]; sessions?: Session[]; artifacts?: Artifact[]; proposals?: Proposal[] }): State => ({
  ...initialState,
  ready: true,
  folders: byId(parts.folders ?? []),
  works: byId(parts.works ?? []),
  sessions: byId(parts.sessions ?? []),
  artifacts: byId(parts.artifacts ?? []),
  proposals: byId(parts.proposals ?? []),
});
const held = { id: "q", text: "남은 요청", refs: [], create: null, at: NOW, held: true };

describe("지금", () => {
  it("puts each session in its first matching group, by priority", () => {
    expect(bucketOf(session("a", "w", { status: "awaitingApproval", lastError: "x" }))).toBe("attention");
    expect(bucketOf(session("b", "w", { status: "error" }))).toBe("trouble");
    expect(bucketOf(session("c", "w", { lastError: "실패", previewAt: NOW, seenAt: 0 }))).toBe("trouble");
    expect(bucketOf(session("d", "w", { queued: [held] }))).toBe("trouble");
    expect(bucketOf(session("e", "w", { previewAt: NOW, seenAt: NOW - 1 }))).toBe("unseen");
    expect(bucketOf(session("f", "w", { unread: true }))).toBe("unseen");
    expect(bucketOf(session("g", "w", { status: "running", queued: [{ ...held, held: false }] }))).toBe("running");
    // A running session holding requests from before is busy first; the requests wait for it.
    expect(bucketOf(session("h", "w", { status: "running", queued: [held] }))).toBe("running");
    expect(bucketOf(session("i", "w", { queued: [{ ...held, held: false }] }))).toBe("queued");
    expect(bucketOf(session("j", "w"))).toBeNull();
  });

  it("lists groups in priority order, newest first, and leaves out archived things", () => {
    const state = stateOf({
      folders: [folder("old", null, 0, { archivedAt: 1 })],
      works: [work("w", null), work("gone", "old")],
      sessions: [
        session("run", "w", { status: "running", updatedAt: NOW - 50 }),
        session("new1", "w", { previewAt: NOW - 20, seenAt: 0 }),
        session("new2", "w", { previewAt: NOW - 10, seenAt: 0 }),
        session("ask", "w", { status: "awaitingApproval" }),
        session("hidden", "gone", { status: "awaitingApproval" }),
        session("archived", "w", { status: "error", archivedAt: 1 }),
      ],
    });
    const groups = nowGroups(state);
    expect(groups.map((group) => [group.label, group.sessions.map((entry) => entry.id)])).toEqual([
      ["확인 필요", ["ask"]],
      ["새 답", ["new2", "new1"]],
      ["진행", ["run"]],
    ]);
    const listed = new Set(groups.flatMap((group) => group.sessions.map((entry) => entry.id)));
    expect(resumeSessions(state, listed)).toEqual([]);
  });

  it("finds the last request and the whole reply after it", () => {
    const items = [
      { kind: "user", text: "첫 요청" },
      { kind: "assistant", text: "첫 답" },
      { kind: "user", text: "둘째 요청" },
      { kind: "tool" },
      { kind: "assistant", text: "앞부분" },
      { kind: "assistant", text: "뒷부분" },
    ];
    expect(lastExchange(items)).toEqual({ request: "둘째 요청", answer: "앞부분\n\n뒷부분" });
    expect(lastExchange([])).toEqual({ request: null, answer: null });
  });

  it("reads the remembered mode, falling back to 지금", () => {
    expect(readHomeMode("flow")).toBe("flow");
    expect(readHomeMode("grid")).toBe("now");
    expect(readHomeMode(undefined)).toBe("now");
  });
});

describe("보드", () => {
  it("has five columns and every visible session in exactly one", () => {
    const sessions = [
      session("a", "w", { status: "awaitingApproval" }),
      session("b", "w", { status: "starting" }),
      session("c", "w", { status: "error" }),
      session("d", "w", { previewAt: NOW, seenAt: 0 }),
      session("e", "w"),
      session("f", "w", { queued: [{ ...held, held: false }] }),
    ];
    const columns = boardColumns(stateOf({ works: [work("w", null)], sessions }));
    expect(columns.map((column) => column.label)).toEqual(["확인 필요", "진행 중", "오류·멈춤", "새 답", "쉬는 중"]);
    expect(columns.map((column) => column.sessions.map((entry) => entry.id).join(""))).toEqual(["a", "b", "c", "d", "ef"]);
  });
});

describe("지도", () => {
  it("walks folders in tree order with their paths, loose works last", () => {
    const state = stateOf({
      folders: [folder("강의", null, 0), folder("2026-2", "강의", 0), folder("연구", null, 1), folder("빈 폴더", null, 2)],
      works: [work("w8", "2026-2", 1), work("w7", "2026-2", 0), work("논문", "연구"), work("보고서", null), work("강의 공통", "강의")],
    });
    expect(mapSections(state).map((section) => [section.path.join(" / "), section.works.map((entry) => entry.id)])).toEqual([
      ["강의", ["강의 공통"]],
      ["강의 / 2026-2", ["w7", "w8"]],
      ["연구", ["논문"]],
      ["", ["보고서"]],
    ]);
  });

  it("draws a mind map Mermaid can read, kept small", () => {
    const works = Array.from({ length: 7 }, (_, index) => work(`작업 ${index}`, "f"));
    const state = stateOf({
      folders: [folder("f", null, 0, { name: "강의 (2학기)" })],
      works,
      sessions: Array.from({ length: 5 }, (_, index) => session(`s${index}`, "작업 0", { purpose: `대화 [${index}]: 정리` })),
    });
    const source = mindmapSource(state, mapSections(state));
    expect(source.split("\n").slice(0, 4)).toEqual(["mindmap", "  root((작업 지도))", "    강의 2학기", "      작업 0"]);
    expect(source).toContain("        대화 0 정리");
    expect(source).toContain("        외 2개");
    expect(source).toContain("      작업 2개 더");
    expect(nodeText("  ((  ))  ")).toBe("제목 없음");
  });
});

describe("문서", () => {
  it("lists documents of visible works, the latest change first, with waiting proposals", () => {
    const proposal = (id: string, artifactId: string, status: Proposal["status"]): Proposal => ({
      id,
      artifactId,
      sessionId: "s",
      requestId: id,
      baseRevision: 1,
      workingPath: "",
      status,
      added: 1,
      removed: 0,
      appliedRevision: null,
      createdAt: 0,
      updatedAt: 0,
    });
    const state = stateOf({
      works: [work("w", null), work("gone", null, 0, { archivedAt: 1 })],
      artifacts: [artifact("old", "w", { updatedAt: 1 }), artifact("new", "w", { updatedAt: 5 }), artifact("hidden", "gone")],
      proposals: [proposal("p1", "old", "pending"), proposal("p2", "old", "pending"), proposal("p3", "new", "running"), proposal("p4", "new", "applied")],
    });
    expect(docEntries(state).map((entry) => [entry.artifact.id, entry.pending, entry.running])).toEqual([
      ["new", 0, 1],
      ["old", 2, 0],
    ]);
  });

  it("shows text documents by their opening lines, without Markdown or HTML marks", () => {
    expect(excerpt("---\ntitle: x\n---\n# 강의안\n\n- **질문**에서 시작\n```js\ncode()\n```\n[링크](http://a)", "markdown")).toBe("강의안\n질문에서 시작\n링크");
    expect(excerpt("<html><style>p{}</style><h1>제목</h1><p>본문 &amp; 끝</p><script>x()</script></html>", "html")).toBe("제목\n본문 & 끝");
  });
});
