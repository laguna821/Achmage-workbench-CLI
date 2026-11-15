import { describe, expect, it } from "vitest";
import type { Proposal, Session } from "@workbench/contracts";
import type { Layout, Pane, PaneTab } from "./panes.ts";
import { drawnLayout } from "./tabs.ts";
import type { BrowserPage, NativeBrowserPage } from "@workbench/contracts";
import { AWAKE_RECENT, TAB_SLEEP_MS, pageInUse, sleepPlan, tabAtWork, type SleepInput } from "./tab-sleep.ts";

// 0.5.1, tab sleep: a mounted tab's view is taken down (the tab stays) once it has been off screen for
// ten minutes and nothing in it could be lost or is at work. One function decides; every clause here.

type View = { kind: "work"; beside?: { kind: "browser"; pageId: string } | { kind: "document"; artifactId: string; proposalId: null } } | { kind: "document"; artifactId: string; proposalId: null }
  | { kind: "browser"; pageId: string } | { kind: "new"; folderId: null } | { kind: "terminal" } | { kind: "project"; workId: string };
const chat = (id: string, workId: string, view: View = { kind: "work" }): PaneTab<View> => ({ id, view, workId, sessionId: `s-${id}` });
const doc = (id: string, workId: string): PaneTab<View> => ({ id, view: { kind: "document", artifactId: `a-${id}`, proposalId: null }, workId, sessionId: null });
const pane = (id: string, tabs: PaneTab<View>[], front: string): Pane<View> => {
  const active = tabs.find((tab) => tab.id === front)!;
  return { id, view: active.view, workId: active.workId, sessionId: active.sessionId, tabs, activeTabId: front, recentTabIds: [front] };
};
const MIN = 60_000, NOW = 100 * MIN;
/** Project 2's conversation is on screen; project 1's conversation and document are behind it, shown `ago` minutes ago. */
const scene = (ago = 10, more: Partial<SleepInput<View>> = {}): SleepInput<View> => {
  const layout: Layout<View> = { panes: [pane("a", [chat("c1", "P1"), doc("d1", "P1"), chat("c2", "P2")], "c2")], focus: "a" };
  return {
    layout, drawn: drawnLayout(layout), mounted: new Set(["c1", "d1", "c2"]), now: NOW,
    shownAt: new Map([["c1", NOW - ago * MIN], ["d1", NOW - ago * MIN], ["c2", NOW]]),
    unsaved: () => false, atWork: () => false, ...more,
  };
};

