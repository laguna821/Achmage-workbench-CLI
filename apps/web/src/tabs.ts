import { closePane, paneById, splitPane, type Layout, type Pane, type PaneContent, type PaneTab, type PaneTarget, type TabUiState } from "./panes.ts";

export const MAX_TABS = 128;
/** Entity identity, independent of its group, presentation mode and scroll position. */
export function contentKey<V>(content: PaneContent<V>): string {
  const view = content.view as Record<string, unknown>;
  if (view.kind === "document" || view.kind === "split") return `doc:${view.artifactId}`;
  if (view.kind === "work") return content.sessionId ? `session:${content.sessionId}` : `work:${content.workId ?? ""}`;
  if (view.kind === "project") return `project:${view.workId}`;
  if (view.kind === "terminal") return `terminal:${view.terminalId}`;
  return JSON.stringify(view);
}
export const tabsOf = <V>(pane: Pane<V>): PaneTab<V>[] => pane.tabs ?? [{ id: `tab-${pane.id}`, view: pane.view, workId: pane.workId, sessionId: pane.sessionId }];
export const activeTab = <V>(pane: Pane<V>) => tabsOf(pane).find((tab) => tab.id === pane.activeTabId) ?? tabsOf(pane)[0]!;
const project = <V>(pane: Pane<V>, tabs: PaneTab<V>[], activeId: string, recent = pane.recentTabIds ?? []): Pane<V> => {
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]!;
  return { ...pane, view: active.view, workId: active.workId, sessionId: active.sessionId, tabs, activeTabId: active.id, recentTabIds: [active.id, ...recent.filter((id) => id !== active.id && tabs.some((tab) => tab.id === id))] };
};

/** Upgrade a legacy pane or reconcile its changed active view. Inactive entities keep their IDs. */
export function withTabs<V>(layout: Layout<V>, previous?: Layout<V>): Layout<V> {
  return { ...layout, panes: layout.panes.map((pane) => {
    const before = previous && paneById(previous, pane.id);
    const tabs = [...(pane.tabs ?? (before?.tabs ?? [{ id: `tab-${crypto.randomUUID()}`, view: pane.view, workId: pane.workId, sessionId: pane.sessionId }]))];
    // Legacy focus operations cleared a session pin. Tabs always keep their own session.
    const current = activeTab(pane.tabs ? pane : before ?? pane);
    const view = pane.view as { kind?: string };
    const content = { view: pane.view, workId: pane.workId, sessionId: pane.sessionId ?? (view.kind === "work" && pane.workId === current.workId ? current.sessionId : null) };
    const key = contentKey(content);
    const index = tabs.findIndex((tab) => contentKey(tab) === key);
    const chosen = index >= 0 ? { ...tabs[index]!, ...content } : { id: `tab-${crypto.randomUUID()}`, ...content };
    if (index >= 0) tabs[index] = chosen;
    else {
      if (layout.panes.reduce((sum, entry) => sum + tabsOf(entry).length, 0) >= MAX_TABS) throw new Error(`한 작업공간에는 최대 ${MAX_TABS}개의 탭을 열 수 있습니다.`);
      tabs.push(chosen);
    }
    return project(pane, tabs, chosen.id);
  }) };
}

