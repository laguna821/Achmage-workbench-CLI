import { describe, expect, it } from "vitest";
import { TURN_STEP, TURN_WINDOW, drawFrom, earlierFrom, reachFrom, slideFrom } from "./turn-window.ts";

describe("turn window (A2: only the last turns are drawn; anything can still be reached)", () => {
  it("draws the last TURN_WINDOW turns of a long conversation, all of a short one", () => {
    expect(TURN_WINDOW).toBe(40);
    expect(drawFrom(320, null)).toBe(280);
    expect(drawFrom(40, null)).toBe(0);
    expect(drawFrom(12, null)).toBe(0);
    expect(drawFrom(0, null)).toBe(0);
  });
  it("a reading position to come back to is drawn, with a turn above it", () => {
    expect(drawFrom(320, 100)).toBe(99);
    expect(drawFrom(320, 0)).toBe(0);
    expect(drawFrom(320, 300)).toBe(280);
  });
  it("a saved place without a message to anchor it draws everything (today's way)", () => {
    expect(drawFrom(320, "all")).toBe(0);
  });
  it("이전 대화 보기 adds TURN_STEP turns above, down to the first", () => {
    expect(TURN_STEP).toBe(40);
    expect(earlierFrom(280)).toBe(240);
    expect(earlierFrom(30)).toBe(0);
  });
  it("a jump to an undrawn turn draws from it (one above for context); a drawn one changes nothing", () => {
    expect(reachFrom(280, 10)).toBe(9);
    expect(reachFrom(280, 0)).toBe(0);
    expect(reachFrom(280, 300)).toBe(280);
    expect(reachFrom(280, -1)).toBe(280);
  });
  it("while the reader follows the end, a long run of new turns is let go above (the window stays bounded)", () => {
    expect(slideFrom(280, 320, true)).toBe(280);
    expect(slideFrom(280, 360, true)).toBe(280);
    expect(slideFrom(280, 361, true)).toBe(321);
    // Reading higher up: nothing is taken away under the reader.
    expect(slideFrom(0, 400, false)).toBe(0);
  });
});
