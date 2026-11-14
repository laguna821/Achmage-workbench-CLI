// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { markDiscarded, takeDiscarded } from "./discarded-edits.ts";

// "저장하지 않고 옮기기" on a document in an embedded editor: that editor keeps its own recovery copy
// of the unsaved bytes. The mark makes the next opening in an editor drop it instead of restoring it.
beforeEach(() => localStorage.clear());

it("a discarded document is marked once: the next opening takes the mark, the one after does not", () => {
  markDiscarded("d");
  expect(takeDiscarded("d")).toBe(true);
  expect(takeDiscarded("d")).toBe(false);
});
it("a document not discarded is not marked", () => {
  markDiscarded("d");
  expect(takeDiscarded("other")).toBe(false);
  expect(takeDiscarded("d")).toBe(true);
});
it("the mark is kept on this device until used, across an app restart (the stored list, read again)", () => {
  markDiscarded("d");
  // A new window (or the app started again) reads the same store.
  const stored = localStorage.getItem("workbench.discardedEdits");
  localStorage.clear();
  localStorage.setItem("workbench.discardedEdits", stored!);
  expect(takeDiscarded("d")).toBe(true);
});