describe("which tabs go to sleep", () => {
  it("the constants: ten minutes off screen, the six most recently shown of the project on screen stay", () => {
    expect(TAB_SLEEP_MS).toBe(10 * MIN);
    expect(AWAKE_RECENT).toBe(6);
  });

  it("another project's tabs, ten minutes off screen with nothing to lose and nothing at work, sleep", () => {
    expect(sleepPlan(scene())).toEqual({ sleep: ["c1", "d1"], ask: [] });
  });

  it("not before the ten minutes are over", () => {
    expect(sleepPlan(scene(9.99))).toEqual({ sleep: [], ask: [] });
    expect(sleepPlan(scene(10)).sleep).toEqual(["c1", "d1"]);
  });

  it("a tab on screen never sleeps, whatever is recorded of when it was last shown", () => {
    const input = scene();
    expect(sleepPlan({ ...input, shownAt: new Map([["c1", 0], ["d1", 0], ["c2", 0]]) }).sleep).toEqual(["c1", "d1"]);
  });

  it("the tab in front of every pane on screen stays, also in a pane that is not the focused one", () => {
    const layout: Layout<View> = { panes: [pane("a", [chat("c1", "P1")], "c1"), pane("b", [doc("d1", "P1"), doc("d2", "P1")], "d1")], focus: "a" };
    const plan = sleepPlan({ layout, drawn: drawnLayout(layout), mounted: new Set(["c1", "d1", "d2"]), now: NOW, shownAt: new Map([["c1", 0], ["d1", 0], ["d2", 0]]), unsaved: () => false, atWork: () => false });
    // d2 is behind d1 — but it is one of the project's six most recently shown tabs.
    expect(plan).toEqual({ sleep: [], ask: [] });
  });

  it("a pane that is not drawn (it holds no tab of the window's project) is off screen: its front tab sleeps too", () => {
    const layout: Layout<View> = { panes: [pane("a", [chat("c2", "P2")], "c2"), pane("b", [doc("d1", "P1")], "d1")], focus: "a" };
    const input = { layout, mounted: new Set(["c2", "d1"]), now: NOW, shownAt: new Map([["c2", NOW], ["d1", NOW - 10 * MIN]]), unsaved: () => false, atWork: () => false };
    expect(sleepPlan({ ...input, drawn: drawnLayout(layout) }).sleep).toEqual(["d1"]);
    // 모든 프로젝트의 탭 보기: every pane is drawn, so that tab is on screen.
    expect(sleepPlan({ ...input, drawn: drawnLayout(layout, true) }).sleep).toEqual([]);
    expect(sleepPlan(input).sleep).toEqual([]);
  });

  it("a view that is not mounted is not listed", () => {
    expect(sleepPlan(scene(10, { mounted: new Set(["d1", "c2"]) })).sleep).toEqual(["d1"]);
  });

  it("a tab with no record of when it was last on screen stays awake", () => {
    expect(sleepPlan(scene(10, { shownAt: new Map([["d1", NOW - 10 * MIN], ["c2", NOW]]) })).sleep).toEqual(["d1"]);
  });

  it("a web page, in its own tab or beside a conversation, never sleeps as it is: its native page is released first — at most once per interval — and then it sleeps", () => {
    const layout: Layout<View> = { panes: [pane("a", [{ id: "w1", view: { kind: "browser", pageId: "p" }, workId: "P1", sessionId: null }, chat("c1", "P1", { kind: "work", beside: { kind: "browser", pageId: "q" } }), chat("c2", "P2")], "c2")], focus: "a" };
    const input: SleepInput<View> = { layout, drawn: drawnLayout(layout), mounted: new Set(["w1", "c1", "c2"]), now: NOW, shownAt: new Map([["w1", 0], ["c1", 0], ["c2", NOW]]), unsaved: () => false, atWork: () => false };
    expect(sleepPlan(input)).toEqual({ sleep: [], ask: ["w1", "c1"] });
    expect(sleepPlan({ ...input, askedAt: new Map([["w1", NOW - MIN]]) })).toEqual({ sleep: [], ask: ["c1"] });
    expect(sleepPlan({ ...input, saved: new Set(["w1"]) })).toEqual({ sleep: ["w1"], ask: ["c1"] });
    // In use (an AI is using the page): never, and not asked.
    expect(sleepPlan({ ...input, atWork: (tab) => tab.id === "w1" })).toEqual({ sleep: [], ask: ["c1"] });
    // Not before its ten minutes, and not while it is one of the project's six most recently shown.
    expect(sleepPlan({ ...input, shownAt: new Map([["w1", NOW - 9 * MIN], ["c1", NOW - 9 * MIN], ["c2", NOW]]) })).toEqual({ sleep: [], ask: [] });
    const own: Layout<View> = { panes: [pane("a", [layout.panes[0]!.tabs![0]!, chat("c1", "P1")], "c1")], focus: "a" };
    expect(sleepPlan({ ...input, layout: own, drawn: drawnLayout(own), mounted: new Set(["w1", "c1"]) })).toEqual({ sleep: [], ask: [] });
  });

  it("a tab with something at work in it stays awake and is not asked to save", () => {
    expect(sleepPlan(scene(10, { atWork: (tab) => tab.id === "c1", unsaved: () => true }))).toEqual({ sleep: [], ask: ["d1"] });
  });

  describe("unsaved edits (the keeper: an editor that cannot tell counts as unsaved)", () => {
    it("never sleeps as it is: its editor is asked to save first", () => {
      expect(sleepPlan(scene(10, { unsaved: (tab) => tab.id === "d1" }))).toEqual({ sleep: ["c1"], ask: ["d1"] });
    });
    it("sleeps once its editor has answered saved — every other clause still holding", () => {
      const unsaved = (tab: PaneTab<View>) => tab.id === "d1";
      expect(sleepPlan(scene(10, { unsaved, saved: new Set(["d1"]) })).sleep).toEqual(["c1", "d1"]);
      expect(sleepPlan(scene(10, { unsaved, saved: new Set(["d1"]), atWork: (tab) => tab.id === "d1" })).sleep).toEqual(["c1"]);
      expect(sleepPlan(scene(5, { unsaved, saved: new Set(["d1"]) })).sleep).toEqual([]);
    });
    it("is asked again only once a whole interval has passed since the last time (no tight loop)", () => {
      const unsaved = (tab: PaneTab<View>) => tab.id === "d1";
      expect(sleepPlan(scene(30, { unsaved, askedAt: new Map([["d1", NOW - 9 * MIN]]) })).ask).toEqual([]);
      expect(sleepPlan(scene(30, { unsaved, askedAt: new Map([["d1", NOW - 10 * MIN]]) })).ask).toEqual(["d1"]);
    });
    it("is not asked before it is due", () => {
      expect(sleepPlan(scene(9, { unsaved: () => true }))).toEqual({ sleep: [], ask: [] });
    });
  });

  describe("the six most recently shown tabs of the project on screen", () => {
    const docs = Array.from({ length: 8 }, (_, index) => doc(`d${index + 1}`, "P1"));
    const layout: Layout<View> = { panes: [pane("a", [...docs, chat("c2", "P2")], "d8")], focus: "a" };
    // d8 is on screen; d7 was shown 20 minutes ago, d6 21 … d1 26.
    const shownAt = new Map<string, number>([...docs.map((tab, index): [string, number] => [tab.id, index === 7 ? NOW : NOW - (27 - index) * MIN]), ["c2", NOW - 60 * MIN]]);
    const input: SleepInput<View> = { layout, drawn: drawnLayout(layout), mounted: new Set([...docs.map((tab) => tab.id), "c2"]), now: NOW, shownAt, unsaved: () => false, atWork: () => false };

    it("never sleep, however long ago they were shown; the project's older ones do", () => {
      expect(sleepPlan(input).sleep).toEqual(["d1", "d2", "c2"]);
    });
    it("are not asked to save either", () => {
      expect(sleepPlan({ ...input, unsaved: () => true })).toEqual({ sleep: [], ask: ["d1", "d2", "c2"] });
    });
    it("belong to the project on screen only: on home (no project) no tab is kept for being recent", () => {
      const home: Layout<View> = { panes: [pane("a", [...docs, { id: "h", view: { kind: "new", folderId: null }, workId: null, sessionId: null }], "h")], focus: "a" };
      const plan = sleepPlan({ ...input, layout: home, drawn: drawnLayout(home), mounted: new Set(docs.map((tab) => tab.id)), shownAt: new Map(docs.map((tab): [string, number] => [tab.id, NOW - 10 * MIN])) });
      expect(plan.sleep).toEqual(docs.map((tab) => tab.id));
    });
  });

  it("a shorter time is taken when given (the test rig's), never the default's", () => {
    expect(sleepPlan(scene(1, { after: MIN })).sleep).toEqual(["c1", "d1"]);
    expect(sleepPlan(scene(1)).sleep).toEqual([]);
  });
});

