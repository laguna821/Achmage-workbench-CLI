import { useEffect } from "react";
// "내비게이터로" (⋯ › 단축키, Ctrl+Shift+E by default): the focus goes to the navigator's list (or the
// tree). The sidebar may not be there yet when asked (it was hidden), so the request waits for it.

let wanted = false;
const listeners = new Set<() => void>();

export function requestNavigatorFocus() {
  wanted = true;
  for (const listener of listeners) listener();
}

/** The sidebar takes a waiting request (true once, then the request is gone). */
export function takeNavigatorFocus(): boolean {
  const was = wanted;
  wanted = false;
  return was;
}

export function onNavigatorFocus(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// A dialog opened from a menu gives the focus back to where the menu came from (a sidebar row, a ⋯
// button). Left on the page instead, Enter and Esc would answer a waiting approval.
let origin: { element: HTMLElement; at: number } | null = null;

/** Where the menu being used came from, noted when one of its items is chosen (or when it opens). */
export function markMenuOrigin(element: Element | null | undefined) {
  origin = element instanceof HTMLElement ? { element, at: Date.now() } : null;
}

/** That origin, once, while it is still recent and on the page. */
export function takeMenuOrigin(maxAgeMs = 60_000): HTMLElement | null {
  const taken = origin;
  origin = null;
  return taken && Date.now() - taken.at <= maxAgeMs && taken.element.isConnected ? taken.element : null;
}

/** The row a menu's anchor belongs to: the anchor's own row, or at a point (right-click) the row under it. */
export function rowOfAnchor(anchor: Element | { x: number; y: number } | null | undefined): HTMLElement | null {
  if (!anchor) return null;
  const element = anchor instanceof Element ? anchor : typeof document.elementFromPoint === "function" ? document.elementFromPoint(anchor.x, anchor.y) : null;
  return element?.closest<HTMLElement>("[data-row-id]") ?? (anchor instanceof HTMLElement ? anchor : null);
}

/** For a dialog opened from a menu: on closing, the focus returns to the menu's origin unless it already went somewhere. */
export function useReturnFocus() {
  useEffect(() => {
    const to = takeMenuOrigin();
    return () => {
      if (!to) return;
      // After the dialog is gone from the page (its own focused control goes with it).
      window.setTimeout(() => {
        const active = document.activeElement;
        if (to.isConnected && (!active || active === document.body)) to.focus({ preventScroll: true });
      }, 0);
    };
  }, []);
}
