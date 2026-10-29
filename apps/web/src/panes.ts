// Two panes side by side (2026-10-29: "볼트와 작업공간을 같이 … 듀얼로 드래그해서 작업창을 만들어서").
// The main area shows one view, or two: something dragged onto its left or right half (or "오른쪽에
// 열기") opens there. Sidebar clicks open into the focused pane. Plain data here (no React), so the
// rules can be tested; the app keeps the views themselves (`V`).

export type PaneId = string;
export type Side = "left" | "right" | "top" | "bottom";
export type PaneTarget = { paneId: PaneId; side: Side | "center"; tabIndex?: number };
export type PaneTree = { kind: "pane"; id: PaneId } | { kind: "split"; id: string; axis: "horizontal" | "vertical"; ratio: number; first: PaneTree; second: PaneTree };

/**
 * One pane: the view it shows, the work that view belongs to, and — only while another pane has the
 * focus — the session it keeps showing. The focused pane follows its work's active session, so a
 * session started there shows at once; a pane that loses the focus keeps the session it showed.
 */
export type TabUiState = { cursor?: { anchor: number; head: number }; scroll?: { top: number; left: number }; mode?: string; chatScroll?: { top: number; follow: boolean }; terminalScroll?: { line: number; follow: boolean }; reading?: { page: number | null; fraction: number; top?: number } };
export type PaneTab<V> = { id: string; view: V; workId: string | null; sessionId: string | null; ui?: TabUiState };
export type Pane<V> = { id: PaneId; view: V; workId: string | null; sessionId: string | null; tabs?: PaneTab<V>[]; activeTabId?: string; recentTabIds?: string[] };

/** What a pane shows, without which pane it is. */
export type PaneContent<V> = Pick<Pane<V>, "view" | "workId" | "sessionId">;

/** The panes from left to right (one or two) and the focused one. */
export type Layout<V> = { panes: Pane<V>[]; focus: PaneId; tree?: PaneTree };

/** Something that can be opened in a pane: a sidebar row, a card, a tab, or a pane itself (its header). */
export type PaneItem =
  | { kind: "session"; id: string }
  | { kind: "work"; id: string }
  | { kind: "doc"; id: string }
  | { kind: "project"; id: string }
  | { kind: "note"; path: string }
  | { kind: "vault"; path: string }
  | { kind: "folder"; id: string }
  | { kind: "pane"; id: PaneId }
  | { kind: "tab"; id: string };

/** A pane narrower than this is not usable (the input's controls stop fitting). */
export const MIN_PANE = 360;
/** The divider between the panes (its line is 1px; the rest is room to grab it). */
export const DIVIDER = 7;
export const MIN_PANE_HEIGHT = 220;
export const MAX_PANES = 16;
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

export function singleLayout<V>(view: V, workId: string | null): Layout<V> {
  return { panes: [{ id: "a", view, workId, sessionId: null }], focus: "a" };
}

export const paneById = <V>(layout: Layout<V>, id: PaneId): Pane<V> | undefined => layout.panes.find((pane) => pane.id === id);
export const focusedPane = <V>(layout: Layout<V>): Pane<V> => paneById(layout, layout.focus) ?? layout.panes[0]!;
export const otherPane = <V>(layout: Layout<V>): Pane<V> | null => layout.panes.length > 1 ? layout.panes[(layout.panes.findIndex((pane) => pane.id === layout.focus) + 1) % layout.panes.length]! : null;
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
    ...layout,
    focus: id,
    // Tabs own their session identity. Legacy focus pins must never create a new tab on blur.
    panes: layout.panes.map((pane) => pane.tabs ? pane : (pane.id === layout.focus ? { ...pane, sessionId: keep } : pane.id === id ? { ...pane, sessionId: null } : pane)),
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
  if (layout.panes.length > 2 || side === "top" || side === "bottom") return placeAt(layout, content, { paneId: layout.focus, side }, keep, shows);
  const effect = dropEffect(layout, side, shows);
  const kept = (pane: Pane<V>, focus: PaneId) => (pane.id === layout.focus && pane.id !== focus ? { ...pane, sessionId: keep } : pane);
  if (layout.panes.length === 1) {
    const only = layout.panes[0]!;
    if (effect === "none") return layout;
    const added: Pane<V> = { ...content, id: only.id === "a" ? "b" : "a", sessionId: null };
    const stays = kept(only, added.id);
    const panes = side === "left" ? [added, stays] : [stays, added];
    return { panes, focus: added.id, tree: treeOf({ panes, focus: added.id }) };
  }
  const [left, right] = layout.panes as [Pane<V>, Pane<V>];
  const target = side === "left" ? left : right;
  const other = side === "left" ? right : left;
  if (effect === "none") return focusPane(layout, target.id, keep);
  if (effect === "swap") {
    const moved = { ...swapPanePositions(layout, left.id, right.id), panes: [right, left].map((pane) => kept(pane, other.id)), focus: other.id };
    return setPane(moved, other.id, { sessionId: null });
  }
  return {
    ...layout,
    panes: layout.panes.map((pane) => (pane.id === target.id ? { ...pane, ...content, sessionId: null } : kept(pane, target.id))),
    focus: target.id,
  };
}

