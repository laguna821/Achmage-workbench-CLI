import { closePane, focusedPane, onlyPanes, paneById, splitPane, type Layout, type Pane, type PaneContent, type PaneTab, type PaneTarget, type TabUiState } from "./panes.ts";

export const MAX_TABS = 128;
/** Entity identity, independent of its group, presentation mode and scroll position. */
export function contentKey<V>(content: PaneContent<V>): string {
  const view = content.view as Record<string, unknown>;
  if (view.kind === "document") return `doc:${view.artifactId}`;
  // A conversation is its tab's identity, with or without a companion beside it.
  if (view.kind === "work") return content.sessionId ? `session:${content.sessionId}` : `work:${content.workId ?? ""}`;
  if (view.kind === "project") return `project:${view.workId}`;
  if (view.kind === "terminal") return `terminal:${view.terminalId}`;
  if (view.kind === "browser") return `browser:${view.pageId}`;
  return JSON.stringify(view);
}
export const tabsOf = <V>(pane: Pane<V>): PaneTab<V>[] => pane.tabs ?? [{ id: `tab-${pane.id}`, view: pane.view, workId: pane.workId, sessionId: pane.sessionId }];
export const activeTab = <V>(pane: Pane<V>) => tabsOf(pane).find((tab) => tab.id === pane.activeTabId) ?? tabsOf(pane)[0]!;
const project = <V>(pane: Pane<V>, tabs: PaneTab<V>[], activeId: string, recent = pane.recentTabIds ?? []): Pane<V> => {
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]!;
  return { ...pane, view: active.view, workId: active.workId, sessionId: active.sessionId, tabs, activeTabId: active.id, recentTabIds: [active.id, ...recent.filter((id) => id !== active.id && tabs.some((tab) => tab.id === id))] };
};

/**
 * Skin 2 · B: what must not step back when the shared cap is reached — a tab with unsaved edits (the
 * app registers the check; an editor that cannot tell counts as unsaved). A live web page never steps
 * back (closing its tab would release the page).
 */
let keeper: (<V>(tab: PaneTab<V>) => boolean) | null = null;
export function setTabKeeper(check: (<V>(tab: PaneTab<V>) => boolean) | null) { keeper = check; }
const showsWeb = (view: unknown) => {
  const value = view as { kind?: string; beside?: { kind?: string } };
  return value.kind === "browser" || value.beside?.kind === "browser";
};

/**
 * The cap of 128 tabs is shared by every project; opening one more never throws at the person. The
 * least recently used tab of ANOTHER project steps back (closing a tab stops nothing; its row stays in
 * its project's list) — never the tab on screen in any pane, one just opened, one with unsaved edits
 * or a live web page. Only when no other project has one: this project's least recently used tab.
 */
function stepBack<V>(layout: Layout<V>, opened: Set<string>, workId: string | null): Layout<V> {
  let next = layout;
  while (next.panes.reduce((sum, pane) => sum + tabsOf(pane).length, 0) > MAX_TABS) {
    const candidates = next.panes.flatMap((pane, paneIndex) => {
      const tabs = tabsOf(pane), recent = pane.recentTabIds ?? [], active = activeTab(pane).id;
      return tabs.filter((tab) => tab.id !== active && !opened.has(tab.id) && !showsWeb(tab.view) && !keeper?.(tab)).map((tab) => {
        const at = recent.indexOf(tab.id);
        // Older = further back in its pane's recent list; never shown = oldest, in the order opened.
        return { pane, tab, age: at < 0 ? recent.length + tabs.length - tabs.indexOf(tab) : at, paneIndex };
      });
    });
    const others = candidates.filter((entry) => projectOfTab(entry.tab) !== workId);
    const pool = others.length ? others : candidates;
    if (!pool.length) return next;
    const oldest = pool.reduce((a, b) => (b.age > a.age ? b : a));
    next = { ...next, panes: next.panes.map((pane) => pane.id === oldest.pane.id ? project(pane, tabsOf(pane).filter((tab) => tab.id !== oldest.tab.id), activeTab(pane).id) : pane) };
  }
  return next;
}