describe("whether something is at work in a tab (unsure: yes)", () => {
  const session = (id: string, patch: Partial<Session> = {}): Session => ({ id, workId: "P1", status: "idle", archivedAt: null, ...patch }) as Session;
  const world = (sessions: Session[], proposals: Partial<Proposal>[] = []) => ({
    sessions: Object.fromEntries(sessions.map((entry) => [entry.id, entry])),
    proposals: Object.fromEntries(proposals.map((entry, index) => [`p${index}`, entry as Proposal])),
  });

  it("an idle conversation and a document with no AI at work: no", () => {
    const idle = world([session("s-c1"), session("ai", { documentAgent: { artifactId: "a-d1", parentSessionId: "s-c1" } as Session["documentAgent"] })]);
    expect(tabAtWork(chat("c1", "P1"), idle)).toBe(false);
    expect(tabAtWork(doc("d1", "P1"), idle)).toBe(false);
  });

  it("a conversation that is answering, waiting for an approval or stopping: yes; one that ended in an error: no", () => {
    for (const status of ["starting", "running", "waiting", "interrupting"]) expect(tabAtWork(chat("c1", "P1"), world([session("s-c1", { status: status as Session["status"] })]))).toBe(true);
    expect(tabAtWork(chat("c1", "P1"), world([session("s-c1", { status: "error" })]))).toBe(false);
  });

  it("another conversation of the project at work does not keep this conversation's tab awake — unless the tab names none, or it works for this one", () => {
    const other = world([session("s-c1"), session("s-other", { status: "running" })]);
    expect(tabAtWork(chat("c1", "P1"), other)).toBe(false);
    expect(tabAtWork({ ...chat("c1", "P1"), sessionId: null }, other)).toBe(true);
    expect(tabAtWork(chat("c1", "P1"), world([session("s-c1"), session("child", { status: "running", pageAgent: { pageId: "p", parentSessionId: "s-c1" } as Session["pageAgent"] })]))).toBe(true);
    // A tab naming another project's conversation shows this project's active one: any of this project's at work counts.
    expect(tabAtWork(chat("c1", "P1"), world([session("s-c1", { workId: "P9" }), session("s-other", { status: "running" })]))).toBe(true);
    // A tab whose conversation the app no longer knows: unsure.
    expect(tabAtWork(chat("c1", "P1"), world([session("s-other", { status: "running" })]))).toBe(true);
  });

  it("a document whose AI is at work, or with a proposal being made: yes — in its own tab and beside a conversation", () => {
    const working = world([session("s-c1"), session("ai", { status: "running", documentAgent: { artifactId: "a-d1", parentSessionId: "s-c1" } as Session["documentAgent"] })]);
    expect(tabAtWork(doc("d1", "P1"), working)).toBe(true);
    expect(tabAtWork(doc("d2", "P1"), working)).toBe(false);
    expect(tabAtWork(chat("c9", "P1", { kind: "work", beside: { kind: "document", artifactId: "a-d1", proposalId: null } }), world([session("s-c9"), ...Object.values(working.sessions)]))).toBe(true);
    expect(tabAtWork(doc("d1", "P1"), world([], [{ artifactId: "a-d1", status: "running" }]))).toBe(true);
    // A proposal waiting to be looked at is kept by the gateway: the view shows it again.
    expect(tabAtWork(doc("d1", "P1"), world([], [{ artifactId: "a-d1", status: "pending" }]))).toBe(false);
  });

  it("only a conversation, a document and a web page are known to come back: every other kind stays awake", () => {
    const none = world([]);
    for (const view of [{ kind: "terminal" }, { kind: "project", workId: "P1" }, { kind: "new", folderId: null }, { kind: "presentation" }, { kind: "pkm" }, { kind: "archive" }] as View[])
      expect(tabAtWork({ id: "t", view, workId: "P1", sessionId: null }, none)).toBe(true);
    // A conversation's tab with no project (the start screen): unsure.
    expect(tabAtWork({ id: "t", view: { kind: "work" }, workId: null, sessionId: null }, none)).toBe(true);
  });
});

