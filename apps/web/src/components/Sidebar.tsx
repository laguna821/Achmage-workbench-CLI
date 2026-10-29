import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Artifact, Folder, NavigatorPrefs, NavLayout, NavSelection, NavShortcut, ProjectStage, ProjectSummary, UiPrefs, Work } from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { State } from "../state.ts";
import { holds, linkPair, moveFor, nudge, toggleWork, treeRows, workTreeRows, type Row, type SortMode, type TreeOpenState } from "../tree.ts";
import { lookStyle, NEUTRAL_LOOK, useAppearance } from "../appearance.ts";
import { comboLabel, shortcutsOf } from "../shortcuts.ts";
import { Icon, type IconName } from "./Icon.tsx";
import type { MenuEntry, MenuRequest } from "./ContextMenu.tsx";
import { UsageCard } from "./UsageCard.tsx";
import { linkable } from "./LinkSidebar.tsx";
import { ViewsSection } from "./pkm/ViewsSection.tsx";
import { VaultSection } from "./pkm/VaultSection.tsx";
import { useDragController, useGhost, zoneOf, type DragPayload, type DropTarget, type GhostStore } from "./nav/drag.ts";
import {
  LIST_WIDTH,
  NAV_HEIGHT,
  NAV_WIDTH,
  addShortcuts,
  folderCounts,
  folderOrder,
  layoutFor,
  listFor,
  moveShortcut,
  projectsOf,
  sameShortcut,
  readNavigator,
  readShortcuts,
  seedShortcuts,
  sortFor,
  tagTree,
  type TagNode,
} from "./nav/model.ts";
import { HomeRow, NavPane, NowSection, ROOT_ROW_ID, ShortcutsSection, beforeLastGroup, viewShortcutEntry } from "./nav/NavPane.tsx";
import { ListPane, type ListItem } from "./nav/ListPane.tsx";
import { TreeSection } from "./nav/TreeSection.tsx";
import { rowItem, rowLabel, type RowContext } from "./nav/rows.tsx";
import { FolderDeleteDialog, FolderStylePanel, TagPrompt } from "./nav/dialogs.tsx";
import { onNavigatorFocus, takeNavigatorFocus } from "./nav/focus.ts";
import type { NavDialog, NavShared, SidebarActions, Toast } from "./nav/shared.ts";
import "../styles/navigator.css";

// The sidebar: a two-pane navigator shaped like Obsidian's Notebook Navigator. The navigation pane
// holds 지금, 바로가기, the project folders (folders only), tags, saved views and the vault; the
// list pane lists the projects of what is selected, one row per project like a note. Stacked on a
// narrow window, or the single tree as before ("한 칸"). New session, search and home stay on top,
// the plan limits and the archive at the foot.

export type { SidebarActions } from "./nav/shared.ts";
export { rowItem } from "./nav/rows.tsx";

const MIN_WIDTH = 232;
const MAX_WIDTH = 480;
const NO_SHORTCUTS: NavShortcut[] = [];

