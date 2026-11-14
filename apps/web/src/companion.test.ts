import { describe, expect, it } from "vitest";
import type { Artifact, Proposal, Session } from "@workbench/contracts";
import type { Layout, PaneContent } from "./panes.ts";
import { activeTab, contentKey, findTab, tabsOf, withTabs } from "./tabs.ts";
import { setPane } from "./panes.ts";
import { initialState, type State } from "./state.ts";
import { CHAT_MIN, COLUMN_GAP, besideFit, childWork, companionMinimum, readMinimum, keepCompanions, legacyView, leavesView, oneViewPerDocument, releaseViews, upgradeStoredLayout, viewDocument, viewsOfDocument, viewsOfPage, viewsToRelease, withoutCompanion, type Companion } from "./companion.ts";

// 곁 화면: a document or web page beside its conversation, inside that conversation's tab.

type View =
  | { kind: "work"; beside?: Companion }
  | { kind: "document"; artifactId: string; proposalId: string | null }
  | { kind: "browser"; pageId: string }
  | { kind: "new" };
const doc = (artifactId: string): Companion => ({ kind: "document", artifactId, proposalId: null });
const chat = (sessionId: string, beside?: Companion): PaneContent<View> => ({ workId: "w", sessionId, view: beside ? { kind: "work", beside } : { kind: "work" } });
const docTab = (artifactId: string, sessionId: string | null = null): PaneContent<View> => ({ workId: "w", sessionId, view: { kind: "document", artifactId, proposalId: null } });
const one = (content: PaneContent<View>): Layout<View> => withTabs({ panes: [{ id: "a", ...content }], focus: "a" });
const open = (layout: Layout<View>, paneId: string, content: PaneContent<View>) => withTabs({ ...setPane(layout, paneId, content), focus: paneId }, layout);

describe("a companion lives in its conversation's tab", () => {
  it("opening and closing one keeps the tab: the conversation is the tab's identity", () => {
    const start = one(chat("s"));
    const tab = activeTab(start.panes[0]!).id;
    const beside = open(start, "a", chat("s", doc("d")));
    expect(tabsOf(beside.panes[0]!)).toHaveLength(1);
    expect(activeTab(beside.panes[0]!).id).toBe(tab);
    expect(contentKey(chat("s", doc("d")))).toBe(contentKey(chat("s")));
    const closed = open(beside, "a", chat("s"));
    expect(activeTab(closed.panes[0]!).id).toBe(tab);
    expect(viewDocument(closed.panes[0]!.view)).toBeNull();
  });

  it("names the document a view shows: its own tab's, or the conversation's companion", () => {
    expect(viewDocument({ kind: "document", artifactId: "d" })).toBe("d");
    expect(viewDocument({ kind: "work", beside: doc("d") })).toBe("d");
    expect(viewDocument({ kind: "work", beside: { kind: "browser", pageId: "p" } })).toBeNull();
    expect(viewDocument({ kind: "work" })).toBeNull();
  });

  it("finds every view of a document, in tabs of its own and beside conversations", () => {
    let layout = one(chat("s", doc("d")));
    layout = open(layout, "a", docTab("other"));
    expect(viewsOfDocument(layout, "d").map((entry) => entry.beside)).toEqual([true]);
    expect(viewsOfDocument(layout, "other").map((entry) => entry.beside)).toEqual([false]);
    expect(viewsOfDocument(layout, "none")).toEqual([]);
  });
});

