import { type Layout, type Pane, type PaneContent, type PaneTree } from "./panes.ts";
import { activeTab, tabsOf, withTabs } from "./tabs.ts";

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
