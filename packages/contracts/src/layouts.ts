/** One workspace's presentation state. Document bytes and running processes live elsewhere. */
export type WorkspaceLayoutRecord = {
  key: string;
  revision: number;
  layout: Record<string, unknown>;
  updatedAt: number;
};

export const GLOBAL_LAYOUT = "global";

/**
 * A phone or another remote client keeps its own record (skin 2 · B): `device:<deviceId>`, so it
 * never contends with the desktop's `global` record (each undoing the other on 409). A device with
 * no record starts from the default; nothing migrates. Remote clients ask for `DEVICE_LAYOUT` (the
 * device gateway resolves it to their own device's key — a device can never address another's).
 */
export const DEVICE_LAYOUT = "device";
export const deviceLayoutKey = (deviceId: string) => `device:${deviceId}`;
export const isDeviceLayoutKey = (key: string) => /^device:[\w-]{1,100}$/.test(key);

const MAX_PANES = 16, MAX_TABS = 128, MAX_PARKED = 32;
const identity = (id: unknown): id is string => typeof id === "string" && /^[\w-]{1,100}$/.test(id);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const content = (entry: Record<string, unknown>) => record(entry.view) && typeof entry.view.kind === "string" && (entry.workId === null || identity(entry.workId)) && (entry.sessionId === null || identity(entry.sessionId));

/**
 * Bound opaque UI state at the storage boundary, tolerantly (skin 2 · B): a tab that cannot be read
 * (bad or repeated id, no view kind, bad owners, past 128) is left out and counted; a pane left
 * without tabs folds away; active/recent tabs and the focus are repaired; a tree that no longer
 * matches the panes is dropped (the web rebuilds one side by side). `null` only for a record with no
 * readable pane. The view kinds themselves are the web app's to know (any kind string is kept).
 */
export function readWorkspaceLayout(value: unknown): { layout: Record<string, unknown>; skipped: number } | null {
  if (!record(value)) return null;
  if (value.version !== 2 || !Array.isArray(value.panes) || !value.panes.length) return null;
  const paneIds = new Set<string>(), tabIds = new Set<string>();
  const panes: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const raw of value.panes) {
    if (panes.length >= MAX_PANES) { skipped += record(raw) && Array.isArray(raw.tabs) ? raw.tabs.length : 1; continue; }
    if (!record(raw) || !identity(raw.id) || paneIds.has(raw.id) || !Array.isArray(raw.tabs)) { skipped += record(raw) && Array.isArray(raw.tabs) ? raw.tabs.length : 1; continue; }
    const tabs: Record<string, unknown>[] = [];
    for (const tab of raw.tabs) {
      if (!record(tab) || !identity(tab.id) || tabIds.has(tab.id) || !content(tab) || tabIds.size >= MAX_TABS) { skipped++; continue; }
      tabIds.add(tab.id); tabs.push(tab);
    }
    if (!tabs.length) continue;
    const active = tabs.find((tab) => tab.id === raw.activeTabId) ?? tabs[0]!;
    const recent = Array.isArray(raw.recentTabIds) ? raw.recentTabIds.filter((id): id is string => tabs.some((tab) => tab.id === id)) : [];
    paneIds.add(raw.id);
    panes.push({ ...raw, view: active.view, workId: active.workId, sessionId: active.sessionId, tabs, activeTabId: active.id, recentTabIds: [...new Set([active.id as string, ...recent])] });
  }
  if (!panes.length) return null;
  const layout: Record<string, unknown> = { ...value, panes, focus: typeof value.focus === "string" && paneIds.has(value.focus) ? value.focus : panes[0]!.id };
  if (layout.tree !== undefined) {
    const seen = new Set<string>(), leaves = new Set<string>();
    const tree = (node: unknown, depth: number): boolean => {
      if (!record(node) || depth > MAX_PANES) return false;
      if (!identity(node.id) || seen.has(node.id)) return false;
      seen.add(node.id);
      if (node.kind === "pane") { leaves.add(node.id); return paneIds.has(node.id); }
      return node.kind === "split" && (node.axis === "horizontal" || node.axis === "vertical") && typeof node.ratio === "number" && Number.isFinite(node.ratio) && node.ratio >= 0.1 && node.ratio <= 0.9 && tree(node.first, depth + 1) && tree(node.second, depth + 1);
    };
    if (!tree(layout.tree, 0) || leaves.size !== paneIds.size) delete layout.tree;
  }
  // Tabs a window could not show (a newer view kind), kept for the windows that can.
  if (layout.parked !== undefined) {
    const parked = Array.isArray(layout.parked) ? layout.parked.filter((entry): entry is Record<string, unknown> => record(entry) && identity(entry.paneId) && record(entry.tab) && identity(entry.tab.id) && !tabIds.has(entry.tab.id)).slice(-MAX_PARKED) : [];
    if (parked.length) layout.parked = parked; else delete layout.parked;
  }
  return { layout, skipped };
}

/** Whether a layout is stored exactly as given (nothing to skip or repair). */
export function validWorkspaceLayout(value: unknown): value is Record<string, unknown> {
  const read = readWorkspaceLayout(value);
  return !!read && read.skipped === 0 && JSON.stringify(read.layout) === JSON.stringify(value);
}
