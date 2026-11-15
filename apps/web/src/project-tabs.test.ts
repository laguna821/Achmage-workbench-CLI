import { describe, expect, it } from "vitest";
import { settleLayout } from "./companion-desk.ts";
import { readWorkspaceLayout } from "@workbench/contracts";
import { applyDrawnPreset } from "./layout-presets.ts";
import { closePane, focusedPane, leafIds, paneById, restoreLayout, setPane, singleLayout, splitPane, treeOf, type Layout, type PaneContent } from "./panes.ts";
import { activeTab, activateTab, closeTab, drawnLayout, findTab, followScope, lastTabOf, offScope, projectOfTab, scopeOf, stripScopes, tabsOf, contentKey } from "./tabs.ts";

// Project tabs (2026-11-15, the owner: "프로젝트 한개 = 하나의 md … 프로젝트를 선택하면 그 프로젝트 안에서
// 여러개 띄워놓은 탭들이 위에 놓여있고 … 프로젝트 선택을 풀면 탭들이 안보이게"). ONE layout holds every
// project's tabs; the window has ONE project (the focused tab's, or none), and the panes follow it.

type View = { kind: "work" } | { kind: "document"; artifactId: string } | { kind: "new"; project?: string } | { kind: "archive" } | { kind: "project"; workId: string };
type L = Layout<View>;
const HOME: PaneContent<View> = { view: { kind: "new" }, workId: null, sessionId: null };
const chat = (id: string, workId: string): PaneContent<View> => ({ view: { kind: "work" }, workId, sessionId: id });
const doc = (id: string, workId: string): PaneContent<View> => ({ view: { kind: "document", artifactId: id }, workId, sessionId: null });

// The app's own steps (App.tsx `updateLayout`, the desk's `show`, `chooseProject`, `closeTabNow`), settled as the app settles them.
const settle = (changed: L, previous: L, all = false) => settleLayout(changed, previous, { home: HOME, all });
const open = (layout: L, content: PaneContent<View>, all = false): L => {
  const target = findTab(layout, contentKey(content))?.pane.id ?? layout.focus;
  return settle({ ...setPane(layout, target, content), focus: target }, layout, all);
};
const choose = (layout: L, workId: string): L => {
  const found = lastTabOf(layout, workId);
  return found ? settle(activateTab(layout, found.pane.id, found.tab.id), layout) : open(layout, { view: { kind: "project", workId }, workId, sessionId: null });
};
const close = (layout: L, key: string, all = false): L => {
  const found = findTab(layout, key)!;
  return settle(closeTab(layout, found.pane.id, found.tab.id, HOME), layout, all);
};
const start = () => settle(singleLayout<View>({ kind: "new" }, null), singleLayout<View>({ kind: "new" }, null));
const shown = (layout: L) => Object.fromEntries(layout.panes.map((pane) => [pane.id, contentKey(activeTab(pane))]));
const order = (layout: L) => layout.panes.map((pane) => `${pane.id}:${tabsOf(pane).map(contentKey).join(",")}`).join(" | ");
const drawn = (layout: L, all = false) => drawnLayout(layout, all).panes.map((pane) => pane.id);

/** Pane a: home, A's two conversations, B's conversation. A pane beside it: A's document, B's document. */
function twoProjectsSplit() {
  let layout = start();
  layout = open(layout, chat("a1", "A"));
  layout = open(layout, chat("a2", "A"));
  const left = layout.focus;
  layout = settle(splitPane(layout, left, "right", doc("docA", "A"), null), layout);
  const right = layout.focus;
  layout = open(layout, doc("docB", "B"));
  layout = settle({ ...layout, focus: left }, layout);
  layout = open(layout, chat("b1", "B"));
  return { layout, left, right };
}

describe("the window's project", () => {
  it("is the focused tab's project; home and the archive are no project", () => {
    let layout = start();
    expect(scopeOf(layout)).toBeNull();
    layout = open(layout, chat("a1", "A"));
    expect(scopeOf(layout)).toBe("A");
    layout = open(layout, { view: { kind: "archive" }, workId: "A", sessionId: null });
    expect(scopeOf(layout)).toBeNull();
    layout = open(layout, { ...HOME, workId: "A" });
    expect(scopeOf(layout)).toBeNull();
  });
});

