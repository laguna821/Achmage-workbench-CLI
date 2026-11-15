import { describe, expect, it } from "vitest";
import { activeTab, activateTab, closeTab, dropTabs, findTab, lastTabOf, moveTab, offScope, tabsOf, updateTabView, withTabs } from "./tabs.ts";
import { closePane, focusPane, focusedPane, restoreLayout, setPane, singleLayout, splitPane } from "./panes.ts";

type View = { kind: "work" } | { kind: "document"; artifactId: string } | { kind: "new" } | { kind: "terminal"; terminalId: string; label: string };
const home = { view: { kind: "new" } as View, workId: null, sessionId: null };
const document = (id: string) => ({ view: { kind: "document", artifactId: id } as View, workId: "project", sessionId: null });
const open = (layout: ReturnType<typeof singleLayout<View>>, id: string) => withTabs(setPane(layout, layout.focus, document(id)), layout);

describe("group tabs", () => {
  it("keeps in-tab vault navigation in its own tab even when the destination is already open", () => {
    const first = { kind: "pkm", target: { kind: "note", path: "Inbox/first.md" } };
    const second = { kind: "pkm", target: { kind: "note", path: "Inbox/second.md" } };
    const initial = withTabs(singleLayout(first, null));
    const other = withTabs(setPane(initial, initial.focus, { view: second }), initial);
    const browserId = activeTab(focusedPane(other)).id;
    const changed = withTabs(updateTabView(other, browserId, () => first), other);
    expect(activeTab(focusedPane(changed)).id).toBe(browserId);
    expect(tabsOf(focusedPane(changed))).toHaveLength(2);
  });
  it("retains terminal identity and scroll position through title changes, splits and restored layouts", () => {
    const content = { view: { kind: "terminal", terminalId: "pty-one", label: "셸" } as View, workId: "project", sessionId: null };
    const original = withTabs(singleLayout(content.view, content.workId));
    const tab = activeTab(original.panes[0]!); tab.ui = { terminalScroll: { line: 150, follow: false } };
    const renamed = withTabs(setPane(original, "a", { ...content, view: { kind: "terminal", terminalId: "pty-one", label: "작업 로그" } }), original);
    expect(activeTab(renamed.panes[0]!).id).toBe(tab.id);
    const divided = withTabs(splitPane(renamed, "a", "right", home, null), renamed);
    const moved = moveTab(divided, tab.id, { paneId: divided.focus, side: "center" });
    const valid = (value: unknown): value is View => !!value && typeof value === "object" && "kind" in value;
    const restored = restoreLayout(JSON.parse(JSON.stringify({ version: 2, ...moved })), valid, original);
    expect(findTab(restored, "terminal:pty-one")?.tab).toMatchObject({ id: tab.id, ui: { terminalScroll: { line: 150, follow: false } } });
  });
  it("keeps a generic conversation's tab and attachments identity while focus moves to a document", () => {
    const start = withTabs(singleLayout<View>({ kind: "work" }, "project"));
    const firstId = activeTab(start.panes[0]!).id;
    const divided = withTabs(splitPane(start, "a", "right", { ...document("source"), sessionId: "session-one" }, "session-one"), start);
    const left = withTabs(focusPane(divided, "a", "session-one"), divided);
    const back = withTabs(focusPane(left, divided.focus, "session-one"), left);
    expect(back.panes[0]!.activeTabId).toBe(firstId);
    expect(back.panes[0]!.tabs).toHaveLength(1);
    expect(back.panes[0]!.sessionId).toBeNull();
    expect(back.panes[1]!.sessionId).toBe("session-one");
    const closed = withTabs(closePane(back, "a"), back);
    expect(closed.panes[0]!.sessionId).toBe("session-one");
  });
  it("keeps stable entity IDs and MRU when changing active documents", () => {
    const initial = withTabs(singleLayout<View>(home.view, null));
    const a = open(initial, "a"), aid = activeTab(focusedPane(a)).id;
    const b = open(a, "b"), bid = activeTab(focusedPane(b)).id;
    const again = open(b, "a");
    expect(activeTab(focusedPane(again)).id).toBe(aid);
    expect(tabsOf(focusedPane(again))).toHaveLength(3);
    const closed = closeTab(again, again.focus, aid, home);
    expect(activeTab(focusedPane(closed)).id).toBe(bid);
    expect(findTab(closed, "doc:a")).toBeNull();
  });
  it("moves just one tab to a new split and retains its cursor and original siblings", () => {
    const a = open(withTabs(singleLayout<View>(home.view, null)), "a");
    const b = open(a, "b"), tab = activeTab(focusedPane(b));
    tab.ui = { cursor: { anchor: 12, head: 18 }, scroll: { top: 150, left: 0 } };
    const moved = withTabs(moveTab(b, tab.id, { paneId: b.focus, side: "bottom" }), b);
    expect(moved.panes).toHaveLength(2);
    expect(findTab(moved, "doc:a")!.pane.id).toBe(b.focus);
    expect(activeTab(focusedPane(moved))).toEqual(tab);
    expect(moved.panes.flatMap(tabsOf).filter((entry) => entry.id === tab.id)).toHaveLength(1);
    const back = moveTab(moved, tab.id, { paneId: b.focus, side: "center" }, 0);
    expect(back.panes).toHaveLength(1);
    expect(tabsOf(focusedPane(back))[0]!.id).toBe(tab.id);
    expect(activeTab(focusedPane(back)).id).toBe(tab.id);
  });
  it("closing or moving a tab does not mutate source state or other sessions", () => {
    const start = withTabs({ ...singleLayout<View>({ kind: "work" }, "project"), panes: [{ id: "a", view: { kind: "work" }, workId: "project", sessionId: "session-one" }] });
    const next = withTabs(setPane(start, "a", { sessionId: "session-two" }), start);
    const original = JSON.stringify(next);
    const selected = activateTab(next, "a", tabsOf(next.panes[0]!)[0]!.id);
    const moved = moveTab(selected, activeTab(selected.panes[0]!).id, { paneId: "a", side: "right" });
    expect(JSON.stringify(next)).toBe(original);
    expect(moved.panes.flatMap(tabsOf).map((tab) => tab.sessionId).sort()).toEqual(["session-one", "session-two"]);
  });
  it("migrates legacy panes and restores v2 tab order, active/MRU and UI state", () => {
    const fallback = singleLayout<View>(home.view, null);
    const initial = withTabs(splitPane(fallback, "a", "bottom", document("a"), null));
    const layout = open(initial, "b");
    const valid = (view: unknown): view is View => !!view && typeof view === "object" && "kind" in view;
    const restored = restoreLayout({ version: 2, ...layout }, valid, fallback);
    expect(restored).toEqual(layout);
    const corrupt = JSON.parse(JSON.stringify({ version: 2, ...layout }));
    corrupt.panes[1].tabs[0].id = corrupt.panes[0].tabs[0].id;
    // Skin 2 · B: the repeated tab is skipped; every other tab (and its pane) stays.
    const tolerant = restoreLayout(corrupt, valid, fallback);
    expect(tolerant.panes.flatMap(tabsOf).map((tab) => tab.id)).toEqual(layout.panes.flatMap(tabsOf).map((tab) => tab.id).filter((id) => id !== layout.panes[1]!.tabs![0]!.id));
    const closed = closeTab(layout, layout.focus, activeTab(focusedPane(layout)).id, home);
    expect(tabsOf(focusedPane(closed)).length).toBeGreaterThan(0);
  });
});

