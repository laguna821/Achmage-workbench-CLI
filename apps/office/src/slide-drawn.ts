/**
 * "The slide is drawn at its fitted place" for the PowerPoint page (office-leftovers point 1).
 *
 * The slides editor says `office:opened` when its worker has the deck, and its AI panel reports ready with the ribbon —
 * both BEFORE the slide is on screen (it shows its own "여는 중…" until the renderer has the deck, then fits its zoom on
 * the stage's first measurable frame and again when the stage's box settles). The window's page picture must leave on
 * the slide, not on those: this watches the page until the slide stage exists (no "여는 중…" screen, a Konva canvas,
 * the slide list) and its box, the stage area's box and the stage's scroll have stayed the same for `stableSamples`
 * looks in a row; then it reports once.
 *
 * Timers, not animation frames: a page opened behind another tab gets no frames, and still settles (the window keeps
 * its own bound for a report that never comes).
 */
export interface SlideDrawnOptions {
  /** Looks with the same boxes in a row before the slide counts as settled. */
  stableSamples?: number;
  /** Between looks (ms). */
  everyMs?: number;
  /** Give up after this long (ms): the window's own bound ends its picture. */
  timeoutMs?: number;
}

function box(el: Element | null): string | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
}

/** One look: the slide stage's geometry as a key, or null while the slide is not there yet. */
export function slideStageKey(doc: Document): string | null {
  if (doc.querySelector(".start-booting")) return null;
  const wrap = doc.querySelector(".stage-wrap");
  const content = wrap?.querySelector(".konvajs-content") ?? null;
  if (!wrap || !content || !content.querySelector("canvas")) return null;
  if (!doc.querySelector(".slide-list .thumb")) return null;
  const a = box(content), b = box(wrap);
  if (!a || !b) return null;
  return `${a}|${b}|${(wrap as HTMLElement).scrollLeft},${(wrap as HTMLElement).scrollTop}`;
}

export function watchSlideDrawn(doc: Document, timers: Pick<Window, "setInterval" | "clearInterval">, onDrawn: () => void, options: SlideDrawnOptions = {}): () => void {
  const need = options.stableSamples ?? 3, every = options.everyMs ?? 60, until = Date.now() + (options.timeoutMs ?? 20_000);
  let last: string | null = null, same = 0, done = false;
  const stop = () => { if (!done) { done = true; timers.clearInterval(id); } };
  const id = timers.setInterval(() => {
    if (done) return;
    if (Date.now() > until) { stop(); return; }
    const key = slideStageKey(doc);
    if (key === null) { last = null; same = 0; return; }
    same = key === last ? same + 1 : 1;
    last = key;
    if (same >= need) { stop(); onDrawn(); }
  }, every);
  return stop;
}