describe("leaving a view (its editor saves first)", () => {
  const at = (content: PaneContent<View>) => content;
  it("closing the companion, or putting another document there, leaves it", () => {
    expect(leavesView(at(chat("s", doc("d"))), { kind: "work" })).toBe(true);
    expect(leavesView(at(chat("s", doc("d"))), { kind: "work", beside: doc("e") })).toBe(true);
    expect(leavesView(at(chat("s", doc("d"))), null)).toBe(true);
  });
  it("the same document in the same place is not left (a proposal shown or closed)", () => {
    expect(leavesView(at(chat("s", doc("d"))), { kind: "work", beside: { kind: "document", artifactId: "d", proposalId: "p" } })).toBe(false);
    expect(leavesView(at(docTab("d")), { kind: "document", artifactId: "d", proposalId: "p" })).toBe(false);
  });
  it("a companion made a tab of its own, or a tab put beside a conversation, is another view: it is left", () => {
    expect(leavesView(at(chat("s", doc("d"))), { kind: "document", artifactId: "d", proposalId: null })).toBe(true);
    expect(leavesView(at(docTab("d", "s")), { kind: "work", beside: doc("d") })).toBe(true);
  });
  it("a conversation with nothing beside it is left only for another conversation", () => {
    expect(leavesView(at(chat("s")), { kind: "work", beside: doc("d") })).toBe(false);
    expect(leavesView(at(chat("s")), { kind: "new" })).toBe(true);
  });
});

describe("one view per document", () => {
  it("a document that has a tab of its own is no conversation's companion", () => {
    let layout = one(chat("s", doc("d")));
    layout = open(layout, "a", docTab("d"));
    const fixed = oneViewPerDocument(layout);
    const conversation = findTab(fixed, "session:s")!.tab;
    expect(conversation.view).toEqual({ kind: "work" });
    expect(findTab(fixed, "doc:d")).not.toBeNull();
  });
  it("two conversations never hold the same document: the one on screen keeps it", () => {
    let layout = one(chat("s", doc("d")));
    layout = open(layout, "a", chat("t", doc("d")));
    const fixed = oneViewPerDocument(layout);
    expect(findTab(fixed, "session:s")!.tab.view).toEqual({ kind: "work" });
    expect(findTab(fixed, "session:t")!.tab.view).toEqual({ kind: "work", beside: doc("d") });
  });
  it("leaves a layout with nothing doubled as it is (the same object)", () => {
    const layout = open(one(chat("s", doc("d"))), "a", docTab("other"));
    expect(oneViewPerDocument(layout)).toBe(layout);
  });
  it("takes a companion out of one tab only", () => {
    const layout = open(one(chat("s", doc("d"))), "a", chat("t", doc("e")));
    const tab = findTab(layout, "session:s")!.tab.id;
    const next = withoutCompanion(layout, tab);
    expect(findTab(next, "session:s")!.tab.view).toEqual({ kind: "work" });
    expect(findTab(next, "session:t")!.tab.view).toEqual({ kind: "work", beside: doc("e") });
  });
});

describe("a conversation shown again keeps what is beside it", () => {
  it("going to a conversation (a sidebar row, a notice, Ctrl+Tab) does not close its companion", () => {
    let layout = one(chat("s", doc("d")));
    layout = open(layout, "a", chat("t"));
    // The app navigates with a plain conversation view.
    const asked = { ...setPane(layout, "a", chat("s")), focus: "a" };
    const settled = withTabs(keepCompanions(asked), layout);
    expect(settled.panes[0]!.view).toEqual({ kind: "work", beside: doc("d") });
    expect(findTab(settled, "session:s")!.tab.view).toEqual({ kind: "work", beside: doc("d") });
  });
  it("closing it is its own act, on the tab: it stays closed", () => {
    const layout = one(chat("s", doc("d")));
    const closed = withTabs(keepCompanions(withoutCompanion(layout, activeTab(layout.panes[0]!).id)), layout);
    expect(closed.panes[0]!.view).toEqual({ kind: "work" });
  });
  it("another companion asked for replaces it", () => {
    const layout = one(chat("s", doc("d")));
    const next = withTabs(keepCompanions(setPane(layout, "a", chat("s", doc("e")))), layout);
    expect(next.panes[0]!.view).toEqual({ kind: "work", beside: doc("e") });
  });
});

