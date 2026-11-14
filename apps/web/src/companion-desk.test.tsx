// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDesk, settleLayout, type Desk } from "./companion-desk.ts";
import { besideOf, viewDocument, type Companion } from "./companion.ts";
import { EditorRegistry, type EditorState } from "./doc-editors.ts";
import { LeaveGate } from "./leave-gate.ts";
import type { Layout, PaneContent } from "./panes.ts";
import { activateTab, activeTab, findTab, tabsOf, withTabs } from "./tabs.ts";

// The app's wiring of 곁 화면, rendered: real panes and tabs, the app's own way of settling a
// layout, and stand-in views that register a leave guard and say what their editor holds — as
// DocumentView does. What is counted: guard calls (a flush or a save), mounts and unmounts.

type View =
  | { kind: "work"; beside?: Companion }
  | { kind: "document"; artifactId: string; proposalId: string | null }
  | { kind: "browser"; pageId: string }
  | { kind: "new" };
const doc = (artifactId: string): Companion => ({ kind: "document", artifactId, proposalId: null });
const chat = (sessionId: string, beside?: Companion): PaneContent<View> => ({ workId: "w", sessionId, view: beside ? { kind: "work", beside } : { kind: "work" } });
const docTab = (artifactId: string, sessionId: string | null = null): PaneContent<View> => ({ workId: "w", sessionId, view: { kind: "document", artifactId, proposalId: null } });
const webTab = (pageId: string): PaneContent<View> => ({ workId: "w", sessionId: "web", view: { kind: "browser", pageId } });

// What the test watches.
const seen = {
  guards: [] as { tabId: string; reason: string | undefined }[],
  mounts: {} as Record<string, number>, unmounts: {} as Record<string, number>,
  asked: [] as { artifactId: string; certain: boolean; same: boolean; go: () => Promise<void>; drop: () => Promise<void> }[],
  failed: [] as unknown[],
  /** What the editor of a document's own tab says of unsaved edits ("unknown": an embedded editor). */
  editor: {} as Record<string, EditorState>,
  /** A guard that refuses (the save failed). */
  refuse: new Set<string>(),
  /** The app's own comparison: the editor's text equals the saved revision. */
  same: {} as Record<string, boolean>,
  /** Tabs whose conversation its companion lies over. */
  covered: new Set<string>(),
  done: 0,
  /** Navigations the app was told of (a choice the start-up restore must not undo). */
  navigated: 0,
};
const count = (bag: Record<string, number>, key: string) => { bag[key] = (bag[key] ?? 0) + 1; };

/** A document view: it registers its tab's leave guard and its editor's state, as DocumentView does. Beside a conversation it only reads. */
function DocumentStandIn({ artifactId, tabId, hosted, guards, editors }: { artifactId: string; tabId: string; hosted: boolean; guards: React.RefObject<Record<string, (reason?: "close" | "discard") => Promise<void>>>; editors: EditorRegistry }) {
  const name = `${artifactId}:${hosted ? "beside" : "tab"}`;
  useEffect(() => {
    count(seen.mounts, name);
    const viewId = `${tabId}:${artifactId}`;
    guards.current[tabId] = async (reason) => {
      seen.guards.push({ tabId, reason });
      if (seen.refuse.has(artifactId)) throw new Error("문서를 저장하지 못해 이동하지 않았습니다.");
    };
    editors.set(artifactId, viewId, { dirty: () => (hosted ? false : seen.editor[artifactId] ?? false), same: () => Boolean(seen.same[artifactId]) });
    return () => { count(seen.unmounts, name); delete guards.current[tabId]; editors.set(artifactId, viewId, null); };
  }, []);
  return <div data-document={artifactId} data-hosted={hosted ? "" : undefined} />;
}
function Conversation({ sessionId }: { sessionId: string | null }) {
  useEffect(() => { count(seen.mounts, `chat:${sessionId}`); return () => count(seen.unmounts, `chat:${sessionId}`); }, []);
  return <div data-conversation={sessionId ?? ""} />;
}

