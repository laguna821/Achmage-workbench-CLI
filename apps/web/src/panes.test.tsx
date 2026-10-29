import { describe, expect, it } from "vitest";
import { DIVIDER, MIN_PANE, clampRatio, closePane, dropEffect, fitsTwo, focusPane, focusedPane, nudgeRatio, otherPane, placeOnSide, readRatio, setPane, shownElsewhere, sideAt, sideOf, singleLayout, swapPanes, type Layout, type Pane } from "./panes.ts";
import { leafIds, minimumSize, movePane, paneGeometry, placeAt, resizeSplit, restoreLayout, splitPane, treeOf } from "./panes.ts";

// Two panes: where something opened on a side lands, closing, swapping, which pane sidebar clicks go
// to (the focused one), what a pane that loses the focus keeps showing, and the divider's ratio.

type V = string;
const showing = (view: V) => (pane: Pane<V>) => pane.view === view;
const views = (layout: Layout<V>) => layout.panes.map((pane) => pane.view);

describe("two panes", () => {
  const one = singleLayout<V>("chat:a", "w1");

  it("opens a second pane on the side it was dropped on, and gives it the focus", () => {
    const right = placeOnSide(one, { view: "note:x", workId: null, sessionId: null }, "right", "s1", showing("note:x"));
    expect(views(right)).toEqual(["chat:a", "note:x"]);
    expect(focusedPane(right).view).toBe("note:x");
    // The pane losing the focus keeps the session it showed; the new one follows its work.
    expect(otherPane(right)).toMatchObject({ view: "chat:a", sessionId: "s1" });
    expect(focusedPane(right).sessionId).toBeNull();

    const left = placeOnSide(one, { view: "doc:d", workId: "w1", sessionId: null }, "left", null, showing("doc:d"));
    expect(views(left)).toEqual(["doc:d", "chat:a"]);
    expect(sideOf(left, focusedPane(left).id)).toBe("left");
    // Panes keep their identity (React keys): the first one stays "a".
    expect(left.panes.find((pane) => pane.view === "chat:a")?.id).toBe("a");
  });

  it("does nothing when the only pane shows it already", () => {
    expect(placeOnSide(one, { view: "chat:a", workId: "w1", sessionId: "s1" }, "right", null, showing("chat:a"))).toBe(one);
    expect(dropEffect(one, "left", showing("chat:a"))).toBe("none");
    expect(dropEffect(one, "left", showing("x"))).toBe("split");
  });

  it("with two panes shows it in the pane on that side, or swaps when the other one has it", () => {
    const two = placeOnSide(one, { view: "note:x", workId: null, sessionId: null }, "right", "s1", showing("note:x"));
    expect(dropEffect(two, "left", showing("doc:d"))).toBe("replace");
    const replaced = placeOnSide(two, { view: "doc:d", workId: "w1", sessionId: null }, "left", null, showing("doc:d"));
    expect(views(replaced)).toEqual(["doc:d", "note:x"]);
    expect(focusedPane(replaced).view).toBe("doc:d");
    // The note pane lost the focus: it keeps what it was given (a note has no session to keep).
    expect(otherPane(replaced)?.sessionId).toBeNull();

    // The note dropped on the left half while it is on the right: the two trade places.
    expect(dropEffect(two, "left", showing("note:x"))).toBe("swap");
    const swapped = placeOnSide(two, { view: "note:x", workId: null, sessionId: null }, "left", null, showing("note:x"));
    expect(views(swapped)).toEqual(["note:x", "chat:a"]);
    expect(focusedPane(swapped).view).toBe("note:x");
    // Never the same thing twice.
    expect(new Set(views(swapped)).size).toBe(2);

    // Dropped where it already is: only the focus moves there.
    const back = focusPane(two, "a", null);
    const same = placeOnSide(back, { view: "note:x", workId: null, sessionId: null }, "right", "s9", showing("note:x"));
    expect(views(same)).toEqual(views(back));
    expect(focusedPane(same).view).toBe("note:x");
    expect(same.panes.find((pane) => pane.view === "chat:a")?.sessionId).toBe("s9");
  });

  it("closes a pane: the other one is left, focused, following its work again", () => {
    const two = placeOnSide(one, { view: "note:x", workId: null, sessionId: null }, "right", "s1", showing("note:x"));
    const closed = closePane(two, focusedPane(two).id);
    expect(views(closed)).toEqual(["chat:a"]);
    expect(closed.focus).toBe("a");
    expect(closed.panes[0]!.sessionId).toBeNull();
    // Closing the pane without the focus keeps the focused one.
    const other = closePane(two, "a");
    expect(views(other)).toEqual(["note:x"]);
    expect(other.focus).toBe(focusedPane(two).id);
    // One pane cannot be closed.
    expect(closePane(one, "a")).toBe(one);
  });

  it("swaps sides and keeps the focus with the same pane", () => {
    const two = placeOnSide(one, { view: "note:x", workId: null, sessionId: null }, "right", null, showing("note:x"));
    const swapped = swapPanes(two);
    expect(views(swapped)).toEqual(["note:x", "chat:a"]);
    expect(focusedPane(swapped).view).toBe("note:x");
    expect(sideOf(swapped, swapped.focus)).toBe("left");
    expect(swapPanes(one)).toBe(one);
  });

  it("routes clicks to the focused pane, and to the other pane when it already shows the thing", () => {
    const two = placeOnSide(one, { view: "note:x", workId: null, sessionId: null }, "right", "s1", showing("note:x"));
    // A sidebar click changes the focused pane only.
    const clicked = setPane(two, two.focus, { view: "doc:d", workId: "w1" });
    expect(views(clicked)).toEqual(["chat:a", "doc:d"]);
    // The conversation is on the left already: the focus goes there instead.
    expect(shownElsewhere(two, showing("chat:a"))).toBe("a");
    expect(shownElsewhere(two, showing("note:x"))).toBeNull();
    const focused = focusPane(two, "a", null);
    expect(focusedPane(focused).view).toBe("chat:a");
    // The pane taking the focus follows its work again; its kept session is for the caller to show.
    expect(focusedPane(focused).sessionId).toBeNull();
    expect(focusPane(focused, "a", "x")).toBe(focused);
  });

  it("keeps the divider where both panes stay usable", () => {
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(0.05)).toBe(0.2);
    expect(clampRatio(0.97)).toBe(0.8);
    expect(clampRatio(Number.NaN)).toBe(0.5);
    // 900px: a pane needs MIN_PANE of the width beside the divider.
    const width = 900;
    const least = MIN_PANE / (width - DIVIDER);
    expect(clampRatio(0.2, width)).toBeCloseTo(least, 5);
    expect(clampRatio(0.8, width)).toBeCloseTo(1 - least, 5);
    // Too narrow for two: half and half (only one is shown anyway).
    expect(clampRatio(0.3, 500)).toBe(0.5);
    expect(fitsTwo(MIN_PANE * 2 + DIVIDER)).toBe(true);
    expect(fitsTwo(MIN_PANE * 2)).toBe(false);
    expect(readRatio("0.3")).toBe(0.5);
    expect(readRatio(0.65)).toBe(0.65);
    expect(readRatio(2)).toBe(0.8);
  });

  it("moves the divider from the keyboard", () => {
    expect(nudgeRatio(0.5, "ArrowLeft", false)).toBeCloseTo(0.48, 5);
    expect(nudgeRatio(0.5, "ArrowRight", true)).toBeCloseTo(0.6, 5);
    expect(nudgeRatio(0.79, "ArrowRight", false)).toBe(0.8);
    expect(nudgeRatio(0.5, "Home", false)).toBe(0.2);
    expect(nudgeRatio(0.5, "End", false, 1000)).toBeCloseTo(1 - MIN_PANE / (1000 - DIVIDER), 5);
    expect(nudgeRatio(0.5, "a", false)).toBeNull();
  });

  it("tells which side a point is on: halves of one pane, the pane itself of two", () => {
    expect(sideAt(399, 0, 800, 1, 0.5)).toBe("left");
    expect(sideAt(401, 0, 800, 1, 0.5)).toBe("right");
    // Two panes at 30/70: the line is the divider, not the middle.
    expect(sideAt(300, 100, 1000, 2, 0.3)).toBe("left");
    expect(sideAt(500, 100, 1000, 2, 0.3)).toBe("right");
  });
});