const LAYOUTS: { id: NavLayout; label: string; icon: IconName }[] = [
  { id: "dual", label: "두 칸", icon: "columns" },
  { id: "stacked", label: "위아래", icon: "rows" },
  { id: "tree", label: "한 칸 (트리)", icon: "list" },
];

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function useWindowWidth() {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/** The projects' summaries (what their notes say) and the person's stages, read again when they change. */
function useProjectData(api: Api, state: State, withSummaries: boolean) {
  const [summaries, setSummaries] = useState<Map<string, ProjectSummary>>(() => new Map());
  const [stages, setStages] = useState<ProjectStage[]>([]);
  const version = useMemo(
    () =>
      Object.entries(state.pkm)
        .filter(([key]) => key.startsWith("project:"))
        .map(([key, value]) => `${key}=${value}`)
        .join(","),
    [state.pkm],
  );
  const worksKey = useMemo(
    () =>
      Object.values(state.works)
        .map((work) => `${work.id}:${work.archivedAt ?? 0}`)
        .join(","),
    [state.works],
  );
  const loaded = useRef(false);
  useEffect(() => {
    let cancelled = false;
    // Several changes in a row (a turn writing the note, a rule) are read once.
    const timer = window.setTimeout(
      () => {
        void Promise.all([withSummaries ? api.projects() : Promise.resolve(null), api.projectStages()])
          .then(([list, nextStages]) => {
            if (cancelled) return;
            loaded.current = true;
            if (list) setSummaries(new Map(list.map((entry) => [entry.workId, entry])));
            setStages(nextStages);
          })
          .catch(() => undefined);
      },
      loaded.current ? 250 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, version, worksKey, withSummaries]);
  return { summaries, stages };
}

/** Documents of each work, newest change first (the project's own note left out, as the tree does). */
function docsByWorkOf(artifacts: Record<string, Artifact>) {
  const map = new Map<string, Artifact[]>();
  for (const artifact of Object.values(artifacts)) {
    if (artifact.role === "project-note") continue;
    const list = map.get(artifact.workId);
    if (list) list.push(artifact);
    else map.set(artifact.workId, [artifact]);
  }
  for (const list of map.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
  return map;
}

/** The ghost under the pointer while something is dragged (only it follows the pointer). */
function DragGhost({ store }: { store: GhostStore }) {
  const ghost = useGhost(store);
  if (!ghost) return null;
  return (
    <div className={`drag-ghost${ghost.tone === "linking" ? " linking" : ghost.tone === "refused" ? " refused" : ""}`} style={{ left: ghost.x + 12, top: ghost.y + 10 }}>
      {ghost.text}
    </div>
  );
}

export function Sidebar({
  state,
  currentWorkId,
  visibleSessionId,
  currentDocId,
  open,
  onOpenChange,
  sortMode,
  onSortMode,
  width,
  onWidth,
  actions,
  pending,
  onPendingDone,
  homeActive = false,
  prefs,
  onPrefs,
  api,
  onToast,
}: {
  state: State;
  currentWorkId: string | null;
  visibleSessionId: string | null;
  currentDocId: string | null;
  open: TreeOpenState;
  onOpenChange: (next: TreeOpenState) => void;
  sortMode: SortMode;
  onSortMode: (mode: SortMode) => void;
  width: number;
  onWidth: (width: number) => void;
  actions: SidebarActions;
  /** A rename or a new folder asked from a menu. */
  pending: { rename?: string; createIn?: string | null } | null;
  onPendingDone: () => void;
  /** Home is on screen. */
  homeActive?: boolean;
  /** The screen preferences as last edited (`navigator`, `navShortcuts`), and how to change them. */
  prefs: UiPrefs;
  onPrefs: (patch: UiPrefs) => void;
  api: Api;
  onToast: (message: Toast) => void;
}) {
  const { lookOf, appTheme } = useAppearance();
  const asideRef = useRef<HTMLElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fail = useCallback((error: unknown) => onToast(error instanceof Error ? error.message : String(error)), [onToast]);

  // ── preferences: the navigator's own object and the shortcuts ───────────────────────────
  const nav = useMemo(() => readNavigator(prefs.navigator), [prefs.navigator]);
  const windowWidth = useWindowWidth();
  const layout = layoutFor(nav, windowWidth);
  // Several changes before the next render build on each other.
  const pendingNav = useRef<Record<string, unknown> | null>(null);
  useEffect(() => {
    pendingNav.current = null;
  }, [prefs.navigator]);
  const saveNav = useCallback(
    (patch: Partial<NavigatorPrefs>) => {
      const next = { ...(pendingNav.current ?? record(prefs.navigator)), ...patch };
      pendingNav.current = next;
      onPrefs({ navigator: next });
    },
    [prefs.navigator, onPrefs],
  );
  const stored = useMemo(() => readShortcuts(prefs.navShortcuts), [prefs.navShortcuts]);
  const shortcuts = stored ?? NO_SHORTCUTS;
  const saveShortcuts = useCallback((next: NavShortcut[]) => onPrefs({ navShortcuts: next }), [onPrefs]);
  // "바로가기" replaces "고정": once, what was pinned becomes the first shortcuts (`pinned` stays).
  const unseeded = stored === null;
  useEffect(() => {
    if (unseeded) onPrefs({ navShortcuts: seedShortcuts(state) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unseeded]);

  // ── what the panes show ─────────────────────────────────────────────────────────────────
  const navigating = layout !== "tree";
  const { summaries, stages } = useProjectData(api, state, navigating);
  const docsByWork = useMemo(() => docsByWorkOf(state.artifacts), [state.artifacts]);
  const projects = useMemo(() => projectsOf(state, summaries, visibleSessionId), [state.works, state.sessions, state.folders, summaries, visibleSessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => folderCounts(projects, state.folders), [projects, state.folders]);
  const tags = useMemo(() => tagTree(projects), [projects]);
  // A folder selected that is gone (deleted, archived) leaves the root selected.
  const selected: NavSelection = nav.selected.kind === "folder" && (!state.folders[nav.selected.id] || state.folders[nav.selected.id]!.archivedAt) ? { kind: "root" } : nav.selected;
  const navState = useMemo(() => ({ ...nav, selected }), [nav, selected.kind === "folder" ? selected.id : selected.kind === "tag" ? selected.tag : selected.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const [query, setQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [listFocus, setListFocus] = useState<string | null>(null);
  const [treeFocus, setTreeFocus] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<string | null | undefined>(undefined);
  const [dialog, setDialog] = useState<NavDialog | null>(null);
  const [live, setLive] = useState<{ nav?: number; list?: number; height?: number; width?: number } | null>(null);

  const sort = sortFor(navState, selected);
  const listed = useMemo(
    () => (navigating ? listFor(projects, selected, { includeSub: nav.includeSub, query, sort, groupSub: nav.groupSub, stages, folders: state.folders, now: Date.now() }) : { entries: [], count: 0 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigating, projects, navState, nav.includeSub, query, sort.key, sort.desc, nav.groupSub, stages, state.folders],
  );
  const items = useMemo<ListItem[]>(() => {
    const out: ListItem[] = [];
    for (const entry of listed.entries) {
      if (entry.type === "group") {
        out.push({ kind: "group", key: entry.key, label: entry.label, count: entry.count });
        continue;
      }
      const work = entry.project.work;
      const [row, ...children] = workTreeRows(state, work, open, currentWorkId, 0, entry.project.sessions, docsByWork.get(work.id) ?? []);
      out.push({ kind: "project", project: entry.project, folder: entry.folder, row: row as Extract<Row, { type: "work" }> });
      for (const child of children) out.push({ kind: "child", row: child });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listed, open, currentWorkId, docsByWork]);
  const rows = useMemo(() => (navigating ? [] : treeRows(state, open, sortMode, currentWorkId)), [navigating, state, open, sortMode, currentWorkId]);

  // Every row a drag can land on, by its `data-row-id`.
  const rowById = useMemo(() => {
    const map = new Map<string, Row>();
    if (!navigating) {
      for (const row of rows) map.set(row.id, row);
      return map;
    }
    map.set(ROOT_ROW_ID, { type: "section", id: ROOT_ROW_ID, depth: 0, label: "프로젝트" });
    for (const { folder, depth } of folderOrder(state.folders, null)) map.set(folder.id, { type: "folder", id: folder.id, depth, folder, open: true, empty: false });
    for (const item of items) if (item.kind !== "group") map.set(item.row.id, item.row);
    return map;
  }, [navigating, rows, items, state.folders]);

  // Picks stay among what is listed.
  useEffect(() => {
    setChosen((current) => (current.length && current.some((id) => !rowById.has(id)) ? current.filter((id) => rowById.has(id)) : current));
  }, [rowById]);
  // A new selection starts at the top of its list.
  const listKey = selected.kind === "folder" ? selected.id : selected.kind === "tag" ? `tag:${selected.tag}` : selected.kind;
  useEffect(() => {
    listRef.current?.closest(".list-scroll")?.scrollTo({ top: 0 });
    setChosen([]);
    setAnchor(null);
  }, [listKey]);

  // ── focus ───────────────────────────────────────────────────────────────────────────────
  const focusTreeRow = useCallback((id: string) => {
    setTreeFocus(id);
    window.requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.focus());
  }, []);
  const focusList = useCallback(
    (id?: string | null) => {
      // A frame later (the list may just have been drawn), unless the focus went somewhere meanwhile.
      const from = document.activeElement;
      window.requestAnimationFrame(() => {
        if (document.activeElement !== from && document.activeElement !== document.body) return;
        const root = navigating ? listRef.current : treeRef.current;
        const target =
          (id ? root?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`) : null) ??
          root?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ??
          root?.querySelector<HTMLElement>('[role="treeitem"]');
        target?.focus();
        target?.scrollIntoView({ block: "nearest" });
      });
    },
    [navigating],
  );
  const focusNav = useCallback(() => {
    const pane = asideRef.current?.querySelector(".nav-pane");
    (pane?.querySelector<HTMLElement>('[data-nav-row][tabindex="0"]') ?? pane?.querySelector<HTMLElement>("[data-nav-row]"))?.focus();
  }, []);
  // "내비게이터로" (Ctrl+Shift+E): asked before the sidebar was there, or while it is.
  useEffect(() => {
    if (takeNavigatorFocus()) focusList();
    return onNavigatorFocus(() => {
      if (takeNavigatorFocus()) focusList();
    });
  }, [focusList]);

  const select = useCallback(
    (next: NavSelection) => {
      if (!navigating) {
        // The single tree has no list: a folder shortcut unfolds its way there instead.
        if (next.kind !== "folder") return;
        const above = new Set<string>();
        for (let at = state.folders[next.id]?.parentId ?? null; at && !above.has(at); at = state.folders[at]?.parentId ?? null) above.add(at);
        if (open.closedFolders.some((id) => above.has(id))) onOpenChange({ ...open, closedFolders: open.closedFolders.filter((id) => !above.has(id)) });
        focusTreeRow(next.id);
        return;
      }
      saveNav({ selected: next });
    },
    [navigating, state.folders, open, onOpenChange, focusTreeRow, saveNav],
  );

  // Menus ask for an inline rename or a new folder; in the navigator the row may first need to be listed.
  useEffect(() => {
    if (!pending) return;
    if (pending.rename !== undefined) {
      const id = pending.rename;
      setRenaming(id);
      if (navigating && !rowById.has(id)) {
        const session = state.sessions[id];
        const work = state.works[session ? session.workId : id];
        if (work && !rowById.has(work.id)) saveNav({ selected: work.folderId && state.folders[work.folderId] ? { kind: "folder", id: work.folderId } : { kind: "root" } });
        if (session && work) onOpenChange(toggleWork(open, work.id, false));
      }
    }
    if (pending.createIn !== undefined) {
      setCreatingIn(pending.createIn);
      if (pending.createIn && open.closedFolders.includes(pending.createIn)) onOpenChange({ ...open, closedFolders: open.closedFolders.filter((id) => id !== pending.createIn) });
      if (navigating && nav.sections.projects) saveNav({ sections: { ...nav.sections, projects: false } });
    }
    onPendingDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  // ── moves ───────────────────────────────────────────────────────────────────────────────
  /** Projects into a folder (or out of folders): first in it, as a drop into a folder always put them. */
  const moveProjects = useCallback(
    (works: Work[], folderId: string | null) => {
      const moving = works.filter((work) => (work.folderId ?? null) !== folderId);
      if (!moving.length) return;
      let first = Math.min(0, ...Object.values(state.works).filter((work) => !work.archivedAt && (work.folderId ?? null) === folderId).map((work) => work.sort));
      const name = folderId ? (state.folders[folderId]?.name ?? "폴더") : "프로젝트";
      void Promise.all(moving.map((work) => api.updateWork(work.id, { folderId, sort: (first -= 1) })))
        .then(() => moving.length > 1 && onToast(`프로젝트 ${moving.length}개를 「${name}」(으)로 옮겼습니다.`))
        .catch(fail);
    },
    [api, state.works, state.folders, onToast, fail],
  );

  /** Where a drag would land now, and what dropping there does. */
  const resolveDrop = (payload: DragPayload, x: number, y: number): DropTarget | null => {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!hit || !asideRef.current?.contains(hit)) return null;
    const zone = hit.closest<HTMLElement>("[data-drop-shortcuts]");
    if (zone) return dropOnShortcuts(payload, hit, zone, y);
    const element = hit.closest<HTMLElement>("[data-row-id]");
    const row = element ? rowById.get(element.dataset.rowId!) : undefined;
    if (!element || !row) return null;
    const inNav = element.dataset.navFolder !== undefined;
    if (payload.kind === "projects") {
      if (!inNav) return { element, mark: "drop-refused", run: null };
      const folderId = row.type === "folder" ? row.folder.id : null;
      if (payload.works.every((work) => (work.folderId ?? null) === folderId)) return { element, mark: "drop-refused", run: null };
      return { element, mark: "drop-inside", hint: ` → ${row.type === "folder" ? row.folder.name : "프로젝트 (폴더 밖)"}`, run: () => moveProjects(payload.works, folderId) };
    }
    if (payload.kind !== "row") return null;
    const dragged = payload.row;
    if (row.id === dragged.id) return null;
    if (navigating) {
      // Folders nest and reorder among folders; the "프로젝트" row takes them to the top.
      if (dragged.type === "folder") {
        if (!inNav) return { element, mark: "drop-refused", run: null };
        const where = row.type === "section" ? "inside" : zoneOf(element, y, true);
        const move = moveFor(state, dragged, row, where, "manual");
        return { element, mark: move ? `drop-${where}` : "drop-refused", run: move ? () => actions.move(move) : null };
      }
      if (inNav) return { element, mark: "drop-refused", run: null };
    }
    // As the tree always did: a session links with another, reorders among its own, or becomes a page of a work.
    if (dragged.type === "session" && row.type === "work" && actions.sessionPage) {
      const work = row.work;
      return { element, mark: "drop-page", hint: ` → 「${work.title}」에 세션 기록 페이지`, run: () => actions.sessionPage!(dragged.session, work) };
    }
    const pair = linkPair(dragged, row);
    const where = zoneOf(element, y, holds(row, dragged) || Boolean(pair));
    const link = where === "inside" && pair && linkable(Object.values(state.links), pair.map((session) => session.id)) ? pair : null;
    if (link) return { element, mark: "drop-link", linking: true, text: `⇄ 세션 잇기: ${link[0].purpose} · ${link[1].purpose}`, run: () => actions.linkSessions(link) };
    // In the list, projects keep their sort order: only sessions move among their own.
    if (navigating && dragged.type === "work") return { element, mark: "drop-refused", run: null };
    const move = pair && where === "inside" ? null : moveFor(state, dragged, row, where, navigating ? "manual" : sortMode);
    return { element, mark: move ? `drop-${where}` : "drop-refused", run: move ? () => actions.move(move) : null };
  };

  /** Onto "바로가기": a shortcut moves; a project, folder, tag or session becomes one. */
  const dropOnShortcuts = (payload: DragPayload, hit: HTMLElement, zone: HTMLElement, y: number): DropTarget => {
    const over = hit.closest<HTMLElement>("[data-shortcut-index]");
    const at = over ? Number(over.dataset.shortcutIndex) : null;
    const half = over ? zoneOf(over, y, false) : null;
    const index = at === null ? shortcuts.length : half === "after" ? at + 1 : at;
    const element = over ?? zone.querySelector<HTMLElement>(".nav-section-head") ?? zone;
    const mark = over ? `drop-${half}` : "drop-inside";
    if (payload.kind === "shortcut") {
      if (at === null || at === payload.index || index === payload.index || index === payload.index + 1) return { element: over, mark: null, run: null };
      return { element, mark, run: () => saveShortcuts(moveShortcut(shortcuts, payload.index, index)) };
    }
    const entries: NavShortcut[] =
      payload.kind === "projects"
        ? payload.works.map((work) => ({ kind: "work", id: work.id }))
        : payload.kind === "tag"
          ? [{ kind: "tag", id: payload.tag }]
          : payload.row.type === "folder"
            ? [{ kind: "folder", id: payload.row.folder.id }]
            : payload.row.type === "work"
              ? [{ kind: "work", id: payload.row.work.id }]
              : payload.row.type === "session"
                ? [{ kind: "session", id: payload.row.session.id }]
                : [];
    if (!entries.length) return { element, mark: "drop-refused", run: null };
    return { element, mark, hint: " → 바로가기", run: () => saveShortcuts(addShortcuts(shortcuts, entries, index)) };
  };

  const { press, justDragged, store } = useDragController({
    resolve: resolveDrop,
    paneSource: (payload) => {
      if (payload.kind === "row") {
        const item = rowItem(payload.row);
        return item ? { item, label: rowLabel(payload.row) } : null;
      }
      if (payload.kind === "projects" && payload.works.length === 1) return { item: { kind: "work", id: payload.works[0]!.id }, label: payload.works[0]!.title };
      if (payload.kind === "shortcut" && (payload.entry.kind === "work" || payload.entry.kind === "session" || payload.entry.kind === "folder")) return { item: { kind: payload.entry.kind, id: payload.entry.id }, label: payload.label };
      return null;
    },
    label: (payload) =>
      payload.kind === "row" ? rowLabel(payload.row) : payload.kind === "projects" ? (payload.works.length === 1 ? payload.works[0]!.title : `프로젝트 ${payload.works.length}개`) : payload.kind === "shortcut" ? payload.label : `#${payload.tag}`,
    sources: (payload) => {
      const root = asideRef.current;
      if (!root) return [];
      const ids = payload.kind === "row" ? [payload.row.id] : payload.kind === "projects" ? payload.works.map((work) => work.id) : [];
      const found = ids.flatMap((id) => [...root.querySelectorAll<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)]);
      if (payload.kind === "shortcut") found.push(...root.querySelectorAll<HTMLElement>(`[data-shortcut-index="${payload.index}"]`));
      if (payload.kind === "tag") found.push(...root.querySelectorAll<HTMLElement>(`[data-tag="${CSS.escape(payload.tag)}"]`));
      return found;
    },
  });

  // ── rows as the tree shows them (the single tree, and a project unfolded in the list) ───
  const toggleRow = (row: Row) => {
    if (row.type === "folder") {
      const closed = new Set(open.closedFolders);
      if (row.open) closed.add(row.id);
      else closed.delete(row.id);
      onOpenChange({ ...open, closedFolders: [...closed] });
    } else if (row.type === "work" && row.expandable) {
      onOpenChange(toggleWork(open, row.id, row.open));
    } else if (row.type === "docs") {
      const docs = new Set(open.openDocs);
      if (row.open) docs.delete(row.work.id);
      else docs.add(row.work.id);
      onOpenChange({ ...open, openDocs: [...docs] });
    }
  };
  const activate = (row: Row) => {
    if (row.type === "folder" || row.type === "docs") return toggleRow(row);
    if (row.type === "work") return actions.openWork(row.work);
    if (row.type === "session") return actions.openSession(row.session);
    if (row.type === "doc") return actions.openDoc(row.artifact);
  };
  /** "바로가기에 더하기" or "바로가기에서 빼기" for something. */
  const shortcutToggle = (entry: NavShortcut): MenuEntry =>
    shortcuts.some((other) => sameShortcut(other, entry))
      ? { kind: "item", label: "바로가기에서 빼기", icon: "star", onSelect: () => saveShortcuts(shortcuts.filter((other) => !sameShortcut(other, entry))) }
      : { kind: "item", label: "바로가기에 더하기", icon: "star", onSelect: () => saveShortcuts(addShortcuts(shortcuts, [entry])) };
  /** "지우기…": an empty folder goes at once; one with things inside asks first (폴더만 지우기 · 보관). */
  const askDeleteFolder = (folder: Folder) => {
    const inside = Object.values(state.folders).some((child) => child.parentId === folder.id) || Object.values(state.works).some((work) => work.folderId === folder.id && !work.archivedAt);
    if (inside) return setDialog({ kind: "delete", folder });
    void api
      .deleteFolder(folder.id)
      .then(() => onToast(`「${folder.name}」 폴더를 지웠습니다.`))
      .catch(fail);
  };
  /**
   * A row's menu: the app's, with the navigator's own items. "고정" of a session becomes a shortcut
   * (shortcuts took the old "고정" section's place); works can be shortcuts; folders get a colour,
   * an icon, a shortcut and "지우기…".
   */
  const openMenuAt = (row: Row, x: number, y: number) => {
    const request = actions.menuFor(row, x, y);
    if (!request) return;
    let items = request.items;
    if (row.type === "session") {
      // A pinned session sat under the old "고정"; now it is kept in 바로가기 (and `pinned` follows).
      const entry = { kind: "session" as const, id: row.id };
      const pinned = row.session.pinned || shortcuts.some((other) => sameShortcut(other, entry));
      items = items.map((item) =>
        item.kind === "item" && (item.label === "고정" || item.label === "고정 풀기")
          ? {
              ...item,
              label: pinned ? "고정 풀기" : "고정",
              hint: "바로가기",
              onSelect: () => {
                saveShortcuts(pinned ? shortcuts.filter((other) => !sameShortcut(other, entry)) : addShortcuts(shortcuts, [entry]));
                void api.updateSession(row.id, { pinned: !pinned }).catch(fail);
              },
            }
          : item,
      );
    } else if (row.type === "work") {
      const at = items.findIndex((entry) => entry.kind === "item" && (entry.label === "고정" || entry.label === "고정 풀기"));
      items = at === -1 ? [...items, shortcutToggle({ kind: "work", id: row.id })] : [...items.slice(0, at + 1), shortcutToggle({ kind: "work", id: row.id }), ...items.slice(at + 1)];
    } else if (row.type === "folder") {
      const folder = row.folder;
      items = [
        ...beforeLastGroup(items, [{ kind: "item", label: "색·아이콘…", icon: "palette", onSelect: () => setDialog({ kind: "style", folder, x, y }) }, shortcutToggle({ kind: "folder", id: folder.id })]),
        { kind: "item", label: "지우기…", icon: "x", danger: true, onSelect: () => askDeleteFolder(folder) },
      ];
    }
    actions.openMenu({ ...request, items });
  };
  const navigable: Row[] = rows.filter((entry) => entry.type !== "section");
  const parentOf = (row: Row): Row | undefined => {
    const index = rows.indexOf(row);
    for (let at = index - 1; at >= 0; at -= 1) if (rows[at]!.depth < row.depth && rows[at]!.type !== "section") return rows[at];
    return undefined;
  };
  const treeKey = (event: ReactKeyboardEvent, row: Row) => {
    const index = navigable.indexOf(row);
    const expandable = (row.type === "folder" && !row.empty) || (row.type === "work" && row.expandable) || row.type === "docs";
    const isOpen = (row.type === "folder" || row.type === "work" || row.type === "docs") && row.open;
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const move = nudge(state, row, event.key === "ArrowUp" ? -1 : 1, sortMode);
      if (move) actions.move(move);
    } else if (event.key === "ArrowDown") {
      const next = navigable[index + 1];
      if (next) focusTreeRow(next.id);
    } else if (event.key === "ArrowUp") {
      const previous = navigable[index - 1];
      if (previous) focusTreeRow(previous.id);
    } else if (event.key === "ArrowRight") {
      if (expandable && !isOpen) toggleRow(row);
      else if (expandable && navigable[index + 1]) focusTreeRow(navigable[index + 1]!.id);
    } else if (event.key === "ArrowLeft") {
      if (expandable && isOpen) toggleRow(row);
      else {
        const parent = parentOf(row);
        if (parent) focusTreeRow(parent.id);
      }
    } else if (event.key === "Home") {
      if (navigable[0]) focusTreeRow(navigable[0].id);
    } else if (event.key === "End") {
      const last = navigable.at(-1);
      if (last) focusTreeRow(last.id);
    } else if (event.key === "Enter") {
      activate(row);
    } else if (event.key === "F2" && (row.type === "folder" || row.type === "work" || row.type === "session")) {
      setRenaming(row.id);
    } else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      openMenuAt(row, rect.left + 24, rect.bottom - 4);
    } else if (event.key === "Delete" && (row.type === "folder" || row.type === "work" || row.type === "session")) {
      actions.archive({ kind: row.type, id: row.id });
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  // Keyboard focus follows the rows that exist (a folded parent takes the focus of its child).
  useEffect(() => {
    if (treeFocus && !rowById.has(treeFocus)) setTreeFocus(null);
  }, [treeFocus, rowById]);

  const rowCtx: RowContext = {
    state,
    lookOf,
    visibleSessionId,
    currentWorkId,
    currentDocId,
    focusId: treeFocus,
    tabId: treeFocus && rowById.has(treeFocus) ? treeFocus : (navigable.find((row) => row.type === "work" && row.id === currentWorkId)?.id ?? navigable[0]?.id ?? null),
    renaming,
    startRename: setRenaming,
    toggle: toggleRow,
    activate,
    onKey: treeKey,
    onPress: (event: ReactPointerEvent, row: Row) => {
      if (event.button === 1 && actions.openRight && rowItem(row)) event.preventDefault();
      if (event.button !== 0 || renaming) return;
      if (row.type !== "folder" && row.type !== "work" && row.type !== "session" && row.type !== "doc") return;
      if ((event.target as HTMLElement).closest("input, .row-chevron")) return;
      press({ kind: "row", row }, event);
    },
    onFocusRow: setTreeFocus,
    onRename: (row, name) => (row.type === "folder" || row.type === "work" || row.type === "session") && actions.rename({ kind: row.type, id: row.id }, name),
    onRenameDone: (row) => {
      setRenaming(null);
      focusTreeRow(row.id);
    },
    onMenu: openMenuAt,
    justDragged,
    openRight: actions.openRight,
    newSession: (folderId) => actions.newSession({ folderId }),
    newPage: (row) => actions.newPage(row.work),
    newSubpage: actions.newSubpage,
  };

  const shared: NavShared = {
    state,
    api,
    actions,
    layout,
    nav: navState,
    saveNav,
    shortcuts,
    saveShortcuts,
    summaries,
    stages,
    projects,
    tags,
    counts,
    open,
    onOpenChange,
    sortMode,
    currentWorkId,
    visibleSessionId,
    currentDocId,
    homeActive,
    theme: appTheme,
    lookOf,
    rowCtx,
    press,
    justDragged,
    select,
    focusList,
    focusNav,
    renaming,
    setRenaming,
    creatingIn,
    setCreatingIn,
    setDialog,
    moveProjects,
    rowMenu: openMenuAt,
    toast: onToast,
    fail,
  };

  // ── head menus ──────────────────────────────────────────────────────────────────────────
  const layoutItems = (): MenuEntry[] => [
    ...LAYOUTS.map((entry) => ({ kind: "item" as const, label: entry.label, icon: entry.icon, checked: layout === entry.id, onSelect: () => saveNav({ layout: entry.id }) })),
    { kind: "item", label: "창 너비에 맞추기", hint: "넓으면 두 칸", checked: nav.layout === null, onSelect: () => saveNav({ layout: undefined }) },
  ];
  const menuAt = (button: HTMLElement, title: string, items: MenuEntry[]) => {
    const box = button.getBoundingClientRect();
    actions.openMenu({ x: box.left, y: box.bottom + 4, title, items });
  };
  const sideMenu = (button: HTMLElement) => {
    const sections = ["now", "shortcuts", "projects", "tags", "views"] as const;
    menuAt(button, "사이드바", [
      { kind: "label", label: "배치" },
      ...layoutItems(),
      { kind: "separator" },
      { kind: "item", label: "모든 섹션 펼치기", icon: "expandAll", onSelect: () => saveNav({ sections: {} }) },
      { kind: "item", label: "모든 섹션 접기", icon: "collapseAll", onSelect: () => saveNav({ sections: Object.fromEntries(sections.map((id) => [id, true])) }) },
      { kind: "separator" },
      { kind: "item", label: "다른 곳의 대화 가져오기…", icon: "restore", onSelect: actions.importConversations },
    ]);
  };
  // The tree's own order (직접 · 최근 · 이름), drawn above everything, never clipped by the tree.
  const openSort = (button: HTMLElement) => {
    const choices: [SortMode, string][] = [
      ["manual", "직접 정한 순서"],
      ["recent", "최근 활동 순"],
      ["name", "이름 순"],
    ];
    menuAt(button, "정렬", [
      ...choices.map(([mode, label]) => ({ kind: "item" as const, label, checked: sortMode === mode, onSelect: () => onSortMode(mode) })),
      { kind: "separator" as const },
      { kind: "item" as const, label: "다른 곳의 대화 가져오기…", icon: "restore" as const, onSelect: actions.importConversations },
    ]);
  };

  // ── sizes: the right edge, the divider between the panes (both remembered) ───────────────
  const navWidth = live?.nav ?? nav.navWidth;
  const listWidth = live?.list ?? nav.listWidth;
  const navHeight = live?.height ?? nav.navHeight;
  const singleWidth = live?.width ?? width;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const drag = (event: ReactPointerEvent, onMove: (dx: number, dy: number) => void, onDone: () => void) => {
    event.preventDefault();
    const x0 = event.clientX;
    const y0 = event.clientY;
    const move = (pointer: PointerEvent) => onMove(pointer.clientX - x0, pointer.clientY - y0);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.documentElement.classList.remove("nav-resizing");
      onDone();
    };
    document.documentElement.classList.add("nav-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const latestSize = useRef<{ nav?: number; list?: number; height?: number; width?: number }>({});
  const finishResize = () => {
    const size = latestSize.current;
    latestSize.current = {};
    setLive(null);
    if (size.width !== undefined && size.width !== width) onWidth(size.width);
    const patch: Partial<NavigatorPrefs> = {};
    if (size.nav !== undefined && size.nav !== nav.navWidth) patch.navWidth = size.nav;
    if (size.list !== undefined && size.list !== nav.listWidth) patch.listWidth = size.list;
    if (size.height !== undefined && size.height !== nav.navHeight) patch.navHeight = Math.round(size.height * 1000) / 1000;
    if (Object.keys(patch).length) saveNav(patch);
  };
  const setSize = (size: { nav?: number; list?: number; height?: number; width?: number }) => {
    // Whole pixels (a pointer can stand between two).
    const whole = Object.fromEntries(Object.entries(size).map(([key, value]) => [key, key === "height" ? value : Math.round(value)]));
    latestSize.current = { ...latestSize.current, ...whole };
    setLive({ ...latestSize.current });
  };
  const startEdge = (event: ReactPointerEvent) => {
    if (layout === "dual") drag(event, (dx) => setSize({ list: clamp(nav.listWidth + dx, LIST_WIDTH.min, LIST_WIDTH.max) }), finishResize);
    else drag(event, (dx) => setSize({ width: clamp(width + dx, MIN_WIDTH, MAX_WIDTH) }), finishResize);
  };
  const startDivider = (event: ReactPointerEvent) => {
    if (layout === "dual") {
      // The split moves; the sidebar keeps its width (as Notebook Navigator's divider).
      const total = nav.navWidth + nav.listWidth;
      drag(
        event,
        (dx) => {
          const next = Math.round(clamp(nav.navWidth + dx, NAV_WIDTH.min, Math.min(NAV_WIDTH.max, total - LIST_WIDTH.min)));
          setSize({ nav: next, list: clamp(total - next, LIST_WIDTH.min, LIST_WIDTH.max) });
        },
        finishResize,
      );
    } else {
      const body = (event.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
      drag(event, (_dx, dy) => setSize({ height: clamp(nav.navHeight + dy / Math.max(1, body.height), NAV_HEIGHT.min, NAV_HEIGHT.max) }), finishResize);
    }
  };
  const dividerKey = (event: ReactKeyboardEvent) => {
    const grow = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!grow) return;
    event.preventDefault();
    if (layout === "dual") {
      const total = nav.navWidth + nav.listWidth;
      const next = clamp(nav.navWidth + grow * 16, NAV_WIDTH.min, Math.min(NAV_WIDTH.max, total - LIST_WIDTH.min));
      saveNav({ navWidth: next, listWidth: clamp(total - next, LIST_WIDTH.min, LIST_WIDTH.max) });
    } else saveNav({ navHeight: clamp(nav.navHeight + grow * 0.04, NAV_HEIGHT.min, NAV_HEIGHT.max) });
  };

  // ── dialogs ─────────────────────────────────────────────────────────────────────────────
  const knownTags = useMemo(() => {
    const out: string[] = [];
    const walk = (nodes: TagNode[]) => nodes.forEach((node) => (out.push(node.tag), walk(node.children)));
    walk(tags.nodes);
    return out;
  }, [tags]);
  const addTags = (works: Work[], added: string[]) =>
    void Promise.allSettled(
      works.map((work) => {
        const current = projects.find((project) => project.work.id === work.id)?.tags ?? work.tags ?? [];
        return api.setProjectProperty(work.id, "tags", [...new Set([...current, ...added])], "tags");
      }),
    ).then((results) => {
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) fail(failed.reason);
      const done = results.filter((result) => result.status === "fulfilled").length;
      if (done) onToast(`${added.map((tag) => `#${tag}`).join(" ")} 태그를 더했습니다${done > 1 ? ` (프로젝트 ${done}개)` : ""}.`);
    });
  const deleteDialog = (folder: Folder) => {
    const parent = folder.parentId ? state.folders[folder.parentId] : undefined;
    const parentName = parent?.name ?? "프로젝트";
    const away = () => {
      if (selected.kind === "folder" && selected.id === folder.id) saveNav({ selected: parent ? { kind: "folder", id: parent.id } : { kind: "root" } });
    };
    return (
      <FolderDeleteDialog
        folder={folder}
        projects={(counts.folders.get(folder.id)?.own ?? 0) + (counts.folders.get(folder.id)?.below ?? 0)}
        folders={folderOrder(state.folders, folder.id).length}
        parentName={parentName}
        onClose={() => setDialog(null)}
        onDeleteOnly={() => {
          setDialog(null);
          void api
            .deleteFolder(folder.id)
            .then(() => {
              away();
              onToast(`「${folder.name}」 폴더를 지웠습니다. 안의 것은 「${parentName}」(으)로 옮겼습니다.`);
            })
            .catch(fail);
        }}
        onArchive={() => {
          setDialog(null);
          away();
          actions.archive({ kind: "folder", id: folder.id });
        }}
      />
    );
  };

  // The combinations set in ⋯ › 단축키, as the buttons' hints.
  const keys = shortcutsOf(state.prefs);
  const totalWidth = layout === "dual" ? navWidth + listWidth + 1 : singleWidth;
  const listPane = (
    <ListPane
      shared={shared}
      items={items}
      count={listed.count}
      selected={chosen}
      setSelected={setChosen}
      anchor={anchor}
      setAnchor={setAnchor}
      focusId={listFocus}
      setFocusId={setListFocus}
      query={query}
      setQuery={setQuery}
      filterOpen={filterOpen}
      setFilterOpen={setFilterOpen}
      treeRef={listRef}
    />
  );
  return (
    <aside
      ref={asideRef}
      className={`sidebar look-scope nav-${layout}`}
      aria-label="세션과 작업"
      data-theme={appTheme}
      data-layout={layout}
      style={{ ...lookStyle(NEUTRAL_LOOK[appTheme]), width: totalWidth, ...(layout === "dual" ? ({ "--nav-width": `${navWidth}px`, "--list-width": `${listWidth}px` } as CSSProperties) : {}) }}
    >
      <div className="side-head">
        <div className="side-head-row">
          <button type="button" className="side-new" onClick={() => actions.newSession({})} title={`새 세션 (${comboLabel(keys.newWork)})`}>
            <Icon name="plus" size={15} /> 새 세션
          </button>
          <button
            type="button"
            className="icon-button small side-layout"
            title={`사이드바 배치: ${LAYOUTS.find((entry) => entry.id === layout)!.label}`}
            aria-label="사이드바 배치"
            aria-haspopup="menu"
            onClick={(event) => menuAt(event.currentTarget, "사이드바 배치", layoutItems())}
          >
            <Icon name={LAYOUTS.find((entry) => entry.id === layout)!.icon} size={16} />
          </button>
          <button type="button" className="icon-button small" title="사이드바 메뉴" aria-label="사이드바 메뉴" aria-haspopup="menu" onClick={(event) => sideMenu(event.currentTarget)}>
            <Icon name="dots" size={16} />
          </button>
        </div>
        <button type="button" className="side-search" onClick={actions.openSearch} title={`찾기 (${comboLabel(keys.palette)})`}>
          <Icon name="search" size={15} />
          <span>찾기</span>
          <kbd>{comboLabel(keys.palette)}</kbd>
        </button>
      </div>

      {navigating ? (
        <div className={`nav-body ${layout}`} style={layout === "stacked" ? ({ "--nav-height": `${navHeight * 100}%` } as CSSProperties) : undefined}>
          <NavPane shared={shared} />
          <div
            className="nav-divider"
            role="separator"
            tabIndex={0}
            aria-orientation={layout === "dual" ? "vertical" : "horizontal"}
            aria-label="탐색 칸과 목록 칸 사이"
            onPointerDown={startDivider}
            onKeyDown={dividerKey}
            onDoubleClick={() => saveNav(layout === "dual" ? { navWidth: NAV_WIDTH.initial, listWidth: LIST_WIDTH.initial } : { navHeight: NAV_HEIGHT.initial })}
          />
          {listPane}
        </div>
      ) : (
        <div className="side-scroll">
          <HomeRow shared={shared} />
          <NowSection shared={shared} />
          <ShortcutsSection shared={shared} />
          <TreeSection shared={shared} rows={rows} treeRef={treeRef} onSort={openSort} />
          <ViewsSection openMenu={actions.openMenu} folded={Boolean(nav.sections.views)} onFold={(folded) => saveNav({ sections: { ...nav.sections, views: folded } })} menuExtras={(view) => [viewShortcutEntry(shared, view.id)]} />
          <VaultSection theme={appTheme} openMenu={actions.openMenu} />
        </div>
      )}

      <div className="side-foot">
        <UsageCard providers={state.providers} onRefresh={actions.refreshUsage} />
        <button type="button" className="side-row" onClick={actions.openArchive} title="보관한 세션·작업·폴더">
          <Icon name="archive" size={15} className="side-row-icon" />
          <span className="side-row-label">보관함</span>
          {(() => {
            const count =
              Object.values(state.folders).filter((folder) => folder.archivedAt).length +
              Object.values(state.works).filter((work) => work.archivedAt).length +
              Object.values(state.sessions).filter((session) => session.archivedAt).length;
            return count ? <span className="side-row-trail muted">{count}</span> : null;
          })()}
        </button>
      </div>
      <div className="side-resize" onPointerDown={startEdge} role="separator" aria-orientation="vertical" aria-label="사이드바 너비" />
      <DragGhost store={store} />
      {dialog?.kind === "delete" ? deleteDialog(state.folders[dialog.folder.id] ?? dialog.folder) : null}
      {dialog?.kind === "style" && state.folders[dialog.folder.id] ? (
        <FolderStylePanel
          folder={state.folders[dialog.folder.id]!}
          stages={stages}
          x={dialog.x}
          y={dialog.y}
          onColor={(color) => void api.updateFolder(dialog.folder.id, { color }).catch(fail)}
          onIcon={(icon) => void api.updateFolder(dialog.folder.id, { icon }).catch(fail)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "tags" ? (
        <TagPrompt
          x={dialog.x}
          y={dialog.y}
          count={dialog.works.length}
          known={knownTags}
          onAdd={(added) => {
            addTags(dialog.works, added);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </aside>
  );
}

/** A folder row for menus built outside the tree (e.g. from the archive). */
export const folderRow = (folder: Folder): Row => ({ type: "folder", id: folder.id, depth: 0, folder, open: true, empty: false });
export type { MenuEntry, MenuRequest };