/**
 * The record a window writes (technical review M11): never more than the gateway keeps. Past 128 (only
 * when nothing could step back: live web pages, unsaved edits) the oldest tabs are left out of the record
 * — another project's first, never a tab on screen — and counted, so the person can be told once; the
 * window keeps showing them until they are closed (nothing open is taken away).
 */
export function storedTabs<V>(layout: Layout<V>, workId: string | null): { layout: Layout<V>; left: number; keptUnsaved: number; unsavedLeft: number } {
  const total = layout.panes.reduce((sum, pane) => sum + tabsOf(pane).length, 0);
  if (total <= MAX_TABS) return { layout, left: 0, keptUnsaved: 0, unsavedLeft: 0 };
  {
    // The same order as stepping back, with every tab allowed to leave the record except those on screen.
    let next = layout;
    while (next.panes.reduce((sum, pane) => sum + tabsOf(pane).length, 0) > MAX_TABS) {
      const candidates = next.panes.flatMap((pane) => {
        const tabs = tabsOf(pane), recent = pane.recentTabIds ?? [], active = activeTab(pane).id;
        return tabs.filter((tab) => tab.id !== active).map((tab) => {
          const at = recent.indexOf(tab.id);
          return { pane, tab, age: at < 0 ? recent.length + tabs.length - tabs.indexOf(tab) : at };
        });
      });
      // A tab with unsaved edits is left out only when nothing else can be (tech review 4): first another
      // project's tabs without unsaved edits, then this project's, and only then the unsaved ones.
      const saved = candidates.filter((entry) => !keeper?.(entry.tab));
      const tiers = [saved.filter((entry) => projectOfTab(entry.tab) !== workId), saved, candidates.filter((entry) => projectOfTab(entry.tab) !== workId), candidates];
      const pool = tiers.find((tier) => tier.length) ?? [];
      if (!pool.length) break;
      const oldest = pool.reduce((a, b) => (b.age > a.age ? b : a));
      next = { ...next, panes: next.panes.map((pane) => pane.id === oldest.pane.id ? project(pane, tabsOf(pane).filter((tab) => tab.id !== oldest.tab.id), activeTab(pane).id) : pane) };
    }
    const keptUnsaved = next.panes.flatMap(tabsOf).filter((tab) => keeper?.(tab)).length;
    const unsavedLeft = layout.panes.flatMap(tabsOf).filter((tab) => keeper?.(tab)).length - keptUnsaved;
    return { layout: next, left: total - next.panes.reduce((sum, pane) => sum + tabsOf(pane).length, 0), keptUnsaved, unsavedLeft };
  }
}

/** Upgrade a legacy pane or reconcile its changed active view. Inactive entities keep their IDs. */
export function withTabs<V>(layout: Layout<V>, previous?: Layout<V>): Layout<V> {
  const opened = new Set<string>();
  let openedWork: string | null = null;
  const next = { ...layout, panes: layout.panes.map((pane) => {
    const before = previous && paneById(previous, pane.id);
    const tabs = [...(pane.tabs ?? (before?.tabs ?? [{ id: `tab-${crypto.randomUUID()}`, view: pane.view, workId: pane.workId, sessionId: pane.sessionId }]))];
    // Legacy focus operations cleared a session pin. Tabs always keep their own session.
    const current = activeTab(pane.tabs ? pane : before ?? pane);
    const view = pane.view as { kind?: string };
    const content = { view: pane.view, workId: pane.workId, sessionId: pane.sessionId ?? (view.kind === "work" && pane.workId === current.workId ? current.sessionId : null) };
    const key = contentKey(content);
    // Explicit in-tab navigation (e.g. a vault browser) retains that tab's history,
    // even if another tab is already showing the same note.
    const currentIndex = tabs.findIndex(tab => tab.id === current.id && contentKey(tab) === key);
    const index = currentIndex >= 0 ? currentIndex : tabs.findIndex((tab) => contentKey(tab) === key);
    const chosen = index >= 0 ? { ...tabs[index]!, ...content } : { id: `tab-${crypto.randomUUID()}`, ...content };
    if (index >= 0) tabs[index] = chosen;
    else {
      tabs.push(chosen);
      opened.add(chosen.id); openedWork = projectOfTab(chosen);
    }
    return project(pane, tabs, chosen.id);
  }) };
  return opened.size ? stepBack(next, opened, openedWork) : next;
}