describe("rule 1: every pane shows a tab of the window's project", () => {
  it("a pane whose tab is another project's activates its own most recent tab of the project", () => {
    const { layout, left, right } = twoProjectsSplit();
    // B was just opened in the left pane: the right pane follows to B's document.
    expect(scopeOf(layout)).toBe("B");
    expect(shown(layout)).toEqual({ [left]: "session:b1", [right]: "doc:docB" });
    const inA = choose(layout, "A");
    expect(shown(inA)).toEqual({ [left]: "session:a2", [right]: "doc:docA" });
    expect(drawn(inA)).toEqual([left, right]);
  });

  it("a pane with no tab of the project is not drawn, and stays in the layout as it was", () => {
    let { layout, left, right } = twoProjectsSplit();
    // C lives in the left pane only.
    layout = open(layout, chat("c1", "C"));
    expect(drawn(layout)).toEqual([left]);
    const view = drawnLayout(layout);
    expect(leafIds(treeOf(view))).toEqual([left]);
    // The layout itself keeps the pane, its tabs, its tab on screen and the split.
    expect(layout.panes.map((pane) => pane.id)).toEqual([left, right]);
    expect(leafIds(treeOf(layout))).toEqual([left, right]);
    expect(shown(layout)[right]).toBe("doc:docB");
    expect(tabsOf(paneById(layout, right)!).map(contentKey)).toEqual(["doc:docA", "doc:docB"]);
    // Back in B the same split is there.
    expect(drawn(choose(layout, "B"))).toEqual([left, right]);
  });

  it("the room of a pane not drawn goes to its neighbours: its split closes in the drawn tree only", () => {
    let layout = start();
    layout = open(layout, chat("a1", "A"));
    const first = layout.focus;
    layout = settle(splitPane(layout, first, "right", doc("docA", "A"), null), layout);
    const second = layout.focus;
    layout = settle(splitPane(layout, second, "bottom", doc("docB", "B"), null), layout);
    const third = layout.focus;
    // B's document is alone in its pane: in B only that pane is drawn.
    expect(drawn(layout)).toEqual([third]);
    const inA = choose(layout, "A");
    const tree = treeOf(drawnLayout(inA));
    expect(leafIds(tree)).toEqual([first, second]);
    expect(tree.kind === "split" && tree.second.kind).toBe("pane");
    expect(leafIds(treeOf(inA))).toEqual([first, second, third]);
  });

  it("all (모든 프로젝트의 탭 보기): nothing is hidden and no pane is made to follow", () => {
    const { layout, left, right } = twoProjectsSplit();
    const mixed = settle(activateTab(layout, left, findTab(layout, "session:a1")!.tab.id), layout, true);
    expect(shown(mixed)).toEqual({ [left]: "session:a1", [right]: "doc:docB" });
    expect(followScope(mixed, true)).toBe(mixed);
    expect(drawnLayout(mixed, true)).toBe(mixed);
    expect(drawn(mixed, true)).toEqual([left, right]);
  });
});

describe("rule 2: no project chosen", () => {
  it("only the panes whose tab is no project's are drawn; the others keep their tab", () => {
    const { layout, left, right } = twoProjectsSplit();
    const atHome = open(layout, HOME);
    expect(scopeOf(atHome)).toBeNull();
    expect(drawn(atHome)).toEqual([left]);
    expect(shown(atHome)).toEqual({ [left]: contentKey(HOME), [right]: "doc:docB" });
  });

  it("the strips show no tab at all", () => {
    const atHome = open(twoProjectsSplit().layout, HOME);
    for (const pane of atHome.panes) expect(offScope(pane, null).sort()).toEqual(tabsOf(pane).map((tab) => tab.id).sort());
    expect(Object.values(stripScopes(atHome, "B", false))).toEqual(atHome.panes.map(() => ({ workId: null, named: false })));
  });
});

