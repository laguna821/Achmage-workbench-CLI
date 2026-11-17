// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPageRest } from "./page-rest.ts";

/** A window-like target with fake timers and frames, so a rest can be installed and watched. */
function fakeWindow() {
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const target = {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestAnimationFrame: (callback: FrameRequestCallback) => { const id = ++next; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  };
  const flushFrames = () => { const now = [...frames.values()]; frames.clear(); for (const callback of now) callback(0); };
  return { target: target as unknown as Window, flushFrames, pendingFrames: () => frames.size };
}

afterEach(() => { vi.useRealTimers(); });

/** An editor page whose document is clean (it says so through restWhenClean). */
const cleanRest = (options?: Parameters<typeof createPageRest>[0]) => { const rest = createPageRest(options); rest.restWhenClean(() => false); return rest; };

describe("an editor page whose tab is hidden rests (A10)", () => {
  it("its repeating timers stop while hidden and each runs once when shown again", () => {
    vi.useFakeTimers();
    const rest = cleanRest();
    const page = fakeWindow();
    rest.install(page.target);
    const tick = vi.fn();
    page.target.setInterval(tick, 2000);
    vi.advanceTimersByTime(4000);
    expect(tick).toHaveBeenCalledTimes(2);
    rest.shown(false);
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    rest.shown(true);
    // Catch up once, then the old period again.
    expect(tick).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(4);
  });

  it("a timer that did not come due while hidden is not run on shown", () => {
    vi.useFakeTimers();
    const rest = cleanRest();
    const page = fakeWindow();
    rest.install(page.target);
    const tick = vi.fn();
    page.target.setInterval(tick, 30_000);
    rest.shown(false);
    vi.advanceTimersByTime(1000);
    rest.shown(true);
    expect(tick).not.toHaveBeenCalled();
  });

  it("a cleared timer stays cleared across hide and show (clearInterval and clearTimeout)", () => {
    vi.useFakeTimers();
    const rest = cleanRest();
    const page = fakeWindow();
    rest.install(page.target);
    const a = vi.fn(), b = vi.fn();
    const ida = page.target.setInterval(a, 100), idb = page.target.setInterval(b, 100);
    page.target.clearInterval(ida);
    rest.shown(false);
    page.target.clearTimeout(idb);
    vi.advanceTimersByTime(1000);
    rest.shown(true);
    vi.advanceTimersByTime(1000);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("animation frames asked for while hidden wait and run when shown; cancelled ones never", () => {
    const rest = cleanRest();
    const page = fakeWindow();
    rest.install(page.target);
    rest.shown(false);
    const draw = vi.fn(), dropped = vi.fn();
    page.target.requestAnimationFrame(draw);
    const id = page.target.requestAnimationFrame(dropped);
    page.target.cancelAnimationFrame(id);
    expect(page.pendingFrames()).toBe(0);
    rest.shown(true);
    page.flushFrames();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it("a frame loop (a paint loop asking for the next frame each time) stops while hidden", () => {
    const rest = cleanRest();
    const page = fakeWindow();
    rest.install(page.target);
    let painted = 0;
    const loop = () => { painted++; page.target.requestAnimationFrame(loop); };
    page.target.requestAnimationFrame(loop);
    page.flushFrames(); page.flushFrames();
    expect(painted).toBe(2);
    rest.shown(false);
    page.flushFrames(); // the frame asked for before the hide runs once and parks its successor
    page.flushFrames(); page.flushFrames();
    expect(painted).toBe(3);
    rest.shown(true);
    page.flushFrames();
    expect(painted).toBe(4);
  });

  it("an AI turn (or anything that holds the page awake) keeps it working while hidden", () => {
    vi.useFakeTimers();
    const rest = cleanRest();
    const page = fakeWindow();
    rest.install(page.target);
    const tick = vi.fn();
    page.target.setInterval(tick, 100);
    rest.shown(false);
    const release = rest.hold("turn");
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(10);
    release();
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(10);
    expect(rest.resting()).toBe(true);
  });

  it("a message from the window wakes the page for a while (a flush, an export, a control request)", () => {
    vi.useFakeTimers();
    const rest = cleanRest({ wakeMs: 5500 });
    const page = fakeWindow();
    rest.install(page.target);
    const tick = vi.fn();
    page.target.setInterval(tick, 1000);
    rest.shown(false);
    rest.nudge();
    expect(rest.resting()).toBe(false);
    vi.advanceTimersByTime(5500);
    expect(tick).toHaveBeenCalledTimes(5);
    expect(rest.resting()).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(5);
  });

  it("a page told nothing (an executor's own window, a headless export) never rests", () => {
    const rest = cleanRest();
    expect(rest.resting()).toBe(false);
  });

  it("an editor that gives no dirty signal never rests, hidden or not", () => {
    const rest = createPageRest();
    rest.shown(false);
    expect(rest.resting()).toBe(false);
  });

  it("the timers installed into a second window (the Hangul studio frame) rest with the page", () => {
    vi.useFakeTimers();
    const rest = cleanRest();
    const page = fakeWindow(), studio = fakeWindow();
    rest.install(page.target);
    rest.install(studio.target);
    const tick = vi.fn();
    studio.target.setInterval(tick, 500);
    rest.shown(false);
    vi.advanceTimersByTime(5000);
    expect(tick).not.toHaveBeenCalled();
    rest.shown(true);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});

describe("an editor page with unsaved edits never rests (coordinator's safety rule)", () => {
  it("hidden and dirty: its timers keep running — the save and the keep-copy happen on time", async () => {
    vi.useFakeTimers();
    let dirty = true;
    const rest = createPageRest();
    rest.restWhenClean(() => dirty);
    const page = fakeWindow();
    rest.install(page.target);
    const save = vi.fn(), keep = vi.fn();
    page.target.setInterval(save, 2000);
    page.target.setInterval(keep, 30_000);
    rest.shown(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rest.resting()).toBe(false);
    expect(save).toHaveBeenCalledTimes(15);
    expect(keep).toHaveBeenCalledTimes(1);
  });

  it("hidden and clean: it rests (the check is asked, also when it answers later)", async () => {
    vi.useFakeTimers();
    const rest = createPageRest();
    rest.restWhenClean(async () => false);
    const page = fakeWindow();
    rest.install(page.target);
    const tick = vi.fn();
    page.target.setInterval(tick, 1000);
    rest.shown(false);
    expect(rest.resting()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(rest.resting()).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("dirty becomes clean while hidden (the autosave saved): it rests afterwards", async () => {
    vi.useFakeTimers();
    let dirty = true;
    const rest = createPageRest();
    rest.restWhenClean(() => dirty);
    const page = fakeWindow();
    rest.install(page.target);
    const save = vi.fn(() => { dirty = false; rest.dirtyHint(false); });
    page.target.setInterval(save, 2000);
    rest.shown(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(rest.resting()).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("dirty becomes clean without a word from the editor: the check is asked again and the page rests", async () => {
    vi.useFakeTimers();
    let dirty = true;
    const rest = createPageRest();
    rest.restWhenClean(() => dirty);
    rest.install(fakeWindow().target);
    rest.shown(false);
    await vi.advanceTimersByTimeAsync(1000);
    dirty = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rest.resting()).toBe(true);
  });

  it("a check that never answers keeps the page awake", async () => {
    vi.useFakeTimers();
    const rest = createPageRest();
    rest.restWhenClean(() => new Promise<boolean>(() => {}));
    rest.install(fakeWindow().target);
    rest.shown(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rest.resting()).toBe(false);
  });

  it("resting, an AI edit (a hold) makes it dirty: after the turn it stays awake until saved", async () => {
    vi.useFakeTimers();
    let dirty = false;
    const rest = createPageRest();
    rest.restWhenClean(() => dirty);
    const page = fakeWindow();
    rest.install(page.target);
    const save = vi.fn();
    page.target.setInterval(save, 2000);
    rest.shown(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(rest.resting()).toBe(true);
    const release = rest.hold("turn");
    expect(rest.resting()).toBe(false);
    dirty = true; rest.dirtyHint(true);
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rest.resting()).toBe(false);
    expect(save).toHaveBeenCalledTimes(5);
  });

  it("resting, a message from the window that leaves edits (a rebase) keeps it awake after the wake", async () => {
    vi.useFakeTimers();
    let dirty = false;
    const rest = createPageRest({ wakeMs: 1000 });
    rest.restWhenClean(() => dirty);
    rest.install(fakeWindow().target);
    rest.shown(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(rest.resting()).toBe(true);
    rest.nudge();
    dirty = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rest.resting()).toBe(false);
  });

  it("a save or flush in flight (a hold) keeps it awake even when the editor already reports clean", async () => {
    vi.useFakeTimers();
    const rest = createPageRest();
    rest.restWhenClean(() => false);
    rest.install(fakeWindow().target);
    const release = rest.hold("save");
    rest.shown(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rest.resting()).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(rest.resting()).toBe(true);
  });
});