let desk!: Desk<View>;
let layoutNow!: () => Layout<View>;
function App({ start }: { start: Layout<View> }) {
  const [layout, setLayout] = useState(start);
  const ref = useRef(layout);
  const guards = useRef<Record<string, (reason?: "close" | "discard") => Promise<void>>>({});
  const editors = useMemo(() => new EditorRegistry(), []);
  // As the app: every change settles the same way.
  const update = (change: (current: Layout<View>) => Layout<View>) => {
    const changed = change(ref.current);
    if (changed === ref.current) return;
    ref.current = settleLayout(changed, ref.current);
    setLayout(ref.current);
  };
  const made = useMemo(() => {
    const created: Desk<View> = createDesk<View>({
      layout: () => ref.current, update, guard: (tabId) => guards.current[tabId], gate: new LeaveGate(),
      select: (paneId, tabId, then) => {
        const tab = ref.current.panes.flatMap(tabsOf).find((entry) => entry.id === tabId);
        if (tab) created.leave(paneId, tab.view, () => { update((current) => activateTab(current, paneId, tabId)); then?.(); }, { destination: tabId });
      },
      editors: (artifactId) => editors.states(artifactId),
      looksSaved: (artifactId) => editors.looksSaved(artifactId),
      ask: (artifactId, { certain, same }, go, drop) => seen.asked.push({ artifactId, certain, same, go, drop }),
      covered: (tabId) => seen.covered.has(tabId),
      onNavigate: () => { seen.navigated += 1; },
      fail: (error) => seen.failed.push(error),
      home: { view: { kind: "new" }, workId: null, sessionId: null },
      conversation: (beside) => ({ kind: "work", beside }),
      page: (pageId) => webTab(pageId),
    });
    return created;
  }, []);
  desk = made; layoutNow = () => ref.current;
  return <>{layout.panes.flatMap((pane) => tabsOf(pane).map((tab) => {
    const beside = besideOf(tab.view);
    return (
      <section key={tab.id} data-tab={tab.id} data-active={activeTab(pane).id === tab.id}>
        {tab.view.kind === "work" ? <Conversation sessionId={tab.sessionId} /> : null}
        {tab.view.kind === "document" ? <DocumentStandIn key={tab.view.artifactId} artifactId={tab.view.artifactId} tabId={tab.id} hosted={false} guards={guards} editors={editors} /> : null}
        {beside?.kind === "document" ? <DocumentStandIn key={beside.artifactId} artifactId={beside.artifactId} tabId={tab.id} hosted guards={guards} editors={editors} /> : null}
      </section>
    );
  }))}</>;
}

const open = (layout: Layout<View>, content: PaneContent<View>) => settleLayout({ ...layout, panes: layout.panes.map((pane) => (pane.id === "a" ? { ...pane, ...content } : pane)), focus: "a" }, layout);
const start = (...contents: PaneContent<View>[]) => contents.slice(1).reduce(open, withTabs<View>({ panes: [{ id: "a", ...contents[0]! }], focus: "a" }));
const mount = async (layout: Layout<View>) => { render(<App start={layout} />); await act(async () => {}); };
const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
const active = () => { const pane = layoutNow().panes[0]!; return activeTab(pane); };
const tabOf = (key: string) => findTab(layoutNow(), key)?.tab;

beforeEach(() => {
  seen.guards = []; seen.mounts = {}; seen.unmounts = {}; seen.asked = []; seen.failed = []; seen.editor = {}; seen.refuse = new Set(); seen.same = {}; seen.covered = new Set(); seen.done = 0; seen.navigated = 0;
});
afterEach(cleanup);

// Ruling: nothing saves or closes a document's other view by itself.
describe("a document that already has a tab of its own, opened from the conversation (a card, a 연결 row, ⋯ › 문서)", () => {
  it.each([
    ["a rich-editor Markdown tab that is untouched", "unknown" as EditorState],
    ["a tab with unsaved edits", true as EditorState],
    ["a clean text tab", false as EditorState],
  ])("%s: the tab is brought to the front — 0 flushes, 0 saves, nothing closed, nothing asked", async (_name, state) => {
    seen.editor.d = state;
    await mount(start(docTab("d"), chat("s")));
    const own = tabOf("doc:d")!.id;
    await act(async () => { expect(desk.openBeside("a", doc("d"))).toBe(true); });
    await settle();
    expect(active().id).toBe(own);
    expect(seen.guards).toEqual([]);
    expect(seen.asked).toEqual([]);
    expect(seen.unmounts["d:tab"] ?? 0).toBe(0);
    expect(seen.mounts["d:beside"] ?? 0).toBe(0);
    expect(tabOf("session:s")!.view).toEqual({ kind: "work" });
  });

  it("open nowhere: it comes beside the conversation, which is not remounted", async () => {
    await mount(start(chat("s")));
    await act(async () => { desk.openBeside("a", doc("d")); });
    await settle();
    expect(viewDocument(active().view)).toBe("d");
    expect(seen.mounts["d:beside"]).toBe(1);
    expect(seen.mounts["chat:s"]).toBe(1);
    expect(seen.unmounts["chat:s"] ?? 0).toBe(0);
    expect(seen.guards).toEqual([]);
  });

  it("beside another conversation: the app goes to that conversation's tab; the document stays where it is", async () => {
    await mount(start(chat("t", doc("d")), chat("s")));
    await act(async () => { desk.openBeside("a", doc("d")); });
    await settle();
    expect(active().sessionId).toBe("t");
    expect(tabOf("session:t")!.view).toEqual({ kind: "work", beside: doc("d") });
    expect(tabOf("session:s")!.view).toEqual({ kind: "work" });
    expect(seen.unmounts["d:beside"] ?? 0).toBe(0);
    expect(seen.asked).toEqual([]);
  });
});