/** Close a pane: the other one is all that is left, and has the focus (it follows its work again). */
export function closePane<V>(layout: Layout<V>, id: PaneId): Layout<V> {
  if (layout.panes.length < 2 || !paneById(layout, id)) return layout;
  const tree = removeLeaf(treeOf(layout), id)!;
  const rest = orderedPanes(tree, layout.panes);
  const focus = layout.focus === id ? rest[Math.min(layout.panes.findIndex((pane) => pane.id === id), rest.length - 1)]!.id : layout.focus;
  return { tree, panes: rest.map((pane) => pane.id === focus && !pane.tabs ? { ...pane, sessionId: null } : pane), focus };
}

/** The two panes trade sides; the focus stays with the same pane. */
export function swapPanes<V>(layout: Layout<V>): Layout<V> {
  const other = otherPane(layout);
  return other ? swapPanePositions(layout, layout.focus, other.id) : layout;
}

/** The pane (other than the focused one) that shows something already, so a click can go there instead. */
export function shownElsewhere<V>(layout: Layout<V>, shows: (pane: Pane<V>) => boolean): PaneId | null {
  return layout.panes.find((pane) => pane.id !== layout.focus && shows(pane))?.id ?? null;
}

/** Migrate the original one/two-pane shape without changing pane or content identities. */
export function treeOf<V>(layout: Layout<V>): PaneTree {
  if (layout.tree) return layout.tree;
  return layout.panes.slice(1).reduce<PaneTree>((first, pane, index) => ({ kind: "split", id: `legacy-${index}`, axis: "horizontal", ratio: 0.5, first, second: { kind: "pane", id: pane.id } }), { kind: "pane", id: layout.panes[0]!.id });
}

export const leafIds = (tree: PaneTree): string[] => tree.kind === "pane" ? [tree.id] : [...leafIds(tree.first), ...leafIds(tree.second)];
const orderedPanes = <V>(tree: PaneTree, panes: Pane<V>[]) => leafIds(tree).map((id) => panes.find((pane) => pane.id === id)!);
const mapTree = (tree: PaneTree, map: (node: PaneTree) => PaneTree): PaneTree => map(tree.kind === "split" ? { ...tree, first: mapTree(tree.first, map), second: mapTree(tree.second, map) } : tree);

function removeLeaf(tree: PaneTree, id: string): PaneTree | null {
  if (tree.kind === "pane") return tree.id === id ? null : tree;
  const first = removeLeaf(tree.first, id);
  const second = removeLeaf(tree.second, id);
  return first && second ? { ...tree, first, second } : first ?? second;
}

function uniqueId(tree: PaneTree, prefix: string) {
  const ids = new Set<string>();
  mapTree(tree, (node) => { ids.add(node.id); return node; });
  let index = 1;
  while (ids.has(`${prefix}${index}`)) index++;
  return `${prefix}${index}`;
}

function insertLeaf(tree: PaneTree, target: string, added: PaneTree, side: Side): PaneTree {
  const splitId = uniqueId(tree, "split-");
  return mapTree(tree, (node) => node.kind === "pane" && node.id === target ? {
    kind: "split", id: splitId, axis: side === "top" || side === "bottom" ? "vertical" : "horizontal", ratio: 0.5,
    first: side === "left" || side === "top" ? added : node,
    second: side === "left" || side === "top" ? node : added,
  } : node);
}

export function splitPane<V>(layout: Layout<V>, target: PaneId, side: Side, content: PaneContent<V>, keep: string | null): Layout<V> {
  if (!paneById(layout, target) || layout.panes.length >= MAX_PANES) return layout;
  const oldTree = treeOf(layout);
  const id = uniqueId(oldTree, "pane-");
  const tree = insertLeaf(oldTree, target, { kind: "pane", id }, side);
  const panes = [...layout.panes.map((pane) => pane.id === layout.focus && !pane.tabs ? { ...pane, sessionId: keep } : pane), { ...content, id }];
  return { tree, panes: orderedPanes(tree, panes), focus: id };
}

export function swapPanePositions<V>(layout: Layout<V>, a: PaneId, b: PaneId): Layout<V> {
  if (a === b || !paneById(layout, a) || !paneById(layout, b)) return layout;
  const tree = mapTree(treeOf(layout), (node) => node.kind === "pane" ? { ...node, id: node.id === a ? b : node.id === b ? a : node.id } : node);
  return { ...layout, tree, panes: orderedPanes(tree, layout.panes) };
}

