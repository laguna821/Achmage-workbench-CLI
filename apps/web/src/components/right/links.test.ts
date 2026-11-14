import { describe, expect, it } from "vitest";
import type { Artifact, BrowserPage, Handoff, Proposal, Session, SessionLink, TranscriptItem } from "@workbench/contracts";
import { initialState, type State } from "../../state.ts";
import { linksOf } from "./links.ts";

const session = (id: string, extra: Partial<Session> = {}) => ({ id, workId: "w", provider: "codex", purpose: id, status: "idle", archivedAt: null, ...extra }) as unknown as Session;
const doc = (id: string, name: string, extra: Partial<Artifact> = {}) => ({ id, workId: "w", name, path: `/works/w/${name}`, format: "markdown", revision: 2, readBy: {}, ...extra }) as unknown as Artifact;

// A conversation's record, as the gateway keeps it: what it wrote, proposed, was given and fetched.
const items: TranscriptItem[] = [
  { kind: "user", id: "u1", text: "강의안을 읽고 슬라이드를 만들어 줘", at: 10, refs: [{ artifactId: "lecture", name: "강의안.md", revision: 1, mode: "review", selection: null }] },
  { kind: "tool", id: "t1", tool: "web", title: "https://ctl.example.ac.kr/guide", detail: null, output: null, status: "completed", at: 11 },
  { kind: "tool", id: "t2", tool: "web", title: "AI 평가 기준", detail: null, output: null, status: "completed", at: 12 },
  { kind: "tool", id: "t3", tool: "command", title: "cat 참고.md", detail: null, output: null, status: "completed", at: 13, reads: ["/works/w/참고.md"] },
  { kind: "artifact", id: "f1", artifactId: "slides", revision: 1, change: "created", at: 14 },
  { kind: "user", id: "u2", text: "강의안 도입부도 고쳐 줘", at: 20, from: { sessionId: "sender", label: "자료 조사" } },
  { kind: "proposal", id: "p1", proposalId: "prop", at: 21 },
  { kind: "tool", id: "t4", tool: "web", title: "https://ctl.example.ac.kr/guide", detail: null, output: null, status: "completed", at: 22 },
  { kind: "artifact", id: "f2", artifactId: "slides", revision: 2, change: "modified", at: 23 },
];

const me = session("me");
const state: State = {
  ...initialState,
  sessions: {
    me,
    sender: session("sender", { purpose: "자료 조사" }),
    peer: session("peer", { purpose: "평가 기준 토론" }),
    helper: session("helper", { purpose: "보조" }),
    docAi: session("docAi", { purpose: "강의안 다듬기", documentAgent: { artifactId: "lecture", parentSessionId: "me" } }),
    pageAi: session("pageAi", { purpose: "센터 안내 요약", pageAgent: { pageId: "page-1", parentSessionId: "me" } }),
    stranger: session("stranger"),
  },
  artifacts: {
    lecture: doc("lecture", "강의안.md"),
    slides: doc("slides", "슬라이드.md"),
    notes: doc("notes", "참고.md"),
    syllabus: doc("syllabus", "강의계획서.pdf", { format: "pdf", readBy: { me: 1 } }),
    other: doc("other", "다른 문서.md"),
  },
  proposals: { prop: { id: "prop", artifactId: "lecture", sessionId: "me", status: "pending" } as unknown as Proposal },
  handoffs: {
    out: { id: "out", sourceSessionId: "me", targetSessionId: "helper", status: "answered", createdAt: 30 } as unknown as Handoff,
    in: { id: "in", sourceSessionId: "sender", targetSessionId: "me", status: "answered", createdAt: 20 } as unknown as Handoff,
  },
  links: { l1: { id: "l1", participants: ["peer", "me"], state: "ended", startedAt: 40, updatedAt: 41 } as unknown as SessionLink },
};
const pages = [{ pageId: "page-1", sessionId: "pageAi", title: "교수학습센터 안내", url: "https://ctl.example.ac.kr", status: "ready" } as unknown as BrowserPage];

