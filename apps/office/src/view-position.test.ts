// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfficeViewPosition } from "@workbench/contracts";
import { installViewPosition, readScroll, restoreScroll } from "./view-position.ts";

afterEach(() => { vi.useRealTimers(); });

function scroller(content: number, view = 500) {
  const el = document.createElement("div");
  let top = 0;
  Object.defineProperties(el, {
    scrollHeight: { get: () => content, configurable: true }, clientHeight: { get: () => view, configurable: true },
    scrollTop: { get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, Math.max(0, content - view))); }, configurable: true },
  });
  return { el, resize: (next: number) => { content = next; } };
}

describe("a woken document comes back where it was (office-leftovers point 3)", () => {
  it("reads a scroller's place with its share of the document, and puts it back by pixels or, at another height, by share", () => {
    const a = scroller(3000); a.el.scrollTop = 1250;
    const kept = readScroll(a.el)!;
    expect(kept).toEqual({ top: 1250, left: 0, fraction: 0.5 });
    const b = scroller(3000);
    expect(restoreScroll(b.el, kept)).toBe(true); expect(b.el.scrollTop).toBe(1250);
    const c = scroller(1500); // drawn smaller (another zoom / fonts): the same share
    expect(restoreScroll(c.el, kept)).toBe(true); expect(c.el.scrollTop).toBe(500);
    const empty = scroller(400); // not laid out yet: not there yet
    expect(restoreScroll(empty.el, kept)).toBe(false);
  });

  it("puts the view back once after opening, says nothing before that, then says only changes", async () => {
    vi.useFakeTimers();
    const posts: OfficeViewPosition[] = [];
    let ready = false, place: OfficeViewPosition = { slide: 0 };
    const restore = vi.fn((p: OfficeViewPosition) => { if (!ready) return false; place = p; return true; });
    installViewPosition({ read: () => place, restore }, { initial: { slide: 4 }, post: (p) => posts.push(p), everyMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    // Booting at slide 1: never reported (it would overwrite where the tab was).
    expect(posts).toEqual([]);
    ready = true;
    await vi.advanceTimersByTimeAsync(2500);
    expect(place).toEqual({ slide: 4 });
    expect(restore).toHaveBeenLastCalledWith({ slide: 4 });
    expect(posts).toEqual([]); // back where the tab already knew: nothing new
    place = { slide: 6 };
    await vi.advanceTimersByTimeAsync(1200);
    expect(posts).toEqual([{ slide: 6 }]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(posts).toHaveLength(1);
  });

  it("gives up the restore at its bound and goes on reporting (a document that got shorter)", async () => {
    vi.useFakeTimers();
    const posts: OfficeViewPosition[] = [];
    installViewPosition({ read: () => ({ slide: 0 }), restore: () => false }, { initial: { slide: 9 }, post: (p) => posts.push(p), restoreForMs: 2000 });
    await vi.advanceTimersByTimeAsync(4000);
    expect(posts).toEqual([{ slide: 0 }]);
  });

  it("with nothing kept it only reports", async () => {
    vi.useFakeTimers();
    const posts: OfficeViewPosition[] = [];
    const restore = vi.fn(() => true);
    installViewPosition({ read: () => ({ scroll: { top: 10, left: 0, fraction: 0.1 } }), restore }, { post: (p) => posts.push(p) });
    await vi.advanceTimersByTimeAsync(1500);
    expect(restore).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
  });
});

describe("a page behind another tab", () => {
  it("says nothing while it is not laid out (a hidden frame's scroller reads 0)", async () => {
    vi.useFakeTimers();
    const posts: OfficeViewPosition[] = [];
    let shown = true;
    const a = scroller(3000); a.el.scrollTop = 900;
    installViewPosition({ read: () => { const scroll = readScroll(a.el); return scroll ? { scroll } : null; }, restore: () => true }, { post: (p) => posts.push(p), shown: () => shown });
    await vi.advanceTimersByTimeAsync(1200);
    expect(posts).toHaveLength(1);
    shown = false; a.el.scrollTop = 0;
    await vi.advanceTimersByTimeAsync(3000);
    expect(posts).toHaveLength(1);
    const hidden = scroller(3000, 0);
    expect(readScroll(hidden.el)).toBeUndefined();
  });
});

it("a page opened behind another tab puts the view back when it is shown, however long that takes (a hidden tab's editor reopened after its AI's turn)", async () => {
  vi.useFakeTimers();
  let shown = false;
  const restore = vi.fn(() => shown);
  installViewPosition({ read: () => ({ slide: 2 }), restore }, { initial: { slide: 2 }, post: () => {}, shown: () => shown, restoreForMs: 2000 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(restore).not.toHaveBeenCalled();
  shown = true;
  await vi.advanceTimersByTimeAsync(400);
  expect(restore).toHaveBeenCalledWith({ slide: 2 });
});

it("after a load in place while hidden, the place last said comes back when the page is shown (office-leftovers point 2)", async () => {
  vi.useFakeTimers();
  let shown = true;
  const a = scroller(3000); a.el.scrollTop = 700;
  const vp = installViewPosition({ read: () => { const scroll = readScroll(a.el); return scroll ? { scroll } : null; }, restore: (p) => restoreScroll(a.el, p.scroll) }, { post: () => {}, shown: () => shown });
  await vi.advanceTimersByTimeAsync(1200);
  shown = false;
  a.el.scrollTop = 0; // the editor loaded the new revision: back at its top
  vp.again();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(a.el.scrollTop).toBe(0);
  shown = true;
  await vi.advanceTimersByTimeAsync(400);
  expect(a.el.scrollTop).toBe(700);
});
