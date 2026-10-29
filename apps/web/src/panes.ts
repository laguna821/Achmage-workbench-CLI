// Two panes side by side (2026-10-29: "볼트와 작업공간을 같이 … 듀얼로 드래그해서 작업창을 만들어서").
// The main area shows one view, or two: something dragged onto its left or right half (or "오른쪽에
// 열기") opens there. Sidebar clicks open into the focused pane. Plain data here (no React), so the
// rules can be tested; the app keeps the views themselves (`V`).

export type PaneId = "a" | "b";
export type Side = "left" | "right";

/**
 * One pane: the view it shows, the work that view belongs to, and — only while another pane has the
 * focus — the session it keeps showing. The focused pane follows its work's active session, so a
 * session started there shows at once; a pane that loses the focus keeps the session it showed.
 */
export type Pane<V> = { id: PaneId; view: V; workId: string | null; sessionId: string | null };

/** What a pane shows, without which pane it is. */
export type PaneContent<V> = Omit<Pane<V>, "id">;

/** The panes from left to right (one or two) and the focused one. */
export type Layout<V> = { panes: Pane<V>[]; focus: PaneId };

/** Something that can be opened in a pane: a sidebar row, a card, a tab, or a pane itself (its header). */
export type PaneItem =
  | { kind: "session"; id: string }
  | { kind: "work"; id: string }
  | { kind: "doc"; id: string }
  | { kind: "project"; id: string }
  | { kind: "note"; path: string }
  | { kind: "vault"; path: string }
  | { kind: "folder"; id: string }
  | { kind: "pane"; id: PaneId };

/** A pane narrower than this is not usable (the input's controls stop fitting). */
export const MIN_PANE = 360;
/** The divider between the panes (its line is 1px; the rest is room to grab it). */
export const DIVIDER = 7;
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

export function singleLayout<V>(view: V, workId: string | null): Layout<V> {
  return { panes: [{ id: "a", view, workId, sessionId: null }], focus: "a" };
}

export const paneById = <V>(layout: Layout<V>, id: PaneId): Pane<V> | undefined => layout.panes.find((pane) => pane.id === id);
export const focusedPane = <V>(layout: Layout<V>): Pane<V> => paneById(layout, layout.focus) ?? layout.panes[0]!;
export const otherPane = <V>(layout: Layout<V>): Pane<V> | null => layout.panes.find((pane) => pane.id !== layout.focus) ?? null;
export const sideOf = <V>(layout: Layout<V>, id: PaneId): Side => (layout.panes.length === 2 && layout.panes[1]!.id === id ? "right" : "left");

/** Change what one pane shows; the other stays as it is. */
export function setPane<V>(layout: Layout<V>, id: PaneId, patch: Partial<PaneContent<V>>): Layout<V> {
  if (!paneById(layout, id)) return layout;
  return { ...layout, panes: layout.panes.map((pane) => (pane.id === id ? { ...pane, ...patch } : pane)) };
}

/**
 * Give the focus to a pane. The pane losing it keeps showing `keep` (the session on it now); the
 * pane taking it follows its work again — the caller makes the session it kept the work's active one.
 */
export function focusPane<V>(layout: Layout<V>, id: PaneId, keep: string | null): Layout<V> {
  if (layout.focus === id || !paneById(layout, id)) return layout;
  return {
    focus: id,
    panes: layout.panes.map((pane) => (pane.id === layout.focus ? { ...pane, sessionId: keep } : pane.id === id ? { ...pane, sessionId: null } : pane)),
  };
}

/** What a drop (or "오른쪽에 열기") on a side does. */
export type DropEffect = "split" | "replace" | "swap" | "none";

export function dropEffect<V>(layout: Layout<V>, side: Side, shows: (pane: Pane<V>) => boolean): DropEffect {
  if (layout.panes.length === 1) return shows(layout.panes[0]!) ? "none" : "split";
  const [left, right] = layout.panes as [Pane<V>, Pane<V>];
  const target = side === "left" ? left : right;
  const other = side === "left" ? right : left;
  if (shows(target)) return "none";
  return shows(other) ? "swap" : "replace";
}

/**
 * Open something on a side. One pane: a second pane opens there. Two: the pane on that side shows
 * it instead — or, when the other pane already shows it, the two trade places so it lands where it
 * was dropped (never the same session or document twice). The pane it lands in takes the focus;
 * the pane losing the focus keeps `keep`.
 */
