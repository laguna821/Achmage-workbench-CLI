import { describe, expect, it } from "vitest";
import { activeTab, activateTab, closeTab, findTab, moveTab, tabsOf, withTabs } from "./tabs.ts";
import { focusedPane, restoreLayout, setPane, singleLayout, splitPane } from "./panes.ts";

type View = { kind: "work" } | { kind: "document"; artifactId: string } | { kind: "new" };
const home = { view: { kind: "new" } as View, workId: null, sessionId: null };
const document = (id: string) => ({ view: { kind: "document", artifactId: id } as View, workId: "project", sessionId: null });
const open = (layout: ReturnType<typeof singleLayout<View>>, id: string) => withTabs(setPane(layout, layout.focus, document(id)), layout);

describe("group tabs", () => {
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
    expect(restoreLayout(corrupt, valid, fallback)).toBe(fallback);
    const closed = closeTab(layout, layout.focus, activeTab(focusedPane(layout)).id, home);
    expect(tabsOf(focusedPane(closed)).length).toBeGreaterThan(0);
  });
});