/** Move a whole pane without unmounting its content or closing its session. */
export function movePane<V>(layout: Layout<V>, id: PaneId, target: PaneTarget): Layout<V> {
  if (id === target.paneId || !paneById(layout, id) || !paneById(layout, target.paneId)) return layout;
  if (target.side === "center") return swapPanePositions(layout, id, target.paneId);
  const rest = removeLeaf(treeOf(layout), id)!;
  const tree = insertLeaf(rest, target.paneId, { kind: "pane", id }, target.side);
  return { ...layout, tree, panes: orderedPanes(tree, layout.panes) };
}

export function effectAt<V>(layout: Layout<V>, target: PaneTarget, shows: (pane: Pane<V>) => boolean): DropEffect {
  const current = layout.panes.find(shows);
  if (current?.id === target.paneId) return "none";
  if (current) return "swap";
  return target.side === "center" ? "replace" : layout.panes.length < MAX_PANES ? "split" : "none";
}

export function placeAt<V>(layout: Layout<V>, content: PaneContent<V>, target: PaneTarget, keep: string | null, shows: (pane: Pane<V>) => boolean): Layout<V> {
  if (!paneById(layout, target.paneId)) return layout;
  const existing = layout.panes.find(shows);
  if (existing) return focusPane(movePane(layout, existing.id, target), existing.id, keep);
  if (target.side === "center") return setPane(focusPane(layout, target.paneId, keep), target.paneId, content);
  return splitPane(layout, target.paneId, target.side, content, keep);
}

export function resizeSplit<V>(layout: Layout<V>, id: string, ratio: number): Layout<V> {
  return { ...layout, tree: mapTree(treeOf(layout), (node) => node.kind === "split" && node.id === id ? { ...node, ratio: Math.max(0.1, Math.min(0.9, Number.isFinite(ratio) ? ratio : 0.5)) } : node) };
}

export type PaneRect = { left: number; top: number; width: number; height: number };
export type DividerRect = PaneRect & { id: string; axis: "horizontal" | "vertical"; parent: PaneRect; ratio: number; min: number; max: number };
export function minimumSize(tree: PaneTree): { width: number; height: number } {
  if (tree.kind === "pane") return { width: MIN_PANE, height: MIN_PANE_HEIGHT };
  const a = minimumSize(tree.first), b = minimumSize(tree.second);
  return tree.axis === "horizontal" ? { width: a.width + b.width + DIVIDER, height: Math.max(a.height, b.height) } : { width: Math.max(a.width, b.width), height: a.height + b.height + DIVIDER };
}

/** Flat rectangles keep React's editor keys/parents stable when panes move in the tree. */
export function paneGeometry(tree: PaneTree, width: number, height: number) {
  const panes: Record<string, PaneRect> = {};
  const dividers: DividerRect[] = [];
  const walk = (node: PaneTree, box: PaneRect) => {
    if (node.kind === "pane") { panes[node.id] = box; return; }
    const horizontal = node.axis === "horizontal";
    const dimension = horizontal ? "width" : "height";
    const available = Math.max(0, box[dimension] - DIVIDER);
    const min = Math.max(0.1, available ? minimumSize(node.first)[dimension] / available : 0.5);
    const max = Math.min(0.9, available ? 1 - minimumSize(node.second)[dimension] / available : 0.5);
    const ratio = min > max ? 0.5 : Math.max(min, Math.min(max, node.ratio));
    const size = available * ratio;
    dividers.push({ ...box, id: node.id, axis: node.axis, parent: box, ratio, min, max, ...(horizontal ? { left: box.left + size, width: DIVIDER } : { top: box.top + size, height: DIVIDER }) });
    walk(node.first, { ...box, [dimension]: size });
    walk(node.second, { ...box, [dimension]: available - size, ...(horizontal ? { left: box.left + size + DIVIDER } : { top: box.top + size + DIVIDER }) });
  };
  walk(tree, { left: 0, top: 0, width, height });
  return { panes, dividers };
}