describe("recursive panes", () => {
  const content = (view: string) => ({ view, workId: view.startsWith("chat") ? "w1" : null, sessionId: null });
  const four = () => {
    const two = splitPane(singleLayout("chat:a", "w1"), "a", "right", content("doc:b"), "s1");
    const three = splitPane(two, "a", "bottom", content("terminal:c"), null);
    return splitPane(three, two.focus, "bottom", content("diff:d"), null);
  };
  it("creates 2×2 rectangles and collapses only the closed branch", () => {
    const layout = four();
    const { panes, dividers } = paneGeometry(treeOf(layout), 1007, 807);
    expect(Object.values(panes)).toEqual(expect.arrayContaining([
      { left: 0, top: 0, width: 500, height: 400 }, { left: 0, top: 407, width: 500, height: 400 },
      { left: 507, top: 0, width: 500, height: 400 }, { left: 507, top: 407, width: 500, height: 400 },
    ]));
    expect(dividers).toHaveLength(3);
    const closed = closePane(layout, "a");
    expect(closed.panes).toHaveLength(3);
    expect(closed.focus).toBe(layout.focus);
    expect(leafIds(treeOf(closed))).toEqual(closed.panes.map((pane) => pane.id));
  });
  it("moves existing panes without duplicating their views or losing session pins", () => {
    const layout = four();
    const before = layout.panes.map((pane) => [pane.id, pane.view, pane.sessionId]).sort();
    const moved = movePane(layout, "a", { paneId: layout.focus, side: "bottom" });
    expect(moved.panes.map((pane) => [pane.id, pane.view, pane.sessionId]).sort()).toEqual(before);
    expect(moved.focus).toBe(layout.focus);
    const again = placeAt(moved, content("doc:b"), { paneId: "a", side: "center" }, null, showing("doc:b"));
    expect(again.panes).toHaveLength(4);
    expect(focusedPane(again).view).toBe("doc:b");
    expect(new Set(again.panes.map((pane) => pane.view)).size).toBe(4);
  });
  it("round-trips content, focus, ratios and legacy two-pane data; rejects corrupt trees", () => {
    const layout = four();
    const root = treeOf(layout);
    const changed = resizeSplit(layout, root.id, 0.6);
    const fallback = singleLayout("home", null);
    const isString = (value: unknown): value is string => typeof value === "string";
    expect(restoreLayout(JSON.parse(JSON.stringify({ version: 1, ...changed })), isString, fallback)).toEqual(changed);
    expect(restoreLayout({ ...changed, tree: { kind: "pane", id: "a" } }, isString, fallback)).toBe(fallback);
    expect(restoreLayout({ ...changed, panes: [changed.panes[0], changed.panes[0]] }, isString, fallback)).toBe(fallback);
    const legacy = { panes: layout.panes.slice(0, 2), focus: "a" };
    expect(restoreLayout(legacy, isString, fallback).panes).toEqual(legacy.panes);
    expect(minimumSize(root)).toEqual({ width: MIN_PANE * 2 + DIVIDER, height: 447 });
  });
  it("cycles focus through every pane, preserving all other sessions", () => {
    const layout = four();
    const visited = new Set<string>();
    let next = layout;
    for (let index = 0; index < layout.panes.length; index++) {
      next = focusPane(next, otherPane(next)!.id, `s${index}`);
      visited.add(next.focus);
      expect(treeOf(next)).toEqual(treeOf(layout));
    }
    expect(visited.size).toBe(4);
  });
});