describe("rule 3: switching is exact", () => {
  it("1 → 2 → home → 1: the tabs, their order, the tab on screen in each pane and the split are as they were left", () => {
    const { layout, left, right } = twoProjectsSplit();
    let one = choose(layout, "A");
    // In A: the first conversation on the left (not the last one opened), A's document on the right.
    one = settle(activateTab(one, left, findTab(one, "session:a1")!.tab.id), one);
    const before = { shown: shown(one), order: order(one), tree: JSON.stringify(treeOf(one)) };
    const two = choose(one, "B");
    expect(shown(two)).toEqual({ [left]: "session:b1", [right]: "doc:docB" });
    const atHome = open(two, HOME);
    expect(drawn(atHome)).toEqual([left]);
    const back = choose(atHome, "A");
    expect({ shown: shown(back), order: order(back), tree: JSON.stringify(treeOf(back)) }).toEqual(before);
    expect(drawn(back)).toEqual([left, right]);
  });

  it("a project with nothing open opens its project note (today's chooseProject)", () => {
    const { layout } = twoProjectsSplit();
    const fresh = choose(layout, "Z");
    expect(contentKey(activeTab(focusedPane(fresh)))).toBe("project:Z");
    expect(drawn(fresh)).toEqual([fresh.focus]);
  });
});

describe("the strip (rules 1, 2, 7)", () => {
  it("leaves out everything that is not the project's: other projects' tabs, home, the archive", () => {
    const { layout, left } = twoProjectsSplit();
    const pane = paneById(choose(layout, "A"), left)!;
    const off = offScope(pane, "A");
    expect(tabsOf(pane).filter((tab) => !off.includes(tab.id)).map(contentKey)).toEqual(["session:a1", "session:a2"]);
    expect(offScope(pane, "A", true)).toEqual([]);
  });

  it("every pane's strip is the window's project; with all on, each pane's own as before", () => {
    const { layout, left, right } = twoProjectsSplit();
    expect(stripScopes(layout, "A", false)).toEqual({ [left]: { workId: "B", named: false }, [right]: { workId: "B", named: false } });
    const mixed = settle(activateTab(layout, left, findTab(layout, "session:a1")!.tab.id), layout, true);
    expect(stripScopes(mixed, "A", true)).toEqual({ [left]: { workId: "A", named: true }, [right]: { workId: "B", named: true } });
  });
});

describe("rule 5: closing never jumps into another project", () => {
  const single = () => {
    let layout = start();
    layout = open(layout, chat("a1", "A"));
    layout = open(layout, chat("b1", "B"));
    layout = open(layout, chat("a2", "A"));
    return layout;
  };

  it("the project's next tab comes forward, not the most recent tab of another project", () => {
    const closed = close(single(), "session:a2");
    expect(contentKey(activeTab(focusedPane(closed)))).toBe("session:a1");
  });

  it("the last tab of the project closed: the window goes home; the other project's tab stays open behind", () => {
    const closed = close(close(single(), "session:a2"), "session:a1");
    expect(scopeOf(closed)).toBeNull();
    expect(contentKey(activeTab(focusedPane(closed)))).toBe(contentKey(HOME));
    expect(findTab(closed, "session:b1")).not.toBeNull();
    // No second home tab was made.
    expect(tabsOf(focusedPane(closed)).filter((tab) => tab.view.kind === "new")).toHaveLength(1);
  });

  it("no home tab left to go to: one is opened", () => {
    let layout = single();
    layout = settle(closeTab(layout, layout.focus, findTab(layout, contentKey(HOME))!.tab.id, HOME), layout);
    const closed = close(close(layout, "session:a2"), "session:a1");
    expect(scopeOf(closed)).toBeNull();
    expect(contentKey(activeTab(focusedPane(closed)))).toBe(contentKey(HOME));
    expect(findTab(closed, "session:b1")).not.toBeNull();
  });

  it("another drawn pane has the project's tabs: the focus goes there", () => {
    const { layout, left, right } = twoProjectsSplit();
    const inA = choose(layout, "A");
    expect(inA.focus).toBe(left);
    const closed = close(close(inA, "session:a2"), "session:a1");
    expect(closed.focus).toBe(right);
    expect(scopeOf(closed)).toBe("A");
    expect(contentKey(activeTab(focusedPane(closed)))).toBe("doc:docA");
    // The pane left behind holds no tab of A any more: it is not drawn.
    expect(drawn(closed)).toEqual([right]);
  });

  it("a pane closed with its last tab, beside a pane of another project only: home, not that project", () => {
    let layout = start();
    layout = open(layout, chat("b1", "B"));
    layout = settle(closeTab(layout, layout.focus, findTab(layout, contentKey(HOME))!.tab.id, HOME), layout);
    const first = layout.focus;
    layout = settle(splitPane(layout, first, "right", chat("a1", "A"), null), layout);
    expect(drawn(layout)).toEqual([layout.focus]);
    const closed = close(layout, "session:a1");
    expect(closed.panes.map((pane) => pane.id)).toEqual([first]);
    expect(scopeOf(closed)).toBeNull();
    expect(findTab(closed, "session:b1")).not.toBeNull();
    // The same through 이 칸 닫기.
    const paneClosed = settle(closePane(layout, layout.focus), layout);
    expect(scopeOf(paneClosed)).toBeNull();
  });

  it("all on: closing takes the next recent tab whatever its project, as before", () => {
    const closed = close(single(), "session:a2", true);
    expect(contentKey(activeTab(focusedPane(closed)))).toBe("session:b1");
  });

  it("an item of another project opened, or a stored layout read, is not a close", () => {
    const layout = single();
    expect(scopeOf(open(layout, chat("b1", "B")))).toBe("B");
    // A stored record in which the tab on screen is gone and another project's tab is in front is taken as it is.
    const stored = activateTab(closeTab(layout, layout.focus, findTab(layout, "session:a2")!.tab.id, HOME), layout.focus, findTab(layout, "session:b1")!.tab.id);
    expect(scopeOf(settleLayout(stored, layout, { home: HOME, restored: true }))).toBe("B");
  });
});