describe("whether a web page is in use (Part 3: its own, stricter clauses)", () => {
  const session = (id: string, patch: Partial<Session> = {}): Session => ({ id, workId: "P1", status: "idle", archivedAt: null, ...patch }) as Session;
  const native = (patch: Partial<NativeBrowserPage> = {}): NativeBrowserPage => ({ pageId: "p", profileId: "default", navigationRevision: 1, capabilities: [], url: "https://example.com/", title: "글", loading: false, control: { owner: "human", generation: 0 }, popups: [], error: null, ...patch });
  const page = (patch: Partial<BrowserPage> = {}): BrowserPage => ({ pageId: "p", profileId: "default", workId: "P1", workspaceId: "space", driverId: "d", url: "https://example.com/", title: "글", status: "ready", sessionId: null, control: { owner: "human", generation: 0 }, native: native(), createdAt: 1, updatedAt: 1, error: null, ...patch });
  const world = (pages: BrowserPage[], sessions: Session[] = [], more: { heldPageIds?: string[]; pending?: Record<string, unknown> } = {}) => ({ sessions: Object.fromEntries(sessions.map((entry) => [entry.id, entry])), proposals: {}, pages, ...more });
  const webTab: PaneTab<View> = { id: "w", view: { kind: "browser", pageId: "p" }, workId: "P1", sessionId: null };

  it("an open page nobody and nothing is using: no — also with its web AI conversation idle or ended in an error", () => {
    expect(pageInUse("p", world([page()]))).toBe(false);
    expect(pageInUse("p", world([page({ sessionId: "ai" })], [session("ai", { pageAgent: { pageId: "p", parentSessionId: "main" } as Session["pageAgent"] })]))).toBe(false);
    expect(pageInUse("p", world([page({ sessionId: "ai" })], [session("ai", { status: "error" })]))).toBe(false);
    expect(tabAtWork(webTab, world([page()]))).toBe(false);
  });

  it("an AI is using the page: ALWAYS yes — its conversation answering, waiting or stopping; the AI holding the page; an agent's own page; a held page; an action without a result", () => {
    for (const status of ["starting", "running", "waiting", "interrupting"]) {
      expect(pageInUse("p", world([page({ sessionId: "ai" })], [session("ai", { status: status as Session["status"] })]))).toBe(true);
      expect(pageInUse("p", world([page()], [session("other", { status: status as Session["status"], pageAgent: { pageId: "p", parentSessionId: "main" } as Session["pageAgent"] })]))).toBe(true);
    }
    expect(pageInUse("p", world([page({ control: { owner: "ai", generation: 3 } })]))).toBe(true);
    expect(pageInUse("p", world([page({ agentSessionId: "main" })], [session("main")]))).toBe(true);
    expect(pageInUse("p", world([page()], [], { heldPageIds: ["p"] }))).toBe(true);
    expect(pageInUse("p", world([page()], [], { pending: { p: { id: "job", status: "waiting" } } }))).toBe(true);
    expect(tabAtWork(webTab, world([page({ sessionId: "ai" })], [session("ai", { status: "running" })]))).toBe(true);
    // Beside a conversation: the conversation idle, the page's AI at work.
    expect(tabAtWork(chat("c1", "P1", { kind: "work", beside: { kind: "browser", pageId: "p" } }), world([page({ sessionId: "ai" })], [session("s-c1"), session("ai", { status: "running" })]))).toBe(true);
    expect(tabAtWork(chat("c1", "P1", { kind: "work", beside: { kind: "browser", pageId: "p" } }), world([page()], [session("s-c1")]))).toBe(false);
  });

  it("what the app can see the page doing: a download on its way or waiting, a permission question, a window it opened — yes; a finished download, an answered question — no", () => {
    const download = (status: string) => ({ id: "f", url: "", name: "", path: null, directory: null, requestedAt: 1, finishedAt: null, status, size: null, sha256: null, error: null }) as NonNullable<NativeBrowserPage["downloads"]>[number];
    const asked = (status: string) => ({ id: "q", kind: "camera", pageUrl: "", navigationRevision: 1, requestedAt: 1, expiresAt: 2, status, requestingOrigin: null }) as NonNullable<NativeBrowserPage["permissions"]>[number];
    for (const status of ["blocked", "downloading", "cancelling", "checking"]) expect(pageInUse("p", world([page({ native: native({ downloads: [download(status)] }) })]))).toBe(true);
    for (const status of ["completed", "failed", "cancelled"]) expect(pageInUse("p", world([page({ native: native({ downloads: [download(status)] }) })]))).toBe(false);
    for (const status of ["pending", "native-prompt"]) expect(pageInUse("p", world([page({ native: native({ permissions: [asked(status)] }) })]))).toBe(true);
    for (const status of ["allowed", "denied", "expired"]) expect(pageInUse("p", world([page({ native: native({ permissions: [asked(status)] }) })]))).toBe(false);
    expect(pageInUse("p", world([page({ native: native({ popups: [{ id: "x", url: "https://example.com/pop" }] }) })]))).toBe(true);
  });

  it("a page the app does not know, or one still opening: unsure, so yes; one with no native page (not connected, closed): nothing is held", () => {
    expect(pageInUse("p", world([]))).toBe(true);
    expect(pageInUse("p", { sessions: {}, proposals: {} })).toBe(true);
    expect(pageInUse("p", world([page({ status: "opening", native: null })]))).toBe(true);
    expect(pageInUse("p", world([page({ status: "interrupted", native: null })]))).toBe(false);
    expect(pageInUse("p", world([page({ status: "closed", native: null })]))).toBe(false);
  });
});
