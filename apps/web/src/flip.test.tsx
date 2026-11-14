// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { pickAnchor, startFrame } from "./flip.ts";

// The FLIP arithmetic behind mode changes.

describe("FLIP", () => {
  it("keeps the thing at the reading line (or nearest to it) as the anchor", () => {
    const boxes = new Map([
      ["a", { left: 0, top: 0, width: 100, height: 40 }],
      ["b", { left: 0, top: 50, width: 100, height: 40 }],
      ["c", { left: 0, top: 900, width: 100, height: 40 }],
    ]);
    expect(pickAnchor(boxes, { top: 0, bottom: 600 }, 60)).toBe("b");
    expect(pickAnchor(boxes, { top: 0, bottom: 600 }, 45)).toBe("a");
    expect(pickAnchor(boxes, { top: 800, bottom: 1400 }, 1000)).toBe("c");
    expect(pickAnchor(new Map(), { top: 0, bottom: 600 }, 60)).toBeNull();
  });

  it("starts a box where it was; a box holding others only slides, and a child moves by what is left", () => {
    const before = { left: 10, top: 300, width: 200, height: 40 };
    const after = { left: 110, top: 100, width: 400, height: 80 };
    expect(startFrame(before, after, { holdsOthers: false, parent: null })).toEqual({ dx: -100, dy: 200, ownDx: -100, ownDy: 200, sx: 0.5, sy: 0.5 });
    expect(startFrame(before, after, { holdsOthers: true, parent: null })).toMatchObject({ sx: 1, sy: 1 });
    expect(startFrame(before, after, { holdsOthers: false, parent: { dx: -60, dy: 150 } })).toMatchObject({ ownDx: -40, ownDy: 50 });
  });
});
