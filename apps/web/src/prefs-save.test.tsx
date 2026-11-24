// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiPrefs } from "@workbench/contracts";
import { usePrefsSaver } from "./prefs-save.ts";

// composer-056: a fold that waited for the double-click window was written over the PC's stored
// preferences as they were when it was clicked, folding again a folder unfolded meanwhile (rig-seen:
// 강의 unfolded by a move, then a click on 2026-2 folded both). Every change builds on the latest.
type Tree = { closedFolders: string[] };
const closed = (prefs: UiPrefs) => (prefs.tree as Tree | undefined)?.closedFolders ?? [];

describe("usePrefsSaver: screen preferences edited at once, saved after a pause", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a change asked by a callback made before the last answer still builds on the latest preferences", async () => {
    const stored: UiPrefs[] = [];
    let answer: (value: { prefs: UiPrefs }) => void = () => {};
    const save = vi.fn((prefs: UiPrefs) => { stored.push(prefs); return new Promise<{ prefs: UiPrefs }>((done) => { answer = done; }); });
    const received: UiPrefs[] = [];
    const { result, rerender } = renderHook(({ server }) => usePrefsSaver(server, save, (prefs) => received.push(prefs), () => {}), { initialProps: { server: { tree: { closedFolders: ["강의"] } } as UiPrefs } });
    // A callback kept from now (a click waiting for the double-click window).
    const later = result.current.save;
    act(() => result.current.save((current) => ({ tree: { closedFolders: closed(current).filter((id) => id !== "강의") } })));
    expect(closed(result.current.local!)).toEqual([]);
    act(() => { vi.advanceTimersByTime(300); });
    expect(closed(stored.at(-1)!)).toEqual([]);
    // The gateway answers; the app takes the answer in (the server prefs change).
    await act(async () => { answer({ prefs: stored.at(-1)! }); await Promise.resolve(); });
    rerender({ server: received.at(-1)! });
    expect(result.current.local).toBeNull();
    act(() => later((current) => ({ tree: { closedFolders: [...closed(current), "2026-2"] } })));
    expect(closed(result.current.local!)).toEqual(["2026-2"]);
  });

  it("the answer to an older save does not drop a newer change made meanwhile", async () => {
    const answers: ((value: { prefs: UiPrefs }) => void)[] = [];
    const save = vi.fn((prefs: UiPrefs) => new Promise<{ prefs: UiPrefs }>((done) => { answers.push(() => done({ prefs })); }));
    const { result } = renderHook(() => usePrefsSaver({ tree: { closedFolders: [] } } as UiPrefs, save, () => {}, () => {}));
    act(() => result.current.save((current) => ({ tree: { closedFolders: [...closed(current), "강의"] } })));
    act(() => { vi.advanceTimersByTime(300); });
    act(() => result.current.save((current) => ({ tree: { closedFolders: closed(current).filter((id) => id !== "강의") } })));
    await act(async () => { answers[0]!({ prefs: { tree: { closedFolders: ["강의"] } } as UiPrefs }); await Promise.resolve(); });
    expect(closed(result.current.local!)).toEqual([]);
    act(() => { vi.advanceTimersByTime(300); });
    expect(closed(save.mock.calls.at(-1)![0])).toEqual([]);
  });
});