describe("the navigator, home or the palette asking for a document that is beside a conversation", () => {
  it("goes to that conversation's tab: the companion is not closed, no second view is opened — and whoever asked is told it is there", async () => {
    await mount(start(chat("s", doc("d")), chat("t")));
    await act(async () => { desk.show("a", docTab("d"), { then: () => { seen.done += 1; } }); });
    await settle();
    expect(seen.done).toBe(1);
    expect(active().sessionId).toBe("s");
    expect(tabOf("doc:d")).toBeUndefined();
    expect(seen.unmounts["d:beside"] ?? 0).toBe(0);
    expect(seen.mounts["d:tab"] ?? 0).toBe(0);
  });

  it("going back to a conversation's tab keeps what is beside it", async () => {
    await mount(start(chat("s", doc("d")), chat("t")));
    await act(async () => { desk.show("a", chat("s")); });
    await settle();
    expect(active().view).toEqual({ kind: "work", beside: doc("d") });
    expect(seen.unmounts["d:beside"] ?? 0).toBe(0);
  });
});

// Ruling: moving a document is an explicit act; a view that holds an editor goes through the
// leave question, which the person can cancel. No flush without the person's answer.
describe("대화 옆에: the person moves a document's tab beside its conversation", () => {
  it.each([["with unsaved edits", true as EditorState, true], ["in an embedded editor that cannot tell", "unknown" as EditorState, false]])(
    "%s: the person is asked first, and nothing is flushed before the answer", async (_name, state, certain) => {
      seen.editor.d = state;
      await mount(start(chat("s"), docTab("d", "s")));
      await act(async () => { desk.moveBeside("a", { workId: "w", sessionId: "s" }, doc("d")); });
      await settle();
      expect(seen.asked).toHaveLength(1);
      expect(seen.asked[0]).toMatchObject({ artifactId: "d", certain });
      expect(seen.guards).toEqual([]);
      expect(viewDocument(active().view)).toBe("d");
      expect(active().view.kind).toBe("document");
    },
  );

  it("cancel: nothing changed — the tab, its editor and the conversation are as they were", async () => {
    seen.editor.d = true;
    await mount(start(chat("s"), docTab("d", "s")));
    const before = layoutNow();
    await act(async () => { desk.moveBeside("a", { workId: "w", sessionId: "s" }, doc("d")); });
    await settle();
    // The person closes the question without answering yes: `go` is never run.
    expect(layoutNow()).toBe(before);
    expect(seen.guards).toEqual([]);
    expect(seen.unmounts["d:tab"] ?? 0).toBe(0);
    expect(seen.mounts["d:beside"] ?? 0).toBe(0);
  });

  it("yes: the tab saves through its own guard (as when it closes), closes, and the document is beside the conversation", async () => {
    seen.editor.d = true;
    await mount(start(chat("s"), docTab("d", "s")));
    const own = tabOf("doc:d")!.id;
    await act(async () => { desk.moveBeside("a", { workId: "w", sessionId: "s" }, doc("d")); });
    await act(async () => { await seen.asked[0]!.go(); });
    await settle();
    expect(seen.guards).toEqual([{ tabId: own, reason: "close" }]);
    expect(tabOf("doc:d")).toBeUndefined();
    expect(active().view).toEqual({ kind: "work", beside: doc("d") });
    expect(seen.unmounts["d:tab"]).toBe(1);
    expect(seen.mounts["d:beside"]).toBe(1);
    expect(seen.mounts["chat:s"]).toBe(1);
  });

  it("yes, but the save fails: nothing moves, and the failure is said", async () => {
    seen.editor.d = true; seen.refuse.add("d");
    await mount(start(chat("s"), docTab("d", "s")));
    await act(async () => { desk.moveBeside("a", { workId: "w", sessionId: "s" }, doc("d")); });
    await act(async () => { await seen.asked[0]!.go(); });
    await settle();
    expect(seen.failed).toHaveLength(1);
    expect(tabOf("doc:d")).toBeDefined();
    expect(tabOf("session:s")!.view).toEqual({ kind: "work" });
    expect(seen.unmounts["d:tab"] ?? 0).toBe(0);
  });

  it("저장하지 않고 옮기기: the tab leaves by its discard path — nothing is saved — and the document is beside the conversation", async () => {
    seen.editor.d = true;
    await mount(start(chat("s"), docTab("d", "s")));
    const own = tabOf("doc:d")!.id;
    await act(async () => { desk.moveBeside("a", { workId: "w", sessionId: "s" }, doc("d")); });
    await act(async () => { await seen.asked[0]!.drop(); });
    await settle();
    expect(seen.guards).toEqual([{ tabId: own, reason: "discard" }]);
    expect(tabOf("doc:d")).toBeUndefined();
    expect(active().view).toEqual({ kind: "work", beside: doc("d") });
  });

  it("the question says, as information only, when the editor's text equals the saved revision; the choices stay the person's", async () => {
    seen.editor.d = true; seen.same.d = true;
    await mount(start(chat("s"), docTab("d", "s")));
    await act(async () => { desk.moveBeside("a", { workId: "w", sessionId: "s" }, doc("d")); });
    await settle();
    expect(seen.asked).toHaveLength(1);
    expect(seen.asked[0]).toMatchObject({ artifactId: "d", same: true });
    // Nothing was decided for the person: nothing ran, nothing moved.
    expect(seen.guards).toEqual([]);
    expect(active().view.kind).toBe("document");
  });

  it("a view with nothing to save moves without a question", async () => {
    seen.editor.d = false;
    await mount(start(chat("s"), docTab("d", "s")));
    await act(async () => { desk.moveBeside("a", { workId: "w", sessionId: "s" }, doc("d")); });
    await settle();
    expect(seen.asked).toEqual([]);
    expect(active().view).toEqual({ kind: "work", beside: doc("d") });
    expect(tabOf("doc:d")).toBeUndefined();
  });
});

