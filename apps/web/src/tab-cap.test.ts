import { afterEach, describe, expect, it } from "vitest";
import { MAX_TABS, activeTab, setTabKeeper, storedTabs, tabsOf, withTabs } from "./tabs.ts";
import { focusedPane, setPane, singleLayout, splitPane, type Layout, type PaneTab } from "./panes.ts";

// Skin 2 · B, item 3: 128 tabs are shared by every project. Opening one more never throws at the
// person: the least recently used tab of ANOTHER project steps back — not one with unsaved edits, not
// a live web page, never a tab on screen. Closing a tab stops nothing; its row stays in its list.

type View = { kind: "document"; artifactId: string } | { kind: "browser"; pageId: string } | { kind: "new" };
const doc = (id: string, workId: string) => ({ view: { kind: "document", artifactId: id } as View, workId, sessionId: null });
const page = (id: string, workId: string) => ({ view: { kind: "browser", pageId: id } as View, workId, sessionId: null });
const open = (layout: Layout<View>, content: ReturnType<typeof doc>) => withTabs(setPane(layout, layout.focus, content), layout);
const keys = (layout: Layout<View>) => layout.panes.flatMap(tabsOf).map((tab) => (tab.view.kind === "document" ? tab.view.artifactId : tab.view.kind === "browser" ? `web:${tab.view.pageId}` : "new"));
afterEach(() => setTabKeeper(null));

/** 128 tabs: the first `others` of project B (opened first, so least recently used), the rest of project A. */
function full(others: (index: number) => ReturnType<typeof doc> = (index) => doc(`b${index}`, "project-b"), count = 8) {
  let layout = withTabs(singleLayout<View>(doc("b0", "project-b").view, "project-b"));
  for (let index = 1; index < count; index++) layout = open(layout, others(index));
  for (let index = count; layout.panes.flatMap(tabsOf).length < MAX_TABS; index++) layout = open(layout, doc(`a${index}`, "project-a"));
  return layout;
}

describe("the shared tab cap", () => {
  it("opening the 129th tab does not throw: the least recently used tab of another project steps back", () => {
    const layout = full();
    expect(layout.panes.flatMap(tabsOf)).toHaveLength(MAX_TABS);
    const next = open(layout, doc("a-new", "project-a"));
    expect(next.panes.flatMap(tabsOf)).toHaveLength(MAX_TABS);
    expect(keys(next)).not.toContain("b0");
    expect(keys(next)).toContain("b1");
    expect(activeTab(focusedPane(next)).view).toEqual({ kind: "document", artifactId: "a-new" });
  });
  it("never steps back a tab of the project being opened while another project has one", () => {
    const next = open(full(), doc("a-new", "project-a"));
    expect(keys(next).filter((key) => key.startsWith("a"))).toHaveLength(MAX_TABS - 8 + 1);
  });
  it("skips tabs with unsaved edits and live web pages (the keeper says so)", () => {
    const layout = full((index) => (index === 1 ? page("p1", "project-b") : doc(`b${index}`, "project-b")));
    setTabKeeper((tab: PaneTab<unknown>) => (tab.view as View).kind === "document" && (tab.view as { artifactId: string }).artifactId === "b0");
    const next = open(layout, doc("a-new", "project-a"));
    expect(keys(next)).toContain("b0");
    expect(keys(next)).toContain("web:p1");
    expect(keys(next)).not.toContain("b2");
  });
  it("a web page is kept even without a keeper", () => {
    const layout = full((index) => page(`p${index}`, "project-b"), 2);
    const next = open(layout, doc("a-new", "project-a"));
    expect(keys(next)).toContain("web:p1");
    expect(keys(next)).not.toContain("b0");
  });
  it("never steps back the tab on screen in another pane; with nothing else to step back the open still happens", () => {
    let layout = full(undefined, 2);
    layout = withTabs(splitPane(layout, layout.focus, "right", doc("b-shown", "project-b"), null), layout);
    // Every tab of B except the one shown on the right is kept (unsaved); A's own tabs are this project's.
    setTabKeeper((tab: PaneTab<unknown>) => (tab.view as View).kind === "document" && (tab.view as { artifactId: string }).artifactId !== "b-shown" && tab.workId === "project-b");
    const left = layout.panes.find((pane) => pane.id !== layout.focus)!;
    const focused = { ...layout, focus: left.id };
    const next = open(focused, doc("a-new", "project-a"));
    expect(keys(next)).toContain("b-shown");
    // Last resort: the oldest tab of the same project that is not on screen (never a throw).
    expect(keys(next)).toContain("a-new");
    expect(next.panes.flatMap(tabsOf).length).toBeLessThanOrEqual(MAX_TABS);
  });
});

// Technical review M11: when nothing could step back (live web pages, unsaved edits) the window kept more
// than 128 tabs and the gateway cut the record silently past 128 — the window showed tabs the record no
// longer had, until reload. At write time the window now decides what is stored (128, the gateway keeps
// all of it: they agree) and says how many will not come back next time.
describe("the record written agrees with the gateway's 128", () => {
  it("leaves the oldest tabs out of the record (another project's first, never a tab on screen) and counts them", () => {
    const layout = full((index) => page(`p${index}`, "project-b"), 4);
    // Four live web pages of B and 124 documents of A, every one with unsaved edits: nothing can step back.
    setTabKeeper(() => true);
    const over = open(open(layout, page("pa1", "project-a")), page("pa2", "project-a"));
    expect(over.panes.flatMap(tabsOf).length).toBeGreaterThan(MAX_TABS);
    const { layout: stored, left } = storedTabs(over, "project-a");
    expect(stored.panes.flatMap(tabsOf)).toHaveLength(MAX_TABS);
    expect(left).toBe(over.panes.flatMap(tabsOf).length - MAX_TABS);
    expect(keys(stored)).not.toContain("web:p0");
    expect(keys(stored)).toContain("web:pa2");
    expect(activeTab(focusedPane(stored)).id).toBe(activeTab(focusedPane(over)).id);
    // Within the cap the record is the layout itself.
    expect(storedTabs(layout, "project-a")).toEqual({ layout, left: 0, keptUnsaved: 0, unsavedLeft: 0 });
  });

  // Tech review 4 (MINOR): past 128 a tab with unsaved edits is never the one left out; the notice says so.
  it("never leaves a tab with unsaved edits out of the record while another could go, and counts the unsaved it kept", () => {
    const layout = full((index) => page(`p${index}`, "project-b"), 4);
    // Every document has unsaved edits; the live web pages are what may be left out of the record.
    setTabKeeper((tab) => (tab.view as { kind?: string }).kind === "document");
    const over = open(open(layout, page("pa1", "project-a")), page("pa2", "project-a"));
    expect(over.panes.flatMap(tabsOf).length).toBeGreaterThan(MAX_TABS);
    const { layout: stored, left, keptUnsaved } = storedTabs(over, "project-a");
    expect(stored.panes.flatMap(tabsOf)).toHaveLength(MAX_TABS);
    expect(left).toBe(over.panes.flatMap(tabsOf).length - MAX_TABS);
    const unsaved = keys(over).filter((key) => !key.startsWith("web:"));
    for (const key of unsaved) expect(keys(stored), key).toContain(key);
    expect(keptUnsaved).toBe(unsaved.length);
    expect(storedTabs(over, "project-a").unsavedLeft).toBe(0);
  });
});