describe("the other views of a document go when it is opened somewhere else", () => {
  const fallback: PaneContent<View> = { view: { kind: "new" }, workId: null, sessionId: null };
  it("a companion is closed in its conversation's tab; a tab of its own is closed", () => {
    let layout = one(chat("s", doc("d")));
    layout = open(layout, "a", docTab("e"));
    layout = open(layout, "a", chat("t"));
    const released = releaseViews(layout, [...viewsOfDocument(layout, "d"), ...viewsOfDocument(layout, "e")], fallback);
    expect(findTab(released, "session:s")!.tab.view).toEqual({ kind: "work" });
    expect(findTab(released, "doc:e")).toBeNull();
    expect(findTab(released, "session:t")).not.toBeNull();
  });
  it("finds a web page in a tab of its own and beside a conversation", () => {
    let layout = one(chat("s", { kind: "browser", pageId: "p" }));
    layout = open(layout, "a", { workId: "w", sessionId: "web", view: { kind: "browser", pageId: "q" } });
    expect(viewsOfPage(layout, "p").map((entry) => entry.beside)).toEqual([true]);
    expect(viewsOfPage(layout, "q").map((entry) => entry.beside)).toEqual([false]);
  });
});

describe("which views go before another is shown", () => {
  const fresh = (view: View) => view;
  it("going back to a conversation's tab never closes what is beside it (the tab is shown again, not opened anew)", () => {
    let layout = one(chat("s", doc("d")));
    layout = open(layout, "a", chat("t"));
    const holder = findTab(layout, "session:s")!.tab;
    // A tab switch hands over the tab's own view.
    expect(viewsToRelease(layout, holder.id, holder.view)).toEqual({ documents: [], pages: [] });
    // Even where the destination is not said (a tab moved between panes): the view handed over is
    // the holder's own, so it is not another view of the document.
    expect(viewsToRelease(layout, null, holder.view)).toEqual({ documents: [], pages: [] });
    // The same view as a new object is another view: that one goes.
    expect(viewsToRelease(layout, null, { ...holder.view }).documents).toEqual([{ paneId: "a", tabId: holder.id, beside: true }]);
    // And so does the app going there with a plain conversation view.
    expect(viewsToRelease(layout, holder.id, fresh({ kind: "work" }))).toEqual({ documents: [], pages: [] });
  });
  it("a document opened in a tab of its own: the conversation it was beside lets it go", () => {
    let layout = one(chat("s", doc("d")));
    layout = open(layout, "a", chat("t"));
    const holder = findTab(layout, "session:s")!.tab.id;
    expect(viewsToRelease(layout, null, fresh({ kind: "document", artifactId: "d", proposalId: null }))).toEqual({ documents: [{ paneId: "a", tabId: holder, beside: true }], pages: [] });
  });
  it("a document's own tab shown again releases nothing", () => {
    let layout = one(docTab("d"));
    layout = open(layout, "a", chat("s"));
    const own = findTab(layout, "doc:d")!.tab;
    expect(viewsToRelease(layout, own.id, own.view)).toEqual({ documents: [], pages: [] });
    expect(viewsToRelease(layout, own.id, fresh({ kind: "document", artifactId: "d", proposalId: "p" }))).toEqual({ documents: [], pages: [] });
  });
  it("a document put beside a conversation: its own tab and any other conversation holding it go, the destination does not", () => {
    let layout = one(docTab("d"));
    layout = open(layout, "a", chat("s"));
    const destination = findTab(layout, "session:s")!.tab.id, own = findTab(layout, "doc:d")!.tab.id;
    expect(viewsToRelease(layout, destination, fresh({ kind: "work", beside: doc("d") }))).toEqual({ documents: [{ paneId: "a", tabId: own, beside: false }], pages: [] });
    let two = one(chat("t", doc("d")));
    two = open(two, "a", chat("s"));
    const other = findTab(two, "session:t")!.tab.id;
    expect(viewsToRelease(two, findTab(two, "session:s")!.tab.id, fresh({ kind: "work", beside: doc("d") })).documents).toEqual([{ paneId: "a", tabId: other, beside: true }]);
    // Already beside the destination (a proposal shown there): nothing goes.
    expect(viewsToRelease(two, other, fresh({ kind: "work", beside: { kind: "document", artifactId: "d", proposalId: "p" } })).documents).toEqual([]);
  });
  it("a web page moved between its tab and a conversation only changes place", () => {
    let layout = one({ workId: "w", sessionId: "web", view: { kind: "browser", pageId: "p" } });
    layout = open(layout, "a", chat("s"));
    const own = findTab(layout, "browser:p")!.tab.id, destination = findTab(layout, "session:s")!.tab.id;
    expect(viewsToRelease(layout, destination, fresh({ kind: "work", beside: { kind: "browser", pageId: "p" } }))).toEqual({ documents: [], pages: [{ paneId: "a", tabId: own, beside: false }] });
    const beside = open(releaseViews(layout, [{ paneId: "a", tabId: own, beside: false }], { view: { kind: "new" }, workId: null, sessionId: null }), "a", chat("s", { kind: "browser", pageId: "p" }));
    expect(viewsToRelease(beside, null, fresh({ kind: "browser", pageId: "p" })).pages).toEqual([{ paneId: "a", tabId: findTab(beside, "session:s")!.tab.id, beside: true }]);
  });
  it("nothing to show, or a view of neither: nothing goes", () => {
    const layout = one(chat("s", doc("d")));
    expect(viewsToRelease(layout, null, null)).toEqual({ documents: [], pages: [] });
    expect(viewsToRelease(layout, null, fresh({ kind: "new" }))).toEqual({ documents: [], pages: [] });
  });
});