describe("what a conversation is connected to", () => {
  it("lists the documents it made, changed or read, each once, with what it did last", () => {
    const { documents } = linksOf(me, items, state, pages);
    expect(documents.map((entry) => [entry.artifact.name, entry.state])).toEqual([
      ["강의안.md", "수정안 대기"],
      ["참고.md", "읽음"],
      ["슬라이드.md", "고침"],
      ["강의계획서.pdf", "읽음"],
    ]);
  });

  it("lists the web tabs it opened and the pages it fetched, not its searches", () => {
    const { web } = linksOf(me, items, state, pages);
    expect(web.map((entry) => [entry.kind, entry.title])).toEqual([["tab", "교수학습센터 안내"], ["visit", "ctl.example.ac.kr/guide"]]);
  });

  it("lists the sessions it is linked to: its document AI, hand-offs both ways and relays", () => {
    const { chats } = linksOf(me, items, state, pages);
    expect(chats.map((entry) => [entry.session.id, entry.relation])).toEqual([
      ["docAi", "문서 AI · 강의안.md"],
      ["peer", "세션 잇기 · 끝남"],
      ["helper", "보낸 요청 · 답 받음"],
      ["sender", "받은 요청"],
    ]);
  });

  it("shows a document or page AI the conversation it came from", () => {
    expect(linksOf(state.sessions.docAi!, [], state, pages).chats.map((entry) => [entry.session.id, entry.relation])).toEqual([["me", "원래 대화"]]);
    expect(linksOf(state.sessions.pageAi!, [], state, pages).chats.map((entry) => entry.relation)).toEqual(["원래 대화"]);
  });

  it("is empty for a conversation that touched nothing", () => {
    expect(linksOf(state.sessions.stranger!, [{ kind: "user", id: "x", text: "안녕", at: 1 }], state, [])).toEqual({ documents: [], web: [], chats: [] });
  });
});

describe("what a row's target is now", () => {
  const live = session("live", { purpose: "남은 대화" });
  const gone = session("gone", { purpose: "끝난 대화", archivedAt: 50 } as Partial<Session>);
  const oldAi = session("oldAi", { purpose: "옛 문서 AI", archivedAt: 60, documentAgent: { artifactId: "lecture", parentSessionId: "live" } } as Partial<Session>);
  const closedAi = session("closedAi", { purpose: "닫힌 탭 AI", pageAgent: { pageId: "page-closed", parentSessionId: "live" } });
  const lostAi = session("lostAi", { purpose: "기록 없는 탭 AI", pageAgent: { pageId: "page-lost", parentSessionId: "live" } });
  const missing = doc("missing", "옮겨진.md", { diskState: "missing" } as Partial<Artifact>);
  const now: State = {
    ...state,
    sessions: { live, gone, oldAi, closedAi, lostAi },
    artifacts: { ...state.artifacts, missing },
    handoffs: { h: { id: "h", sourceSessionId: "live", targetSessionId: "gone", status: "answered", createdAt: 1 } as unknown as Handoff },
    links: {},
  };
  const closedPage = { pageId: "page-closed", sessionId: "closedAi", title: "센터 안내", url: "https://ctl.example.ac.kr/guide", workspaceId: "space", workId: "w", status: "closed", closedAt: 70 } as unknown as BrowserPage;
  const record: TranscriptItem[] = [{ kind: "artifact", id: "f", artifactId: "missing", revision: 1, change: "created", at: 1 }];

  it("labels an archived conversation 보관됨 and keeps it as itself", () => {
    const { chats } = linksOf(live, record, now, [closedPage]);
    expect(chats.map((entry) => [entry.session.id, entry.relation, entry.archived])).toEqual([
      ["oldAi", "문서 AI · 강의안.md · 보관됨", true],
      ["gone", "보낸 요청 · 답 받음 · 보관됨", true],
    ]);
  });

  it("labels a closed web tab 닫힘 with the address to open again, or none when the address is unknown", () => {
    const { web } = linksOf(live, record, now, [closedPage]);
    expect(web.map((entry) => entry.kind === "tab" ? [entry.title, entry.state, entry.closed, entry.page?.url ?? null] : null)).toEqual([
      ["센터 안내", "닫힘", true, "https://ctl.example.ac.kr/guide"],
      ["기록 없는 탭 AI", "닫힘", true, null],
    ]);
  });

  it("labels a document whose file is gone, and does not offer to open it", () => {
    const { documents } = linksOf(live, record, now, []);
    expect(documents.map((entry) => [entry.artifact.name, entry.state, entry.gone])).toEqual([["옮겨진.md", "파일 없음", true]]);
  });
});
