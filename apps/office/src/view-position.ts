import type { OfficeViewPosition } from "@workbench/contracts";

/**
 * A woken document comes back where it was (office-leftovers point 3). Every editor page reports where its view is
 * (`office:view-position`, only when it changed); the window keeps it with the tab; a page opened again (after the
 * tab slept, or a remount) gets it in its init and puts the view back ONCE after opening. Only the place: no content,
 * no selection of text, nothing that could touch unsaved edits. The undo history is not kept (each editor starts it
 * again on opening).
 */
export type ViewParts = {
  /** Where the view is now; null while the editor is not ready to say. */
  read(): OfficeViewPosition | null;
  /** Put the view there; true when it is (false: not yet — tried again until the bound). */
  restore(position: OfficeViewPosition): boolean | Promise<boolean>;
};

type Timers = Pick<Window, "setInterval" | "clearInterval" | "setTimeout" | "clearTimeout">;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The scroll of one scroller, with the fraction used when the content's height differs on the way back. */
export function readScroll(element: HTMLElement | null | undefined): OfficeViewPosition["scroll"] | undefined {
  // Not laid out (the tab is behind another, its frame hidden): a scroller reads 0 there — never said as the place.
  if (!element || element.clientHeight === 0) return undefined;
  const range = element.scrollHeight - element.clientHeight;
  return { top: Math.round(element.scrollTop), left: Math.round(element.scrollLeft), fraction: range > 0 ? Math.round((element.scrollTop / range) * 10_000) / 10_000 : 0 };
}

/** Puts a scroller back: true once it is there (or as near as its content allows), false while it cannot scroll yet. */
export function restoreScroll(element: HTMLElement | null | undefined, scroll: OfficeViewPosition["scroll"]): boolean {
  if (!scroll) return true;
  if (!element) return false;
  const range = element.scrollHeight - element.clientHeight;
  if (scroll.top > 0 && range <= 0) return false;
  // The same height as before → the same pixels; another height (fonts, another zoom) → the same share of the document.
  const top = range >= scroll.top ? scroll.top : Math.round(scroll.fraction * range);
  element.scrollTop = top; element.scrollLeft = scroll.left;
  return Math.abs(element.scrollTop - top) <= 2;
}

/** The page's main scroller when an editor has no named one: the largest box whose content scrolls. */
export function largestScroller(doc: Document, holds: (el: HTMLElement) => boolean = () => true): HTMLElement | null {
  let best: HTMLElement | null = null, area = 0;
  for (const el of doc.querySelectorAll<HTMLElement>("body *")) {
    if (el.closest(".ai-dock, .copilot, .ai-panel, .wb-hwp-hold")) continue;
    if (el.scrollHeight - el.clientHeight < 8 && el.scrollWidth - el.clientWidth < 8) continue;
    const overflow = getComputedStyle(el);
    if (!/(auto|scroll)/.test(overflow.overflowY + overflow.overflowX) || !holds(el)) continue;
    const r = el.getBoundingClientRect(), a = r.width * r.height;
    if (a > area) { best = el; area = a; }
  }
  return best;
}

export function installViewPosition(parts: ViewParts, options: { initial?: OfficeViewPosition | null; post(position: OfficeViewPosition): void; timers?: Timers; everyMs?: number; restoreForMs?: number; shown?: () => boolean }) {
  options = { shown: () => typeof window === "undefined" || (window.innerWidth > 0 && window.innerHeight > 0), ...options };
  const timers = options.timers ?? window;
  const every = options.everyMs ?? 1000;
  let last: OfficeViewPosition | null = options.initial ?? null;
  let restoring = Boolean(options.initial && Object.keys(options.initial).length);
  let until = Date.now() + (options.restoreForMs ?? 15_000);
  let busy = false, lastLook = 0, lastTick = Date.now();
  const look = () => {
    // A page whose frame is not laid out (its tab behind another) has no place to say.
    if (options.shown && !options.shown()) return;
    let now: OfficeViewPosition | null = null;
    try { now = parts.read(); } catch { now = null; }
    if (now && !same(now, last)) { last = now; options.post(now); }
  };
  const tick = async () => {
    if (busy) return;
    // A page at rest gets no ticks (page-rest.ts holds its timers): that time does not count against the restore.
    const gap = Date.now() - lastTick; lastTick = Date.now();
    if (gap > 1000) until += gap;
    busy = true;
    try {
      if (restoring) {
        // A page opened behind another tab (a reopened editor of a hidden tab): it puts the view back when it is shown;
        // its bound counts only time on screen.
        if (options.shown && !options.shown()) { until += 200; return; }
        // Nothing is said before the view is back (a booting editor at its top would overwrite where the tab was).
        let done = false;
        try { done = await parts.restore(options.initial!); } catch { done = false; }
        if (done || Date.now() > until) { restoring = false; lastLook = Date.now(); }
        return;
      }
      if (Date.now() - lastLook < every) return;
      lastLook = Date.now();
      look();
    } finally { busy = false; }
  };
  const id = timers.setInterval(() => void tick(), 200);
  return {
    /**
     * Put the view back where it was last said to be — after the editor loaded a new revision in place, which a
     * hidden tab's page does while it is not laid out (its scroll cannot be set then): done when it is shown.
     */
    again: (position?: OfficeViewPosition | null) => {
      const target = position ?? last;
      if (!target || !Object.keys(target).length) return;
      options.initial = target; restoring = true; until = Date.now() + (options.restoreForMs ?? 15_000);
    },
    /** The place last said. */
    last: () => last,
    /** Read now (before the page goes away). */
    flush: () => { if (!restoring) look(); },
    get restoring() { return restoring; },
    dispose: () => timers.clearInterval(id),
  };
}

/** The parts for an editor whose place is its main scroller (PDF, Markdown, HTML): `holds` says the scroller is the document's. */
export function scrollerParts(doc: Document, holds: (el: HTMLElement) => boolean): ViewParts {
  let known: HTMLElement | null = null;
  const find = () => (known && known.isConnected ? known : (known = largestScroller(doc, holds)));
  return {
    read: () => { const scroll = readScroll(find()); return scroll ? { scroll } : null; },
    restore: (position) => restoreScroll(find(), position.scroll),
  };
}