describe("restoring a layout saved before", () => {
  it("나란히 (a tab that was the document's) comes back as the document's tab", () => {
    expect(legacyView({ kind: "split", artifactId: "d", draftKey: "doc:d", focus: "doc" })).toEqual({ kind: "document", artifactId: "d", proposalId: null });
  });
  it("keeps every other view, and drops a companion that is not one", () => {
    expect(legacyView({ kind: "work" })).toEqual({ kind: "work" });
    expect(legacyView({ kind: "work", beside: doc("d") })).toEqual({ kind: "work", beside: doc("d") });
    expect(legacyView({ kind: "work", beside: { kind: "nothing" } })).toEqual({ kind: "work" });
    expect(legacyView({ kind: "document", artifactId: "d", proposalId: null })).toEqual({ kind: "document", artifactId: "d", proposalId: null });
  });
});

describe("a stored layout from before", () => {
  it("is read with its 나란히 tabs as document tabs, pane and tabs alike", () => {
    const raw = { version: 2, focus: "a", panes: [{ id: "a", view: { kind: "split", artifactId: "d", draftKey: "doc:d", focus: "chat" }, workId: "w", sessionId: "s", activeTabId: "t1",
      tabs: [{ id: "t1", view: { kind: "split", artifactId: "d", draftKey: "doc:d", focus: "chat" }, workId: "w", sessionId: "s" }, { id: "t2", view: { kind: "work" }, workId: "w", sessionId: "s" }] }] };
    const upgraded = upgradeStoredLayout(raw) as typeof raw;
    expect(upgraded.panes[0]!.view).toEqual({ kind: "document", artifactId: "d", proposalId: null });
    expect(upgraded.panes[0]!.tabs[0]!.view).toEqual({ kind: "document", artifactId: "d", proposalId: null });
    expect(upgraded.panes[0]!.tabs[1]!.view).toEqual({ kind: "work" });
    // Nothing else is touched, and what is not a layout is handed back as it is.
    expect(upgraded.panes[0]!.tabs[1]!.id).toBe("t2");
    expect(upgradeStoredLayout(null)).toBeNull();
    expect(upgradeStoredLayout({ panes: "x" })).toEqual({ panes: "x" });
  });
});