describe("rule 6: opening switches the window to the item's project", () => {
  it("the other panes follow; a pane holding nothing of it steps out", () => {
    const { layout, left, right } = twoProjectsSplit();
    const inA = choose(layout, "A");
    // B's document is opened from the list while A is on screen: its tab is in the right pane.
    const opened = open(inA, doc("docB", "B"));
    expect(opened.focus).toBe(right);
    expect(shown(opened)).toEqual({ [left]: "session:b1", [right]: "doc:docB" });
    // An item of a project with no tab yet opens in the focused pane, alone.
    const other = open(inA, chat("d1", "D"));
    expect(drawn(other)).toEqual([left]);
  });
});

// ── An empty pane made INSIDE a project belongs to that project (coordinator, 2026-11-15) ──────────
// "오른쪽/아래로 분할", a 화면 배치 preset, or closing down to an empty pane while project P is on screen:
// the new empty tab's view carries `project: P`, so it is P's tab — the window stays in P, the empty
// pane is drawn beside P's panes, and it is not drawn in another project or at home. The rail's 지금
// stays a plain `new` view (no project chosen).
describe("an empty pane inside a project", () => {
  const emptyOf = (layout: L, paneId: string) => activeTab(paneById(layout, paneId)!);
  const split = (layout: L, side: "right" | "bottom" = "right") => settle(splitPane(layout, layout.focus, side, HOME, null), layout);
  const inProject = () => {
    let layout = start();
    layout = open(layout, chat("b1", "B"));
    layout = open(layout, chat("a1", "A"));
    return layout;
  };

  it("a split inside a project: the new empty tab is the project's, the window stays in it, both panes are drawn", () => {
    const before = inProject(), first = before.focus;
    const layout = split(before);
    const made = layout.focus;
    expect(made).not.toBe(first);
    expect(emptyOf(layout, made).view).toEqual({ kind: "new", project: "A" });
    expect(projectOfTab(emptyOf(layout, made))).toBe("A");
    expect(scopeOf(layout)).toBe("A");
    expect(drawn(layout)).toEqual([first, made]);
    // Its strip shows it as the project's tab.
    expect(offScope(paneById(layout, made)!, "A")).toEqual([]);
    // The first pane still shows the conversation, and its home tab is where it was.
    expect(contentKey(emptyOf(layout, first))).toBe("session:a1");
    expect(tabsOf(paneById(layout, first)!).map(contentKey)).toEqual([contentKey(HOME), "session:b1", "session:a1"]);
  });

  it("an item opened there replaces it", () => {
    const layout = split(inProject()), made = layout.focus;
    const opened = open(layout, doc("docA", "A"));
    expect(tabsOf(paneById(opened, made)!).map(contentKey)).toEqual(["doc:docA"]);
    expect(drawn(opened)).toEqual(layout.panes.map((pane) => pane.id));
  });

  it("in another project and at home it is not drawn; back in its project it is", () => {
    const layout = split(inProject()), made = layout.focus, first = layout.panes.find((pane) => pane.id !== made)!.id;
    const inB = choose(layout, "B");
    expect(drawn(inB)).toEqual([first]);
    const atHome = open(inB, HOME);
    expect(scopeOf(atHome)).toBeNull();
    expect(drawn(atHome)).toEqual([first]);
    // 지금 is the plain home view: no project on it.
    expect(activeTab(focusedPane(atHome)).view).toEqual({ kind: "new" });
    expect(drawn(choose(atHome, "A"))).toEqual([first, made]);
  });

  it("with no project chosen a split makes a plain home pane", () => {
    const layout = split(open(inProject(), HOME));
    expect(emptyOf(layout, layout.focus).view).toEqual({ kind: "new" });
    expect(scopeOf(layout)).toBeNull();
    expect(drawn(layout)).toHaveLength(2);
  });

  it("the rail's 지금 opened where no home tab is left is the plain home view, not the project's empty tab", () => {
    let layout = inProject();
    layout = settle(closeTab(layout, layout.focus, findTab(layout, contentKey(HOME))!.tab.id, HOME), layout);
    const atHome = open(layout, HOME);
    expect(activeTab(focusedPane(atHome)).view).toEqual({ kind: "new" });
    expect(scopeOf(atHome)).toBeNull();
  });

  it("지금 pressed while the project's empty pane has the focus: home there, no project chosen", () => {
    const layout = split(inProject()), made = layout.focus;
    // The app sets the focused pane's view to the plain home view (it carries the pane's workId).
    const atHome = settle({ ...setPane(layout, made, { ...HOME, workId: "A" }), focus: made }, layout);
    expect(tabsOf(paneById(atHome, made)!).map((tab) => tab.view)).toEqual([{ kind: "new" }]);
    expect(scopeOf(atHome)).toBeNull();
    expect(drawn(atHome)).toEqual([made]);
  });

  it("closing down to an empty pane inside a project leaves the project's empty pane", () => {
    let layout = settle(singleLayout<View>({ kind: "work" }, "A"), singleLayout<View>({ kind: "work" }, "A"));
    expect(scopeOf(layout)).toBe("A");
    layout = settle(closeTab(layout, layout.focus, activeTab(focusedPane(layout)).id, HOME), layout);
    expect(activeTab(focusedPane(layout)).view).toEqual({ kind: "new", project: "A" });
    expect(scopeOf(layout)).toBe("A");
  });

  it("closing the pane that holds the project's last tab still goes home", () => {
    const layout = split(inProject()), made = layout.focus, first = layout.panes.find((pane) => pane.id !== made)!.id;
    // The empty pane closed: the project's conversation is still there.
    const without = settle(closePane(layout, made), layout);
    expect(scopeOf(without)).toBe("A");
    // The conversation's tab closed, then the empty pane (the project's last tab): home.
    const emptied = settle(closeTab({ ...layout, focus: first }, first, findTab(layout, "session:a1")!.tab.id, HOME), { ...layout, focus: first });
    expect(scopeOf(emptied)).toBe("A");
    expect(emptied.focus).toBe(made);
    const gone = settle(closePane(emptied, made), emptied);
    expect(scopeOf(gone)).toBeNull();
    expect(findTab(gone, "session:b1")).not.toBeNull();
  });

  it("survives a restart: the stored record keeps the marker (the gateway's reading and the window's)", () => {
    const layout = split(inProject()), made = layout.focus;
    const stored = readWorkspaceLayout(JSON.parse(JSON.stringify({ version: 2, ...layout })))!.layout;
    const isView = (value: unknown): value is View => !!value && typeof value === "object" && "kind" in value;
    const read = restoreLayout(stored, isView, start());
    expect(emptyOf(read, made).view).toEqual({ kind: "new", project: "A" });
    expect(scopeOf(read)).toBe("A");
    expect(drawn(settleLayout(read, read, { home: HOME, restored: true }))).toEqual(drawn(layout));
  });

  it("its project deleted: it goes as the project's other tabs go, and nothing of that project is made again", () => {
    const layout = split(inProject());
    // The app closes every tab whose workId is the deleted project's: the empty tab carries it.
    const ofA = layout.panes.flatMap((pane) => tabsOf(pane).map((tab) => ({ pane, tab }))).filter((entry) => entry.tab.workId === "A");
    expect(ofA.map((entry) => contentKey(entry.tab)).sort()).toEqual([JSON.stringify({ kind: "new", project: "A" }), "session:a1"].sort());
    let closed = layout;
    for (const entry of ofA) closed = closeTab(closed, entry.pane.id, entry.tab.id, HOME);
    const after = settleLayout(closed, layout, { home: HOME, gone: "A" });
    expect(after.panes.flatMap(tabsOf).some((tab) => projectOfTab(tab) === "A")).toBe(false);
    expect(scopeOf(after)).toBeNull();
    // Even when the deleted project's tab was the only tab of the only pane.
    const only = settle(singleLayout<View>({ kind: "work" }, "A"), singleLayout<View>({ kind: "work" }, "A"));
    const emptied = settleLayout(closeTab(only, only.focus, activeTab(focusedPane(only)).id, HOME), only, { home: HOME, gone: "A" });
    expect(activeTab(focusedPane(emptied)).view).toEqual({ kind: "new" });
  });
});

