import { describe, expect, it } from "vitest";
import { moveTab } from "./tabs.ts";
import { stripDropIndex, stripMark } from "./tab-drop.ts";
import type { Layout } from "./panes.ts";

const rows = [{ index: 0, left: 0, width: 100 }, { index: 1, left: 100, width: 100 }, { index: 2, left: 200, width: 100 }];
const layout = (): Layout<string> => ({ panes: [{ id: "a", view: "1", workId: null, sessionId: null, tabs: ["1", "2", "3"].map((id) => ({ id: `t${id}`, view: id, workId: null, sessionId: null })), activeTabId: "t1" }], focus: "a" });
const order = (next: Layout<string>) => next.panes[0]!.tabs!.map((tab) => tab.id);

describe("a tab held over a strip", () => {
  it("lands where the mark is: the first tab dropped between the second and third goes between them", () => {
    const index = stripDropIndex(rows, 205, 0);
    expect(index).toBe(1);
    expect(stripMark(["t1", "t2", "t3"], "t1", index)).toEqual({ before: "t3" });
    expect(order(moveTab(layout(), "t1", { paneId: "a", side: "center" }, index))).toEqual(["t2", "t1", "t3"]);
  });
  it("to the end and to the front", () => {
    const end = stripDropIndex(rows, 290, 0);
    expect(stripMark(["t1", "t2", "t3"], "t1", end)).toEqual({ after: "t3" });
    expect(order(moveTab(layout(), "t1", { paneId: "a", side: "center" }, end))).toEqual(["t2", "t3", "t1"]);
    const front = stripDropIndex(rows, 10, 2);
    expect(stripMark(["t1", "t2", "t3"], "t3", front)).toEqual({ before: "t1" });
    expect(order(moveTab(layout(), "t3", { paneId: "a", side: "center" }, front))).toEqual(["t3", "t1", "t2"]);
  });
  it("shows no mark where the drop changes nothing (its own place)", () => {
    expect(stripMark(["t1", "t2", "t3"], "t2", stripDropIndex(rows, 120, 1))).toBeNull();
    expect(stripMark(["t1", "t2", "t3"], "t2", stripDropIndex(rows, 180, 1))).toBeNull();
  });
  it("a tab of another pane counts every tab here", () => {
    expect(stripDropIndex(rows, 205)).toBe(2);
    expect(stripMark(["t1", "t2", "t3"], null, 2)).toEqual({ before: "t3" });
    expect(stripMark(["t1", "t2", "t3"], null, 3)).toEqual({ after: "t3" });
  });
  it("a tab not on the strip (another project's) is not marked against", () => {
    expect(stripMark(["t1", "x", "t3"], null, 1, (id) => id !== "x")).toEqual({ before: "t3" });
    expect(stripMark(["t1", "t3", "x"], null, 2, (id) => id !== "x")).toEqual({ after: "t3" });
  });
});
