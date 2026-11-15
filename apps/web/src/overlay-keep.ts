import { useEffect, useRef } from "react";

/**
 * The laid-over list column (a phone, a narrow window) closes when what is on screen changes — except
 * after a project was chosen in it (its inside is what the person asked for). That exception lasts until
 * the next choice in the column, not for a time window (tech review N2: a slow phone's view arrived after
 * 400 ms and the column closed instead of showing the project).
 */
export function useOverlayKeep(viewKey: string, close: () => void) {
  const keep = useRef(false);
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (keep.current) { keep.current = false; return; }
    latest.current();
  }, [viewKey]);
  return {
    /** A project was chosen: the next change of view keeps the column open — only when the choice changes
     *  the view (`moves`); a project already on screen arms nothing (re-review 1, next round 8). */
    keepOpen: (moves = true) => { keep.current = moves; },
    /** An item was chosen to open: the column closes now, and no earlier keep survives it. */
    chosen: () => { keep.current = false; latest.current(); },
  };
}

/** Does choosing project `target` change what is on screen? `found`: the tab the choice brings back
 *  (its most recent), else its project page opens. */
export function projectChoiceMoves(now: { focusedTabId: string; focusedWorkId: string | null; viewKind: string }, target: string, found: string | null): boolean {
  if (found) return found !== now.focusedTabId;
  return !(now.viewKind === "project" && now.focusedWorkId === target);
}