describe("탭으로 열어 고치기, and a click on the document's AI: the document beside a conversation gets its own tab", () => {
  it("a companion only reads, so it goes without a question; the conversation's tab stays, alone, and is not remounted", async () => {
    seen.editor.d = "unknown"; // what its editor would say in a tab: beside a conversation there is none
    await mount(start(chat("s", doc("d"))));
    await act(async () => { desk.show("a", docTab("d", "ai"), { move: true }); });
    await settle();
    expect(seen.asked).toEqual([]);
    expect(active().view).toEqual({ kind: "document", artifactId: "d", proposalId: null });
    expect(tabOf("session:s")!.view).toEqual({ kind: "work" });
    expect(seen.unmounts["d:beside"]).toBe(1);
    expect(seen.mounts["d:tab"]).toBe(1);
    expect(seen.unmounts["chat:s"] ?? 0).toBe(0);
    // Its guard ran with no reason (a companion closing is not a tab closing).
    expect(seen.guards.map((call) => call.reason)).toEqual([undefined]);
  });
});

describe("closing what is beside a conversation", () => {
  it("a document: the companion goes, the conversation stays", async () => {
    await mount(start(chat("s", doc("d"))));
    const tab = active().id;
    await act(async () => { desk.closeBeside("a", tab); });
    await settle();
    expect(active().view).toEqual({ kind: "work" });
    expect(seen.unmounts["d:beside"]).toBe(1);
    expect(seen.unmounts["chat:s"] ?? 0).toBe(0);
  });

  it("a web page: it stays listed as a tab of its own behind the conversation — nothing keeps running with no tab and no row", async () => {
    await mount(start(chat("s", { kind: "browser", pageId: "p" })));
    const tab = active().id;
    await act(async () => { desk.closeBeside("a", tab); });
    await settle();
    expect(active().view).toEqual({ kind: "work" });
    expect(tabOf("browser:p")).toBeDefined();
    expect(active().id).toBe(tab);
  });

  it("a web page put beside a conversation leaves its tab without stopping, and no question is asked for it", async () => {
    await mount(start(webTab("p"), chat("s")));
    await act(async () => { desk.openBeside("a", { kind: "browser", pageId: "p" }); });
    await settle();
    expect(tabOf("browser:p")).toBeUndefined();
    expect(active().view).toEqual({ kind: "work", beside: { kind: "browser", pageId: "p" } });
    expect(seen.asked).toEqual([]);
    expect(seen.guards).toEqual([]);
  });
});