describe("화면 배치 inside a project", () => {
  const preset = (layout: L, count: 1 | 2 | 4 | 9) => settle(applyDrawnPreset(layout, drawnLayout(layout), count, () => HOME), layout);
  /** Pane a: home, A's two conversations. A second pane holding only B's document (not drawn in A). */
  const project = () => {
    let layout = start();
    layout = open(layout, chat("a1", "A"));
    const first = layout.focus;
    layout = settle(splitPane(layout, first, "right", doc("docB", "B"), null), layout);
    const other = layout.focus;
    layout = settle({ ...layout, focus: first }, layout);
    layout = open(layout, chat("a2", "A"));
    expect(drawn(layout)).toEqual([first]);
    return { layout, first, other };
  };
  const empties = (layout: L) => layout.panes.filter((pane) => tabsOf(pane).length === 1 && JSON.stringify(activeTab(pane).view) === JSON.stringify({ kind: "new", project: "A" })).map((pane) => pane.id);

  it("2칸 shows two panes: the home tab stays where it is, the new pane is the project's empty pane", () => {
    const { layout, first, other } = project();
    const two = preset(layout, 2);
    expect(drawn(two)).toHaveLength(2);
    expect(scopeOf(two)).toBe("A");
    expect(tabsOf(paneById(two, first)!).map(contentKey)).toEqual([contentKey(HOME), "session:a1", "session:a2"]);
    expect(empties(two)).toEqual(drawn(two).filter((id) => id !== first));
    // The other project's pane keeps its tabs and its place in the layout; every id in the tree is its own.
    expect(tabsOf(paneById(two, other)!).map(contentKey)).toEqual(["doc:docB"]);
    expect(leafIds(treeOf(two)).sort()).toEqual(two.panes.map((pane) => pane.id).sort());
    const ids: string[] = []; const walk = (node: ReturnType<typeof treeOf>) => { ids.push(node.id); if (node.kind === "split") { walk(node.first); walk(node.second); } }; walk(treeOf(two));
    expect(new Set(ids).size).toBe(ids.length);
    expect(drawn(choose(two, "B"))).toEqual([other]);
  });

  it("4칸 shows four; back to 1칸 shows one with every tab of the project kept and the empty panes gone", () => {
    const { layout, first, other } = project();
    const four = preset(layout, 4);
    expect(drawn(four)).toHaveLength(4);
    expect(empties(four)).toHaveLength(3);
    expect(four.grid).toBe(2);
    const one = preset(four, 1);
    expect(drawn(one)).toEqual([first]);
    expect(tabsOf(paneById(one, first)!).map(contentKey)).toEqual([contentKey(HOME), "session:a1", "session:a2"]);
    expect(one.panes.map((pane) => pane.id).sort()).toEqual([first, other].sort());
    expect(tabsOf(paneById(one, other)!).map(contentKey)).toEqual(["doc:docB"]);
  });

  it("with no project chosen 2칸 shows two home panes", () => {
    const two = preset(open(project().layout, HOME), 2);
    expect(scopeOf(two)).toBeNull();
    expect(drawn(two)).toHaveLength(2);
    expect(two.panes.filter((pane) => JSON.stringify(activeTab(pane).view) === JSON.stringify({ kind: "new" }))).toHaveLength(2);
  });
});
