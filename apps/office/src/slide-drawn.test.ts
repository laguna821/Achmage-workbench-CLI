// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slideStageKey, watchSlideDrawn } from "./slide-drawn.ts";

let rects = new Map<string, { left: number; top: number; width: number; height: number }>();
beforeEach(() => {
  vi.useFakeTimers();
  rects = new Map();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const r = rects.get(this.className.split(" ")[0]!) ?? { left: 0, top: 0, width: 0, height: 0 };
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON() {} } as DOMRect;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

const booting = () => { document.body.innerHTML = `<div class="workspace"><div class="start-screen start-booting">여는 중…</div></div>`; };
const drawn = () => {
  document.body.innerHTML = `<div class="slide-list"><div class="thumb active"></div></div><div class="stage-wrap"><div class="stage-zoom-box"><div class="konvajs-content"><canvas></canvas></div></div></div>`;
  rects.set("stage-wrap", { left: 150, top: 140, width: 780, height: 260 });
  rects.set("konvajs-content", { left: 370, top: 180, width: 343, height: 197 });
};

describe("the PowerPoint page's 'slide drawn at its fitted place' report", () => {
  it("is not given while the editor shows its own 여는 중… or before the stage has a size", () => {
    booting();
    expect(slideStageKey(document)).toBeNull();
    drawn(); rects.set("konvajs-content", { left: 0, top: 0, width: 0, height: 0 });
    expect(slideStageKey(document)).toBeNull();
  });

  it("is given once, after the stage's boxes stayed the same for a few looks — not on the first frame that is still moving", () => {
    const said = vi.fn();
    booting();
    watchSlideDrawn(document, window, said, { stableSamples: 3, everyMs: 50 });
    vi.advanceTimersByTime(500);
    expect(said).not.toHaveBeenCalled();
    drawn();
    vi.advanceTimersByTime(60);
    // The first fit, then the stage area shrinks when the notes pane and the AI chips arrive: the slide moves.
    rects.set("stage-wrap", { left: 150, top: 140, width: 780, height: 200 });
    rects.set("konvajs-content", { left: 380, top: 160, width: 320, height: 180 });
    vi.advanceTimersByTime(100);
    expect(said).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(said).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(said).toHaveBeenCalledTimes(1);
  });

  it("gives up after its bound (the window's own bound ends the picture)", () => {
    const said = vi.fn();
    booting();
    watchSlideDrawn(document, window, said, { timeoutMs: 1000, everyMs: 50 });
    vi.advanceTimersByTime(1100);
    drawn();
    vi.advanceTimersByTime(1000);
    expect(said).not.toHaveBeenCalled();
  });
});