export function findTab<V>(layout: Layout<V>, key: string) {
  for (const pane of layout.panes) {
    const tab = tabsOf(pane).find((entry) => contentKey(entry) === key);
    if (tab) return { pane, tab };
  }
  return null;
}
export function activateTab<V>(layout: Layout<V>, paneId: string, tabId: string): Layout<V> {
  const pane = paneById(layout, paneId);
  if (!pane || !tabsOf(pane).some((tab) => tab.id === tabId)) return layout;
  return { ...layout, focus: paneId, panes: layout.panes.map((entry) => entry.id === paneId ? project(entry, tabsOf(entry), tabId) : entry) };
}
export function closeTab<V>(layout: Layout<V>, paneId: string, tabId: string, fallback: PaneContent<V>): Layout<V> {
  const pane = paneById(layout, paneId);
  if (!pane || !tabsOf(pane).some((tab) => tab.id === tabId)) return layout;
  const remaining = tabsOf(pane).filter((tab) => tab.id !== tabId);
  if (!remaining.length && layout.panes.length > 1) return closePane(layout, paneId);
  const tabs = remaining.length ? remaining : [{ ...fallback, id: `tab-${crypto.randomUUID()}` }];
  const next = activeTab(pane).id === tabId ? (pane.recentTabIds ?? []).find((id) => tabs.some((tab) => tab.id === id)) ?? tabs[0]!.id : activeTab(pane).id;
  return { ...layout, panes: layout.panes.map((entry) => entry.id === paneId ? project(entry, tabs, next) : entry) };
}
/** Move one existing tab; never create a second view or alter the underlying session. */
export function moveTab<V>(layout: Layout<V>, tabId: string, target: PaneTarget, index?: number): Layout<V> {
  const source = layout.panes.find((pane) => tabsOf(pane).some((tab) => tab.id === tabId));
  const dest = paneById(layout, target.paneId);
  if (!source || !dest) return layout;
  const tab = tabsOf(source).find((entry) => entry.id === tabId)!;
  if (source.id === dest.id && target.side === "center") {
    const tabs = tabsOf(source).filter((entry) => entry.id !== tabId);
    tabs.splice(Math.max(0, Math.min(tabs.length, index ?? tabs.length)), 0, tab);
    return { ...layout, panes: layout.panes.map((pane) => pane.id === source.id ? project(pane, tabs, activeTab(source).id) : pane) };
  }
  if (source.id === dest.id && tabsOf(source).length === 1) return layout;
  let next = layout;
  let destination = dest.id;
  if (target.side !== "center") {
    next = splitPane(layout, dest.id, target.side, tab, activeTab(paneById(layout, layout.focus)!).sessionId);
    if (next === layout) return layout;
    destination = next.focus;
  }
  const remaining = tabsOf(source).filter((entry) => entry.id !== tabId);
  next = { ...next, panes: next.panes.map((pane) => {
    if (pane.id === destination) {
      const tabs = target.side === "center" ? [...tabsOf(pane)] : [];
      tabs.splice(Math.max(0, Math.min(tabs.length, index ?? tabs.length)), 0, tab);
      return project(pane, tabs, tab.id);
    }
    if (pane.id === source.id && remaining.length) return project(pane, remaining, activeTab(source).id === tabId ? (source.recentTabIds ?? []).find((id) => remaining.some((entry) => entry.id === id)) ?? remaining[0]!.id : activeTab(source).id);
    return pane;
  }), focus: destination };
  return remaining.length ? next : closePane(next, source.id);
}
export function updateTabUi<V>(layout: Layout<V>, tabId: string, ui: TabUiState): Layout<V> {
  const current = layout.panes.flatMap(tabsOf).find((tab) => tab.id === tabId);
  if (!current || JSON.stringify(current.ui ?? {}) === JSON.stringify({ ...current.ui, ...ui })) return layout;
  return { ...layout, panes: layout.panes.map((pane) => ({ ...pane, tabs: tabsOf(pane).map((tab) => tab.id === tabId ? { ...tab, ui: { ...tab.ui, ...ui } } : tab) })) };
}
export function updateTabView<V>(layout: Layout<V>, tabId: string, change: (view: V) => V): Layout<V> {
  return { ...layout, panes: layout.panes.map((pane) => {
    if (!tabsOf(pane).some((tab) => tab.id === tabId)) return pane;
    const tabs = tabsOf(pane).map((tab) => tab.id === tabId ? { ...tab, view: change(tab.view) } : tab);
    return project(pane, tabs, activeTab(pane).id);
  }) };
}

/** Old project document lists become inactive tabs; no document is opened twice. */
export function addBackgroundTab<V>(layout: Layout<V>, paneId: string, content: PaneContent<V>): Layout<V> {
  if (findTab(layout, contentKey(content))) return layout;
  if (layout.panes.reduce((sum, pane) => sum + tabsOf(pane).length, 0) >= MAX_TABS) return layout;
  return { ...layout, panes: layout.panes.map((pane) => pane.id === paneId ? { ...pane, tabs: [...tabsOf(pane), { id: `tab-${crypto.randomUUID()}`, ...content }] } : pane) };
}