export function findTab<V>(layout: Layout<V>, key: string) {
  for (const pane of layout.panes) {
    const tab = tabsOf(pane).find((entry) => contentKey(entry) === key);
    if (tab) return { pane, tab };
  }
  return null;
}
/**
 * N1: the project a tab shows content of (home and the archive carry the last project's id, but are no
 * project's). An empty pane made inside a project is that project's: its `new` view says which (`project`).
 */
export function projectOfTab<V>(tab: PaneTab<V>): string | null {
  const view = tab.view as { kind?: string; project?: unknown };
  if (view.kind === "new") return typeof view.project === "string" ? view.project : null;
  return view.kind === "archive" ? null : (tab.workId ?? null);
}
/** An empty place (home, a new-work screen, a project's empty pane): nothing of its own to keep. */
export const isEmptyTab = <V>(tab: PaneTab<V>): boolean => (tab.view as { kind?: string }).kind === "new";

/**
 * N1, per-project restore: the tab a project was last looked at in — the focused pane's most recent
 * tab of that project, else another pane's — or null when none of its tabs is open.
 */
export function lastTabOf<V>(layout: Layout<V>, workId: string): { pane: Pane<V>; tab: PaneTab<V> } | null {
  const focused = layout.panes.find((pane) => pane.id === layout.focus);
  const order = focused ? [focused, ...layout.panes.filter((pane) => pane !== focused)] : layout.panes;
  for (const pane of order) {
    const tab = recentOf(pane, workId);
    if (tab) return { pane, tab };
  }
  return null;
}
/** A pane's most recently used tab of a project (its tab on screen first), or undefined when it holds none. */
function recentOf<V>(pane: Pane<V>, workId: string): PaneTab<V> | undefined {
  const tabs = tabsOf(pane);
  const recent = [activeTab(pane).id, ...(pane.recentTabIds ?? [])];
  return recent.map((id) => tabs.find((entry) => entry.id === id)).find((entry) => entry && projectOfTab(entry) === workId) ?? tabs.find((entry) => projectOfTab(entry) === workId);
}

// ── Project tabs (2026-11-15): a project is the unit ─────────────────────────────────────────────
// ONE layout holds every open tab of every project. The window has ONE project — the focused tab's,
// or none (home, the archive) — and shows that project only: its tabs on the strips, its panes on
// screen. Everything else stays open, mounted and running exactly as a tab behind another does, so
// coming back to a project brings back its tabs, the tab on screen in each pane and its split.
// `all` ("모든 프로젝트의 탭 보기") turns all of it off: nothing hidden, nothing made to follow.

/** The window's project: the focused pane's tab on screen (null: home, the archive — no project chosen). */
export const scopeOf = <V>(layout: Layout<V>): string | null => projectOfTab(activeTab(focusedPane(layout)));

/**
 * Rule 1: every pane shows a tab of the window's project. A pane whose tab on screen is not that
 * project's brings its own most recently used tab of it forward; a pane that holds none is left as
 * it is (it is not drawn: `drawnLayout`). With no project chosen nothing moves. The same layout
 * back when nothing changed.
 */
export function followScope<V>(layout: Layout<V>, all = false): Layout<V> {
  const scope = all ? null : scopeOf(layout);
  if (scope === null) return layout;
  const focus = focusedPane(layout).id;
  let changed = false;
  const panes = layout.panes.map((pane) => {
    if (pane.id === focus || projectOfTab(activeTab(pane)) === scope) return pane;
    const tab = recentOf(pane, scope);
    if (!tab) return pane;
    changed = true;
    return project(pane, tabsOf(pane), tab.id);
  });
  return changed ? { ...layout, panes } : layout;
}

