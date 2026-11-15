import { leafIds, onlyPanes, paneById, treeOf, type Layout, type Pane, type PaneContent, type PaneTree } from "./panes.ts";
import { activeTab, isEmptyTab, tabsOf, withTabs } from "./tabs.ts";

export type PanePreset = 1 | 2 | 4 | 9;

/** Rearrange actual tabs, preserving session/document identities, editors and saved UI state. */
export function applyPanePreset<V>(input: Layout<V>, count: PanePreset, empty: () => PaneContent<V>): Layout<V> {
  const layout = withTabs(input);
  const retained = layout.panes.slice(0, count).map(pane => ({ ...pane, tabs: [...tabsOf(pane)] }));
  // Shrinking a grid keeps every tab: excess panes merge into the focused retained group.
  const dest = retained.find(pane => pane.id === layout.focus) ?? retained[0]!;
  for (const pane of layout.panes.slice(count)) {
    dest.tabs.push(...tabsOf(pane));
    if (pane.id === layout.focus) dest.activeTabId = activeTab(pane).id;
  }
  while (retained.length < count) {
    const donor = retained.find(pane => pane.tabs.length > 1);
    const moved = donor?.tabs.find(tab => tab.id !== activeTab(donor).id);
    if (donor && moved) donor.tabs = donor.tabs.filter(tab => tab.id !== moved.id);
    const tab = moved ?? { ...empty(), id: `tab-${crypto.randomUUID()}` };
    let index = 1; while (retained.some(pane => pane.id === `grid-pane-${index}`)) index++;
    retained.push({ ...tab, id: `grid-pane-${index}`, tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] });
  }
  const panes: Pane<V>[] = retained.map(pane => {
    const active = pane.tabs.find(tab => tab.id === pane.activeTabId) ?? pane.tabs[0]!;
    return { ...pane, view: active.view, workId: active.workId, sessionId: active.sessionId, activeTabId: active.id, recentTabIds: [active.id, ...(pane.recentTabIds ?? []).filter(id => id !== active.id && pane.tabs.some(tab => tab.id === id))] };
  });
  let split = 0;
  const join = (nodes: PaneTree[], axis: "horizontal" | "vertical"): PaneTree => nodes.length === 1 ? nodes[0]! : {
    kind: "split", id: `grid-split-${++split}`, axis, ratio: 1 / nodes.length, first: nodes[0]!, second: join(nodes.slice(1), axis),
  };
  const columns = count === 9 ? 3 : count === 1 ? 1 : 2;
  const rows: PaneTree[] = [];
  for (let i = 0; i < panes.length; i += columns) rows.push(join(panes.slice(i, i + columns).map(pane => ({ kind: "pane", id: pane.id })), "horizontal"));
  return { panes, focus: panes.some(pane => pane.id === layout.focus) ? layout.focus : dest.id, tree: join(rows, "vertical"), ...(count > 1 ? { grid: columns as 2 | 3 } : {}) };
}

/**
 * Project tabs: the preset arranges the panes ON SCREEN (`drawn`: the window's project's, tabs.ts
 * `drawnLayout`) into `count`; the panes of other projects keep their tabs and their place among
 * themselves behind (their part of the tree is joined to the grid, and falls away when drawn).
 * No tab is moved to fill a new pane — the home tab stays where it is; a new pane is empty (inside
 * a project the settle makes it the project's own). Shrinking keeps every tab: the panes past
 * `count` merge into the focused one, their empty places left out.
 */
export function applyDrawnPreset<V>(input: Layout<V>, drawn: Layout<V>, count: PanePreset, empty: () => PaneContent<V>): Layout<V> {
  const layout = withTabs(input);
  const shown = drawn.panes.flatMap((pane) => paneById(layout, pane.id) ?? []);
  const behind = layout.panes.filter((pane) => !shown.includes(pane));
  const retained = shown.slice(0, count).map((pane) => ({ ...pane, tabs: [...tabsOf(pane)] }));
  const dest = retained.find((pane) => pane.id === layout.focus) ?? retained[0]!;
  for (const pane of shown.slice(count)) {
    const kept = tabsOf(pane).filter((tab) => !isEmptyTab(tab));
    dest.tabs.push(...kept);
    if (pane.id === layout.focus && kept.some((tab) => tab.id === activeTab(pane).id)) dest.activeTabId = activeTab(pane).id;
  }
  const rest = behind.length ? treeOf(onlyPanes(layout, behind.map((pane) => pane.id))) : null;
  // Every id in the tree is its own: the part kept behind may hold an earlier grid's ids.
  const taken = new Set<string>(layout.panes.map((pane) => pane.id));
  const collect = (node: PaneTree) => { taken.add(node.id); if (node.kind === "split") { collect(node.first); collect(node.second); } };
  if (rest) collect(rest);
  const fresh = (prefix: string) => { let index = 1; while (taken.has(`${prefix}${index}`)) index++; taken.add(`${prefix}${index}`); return `${prefix}${index}`; };
  while (retained.length < count) {
    const tab = { ...empty(), id: `tab-${crypto.randomUUID()}` };
    retained.push({ ...tab, id: fresh("grid-pane-"), tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] });
  }
  const panes: Pane<V>[] = retained.map((pane) => {
    const active = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0]!;
    return { ...pane, view: active.view, workId: active.workId, sessionId: active.sessionId, activeTabId: active.id, recentTabIds: [active.id, ...(pane.recentTabIds ?? []).filter((id) => id !== active.id && pane.tabs.some((tab) => tab.id === id))] };
  });
  const join = (nodes: PaneTree[], axis: "horizontal" | "vertical"): PaneTree => nodes.length === 1 ? nodes[0]! : {
    kind: "split", id: fresh("grid-split-"), axis, ratio: 1 / nodes.length, first: nodes[0]!, second: join(nodes.slice(1), axis),
  };
  const columns = count === 9 ? 3 : count === 1 ? 1 : 2;
  const rows: PaneTree[] = [];
  for (let i = 0; i < panes.length; i += columns) rows.push(join(panes.slice(i, i + columns).map((pane) => ({ kind: "pane", id: pane.id })), "horizontal"));
  const grid = join(rows, "vertical");
  const tree: PaneTree = rest ? { kind: "split", id: fresh("grid-rest-"), axis: "horizontal", ratio: 0.5, first: grid, second: rest } : grid;
  const all = [...panes, ...behind];
  return { panes: leafIds(tree).map((id) => all.find((pane) => pane.id === id)!), focus: panes.some((pane) => pane.id === layout.focus) ? layout.focus : dest.id, tree, ...(count > 1 ? { grid: columns as 2 | 3 } : {}) };
}
