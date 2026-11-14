import { describe, expect, it } from "vitest";
import { findTypeahead, matchesTypeahead, place, pointRect } from "./overlay.ts";

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height });
const window1000 = { width: 1000, height: 800 };

describe("place", () => {
  it.each([
    ["fits below the anchor", rect(100, 100, 100, 30), { width: 200, height: 150 }, window1000, {}, { left: 100, top: 134, side: "bottom", maxHeight: 658 }],
    ["no room below: flips above", rect(100, 670, 100, 30), { width: 200, height: 200 }, window1000, {}, { left: 100, top: 466, side: "top", maxHeight: 658 }],
    ["no room above when asked for top: flips below", rect(100, 40, 100, 30), { width: 200, height: 200 }, window1000, { side: "top" as const }, { top: 74, side: "bottom" }],
    ["overflows right: shifts left", rect(900, 100, 60, 30), { width: 200, height: 100 }, window1000, {}, { left: 792, top: 134 }],
    ["align end lines up the right edges", rect(700, 100, 260, 30), { width: 200, height: 100 }, window1000, { align: "end" as const }, { left: 760 }],
    ["align end overflowing left: shifts right", rect(4, 100, 60, 30), { width: 200, height: 100 }, window1000, { align: "end" as const }, { left: 8 }],
    ["no room above or below: the larger side, height limited", rect(100, 120, 100, 30), { width: 200, height: 400 }, { width: 1000, height: 300 }, {}, { side: "bottom", top: 154, maxHeight: 138 }],
    ["no room either way, more above: sits above, top at the margin", rect(100, 170, 100, 30), { width: 200, height: 400 }, { width: 1000, height: 300 }, {}, { side: "top", top: 8, maxHeight: 158 }],
    ["right side flips left at the window edge", rect(900, 100, 60, 30), { width: 200, height: 100 }, window1000, { side: "right" as const }, { side: "left", left: 696, top: 100 }],
    ["right side shifts up at the bottom edge", rect(100, 760, 60, 30), { width: 200, height: 100 }, window1000, { side: "right" as const }, { side: "right", left: 164, top: 692 }],
    ["a restricted viewport keeps the menu inside it", rect(550, 100, 30, 30), { width: 200, height: 100 }, { left: 0, top: 0, width: 600, height: 800 }, {}, { left: 392 }],
    ["a restricted viewport with an offset", rect(250, 100, 30, 30), { width: 200, height: 100 }, { left: 300, top: 50, width: 500, height: 600 }, {}, { left: 308 }],
    ["gap and margin are options", rect(100, 100, 100, 30), { width: 200, height: 100 }, window1000, { gap: 10, margin: 0 }, { top: 140, maxHeight: 660 }],
  ])("%s", (_name, anchor, size, viewport, options, expected) => {
    expect(place(anchor, size, viewport, options)).toMatchObject(expected);
  });

  it("limits the width to the viewport", () => {
    expect(place(rect(500, 100, 10, 10), { width: 1200, height: 100 }, window1000)).toMatchObject({ left: 8, maxWidth: 984 });
  });

  it("an anchor covering the viewport still gets a visible menu inside it", () => {
    const spot = place(rect(0, -10, 1000, 900), { width: 200, height: 150 }, window1000);
    expect(spot.maxHeight).toBe(784);
    expect(spot.top).toBeGreaterThanOrEqual(8);
    expect(spot.top + 150).toBeLessThanOrEqual(792);
  });

  it("an anchor scrolled above the viewport keeps the menu inside", () => {
    expect(place(rect(100, -100, 100, 30), { width: 200, height: 150 }, window1000).top).toBe(8);
  });

  it("opens at a point as a context menu would", () => {
    expect(place(pointRect(990, 790), { width: 200, height: 100 }, window1000, { gap: 0 })).toMatchObject({ left: 792, top: 690, side: "top" });
  });
});

describe("type-ahead", () => {
  it.each([
    ["모든 프로젝트", "모", true],
    ["모든 프로젝트", "ㅁ", true],
    ["목록", "모", true],
    ["모든 프로젝트", "목", false],
    ["Codex", "co", true],
    ["Claude", "co", false],
    ["프로젝트", "", false],
  ])("%s ← %s", (label, query, expected) => {
    expect(matchesTypeahead(label, query)).toBe(expected);
  });

  it("finds the first match after the current item, wrapping", () => {
    const labels = ["모델", "엔진", "모든 프로젝트"];
    expect(findTypeahead(labels, "모", 0)).toBe(0);
    expect(findTypeahead(labels, "모", 1)).toBe(2);
    expect(findTypeahead(labels, "모", 3)).toBe(0);
    expect(findTypeahead(labels, "없음", 0)).toBe(-1);
  });

  it("falls back to a word inside the label", () => {
    expect(findTypeahead(["학과 회의록", "논문 리뷰"], "리", 0)).toBe(1);
  });
});