/**
 * Rule 5: closing never takes the window into ANOTHER project. When the tab that was on screen in
 * the focused pane is gone and the tab now there is another project's: the project's most recent
 * tab in that pane comes forward; else the focus goes to another pane holding the project's tabs
 * (one that was showing it first); else the window goes home (the home tab there is, or a new one).
 * Not a close — the tab is still there, or what is in front was only just opened — is left alone.
 */
function stayInProject<V>(changed: Layout<V>, previous: Layout<V>, home: PaneContent<V>): Layout<V> {
  const scope = scopeOf(previous);
  if (scope === null) return changed;
  const was = activeTab(focusedPane(previous)).id;
  if (changed.panes.some((pane) => tabsOf(pane).some((tab) => tab.id === was))) return changed;
  const focused = focusedPane(changed), now = activeTab(focused);
  if (projectOfTab(now) === scope || !previous.panes.some((pane) => tabsOf(pane).some((tab) => tab.id === now.id))) return changed;
  const front = (pane: Pane<V>, tabId: string): Layout<V> => ({ ...changed, focus: pane.id, panes: changed.panes.map((entry) => entry.id === pane.id ? project(entry, tabsOf(entry), tabId) : entry) });
  const own = recentOf(focused, scope);
  if (own) return front(focused, own.id);
  const other = changed.panes.find((pane) => projectOfTab(activeTab(pane)) === scope) ?? changed.panes.find((pane) => recentOf(pane, scope));
  if (other) return front(other, recentOf(other, scope)!.id);
  if (projectOfTab(now) === null) return changed;
  const key = contentKey(home);
  const holder = [focused, ...changed.panes].find((pane) => tabsOf(pane).some((tab) => contentKey(tab) === key && projectOfTab(tab) === null));
  if (holder) return front(holder, tabsOf(holder).find((tab) => contentKey(tab) === key && projectOfTab(tab) === null)!.id);
  const tab: PaneTab<V> = { id: `tab-${crypto.randomUUID()}`, ...home };
  return { ...changed, panes: changed.panes.map((pane) => pane.id === focused.id ? project(pane, [...tabsOf(pane), tab], tab.id) : pane) };
}

/**
 * An empty pane made INSIDE a project belongs to it. A change made while project P is on screen
 * that leaves a pane with nothing but a just-made home tab — "오른쪽/아래로 분할", a 화면 배치 preset,
 * the last tab closed — marks that tab's view `project: P` (and its workId): it is P's tab, so the
 * window stays in P and the empty pane is drawn beside P's panes, and nowhere else. The rail's 지금
 * (a home tab added to a pane that has other tabs, or the home tab there already) stays plain.
 * `gone`: a project being deleted makes no empty pane of its own.
 */
function ownEmptyPanes<V>(changed: Layout<V>, previous: Layout<V>, home: PaneContent<V>, gone?: string): Layout<V> {
  const scope = scopeOf(previous);
  if (scope === null || scope === gone) return changed;
  const before = new Set(previous.panes.flatMap(tabsOf).map((tab) => tab.id)), key = contentKey(home);
  let made = false;
  const panes = changed.panes.map((pane) => {
    const tabs = tabsOf(pane), only = tabs.length === 1 ? tabs[0]! : null;
    if (!only || before.has(only.id) || projectOfTab(only) !== null || contentKey(only) !== key) return pane;
    made = true;
    const tab: PaneTab<V> = { ...only, view: { ...(only.view as object), project: scope } as V, workId: scope };
    return project(pane, [tab], tab.id);
  });
  return made ? { ...changed, panes } : changed;
}

/** A project's empty tab is a place, not a thing kept: once its pane shows something else it is gone ("an item opened there replaces it"). */
function dropFilledEmpties<V>(layout: Layout<V>): Layout<V> {
  const filled = (pane: Pane<V>) => tabsOf(pane).filter((tab) => tab.id !== activeTab(pane).id && isEmptyTab(tab) && projectOfTab(tab) !== null);
  if (!layout.panes.some((pane) => filled(pane).length)) return layout;
  return { ...layout, panes: layout.panes.map((pane) => {
    const out = filled(pane);
    return out.length ? project(pane, tabsOf(pane).filter((tab) => !out.includes(tab)), activeTab(pane).id) : pane;
  }) };
}

