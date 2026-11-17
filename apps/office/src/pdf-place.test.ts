// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { pdfPlaceParts } from "./pdf-place.ts";

/** A laid-out box that scrolls (jsdom has no layout): its content height, view height and drawn size. */
function box(className: string, content: number, view: number, rect: { width: number; height: number }) {
  const el = document.createElement("div");
  el.className = className; el.style.overflowY = "auto";
  el.append(document.createElement("canvas"));
  let top = 0;
  Object.defineProperties(el, {
    scrollHeight: { get: () => content, configurable: true }, clientHeight: { get: () => view, configurable: true },
    scrollWidth: { get: () => 0, configurable: true }, clientWidth: { get: () => 0, configurable: true },
    scrollTop: { get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, Math.max(0, content - view))); }, configurable: true },
  });
  el.getBoundingClientRect = () => ({ ...rect, x: 0, y: 0, top: 0, left: 0, right: rect.width, bottom: rect.height, toJSON: () => ({}) });
  document.body.append(el);
  return { el, grow: (next: number) => { content = next; } };
}

describe("the PDF tab's place is its pages, not the thumbnail rail (pdf hidden tab → in place: 900 → 1101)", () => {
  it("before the pages are laid out it says nothing, even while the thumbnail rail scrolls; then it says and restores the pages", () => {
    document.body.replaceChildren();
    // On opening the rail (thumbnail canvases) already scrolls; the pages scroller does not yet.
    const rail = box("pdf-thumbs", 1240, 535, { width: 180, height: 535 });
    const pages = box("pdf-scroll", 535, 535, { width: 855, height: 535 });
    const parts = pdfPlaceParts(document, 1);
    rail.el.scrollTop = 200;
    expect(parts.read()).toBeNull();
    // The pages are laid out: the place is theirs, and the rail's scroll is never said or set.
    pages.grow(6376); pages.el.scrollTop = 900;
    expect(parts.read()).toEqual({ scroll: { top: 900, left: 0, fraction: 0.1541 } });
    pages.grow(7436); pages.el.scrollTop = 1101; rail.el.scrollTop = 0; // an in-place load moved the pages
    expect(parts.restore({ scroll: { top: 900, left: 0, fraction: 0.1541 } })).toBe(true);
    expect(pages.el.scrollTop).toBe(900);
    expect(rail.el.scrollTop).toBe(0);
  });

  it("counts the place as back only after it held (the viewer jumps once more after a load)", () => {
    document.body.replaceChildren();
    const pages = box("pdf-scroll", 6376, 535, { width: 855, height: 535 });
    const parts = pdfPlaceParts(document, 3);
    const place = { scroll: { top: 900, left: 0, fraction: 0.1541 } };
    expect(parts.restore(place)).toBe(false);
    expect(parts.restore(place)).toBe(false);
    expect(parts.restore(place)).toBe(true);
    expect(pages.el.scrollTop).toBe(900);
  });
});