/** Validate persisted layouts before rendering; reject duplicate/missing leaves and unknown views. */
export function restoreLayout<V>(raw: unknown, isView: (value: unknown) => value is V, fallback: Layout<V>): Layout<V> {
  if (!raw || typeof raw !== "object") return fallback;
  const data = raw as Partial<Layout<V>> & { version?: unknown };
  if (data.version !== undefined && data.version !== 1 && data.version !== 2) return fallback;
  if (!Array.isArray(data.panes) || !data.panes.length || data.panes.length > MAX_PANES) return fallback;
  const panes: Pane<V>[] = [];
  const tabIds = new Set<string>();
  for (const pane of data.panes) {
    if (!pane || typeof pane.id !== "string" || !/^[\w-]{1,80}$/.test(pane.id) || !isView(pane.view) || !(pane.workId === null || typeof pane.workId === "string") || !(pane.sessionId === null || typeof pane.sessionId === "string")) return fallback;
    const restored: Pane<V> = { id: pane.id, view: pane.view, workId: pane.workId, sessionId: pane.sessionId };
    if (pane.tabs !== undefined) {
      if (!Array.isArray(pane.tabs) || !pane.tabs.length || pane.tabs.length > 128) return fallback;
      restored.tabs = [];
      for (const tab of pane.tabs) {
        if (!tab || typeof tab.id !== "string" || !/^[\w-]{1,100}$/.test(tab.id) || tabIds.has(tab.id) || !isView(tab.view) || !(tab.workId === null || typeof tab.workId === "string") || !(tab.sessionId === null || typeof tab.sessionId === "string")) return fallback;
        tabIds.add(tab.id);
        if (tabIds.size > 128) return fallback;
        const ui: TabUiState = {};
        if (tab.ui?.cursor && [tab.ui.cursor.anchor, tab.ui.cursor.head].every((n) => Number.isSafeInteger(n) && n >= 0)) ui.cursor = { anchor: tab.ui.cursor.anchor, head: tab.ui.cursor.head };
        if (tab.ui?.scroll && [tab.ui.scroll.top, tab.ui.scroll.left].every((n) => Number.isFinite(n) && n >= 0)) ui.scroll = { top: tab.ui.scroll.top, left: tab.ui.scroll.left };
        if (typeof tab.ui?.mode === "string" && tab.ui.mode.length < 40) ui.mode = tab.ui.mode;
        if (tab.ui?.chatScroll && Number.isFinite(tab.ui.chatScroll.top) && tab.ui.chatScroll.top >= 0 && typeof tab.ui.chatScroll.follow === "boolean") ui.chatScroll = { top: tab.ui.chatScroll.top, follow: tab.ui.chatScroll.follow };
        if (tab.ui?.terminalScroll && Number.isSafeInteger(tab.ui.terminalScroll.line) && tab.ui.terminalScroll.line >= 0 && typeof tab.ui.terminalScroll.follow === "boolean") ui.terminalScroll = { line: tab.ui.terminalScroll.line, follow: tab.ui.terminalScroll.follow };
        if (tab.ui?.reading && (tab.ui.reading.page === null || (Number.isSafeInteger(tab.ui.reading.page) && tab.ui.reading.page >= 0)) && Number.isFinite(tab.ui.reading.fraction)) ui.reading = { page: tab.ui.reading.page, fraction: Math.max(0, Math.min(1, tab.ui.reading.fraction)), ...(typeof tab.ui.reading.top === "number" && tab.ui.reading.top >= 0 ? { top: tab.ui.reading.top } : {}) };
        restored.tabs.push({ id: tab.id, view: tab.view, workId: tab.workId, sessionId: tab.sessionId, ...(Object.keys(ui).length ? { ui } : {}) });
      }
      const active = restored.tabs.find((tab) => tab.id === pane.activeTabId) ?? restored.tabs[0]!;
      restored.activeTabId = active.id;
      restored.recentTabIds = [active.id, ...new Set((pane.recentTabIds ?? []).filter((id) => id !== active.id && restored.tabs!.some((tab) => tab.id === id)))];
      restored.view = active.view; restored.workId = active.workId; restored.sessionId = active.sessionId;
    } else if (data.version === 2) return fallback;
    panes.push(restored);
  }
  if (new Set(panes.map((pane) => pane.id)).size !== panes.length) return fallback;
  const focus = panes.some((pane) => pane.id === data.focus) ? data.focus! : panes[0]!.id;
  const seen = new Set<string>();
  const parse = (value: unknown, depth = 0): PaneTree | null => {
    if (!value || typeof value !== "object" || depth > MAX_PANES) return null;
    const node = value as PaneTree;
    if (typeof node.id !== "string" || seen.has(node.id)) return null;
    seen.add(node.id);
    if (node.kind === "pane") return panes.some((pane) => pane.id === node.id) ? { kind: "pane", id: node.id } : null;
    if (node.kind !== "split" || (node.axis !== "horizontal" && node.axis !== "vertical") || typeof node.ratio !== "number" || !Number.isFinite(node.ratio)) return null;
    const first = parse(node.first, depth + 1), second = parse(node.second, depth + 1);
    return first && second ? { kind: "split", id: node.id, axis: node.axis, ratio: Math.max(0.1, Math.min(0.9, node.ratio)), first, second } : null;
  };
  const tree = data.tree === undefined ? treeOf({ panes, focus }) : parse(data.tree);
  if (!tree || leafIds(tree).length !== panes.length) return fallback;
  return { tree, panes: orderedPanes(tree, panes), focus };
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
