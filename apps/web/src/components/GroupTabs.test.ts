import { expect, it } from "vitest";
import { revealScroll, wheelAcross } from "./GroupTabs.tsx";

// The strip shows 400px of its tabs from `scroll`; a tab is `left` into the strip and `width` wide.
const strip = (scroll: number) => ({ scroll, width: 400 });

it("leaves the strip alone while the active tab is fully in view", () => {
  expect(revealScroll(strip(0), { left: 0, width: 120 })).toBeNull();
  expect(revealScroll(strip(100), { left: 380, width: 120 })).toBeNull();
});

it("scrolls just far enough to show a tab cut at the end (behind 새로 만들기)", () => {
  expect(revealScroll(strip(0), { left: 360, width: 120 })).toBe(80);
  expect(revealScroll(strip(0), { left: 900, width: 150 })).toBe(650);
});

it("scrolls back to show a tab cut at the start", () => {
  expect(revealScroll(strip(300), { left: 240, width: 120 })).toBe(240);
});

it("shows the start of a tab wider than the strip", () => {
  expect(revealScroll(strip(0), { left: 500, width: 480 })).toBe(500);
  expect(revealScroll(strip(500), { left: 500, width: 480 })).toBeNull();
});

// The strip has no scrollbar of its own (it covered the tabs): a mouse wheel moves it sideways.
it("turns an up-down wheel over the strip into sideways movement, and leaves a sideways one to the browser", () => {
  expect(wheelAcross({ deltaX: 0, deltaY: 120 })).toBe(120);
  expect(wheelAcross({ deltaX: 0, deltaY: -40 })).toBe(-40);
  expect(wheelAcross({ deltaX: 30, deltaY: 4 })).toBe(0);
  expect(wheelAcross({ deltaX: 0, deltaY: 0 })).toBe(0);
});
