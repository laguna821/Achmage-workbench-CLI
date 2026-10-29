/** One workspace's presentation state. Document bytes and running processes live elsewhere. */
export type WorkspaceLayoutRecord = {
  key: string;
  revision: number;
  layout: Record<string, unknown>;
  updatedAt: number;
};

export const GLOBAL_LAYOUT = "global";

/** Bound opaque UI state at the storage boundary; the web app validates each supported view. */
export function validWorkspaceLayout(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const layout = value as Record<string, unknown>;
  if (layout.version !== 2 || !Array.isArray(layout.panes) || !layout.panes.length || layout.panes.length > 16 || typeof layout.focus !== "string") return false;
  const paneIds = new Set<string>(), tabIds = new Set<string>();
  const identity = (id: unknown): id is string => typeof id === "string" && /^[\w-]{1,100}$/.test(id);
  const content = (entry: Record<string, unknown>) => !!entry.view && typeof entry.view === "object" && !Array.isArray(entry.view) && typeof (entry.view as Record<string, unknown>).kind === "string" && (entry.workId === null || identity(entry.workId)) && (entry.sessionId === null || identity(entry.sessionId));
  for (const raw of layout.panes) {
    if (!raw || typeof raw !== "object") return false;
    const pane = raw as Record<string, unknown>;
    if (!identity(pane.id) || paneIds.has(pane.id) || !content(pane) || !Array.isArray(pane.tabs) || !pane.tabs.length) return false;
    paneIds.add(pane.id);
    for (const rawTab of pane.tabs) {
      if (!rawTab || typeof rawTab !== "object") return false;
      const tab = rawTab as Record<string, unknown>;
      if (!identity(tab.id) || tabIds.has(tab.id) || !content(tab)) return false;
      tabIds.add(tab.id);
      if (tabIds.size > 128) return false;
    }
    const tabs = pane.tabs;
    if (!tabs.some((tab) => tab.id === pane.activeTabId) || !Array.isArray(pane.recentTabIds) || pane.recentTabIds.some((id) => !tabs.some((tab) => tab.id === id))) return false;
  }
  if (!paneIds.has(layout.focus)) return false;
  if (layout.tree !== undefined) {
    const seen = new Set<string>(), leaves = new Set<string>();
    const tree = (node: unknown, depth: number): boolean => {
      if (!node || typeof node !== "object" || depth > 16) return false;
      const branch = node as Record<string, unknown>;
      if (!identity(branch.id) || seen.has(branch.id)) return false;
      seen.add(branch.id);
      if (branch.kind === "pane") { leaves.add(branch.id); return paneIds.has(branch.id); }
      return branch.kind === "split" && (branch.axis === "horizontal" || branch.axis === "vertical") && typeof branch.ratio === "number" && Number.isFinite(branch.ratio) && branch.ratio >= 0.1 && branch.ratio <= 0.9 && tree(branch.first, depth + 1) && tree(branch.second, depth + 1);
    };
    if (!tree(layout.tree, 0) || leaves.size !== paneIds.size) return false;
  }
  return true;
}