describe("side by side only while both columns keep their minimum", () => {
  const fit = (width: number, contentMin: number, was: "beside" | "over" = "beside", ratio = 0.4) => besideFit({ width, chatMin: CHAT_MIN, contentMin, ratio, was });
  it("not measured yet: beside", () => {
    expect(fit(0, 360).mode).toBe("beside");
  });
  it("gives the conversation its share, never below its minimum, never taking the other below its own", () => {
    expect(fit(1136, 360)).toEqual({ mode: "beside", chat: Math.round((1136 - COLUMN_GAP) * 0.4) });
    // An embedded editor needs 680: the conversation gets what is left.
    expect(fit(1136, 680)).toEqual({ mode: "beside", chat: 1136 - COLUMN_GAP - 680 });
    expect(fit(900, 360, "beside", 0.1)).toEqual({ mode: "beside", chat: CHAT_MIN });
  });
  it("lies over when the two minimums do not fit — it never squeezes", () => {
    expect(fit(696, 360).mode).toBe("over");
    expect(fit(1000, 680).mode).toBe("over");
    expect(fit(CHAT_MIN + COLUMN_GAP + 680, 680).mode).toBe("beside");
  });
  it("does not flip at the threshold: laid over, it needs a little more room to come back beside", () => {
    const edge = CHAT_MIN + COLUMN_GAP + 360;
    expect(fit(edge, 360, "beside").mode).toBe("beside");
    expect(fit(edge, 360, "over").mode).toBe("over");
    expect(fit(edge + 16, 360, "over").mode).toBe("beside");
  });
  it("a document asks for the editor's width only while an embedded editor is its view — and for the editor's own AI panel while that may be open", () => {
    expect(companionMinimum({ editing: true })).toBe(680);
    expect(companionMinimum({ editing: true, panel: true })).toBe(1040);
    expect(companionMinimum({ editing: false })).toBe(360);
    expect(companionMinimum({ editing: false, panel: true })).toBe(360);
    // A 1440 window's pane (1136): the column would leave the editor 769 of the 1040 it needs.
    expect(fit(1136, companionMinimum({ editing: true, panel: true })).mode).toBe("over");
    expect(fit(1136, companionMinimum({ editing: true })).mode).toBe("beside");
  });
  it("a document read beside a conversation: text that reflows needs a pane's minimum, a page drawn to the column needs 640", () => {
    expect(readMinimum("markdown")).toBe(360);
    expect(readMinimum("hwpx")).toBe(360);
    expect(readMinimum("text")).toBe(360);
    for (const format of ["docx", "pptx", "xlsx", "pdf"] as const) expect(readMinimum(format)).toBe(640);
    // 1280 with the two-pane navigator leaves a 747 px pane: a Word page lies over, a Markdown text stays beside.
    expect(fit(747, readMinimum("docx")).mode).toBe("over");
    expect(fit(747, readMinimum("markdown")).mode).toBe("beside");
    expect(fit(1136, readMinimum("docx")).mode).toBe("beside");
  });
});

