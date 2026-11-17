// A tab held over a tab strip (0.5.3 window-ux): where it goes, and where the strip draws its insertion mark.
// The index is the tab's place AFTER the move (what moveTab and Ctrl+Shift+←→ take): the held tab's own
// place is not counted, so the mark the person sees and the place the tab lands are the same.

/** A tab of the strip on screen: its index among the pane's tabs and its horizontal extent. */
export type StripRow = { index: number; left: number; width: number };

/** The index a drop at `x` gives; `held` is the held tab's index when it is a tab of this same pane. */
export function stripDropIndex(rows: StripRow[], x: number, held?: number): number {
  const before = rows.find((row) => x < row.left + row.width / 2);
  const raw = before ? before.index : rows.length ? Math.max(...rows.map((row) => row.index)) + 1 : 0;
  return held !== undefined && held < raw ? raw - 1 : raw;
}

/**
 * Where the insertion mark is drawn for a drop at `index`: before a tab, or after the last one; null when
 * dropping there changes nothing (the held tab is already there) or there is nothing to mark against.
 */
export function stripMark(ids: string[], heldId: string | null, index: number, shown: (id: string) => boolean = () => true): { before: string } | { after: string } | null {
  if (heldId !== null && ids.indexOf(heldId) === index) return null;
  const rest = ids.filter((id) => id !== heldId);
  const target = rest.slice(index).find(shown);
  if (target !== undefined) return { before: target };
  const last = [...rest].reverse().find(shown);
  return last === undefined ? null : { after: last };
}