export function placeOnSide<V>(layout: Layout<V>, content: PaneContent<V>, side: Side, keep: string | null, shows: (pane: Pane<V>) => boolean): Layout<V> {
  const effect = dropEffect(layout, side, shows);
  const kept = (pane: Pane<V>, focus: PaneId) => (pane.id === layout.focus && pane.id !== focus ? { ...pane, sessionId: keep } : pane);
  if (layout.panes.length === 1) {
    const only = layout.panes[0]!;
    if (effect === "none") return layout;
    const added: Pane<V> = { ...content, id: only.id === "a" ? "b" : "a", sessionId: null };
    const stays = kept(only, added.id);
    return { panes: side === "left" ? [added, stays] : [stays, added], focus: added.id };
  }
  const [left, right] = layout.panes as [Pane<V>, Pane<V>];
  const target = side === "left" ? left : right;
  const other = side === "left" ? right : left;
  if (effect === "none") return focusPane(layout, target.id, keep);
  if (effect === "swap") {
    const moved = { panes: [right, left].map((pane) => kept(pane, other.id)), focus: other.id };
    return setPane(moved, other.id, { sessionId: null });
  }
  return {
    panes: layout.panes.map((pane) => (pane.id === target.id ? { ...pane, ...content, sessionId: null } : kept(pane, target.id))),
    focus: target.id,
  };
}

/** Close a pane: the other one is all that is left, and has the focus (it follows its work again). */
export function closePane<V>(layout: Layout<V>, id: PaneId): Layout<V> {
  if (layout.panes.length < 2 || !paneById(layout, id)) return layout;
  const rest = layout.panes.find((pane) => pane.id !== id)!;
  return { panes: [{ ...rest, sessionId: null }], focus: rest.id };
}

/** The two panes trade sides; the focus stays with the same pane. */
export function swapPanes<V>(layout: Layout<V>): Layout<V> {
  return layout.panes.length === 2 ? { ...layout, panes: [layout.panes[1]!, layout.panes[0]!] } : layout;
}

/** The pane (other than the focused one) that shows something already, so a click can go there instead. */
export function shownElsewhere<V>(layout: Layout<V>, shows: (pane: Pane<V>) => boolean): PaneId | null {
  return layout.panes.find((pane) => pane.id !== layout.focus && shows(pane))?.id ?? null;
}

// ── the divider ───────────────────────────────────────────────────────────────────────────────

/** The left pane's share of the width, kept so neither pane is narrower than it can be used. */
export function clampRatio(ratio: number, width = 0): number {
  let low = MIN_RATIO;
  let high = MAX_RATIO;
  if (width > DIVIDER) {
    const least = MIN_PANE / (width - DIVIDER);
    low = Math.max(low, least);
    high = Math.min(high, 1 - least);
  }
  if (low > high) return 0.5;
  const value = Number.isFinite(ratio) ? ratio : 0.5;
  return Math.min(high, Math.max(low, value));
}

/** The ratio kept in the screen preferences (anything else reads as half and half). */
export const readRatio = (value: unknown) => (typeof value === "number" ? clampRatio(value) : 0.5);

/** Two panes fit side by side (narrower: only the focused one shows, never overlapping). */
export const fitsTwo = (width: number) => width >= MIN_PANE * 2 + DIVIDER;

/** The divider from the keyboard: ←/→ move it (Shift: further), Home/End to the ends; null for other keys. */
export function nudgeRatio(ratio: number, key: string, shift: boolean, width = 0): number | null {
  const step = shift ? 0.1 : 0.02;
  if (key === "ArrowLeft") return clampRatio(ratio - step, width);
  if (key === "ArrowRight") return clampRatio(ratio + step, width);
  if (key === "Home") return clampRatio(0, width);
  if (key === "End") return clampRatio(1, width);
  return null;
}

/** Which side a point is on: the halves of one pane, or the pane under it when there are two. */
export function sideAt(x: number, left: number, width: number, count: number, ratio: number): Side {
  const split = count === 2 ? left + (width - DIVIDER) * ratio + DIVIDER / 2 : left + width / 2;
  return x < split ? "left" : "right";
}