describe("the main conversation sees its documents' AIs at work", () => {
  const session = (id: string, extra: Partial<Session> = {}) => ({ id, workId: "w", provider: "codex", purpose: id, status: "idle", queued: [], archivedAt: null, unread: false, createdAt: 1, updatedAt: 1, ...extra }) as unknown as Session;
  const child = (id: string, artifactId: string, extra: Partial<Session> = {}) => session(id, { documentAgent: { artifactId, parentSessionId: "main" }, ...extra } as Partial<Session>);
  const proposal = (id: string, sessionId: string, status: Proposal["status"]) => ({ id, artifactId: "d", sessionId, status, baseRevision: 1 }) as unknown as Proposal;
  const base = (sessions: Session[], proposals: Proposal[] = []): State => ({
    ...initialState,
    artifacts: { d: { id: "d", name: "강의안.md" } as Artifact, e: { id: "e", name: "발표.pptx" } as Artifact },
    sessions: Object.fromEntries([session("main"), ...sessions].map((entry) => [entry.id, entry])),
    proposals: Object.fromEntries(proposals.map((entry) => [entry.id, entry])),
  });
  const main = session("main");

  it("one line per child that has something to say: who, which document, its state", () => {
    const state = base([child("ai", "d", { status: "running" })], [proposal("p", "ai", "running")]);
    expect(childWork(state, main, [])).toEqual([{ session: state.sessions.ai, kind: "document", name: "강의안.md", state: "수정안 1건 · 응답 중", tone: "active", last: null }]);
  });
  it("a waiting approval, a waiting proposal, an error and a new answer are all said", () => {
    const state = base(
      [child("a", "d", { status: "awaitingApproval" }), child("b", "e", { status: "idle" }), child("c", "d", { status: "error" }), child("n", "e", { unread: true })],
      [proposal("p1", "b", "pending"), proposal("p2", "b", "pending")],
    );
    expect(childWork(state, main, []).map((line) => [line.session.id, line.state, line.tone])).toEqual([
      ["a", "승인 필요", "attention"],
      ["b", "수정안 2건 · 확인 기다림", "attention"],
      ["c", "오류", "error"],
      ["n", "새 답", "idle"],
    ]);
  });
  // What the gateway already gives on every session: the start of its latest finished reply
  // (`preview`) and what it is doing now (`activity`). No field is added for this.
  it("says what that AI last did, from the reply the gateway already keeps on the session", () => {
    const state = base([
      child("a", "d", { unread: true, preview: "도입부를 질문 하나로 시작하게 바꿨습니다.\n\n바꾼 점은 세 가지입니다.", previewAt: 5 } as Partial<Session>),
      child("b", "e", { status: "running", activity: "파일 읽는 중", preview: "지난번 답", previewAt: 3 } as Partial<Session>),
    ]);
    expect(childWork(state, main, []).map((line) => [line.session.id, line.state, line.last])).toEqual([
      ["a", "새 답", "도입부를 질문 하나로 시작하게 바꿨습니다."],
      // While it works, what it is doing now is the state; its earlier reply is not passed off as this turn's.
      ["b", "파일 읽는 중", null],
    ]);
  });
  it("keeps the last reply to one line of the reply's own words, however long", () => {
    const long = `${"가".repeat(200)}\n둘째 줄`;
    const state = base([child("a", "d", { unread: true, preview: `\n\n  ## ${long}`, previewAt: 5 } as Partial<Session>)]);
    const [line] = childWork(state, main, []);
    expect(line!.last!.length).toBeLessThanOrEqual(81);
    expect(line!.last!.startsWith("가")).toBe(true);
    expect(line!.last!.endsWith("…")).toBe(true);
  });

  it("says nothing of an idle child with nothing waiting, an archived one, one whose document is gone, or another conversation's", () => {
    const state = base([
      child("idle", "d"),
      child("archived", "d", { status: "running", archivedAt: 9 }),
      child("gone", "missing", { status: "running" }),
      session("foreign", { status: "running", documentAgent: { artifactId: "d", parentSessionId: "someone-else" } } as Partial<Session>),
    ]);
    expect(childWork(state, main, [])).toEqual([]);
  });
  it("a web tab's AI is named by its page", () => {
    const state = base([session("web", { status: "running", pageAgent: { pageId: "p", parentSessionId: "main" } } as Partial<Session>)]);
    const pages = [{ pageId: "p", title: "평가 루브릭 안내", url: "https://ctl.example.ac.kr/" }] as never;
    expect(childWork(state, main, pages).map((line) => [line.kind, line.name, line.state])).toEqual([["web", "평가 루브릭 안내", "응답 중"]]);
  });
});
