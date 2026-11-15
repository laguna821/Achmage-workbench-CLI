// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { projectChoiceMoves, useOverlayKeep } from "./overlay-keep.ts";

// Technical review N2: choosing a project in the laid-over column kept the column open for a 400 ms window;
// on a slow phone the project's view arrived later and the column closed instead of showing its inside.
// The column now closes on the item's own open action, not on a clock.
it("a project chosen keeps the column open however late its view arrives; the next item chosen closes it", () => {
  const close = vi.fn();
  const view = renderHook(({ at }) => useOverlayKeep(at, close), { initialProps: { at: "home" } });
  close.mockClear();
  view.result.current.keepOpen();
  vi.useFakeTimers(); vi.advanceTimersByTime(2000); vi.useRealTimers();
  view.rerender({ at: "project:P" });
  expect(close).not.toHaveBeenCalled();
  view.result.current.chosen();
  expect(close).toHaveBeenCalledTimes(1);
  view.rerender({ at: "session:S" });
  expect(close).toHaveBeenCalledTimes(2);
});

it("a project chosen that changes nothing on screen does not keep the column open for the next choice", () => {
  const close = vi.fn();
  const view = renderHook(({ at }) => useOverlayKeep(at, close), { initialProps: { at: "project:P" } });
  close.mockClear();
  view.result.current.keepOpen();
  view.result.current.chosen();
  expect(close).toHaveBeenCalledTimes(1);
  view.rerender({ at: "session:S" });
  expect(close).toHaveBeenCalledTimes(2);
});

// Re-review 1, next round 8: choosing the project ALREADY on screen armed the keep with no view change to
// consume it; the next change of view from elsewhere (the top bar's 확인 N) then left the column over the work.
it("a project chosen that is already on screen arms nothing: the next change of view from elsewhere closes the column", () => {
  expect(projectChoiceMoves({ focusedTabId: "t1", focusedWorkId: "P", viewKind: "session" }, "P", "t1")).toBe(false);
  expect(projectChoiceMoves({ focusedTabId: "t1", focusedWorkId: "P", viewKind: "session" }, "P", "t2")).toBe(true);
  expect(projectChoiceMoves({ focusedTabId: "t1", focusedWorkId: "P", viewKind: "project" }, "P", null)).toBe(false);
  expect(projectChoiceMoves({ focusedTabId: "t1", focusedWorkId: "Q", viewKind: "project" }, "P", null)).toBe(true);
  const close = vi.fn();
  const view = renderHook(({ at }) => useOverlayKeep(at, close), { initialProps: { at: "project:P" } });
  close.mockClear();
  view.result.current.keepOpen(false);
  view.rerender({ at: "session:S" });
  expect(close).toHaveBeenCalledTimes(1);
});
