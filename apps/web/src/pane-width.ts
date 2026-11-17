import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * 0.5.4: a pane at most this many px high is "short" (Panes.tsx `data-short`, from the pane's own box in the
 * layout, never the window's height): it takes the dense grid's forms (styles/hig-chat.css) — the one-row input
 * while the input is not focused, a compact head always. Measured (Chromium, design-shots pane-6-2560): a pane
 * with its tab strip, note head and full input keeps its height minus 183 px for the conversation; five lines of
 * an answer (17 px × 1.75) are 149 px. So a pane up to 332 px would show fewer than five lines with the full
 * input. (The one-row input and compact head take 95 px: a 220 px pane, the smallest, keeps 125 px.)
 */
export const PANE_SHORT_HEIGHT = 332;
/** Whether a pane of this height (px) is short (see PANE_SHORT_HEIGHT); an unmeasured pane (0) is not. */
export const paneShort = (height: number) => height > 0 && height <= PANE_SHORT_HEIGHT;

/**
 * Whether the pane an element is drawn in is at most `limit` px wide — the JS twin of
 * `@container work-pane (max-width: <limit>px)` (styles/hig-workspace.css: every pane is the
 * `work-pane` container). Up to nine panes share a window, so what a pane's content can show
 * follows the pane, never `innerWidth`: a 420 px pane in a 2560 px window is narrow.
 *
 * The width measured is the pane's content box (its `clientWidth`, as the container query
 * measures it), or the conversation's column when a web page or document is beside it. Outside a pane (a dialog, a test without layout) the window decides, as before.
 */
export function usePaneNarrow(ref: RefObject<Element | null>, limit: number): boolean {
  const query = `(max-width: ${limit}px)`;
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.(query).matches));
  useLayoutEffect(() => {
    const pane = ref.current?.closest(".pane");
    if (pane instanceof HTMLElement && typeof ResizeObserver !== "undefined") {
      // Beside a web page or document the conversation's column is the container (styles/companion.css);
      // whether a page is beside it changes while it is drawn, so both boxes are watched.
      const chat = ref.current?.closest(".beside-chat");
      const column = chat instanceof HTMLElement && pane.contains(chat) ? chat : null;
      const box = () => column && column.parentElement?.dataset.fit !== "single" ? column : pane;
      const measure = () => { const width = box().clientWidth; if (width > 0) setNarrow(width <= limit); };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(pane);
      if (column) observer.observe(column);
      return () => observer.disconnect();
    }
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [ref, limit, query]);
  return narrow;
}
