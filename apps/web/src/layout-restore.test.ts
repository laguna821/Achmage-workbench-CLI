import { describe, expect, it } from "vitest";
import { leafIds, readLayout, restoreLayout, singleLayout, type Layout, type PaneTab } from "./panes.ts";

// Skin 2 · B, item 1: a stored layout with one bad tab keeps every other tab of every project. Before,
// one unknown view kind or bad id dropped EVERY tab to the default (panes.ts restoreLayout).

type View = { kind: "work" } | { kind: "document"; artifactId: string } | { kind: "new" };
const KINDS = ["work", "document", "new"];
const isView = (value: unknown): value is View => !!value && typeof value === "object" && KINDS.includes((value as { kind?: string }).kind ?? "");
const fallback = singleLayout<View>({ kind: "new" }, null);
const tab = (id: string, view: unknown, workId: string | null = "project-a", sessionId: string | null = null) => ({ id, view, workId, sessionId });
const doc = (id: string, workId = "project-a") => tab(`tab-${id}`, { kind: "document", artifactId: id }, workId);
const pane = (id: string, tabs: ReturnType<typeof tab>[], activeTabId = tabs[0]!.id) => ({ ...tabs[0]!, id, tabs, activeTabId, recentTabIds: tabs.map((entry) => entry.id) });
const stored = (panes: ReturnType<typeof pane>[], extra: Record<string, unknown> = {}) => ({ version: 2, focus: panes[0]!.id, panes,
  tree: panes.length === 2 ? { kind: "split", id: "s1", axis: "horizontal", ratio: 0.4, first: { kind: "pane", id: panes[0]!.id }, second: { kind: "pane", id: panes[1]!.id } } : { kind: "pane", id: panes[0]!.id }, ...extra });
const ids = (layout: Layout<View>) => layout.panes.flatMap((entry) => (entry.tabs ?? []).map((item) => item.id));

describe("restore skips the bad tab, not the layout", () => {
  it("a tab with an unknown view kind is skipped and parked; every other project's tabs stay", () => {
    const raw = stored([pane("a", [doc("one"), tab("tab-future", { kind: "timeline", day: 3 }, "project-b"), doc("two", "project-b")], "tab-future"), pane("b", [doc("three", "project-c")])]);
    const read = readLayout(JSON.parse(JSON.stringify(raw)), isView, fallback);
    expect(read.layout).not.toBe(fallback);
    expect(ids(read.layout)).toEqual(["tab-one", "tab-two", "tab-three"]);
    expect(read.skipped).toBe(1);
    // Nothing lost on disk: the unreadable tab is kept for the record, as it was.
    expect(read.parked).toEqual([{ paneId: "a", tab: raw.panes[0]!.tabs[1] }]);
    // Its pane falls back to its first readable tab; the split keeps its ratio.
    expect(read.layout.panes[0]!.activeTabId).toBe("tab-one");
    expect(read.layout.tree).toMatchObject({ kind: "split", ratio: 0.4 });
  });
  it("a parked tab comes back once a window can read it", () => {
    const raw = stored([pane("a", [doc("one")])], { parked: [{ paneId: "a", tab: doc("back") }, { paneId: "a", tab: tab("tab-later", { kind: "timeline" }) }] });
    const read = readLayout(raw, isView, fallback);
    expect(ids(read.layout)).toEqual(["tab-one", "tab-back"]);
    expect(read.parked.map((entry) => entry.tab.id)).toEqual(["tab-later"]);
    expect(read.skipped).toBe(0);
  });
  it("a repeated id and a bad id are skipped (counted); a pane left empty folds away with its split", () => {
    const raw = stored([pane("a", [doc("one"), tab("bad id/", { kind: "new" })]), pane("b", [doc("one")])]);
    const read = readLayout(raw, isView, fallback);
    expect(ids(read.layout)).toEqual(["tab-one"]);
    expect(read.skipped).toBe(2);
    expect(read.parked).toEqual([]);
    expect(read.layout.panes.map((entry) => entry.id)).toEqual(["a"]);
    expect(leafIds(read.layout.tree!)).toEqual(["a"]);
    expect(read.layout.focus).toBe("a");
  });
  it("a tab whose item was removed is skipped through `keep`; the rest stays", () => {
    const raw = stored([pane("a", [doc("gone"), doc("kept"), tab("tab-chat", { kind: "work" }, "project-a", "session-1")], "tab-gone")]);
    const read = readLayout(raw, isView, fallback, (entry: PaneTab<View>) => !(entry.view.kind === "document" && entry.view.artifactId === "gone"));
    expect(ids(read.layout)).toEqual(["tab-kept", "tab-chat"]);
    expect(read.skipped).toBe(1);
    expect(read.layout.panes[0]!.activeTabId).toBe("tab-kept");
  });
  it("only a record with nothing readable falls back (and says how many it skipped)", () => {
    const read = readLayout(stored([pane("a", [tab("tab-x", { kind: "timeline" })])]), isView, fallback);
    expect(read.layout).toBe(fallback);
    expect(read.skipped).toBe(1);
    expect(restoreLayout({ version: 9, panes: [] }, isView, fallback)).toBe(fallback);
  });
});