// Office control (the AI editing a document through the Office MCP) waits for an editable view of
// the document. Beside a conversation the document is only read: its own tab is opened for it.
describe("office control asks for an editable view of the document", () => {
  const edit = async (layout: Layout<View>) => {
    await mount(layout);
    let done = 0;
    await act(async () => { desk.edit("a", docTab("d"), () => { done += 1; }); });
    await settle();
    return () => done;
  };
  it("beside the conversation in the focused pane: its own tab opens, the conversation keeps its place, and the request is answered", async () => {
    const done = await edit(start(chat("s", doc("d"))));
    expect(done()).toBe(1);
    expect(active().view).toEqual({ kind: "document", artifactId: "d", proposalId: null });
    expect(tabOf("session:s")!.view).toEqual({ kind: "work" });
    expect(seen.unmounts["chat:s"] ?? 0).toBe(0);
    // The read view held nothing: no question, and its guard is not asked to save as a tab closing.
    expect(seen.asked).toEqual([]);
    expect(seen.guards.map((call) => call.reason)).toEqual([undefined]);
  });
  it("beside a conversation in a background tab: the same, and the request is answered", async () => {
    const done = await edit(start(chat("t", doc("d")), chat("s")));
    expect(done()).toBe(1);
    expect(active().view).toEqual({ kind: "document", artifactId: "d", proposalId: null });
    expect(tabOf("session:t")!.view).toEqual({ kind: "work" });
    expect(seen.asked).toEqual([]);
  });
  it("the tab on screen cannot be left (its save failed): the request is refused at once, nothing moves", async () => {
    await mount(start(chat("s", doc("d")), docTab("x")));
    seen.refuse.add("x");
    let done = 0;
    const refused: unknown[] = [];
    await act(async () => { desk.edit("a", docTab("d"), () => { done += 1; }, (error) => { refused.push(error); }); });
    await settle();
    expect(done).toBe(0);
    expect(refused).toHaveLength(1);
    expect(tabOf("session:s")!.view).toEqual({ kind: "work", beside: doc("d") });
    expect(tabOf("doc:d")).toBeUndefined();
  });
  it("open in its own tab: answered at once, that tab brought to the front, nothing saved", async () => {
    await mount(start(docTab("d"), chat("s")));
    let done = 0;
    act(() => { desk.edit("a", docTab("d"), () => { done += 1; }); });
    expect(done).toBe(1);
    await settle();
    expect(active().view.kind).toBe("document");
    expect(seen.guards).toEqual([]);
    expect(seen.mounts["d:tab"]).toBe(1);
  });
});

// A conversation's row names the conversation: where its companion lies over it, the conversation is brought back.
describe("going to a conversation whose companion lies over it", () => {
  it("from another tab in front: the conversation comes forward without its companion", async () => {
    await mount(start(chat("s", doc("d")), chat("t")));
    expect(active().sessionId).toBe("t");
    seen.covered.add(tabOf("session:s")!.id);
    await act(async () => { desk.conversation("a", chat("s")); });
    await settle();
    expect(active().sessionId).toBe("s");
    expect(active().view).toEqual({ kind: "work" });
  });
  it("brings the conversation (the companion closes); side by side, the companion stays", async () => {
    await mount(start(chat("s", doc("d")), chat("t")));
    seen.covered.add(tabOf("session:s")!.id);
    await act(async () => { desk.conversation("a", chat("s")); });
    await settle();
    expect(active().sessionId).toBe("s");
    expect(active().view).toEqual({ kind: "work" });
    cleanup();
    seen.covered.clear();
    await mount(start(chat("s", doc("d")), chat("t")));
    await act(async () => { desk.conversation("a", chat("s")); });
    await settle();
    expect(active().view).toEqual({ kind: "work", beside: doc("d") });
  });
});

it("every navigation tells the app a choice was made (the start-up restore keeps it)", async () => {
  await mount(start(chat("s"), chat("t")));
  expect(seen.navigated).toBe(0);
  await act(async () => { desk.show("a", chat("s")); });
  expect(seen.navigated).toBe(1);
});