/**
 * `all`: 모든 프로젝트의 탭 보기. `home`: what the window shows with no project chosen. `restored`: a
 * stored layout read (not a close, and nothing in it is newly made). `gone`: the project being deleted.
 */
export type ScopeRule<V> = { all?: boolean; home: PaneContent<V>; restored?: boolean; gone?: string };

/** The project rules every layout change settles by (companion-desk.ts `settleLayout`): empty panes made in a project are its own, rule 5, then rule 1. */
export function settleScope<V>(changed: Layout<V>, previous: Layout<V>, rule: ScopeRule<V>): Layout<V> {
  // Marked first: a home tab opened OVER a project's empty tab (지금 pressed there) is home, not that pane emptied again.
  const kept = dropFilledEmpties(rule.all || rule.restored ? changed : ownEmptyPanes(changed, previous, rule.home, rule.gone));
  if (rule.all) return kept;
  return followScope(rule.restored ? kept : stayInProject(kept, previous, rule.home));
}

/**
 * Which panes are drawn: those whose tab on screen is the window's project's (with no project
 * chosen: those on home or the archive), the focused one always. The layout comes back with only
 * them — the others' room goes to their neighbours — and is the same object when all are drawn.
 */
export function drawnLayout<V>(layout: Layout<V>, all = false): Layout<V> {
  if (all || layout.panes.length < 2) return layout;
  const scope = scopeOf(layout), focus = focusedPane(layout).id;
  return onlyPanes(layout, layout.panes.filter((pane) => pane.id === focus || projectOfTab(activeTab(pane)) === scope).map((pane) => pane.id));
}

/**
 * The tabs a pane's strip leaves out (they stay open and running, one list away): everything that
 * is not the project's — other projects' tabs, home, the archive; with no project chosen, every tab.
 * `all` leaves nothing out.
 */
export function offScope<V>(pane: Pane<V>, workId: string | null, all = false): string[] {
  if (all) return [];
  return tabsOf(pane).filter((tab) => workId === null || projectOfTab(tab) !== workId).map((tab) => tab.id);
}

/**
 * What each pane's strip belongs to: the window's project for every pane (none: no tab on any
 * strip). With `all` on, as before (`paneScopes`): each pane its own, `last` for a pane on home.
 */
export function stripScopes<V>(layout: Layout<V>, last: string | null, all: boolean): Record<string, { workId: string | null; named: boolean }> {
  if (all) return paneScopes(layout, last);
  const scope = scopeOf(layout);
  return Object.fromEntries(layout.panes.map((pane) => [pane.id, { workId: scope, named: false }]));
}

/**
 * Skin 2 · B, now only while "모든 프로젝트의 탭 보기" is on (`stripScopes`): each pane's strip follows
 * its OWN active tab's project (a pane on home or the archive keeps `current`), and `named` when the
 * panes show different projects — then each pane names its project before its tabs.
 */
export function paneScopes<V>(layout: Layout<V>, current: string | null): Record<string, { workId: string | null; named: boolean }> {
  const own = Object.fromEntries(layout.panes.map((pane) => [pane.id, projectOfTab(activeTab(pane))]));
  const named = new Set(Object.values(own).filter((id): id is string => id !== null)).size > 1;
  return Object.fromEntries(layout.panes.map((pane) => [pane.id, { workId: own[pane.id] ?? current, named: named && own[pane.id] !== null }]));
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

/**
 * Tabs whose view is gone (a document taken out of its project): `decide` closes a tab ("close"),
 * gives it another view, or leaves it (null). The same layout back when nothing changed.
 */
export function dropTabs<V>(layout: Layout<V>, decide: (view: V) => "close" | V | null, fallback: PaneContent<V>): Layout<V> {
  let next = layout;
  for (const pane of layout.panes) for (const tab of tabsOf(pane)) {
    const verdict = decide(tab.view);
    if (verdict === null) continue;
    next = verdict === "close" ? closeTab(next, pane.id, tab.id, fallback) : updateTabView(next, tab.id, () => verdict);
  }
  return next;
}