describe("a document taken out of its project", () => {
  it("closes its document tabs and leaves the other tabs as they were", () => {
    const first = open(singleLayout<View>(home.view, null), "kept");
    const both = open(first, "gone");
    const dropped = dropTabs(both, (view) => (view.kind === "document" && view.artifactId === "gone" ? "close" : null), home);
    expect(tabsOf(focusedPane(dropped)).map((tab) => (tab.view as { artifactId?: string }).artifactId)).toEqual(["kept"]);
    expect(dropTabs(both, () => null, home)).toBe(both);
  });
  it("gives a tab another view when asked (a conversation beside the document stays)", () => {
    const layout = open(singleLayout<View>(home.view, null), "gone");
    const changed = dropTabs(layout, (view) => (view.kind === "document" ? ({ kind: "work" } as View) : null), home);
    expect(activeTab(focusedPane(changed)).view).toEqual({ kind: "work" });
  });
});

// N1, the owner's navigation: one tab per item, closing a tab stops nothing, and choosing a project
// brings back the tab it was last looked at in (per-project restore), while other projects' tabs stay open.
describe("tabs and projects (N1)", () => {
  const conversation = (id: string, workId: string) => ({ view: { kind: "work" } as View, workId, sessionId: id });
  const go = (layout: ReturnType<typeof singleLayout<View>>, content: ReturnType<typeof conversation>) => withTabs(setPane(layout, layout.focus, content), layout);

  it("an item opens in one tab by its stable id: going to it again goes to that tab", () => {
    let layout = withTabs(singleLayout<View>({ kind: "new" }, null));
    layout = go(layout, conversation("s1", "A"));
    layout = go(layout, conversation("s2", "A"));
    const first = findTab(layout, "session:s1")!.tab.id;
    layout = go(layout, conversation("s1", "A"));
    expect(tabsOf(focusedPane(layout)).filter((tab) => tab.sessionId === "s1")).toHaveLength(1);
    expect(activeTab(focusedPane(layout)).id).toBe(first);
  });

  it("closing a tab removes the view only: the item's session, its project and the other tabs stay", () => {
    let layout = withTabs(singleLayout<View>({ kind: "new" }, null));
    layout = go(layout, conversation("running", "A"));
    layout = go(layout, conversation("other", "A"));
    const before = JSON.stringify(tabsOf(focusedPane(layout)).filter((tab) => tab.sessionId !== "running"));
    const closed = closeTab(layout, layout.focus, findTab(layout, "session:running")!.tab.id, home);
    expect(findTab(closed, "session:running")).toBeNull();
    expect(JSON.stringify(tabsOf(focusedPane(closed)).filter((tab) => tab.sessionId !== "running"))).toBe(before);
    // Nothing in a tab carries a stop: the layout holds views only (the session is the gateway's).
    expect(Object.keys(activeTab(focusedPane(closed))).sort()).toEqual(["id", "sessionId", "view", "workId"]);
  });

  it("a project chosen again comes back to the tab it was last looked at in, not its first one", () => {
    let layout = withTabs(singleLayout<View>({ kind: "new" }, null));
    layout = go(layout, conversation("a1", "A"));
    layout = go(layout, conversation("a2", "A"));
    layout = go(layout, conversation("b1", "B"));
    // A's tabs are a1 then a2; a2 was looked at last.
    expect(lastTabOf(layout, "A")!.tab.sessionId).toBe("a2");
    layout = go(layout, conversation("a1", "A"));
    layout = go(layout, conversation("b1", "B"));
    expect(lastTabOf(layout, "A")!.tab.sessionId).toBe("a1");
    expect(lastTabOf(layout, "B")!.tab.sessionId).toBe("b1");
    expect(lastTabOf(layout, "C")).toBeNull();
  });

  it("home and the archive are no project's tab, though they carry the last project's id", () => {
    let layout = withTabs(singleLayout<View>({ kind: "new" }, "A"));
    expect(lastTabOf(layout, "A")).toBeNull();
    layout = go(layout, conversation("b1", "B"));
    // Project tabs (2026-11-15): home is no project's, so it is not on a project's strip either (one list away).
    expect(offScope(focusedPane(layout), "B")).toEqual([findTab(layout, JSON.stringify({ kind: "new" }))!.tab.id]);
  });

  it("prefers the focused pane, then another pane (a project open beside)", () => {
    let layout = withTabs(singleLayout<View>({ kind: "new" }, null));
    layout = go(layout, conversation("a1", "A"));
    layout = withTabs(splitPane(layout, layout.focus, "right", conversation("b1", "B"), null), layout);
    expect(lastTabOf(layout, "A")!.pane.id).not.toBe(layout.focus);
    expect(lastTabOf(layout, "B")!.pane.id).toBe(layout.focus);
  });

  it("the strip leaves out everything that is not the project's (open and running, one list away); all shows them", () => {
    let layout = withTabs(singleLayout<View>({ kind: "new" }, null));
    layout = go(layout, conversation("a1", "A"));
    layout = go(layout, conversation("b1", "B"));
    const pane = focusedPane(layout);
    const a1 = findTab(layout, "session:a1")!.tab.id;
    const homeTab = findTab(layout, JSON.stringify({ kind: "new" }))!.tab.id, b1 = findTab(layout, "session:b1")!.tab.id;
    expect(offScope(pane, "B")).toEqual([homeTab, a1]);
    // Project tabs (2026-11-15): the strip is the window's project only — a tab of another project is off it
    // even where it is the pane's tab on screen (the panes follow the window's project: tabs.ts followScope).
    expect(offScope(pane, "A")).toEqual([homeTab, b1]);
    expect(offScope(pane, "B", true)).toEqual([]);
    // No project chosen: no tab on the strip.
    expect(offScope(pane, null)).toEqual([homeTab, a1, b1]);
  });
});
