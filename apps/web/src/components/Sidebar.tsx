import { withParticle } from "@workbench/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { failure } from "../top-notice.ts";
import type { Artifact, DocumentRemovalPlan, Folder, NavigatorPrefs, NavSelection, NavShortcut, ProjectStage, ProjectSummary, UiPrefs, Work } from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { State } from "../state.ts";
import { docOpenTarget, holds, linkPair, moveFor, nudge, toggleWork, workHidden, type Row, type SortMode, type TreeOpenState } from "../tree.ts";
import { useAppearance } from "../appearance.ts";
import { Icon } from "./Icon.tsx";
import type { MenuEntry, MenuRequest } from "./ContextMenu.tsx";
import { UsageCard } from "./UsageCard.tsx";
import { linkable } from "./LinkSidebar.tsx";
import { useDragController, useGhost, zoneOf, type DragPayload, type DropTarget, type GhostStore } from "./nav/drag.ts";
import { SIDE_WIDTH, addShortcuts, folderCounts, folderOrder, insideSections, levelOneRows, moveShortcut, projectsOf, readNavigator, readShortcuts, sameShortcut, seedShortcuts, sortFor, tagTree, type TagNode } from "./nav/model.ts";
import { ROOT_ROW_ID, beforeLastGroup } from "./nav/NavPane.tsx";
import { rowItem, rowLabel, type RowContext } from "./nav/rows.tsx";
import { RowMenu } from "./nav/RowMenu.tsx";
import { MIN_PANE } from "../panes.ts";
import type { LayerAnchor } from "./ui/AnchoredLayer.tsx";
import { FolderDeleteDialog, FolderStylePanel, TagPrompt } from "./nav/dialogs.tsx";
import { onNavigatorFocus, takeNavigatorFocus } from "./nav/focus.ts";
import { addNoteTags, tagsNotice } from "./nav/tags.ts";
import { ProjectsLevel, type LevelOneState } from "./nav/ProjectsLevel.tsx";
import { ProjectLevel } from "./nav/ProjectLevel.tsx";
import { ActivityList, DocsList, NowList, VaultList } from "./nav/Lists.tsx";
import { placePrefix, useNavPlace, type NavPlace } from "./nav/place.ts";
import type { NavDialog, NavShared, SidebarActions, Toast } from "./nav/shared.ts";
import "../styles/navigator.css";

// The list column (N1, the owner's navigation, 2026-11-14): ONE white column beside the navy rail.
// The rail chooses what it shows: 프로젝트 (level 1: every project in its folders; level 2: inside
// one project, "← 프로젝트 목록" back), 문서, 활동 or 볼트. Going back changes the list only: the
// tabs, the panes and the running AI stay, and level 1 comes back with its folds, scroll and picks.
// The three old layouts (두 칸 · 위아래 · 한 칸) collapse into it; what they stored is kept.

export type { SidebarActions } from "./nav/shared.ts";
export { rowItem } from "./nav/rows.tsx";

const NO_SHORTCUTS: NavShortcut[] = [];

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
function useProjectData(api: Api, state: State) {
  const [summaries, setSummaries] = useState<Map<string, ProjectSummary>>(() => new Map());
  const [stages, setStages] = useState<ProjectStage[]>([]);
  const version = useMemo(() => Object.entries(state.pkm).filter(([key]) => key.startsWith("project:")).map(([key, value]) => `${key}=${value}`).join(","), [state.pkm]);
  const worksKey = useMemo(() => Object.values(state.works).map((work) => `${work.id}:${work.archivedAt ?? 0}`).join(","), [state.works]);
  const loaded = useRef(false);
  useEffect(() => {
    let cancelled = false;
    // Several changes in a row (a turn writing the note, a rule) are read once.
    const timer = window.setTimeout(
      () => {
        void Promise.all([api.projects(), api.projectStages()])
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
  }, [api, version, worksKey]);
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

export type PrefsPatch = UiPrefs | ((current: UiPrefs) => UiPrefs);

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
  paneMinimum = MIN_PANE,
  actions,
  pending,
  onPendingDone,
  homeActive = false,
  homeOwnsNow = false,
  atNow = false,
  onLeaveNow,
  prefs,
  onPrefs,
  api,
  onToast,
  unreadNotices = 0,
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
  /** The least width the work panes need side by side (panes.ts `minimumSize`): the column never takes it. */
  paneMinimum?: number;
  actions: SidebarActions;
  /** A rename or a new folder asked from a menu. */
  pending: { rename?: string; createIn?: string | null } | null;
  onPendingDone: () => void;
  /** Home is on screen. */
  homeActive?: boolean;
  /** Home's 지금 ledger is on screen: it lists what waits, so 지금 here keeps only the counts. */
  homeOwnsNow?: boolean;
  /** The rail's 지금 is lit (home's 지금 on screen): the column shows what 지금 means for navigation. */
  atNow?: boolean;
  /** Leave 지금 for the project list (the empty 지금 list's one action). */
  onLeaveNow?: () => void;
  /** The screen preferences as last edited (`navigator`, `navShortcuts`), and how to change them (a patch, or a change of the latest). */
  prefs: UiPrefs;
  onPrefs: (patch: PrefsPatch) => void;
  api: Api;
  onToast: (message: Toast) => void;
  unreadNotices?: number;
}) {
  const { lookOf, appTheme } = useAppearance();
  const asideRef = useRef<HTMLElement>(null);
  const fail = useCallback((error: unknown) => onToast(failure(error)), [onToast]);

  // ── preferences: the navigator's own object and the shortcuts ───────────────────────────
  // Where the column is (rail, level, project, scroll) belongs to THIS window (nav/place.ts); the
  // rest of `navigator` (folds, sorts, sections, shortcuts) stays shared in the gateway prefs.
  const [place, setPlace] = useNavPlace(placePrefix(api.remoteHostId), prefs.navigator);
  const nav = useMemo(() => ({ ...readNavigator(prefs.navigator), rail: place.rail, level: place.level, project: place.project }), [prefs.navigator, place]);
  const windowWidth = useWindowWidth();
  // Every change builds on the latest stored object (several in a row never undo each other), and
  // keeps every key it does not know (an older or newer app may have written them).
  const saveNav = useCallback((patch: Partial<NavigatorPrefs>) => {
    const { rail, level, project, ...shared } = patch;
    const here: Partial<NavPlace> = {};
    if (rail !== undefined) here.rail = rail;
    if (level !== undefined) here.level = level;
    if (project !== undefined) here.project = project;
    if (Object.keys(here).length) setPlace(here);
    if (Object.keys(shared).length) onPrefs((current) => ({ navigator: { ...record(current.navigator), ...shared } }));
  }, [onPrefs, setPlace]);
  const stored = useMemo(() => readShortcuts(prefs.navShortcuts), [prefs.navShortcuts]);
  const shortcuts = stored ?? NO_SHORTCUTS;
  const saveShortcuts = useCallback((next: NavShortcut[]) => onPrefs({ navShortcuts: next }), [onPrefs]);
  // "바로가기" replaces "고정": once, what was pinned becomes the first shortcuts (`pinned` stays).
  const unseeded = stored === null;
  useEffect(() => {
    if (unseeded) onPrefs({ navShortcuts: seedShortcuts(state) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unseeded]);

  // ── what the column shows ───────────────────────────────────────────────────────────────
  const { summaries, stages } = useProjectData(api, state);
  const docsByWork = useMemo(() => docsByWorkOf(state.artifacts), [state.artifacts]);
  const projects = useMemo(() => projectsOf(state, summaries, visibleSessionId), [state.works, state.sessions, state.folders, summaries, visibleSessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => folderCounts(projects, state.folders), [projects, state.folders]);
  const tags = useMemo(() => tagTree(projects), [projects]);
  // A folder selected that is gone (deleted, archived) leaves the root selected.
  const selected: NavSelection = nav.selected.kind === "folder" && (!state.folders[nav.selected.id] || state.folders[nav.selected.id]!.archivedAt) ? { kind: "root" } : nav.selected;
  const navState = useMemo(() => ({ ...nav, selected }), [nav, selected.kind === "folder" ? selected.id : selected.kind === "tag" ? selected.tag : selected.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const inside = nav.level === "project" && nav.project ? state.works[nav.project] : undefined;
  const insideWork = inside && !workHidden(state, inside) ? inside : undefined;
  const level = nav.rail === "projects" && insideWork ? "project" : "projects";

  // Level 1's own state lives here, so it is as it was when the person comes back from inside.
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [listFocus, setListFocus] = useState<string | null>(null);
  const scroll = useRef(place.scroll);
  const [fieldOpen, setFieldOpen] = useState(false);
  const local: LevelOneState = { query, setQuery, picked, setPicked, anchor, setAnchor, focusId: listFocus, setFocusId: setListFocus, scroll, keepScroll: (top) => setPlace({ scroll: top }), fieldOpen, setFieldOpen };
  const [insideQuery, setInsideQuery] = useState("");
  const [treeFocus, setTreeFocus] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<string | null | undefined>(undefined);
  const [dialog, setDialog] = useState<NavDialog | null>(null);
  /** A document row's menu (the shared Menu): at the pointer, or under its ⋯. */
  const [rowMenu, setRowMenu] = useState<{ rowId: string; request: MenuRequest; anchor: LayerAnchor } | null>(null);
  const [live, setLive] = useState<number | null>(null);

  // The list follows what is opened (nav/place.ts `followOpen`, driven by the app for every way of
  // opening); here only the inside search is left behind when the project changes.
  useEffect(() => setInsideQuery(""), [nav.project]);

  // Every row a drag can land on, by its `data-row-id` (what the column shows now).
  const rowById = useMemo(() => {
    const map = new Map<string, Row>();
    map.set(ROOT_ROW_ID, { type: "section", id: ROOT_ROW_ID, depth: 0, label: "프로젝트" });
    for (const { folder, depth } of folderOrder(state.folders, null)) map.set(folder.id, { type: "folder", id: folder.id, depth, folder, open: true, empty: false });
    for (const project of projects) map.set(project.work.id, { type: "work", id: project.work.id, depth: 0, work: project.work, open: false, expandable: false, sessions: project.sessions, docs: docsByWork.get(project.work.id) ?? [] });
    if (insideWork) {
      const sections = insideSections(state, insideWork);
      for (const row of [...sections.chats, ...sections.docs, ...sections.web]) map.set(row.id, row);
    }
    return map;
  }, [state, projects, docsByWork, insideWork]);

  // Picks stay among what is listed.
  useEffect(() => {
    setPicked((current) => (current.length && current.some((id) => !rowById.has(id)) ? current.filter((id) => rowById.has(id)) : current));
  }, [rowById]);

  // ── where the column goes ───────────────────────────────────────────────────────────────
  const focusIn = useCallback((selector?: string) => {
    const from = document.activeElement;
    window.requestAnimationFrame(() => {
      if (document.activeElement !== from && document.activeElement !== document.body) return;
      const root = asideRef.current;
      const target = (selector ? root?.querySelector<HTMLElement>(selector) : null) ?? root?.querySelector<HTMLElement>('[data-list-row][tabindex="0"]') ?? root?.querySelector<HTMLElement>("[data-list-row]");
      target?.focus();
      target?.scrollIntoView({ block: "nearest" });
    });
  }, []);
  const focusList = useCallback((id?: string | null) => focusIn(id ? `[data-row-id="${CSS.escape(id)}"]` : undefined), [focusIn]);
  // "내비게이터로" (Ctrl+Shift+E): asked before the column was there, or while it is.
  useEffect(() => {
    if (takeNavigatorFocus()) focusList();
    return onNavigatorFocus(() => {
      if (takeNavigatorFocus()) focusList();
    });
  }, [focusList]);
  /** Folds open on the way to a folder (its ancestors and itself). */
  const unfoldTo = useCallback((folderId: string, itself = true) => {
    const above = new Set<string>();
    for (let at: string | null = itself ? folderId : (state.folders[folderId]?.parentId ?? null); at && !above.has(at); at = state.folders[at]?.parentId ?? null) above.add(at);
    if (open.closedFolders.some((id) => above.has(id))) onOpenChange({ ...open, closedFolders: open.closedFolders.filter((id) => !above.has(id)) });
  }, [state.folders, open, onOpenChange]);

  /** Back to every project: the list only (nothing in the centre moves). */
  const back = useCallback(() => {
    saveNav({ level: "projects" });
    setInsideQuery("");
    // The project that was open is where the keyboard lands (unless the person picked another row).
    const target = listFocus ?? nav.project;
    focusIn(target ? `[data-row-id="${CSS.escape(target)}"]` : undefined);
  }, [saveNav, focusIn, listFocus, nav.project]);
  /** Inside a project: the list shows it; the centre brings back its last tab (the app decides). */
  const choose = useCallback((work: Work) => {
    saveNav({ rail: "projects", level: "project", project: work.id });
    setInsideQuery("");
    setListFocus(work.id);
    // The keyboard lands on the level's head (its back key), where the person can go on or back.
    if (asideRef.current?.contains(document.activeElement)) window.requestAnimationFrame(() => asideRef.current?.querySelector<HTMLElement>(".nav-back")?.focus());
    if (actions.chooseProject) actions.chooseProject(work);
    else actions.openWork(work);
  }, [saveNav, actions]);

  const select = useCallback(
    (next: NavSelection) => {
      if (next.kind === "folder") {
        // A folder (from 바로가기): level 1, unfolded on the way, the keyboard on it.
        saveNav({ rail: "projects", level: "projects" });
        unfoldTo(next.id);
        focusList(next.id);
        return;
      }
      saveNav({ rail: "projects", level: "projects", selected: next });
    },
    [saveNav, unfoldTo, focusList],
  );

  // Menus ask for an inline rename or a new folder: the row must be listed first.
  useEffect(() => {
    if (!pending) return;
    if (pending.rename !== undefined) {
      const id = pending.rename;
      setRenaming(id);
      const session = state.sessions[id];
      const folder = state.folders[id];
      const work = state.works[id];
      if (session) saveNav({ rail: "projects", level: "project", project: session.workId });
      else if (folder) { saveNav({ rail: "projects", level: "projects" }); unfoldTo(id, false); }
      else if (work) { saveNav({ rail: "projects", level: "projects" }); if (work.folderId) unfoldTo(work.folderId); }
    }
    if (pending.createIn !== undefined) {
      setCreatingIn(pending.createIn);
      saveNav({ rail: "projects", level: "projects" });
      if (pending.createIn) unfoldTo(pending.createIn);
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
        .then(() => moving.length > 1 && onToast(`프로젝트 ${moving.length}개를 ${withParticle(`「${name}」`, "으로/로")} 옮겼습니다.`))
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
    const onFolder = element.dataset.navFolder !== undefined;
    if (payload.kind === "projects") {
      if (!onFolder) return { element, mark: "drop-refused", run: null };
      const folderId = row.type === "folder" ? row.folder.id : null;
      if (payload.works.every((work) => (work.folderId ?? null) === folderId)) return { element, mark: "drop-refused", run: null };
      return { element, mark: "drop-inside", hint: ` → ${row.type === "folder" ? row.folder.name : "폴더 밖"}`, run: () => moveProjects(payload.works, folderId) };
    }
    if (payload.kind !== "row") return null;
    const dragged = payload.row;
    if (row.id === dragged.id) return null;
    // Folders nest and reorder among folders; "폴더 밖" takes them to the top.
    if (dragged.type === "folder") {
      if (!onFolder) return { element, mark: "drop-refused", run: null };
      const where = row.type === "section" ? "inside" : zoneOf(element, y, true);
      const move = moveFor(state, dragged, row, where, "manual");
      return { element, mark: move ? `drop-${where}` : "drop-refused", run: move ? () => actions.move(move) : null };
    }
    if (onFolder) return { element, mark: "drop-refused", run: null };
    // As the tree always did: a session links with another, reorders among its own, or becomes a page of a work.
    if (dragged.type === "session" && row.type === "work" && actions.sessionPage) {
      const work = row.work;
      return { element, mark: "drop-page", hint: ` → 「${work.title}」에 대화 기록 페이지`, run: () => actions.sessionPage!(dragged.session, work) };
    }
    const pair = linkPair(dragged, row);
    const where = zoneOf(element, y, holds(row, dragged) || Boolean(pair));
    const link = where === "inside" && pair && linkable(Object.values(state.links), pair.map((session) => session.id)) ? pair : null;
    if (link) return { element, mark: "drop-link", linking: true, text: `⇄ 대화 잇기: ${link[0].purpose} · ${link[1].purpose}`, run: () => actions.linkSessions(link) };
    const move = pair && where === "inside" ? null : moveFor(state, dragged, row, where, "manual");
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

  // ── rows as the tree shows them (inside a project) ──────────────────────────────────────
  const toggleRow = (row: Row) => {
    if (row.type === "folder") {
      const closed = new Set(open.closedFolders);
      if (row.open) closed.add(row.id);
      else closed.delete(row.id);
      onOpenChange({ ...open, closedFolders: [...closed] });
    } else if (row.type === "work" && row.expandable) onOpenChange(toggleWork(open, row.id, row.open));
  };
  const activate = (row: Row) => {
    if (row.type === "folder" || row.type === "docs") return toggleRow(row);
    if (row.type === "work") return choose(row.work);
    if (row.type === "session") return actions.openSession(row.session);
    if (row.type === "doc") {
      // The row and the click agree: the AI shown beside the document is the one the row shows.
      const target = docOpenTarget(row.agents, visibleSessionId);
      if (target && actions.openDocAgent) return actions.openDocAgent(row.artifact, target);
      return actions.openDoc(row.artifact);
    }
  };
  /** "바로가기에 더하기" or "바로가기에서 빼기" for something. */
  const shortcutToggle = (entry: NavShortcut): MenuEntry =>
    shortcuts.some((other) => sameShortcut(other, entry))
      ? { kind: "item", label: "바로가기에서 빼기", icon: "star", onSelect: () => saveShortcuts(shortcuts.filter((other) => !sameShortcut(other, entry))) }
      : { kind: "item", label: "바로가기에 더하기", icon: "star", onSelect: () => saveShortcuts(addShortcuts(shortcuts, [entry])) };
  /** "지우기…": an empty folder goes at once; one with things inside asks first (폴더만 지우기 · 보관). */
  const askDeleteFolder = (folder: Folder) => {
    const filled = Object.values(state.folders).some((child) => child.parentId === folder.id) || Object.values(state.works).some((work) => work.folderId === folder.id && !work.archivedAt);
    if (filled) return setDialog({ kind: "delete", folder });
    void api
      .deleteFolder(folder.id)
      .then(() => onToast(`「${folder.name}」 폴더를 지웠습니다.`))
      .catch(fail);
  };
  /** A row's menu: the app's, with the navigator's own items (바로가기; a folder's colour, icon and delete). */
  const openMenuAt = (row: Row, x: number, y: number, at?: HTMLElement) => {
    if (row.type === "doc") {
      // The 삭제 item says what the gateway would do with this file now.
      const show = (removal?: DocumentRemovalPlan) => {
        const request = actions.menuFor(row, x, y, removal);
        if (request) setRowMenu({ rowId: row.id, request, anchor: at ?? { x, y } });
      };
      if (actions.docRemoval) void actions.docRemoval(row.artifact).then(show, () => show());
      else show();
      return;
    }
    const request = actions.menuFor(row, x, y);
    if (!request) return;
    let items = request.items;
    if (row.type === "work") {
      const pin = items.findIndex((entry) => entry.kind === "item" && (entry.label === "고정" || entry.label === "고정 풀기"));
      items = pin === -1 ? [...items, shortcutToggle({ kind: "work", id: row.id })] : [...items.slice(0, pin + 1), shortcutToggle({ kind: "work", id: row.id }), ...items.slice(pin + 1)];
    } else if (row.type === "folder") {
      const folder = row.folder;
      items = [
        ...beforeLastGroup(items, [{ kind: "item", label: "색·아이콘…", icon: "palette", onSelect: () => setDialog({ kind: "style", folder, x, y }) }, shortcutToggle({ kind: "folder", id: folder.id })]),
        { kind: "item", label: "지우기…", icon: "x", danger: true, onSelect: () => askDeleteFolder(folder) },
      ];
    }
    actions.openMenu({ ...request, items });
  };
  const treeKey = (event: ReactKeyboardEvent, row: Row) => {
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const move = nudge(state, row, event.key === "ArrowUp" ? -1 : 1, "manual");
      if (move) actions.move(move);
    } else if (event.key === "Enter") activate(row);
    else if (event.key === "F2" && (row.type === "folder" || row.type === "work" || row.type === "session")) setRenaming(row.id);
    else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      openMenuAt(row, rect.left + 24, rect.bottom - 4);
    } else if (event.key === "Delete" && (row.type === "folder" || row.type === "work" || row.type === "session")) actions.archive({ kind: row.type, id: row.id });
    else if (event.key === "Delete" && row.type === "doc") {
      // A document's Delete opens its menu: the person picks 목록에서 빼기 or 휴지통으로 옮기기 there.
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      openMenuAt(row, rect.left + 24, rect.bottom - 4);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };
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
    tabId: treeFocus,
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
      focusList(row.id);
    },
    onMenu: openMenuAt,
    onMoreMenu: (row, at) => {
      const box = at.getBoundingClientRect();
      openMenuAt(row, box.right, box.bottom, at);
    },
    menuOpenId: rowMenu?.rowId ?? null,
    justDragged,
    openRight: actions.openRight,
    closeWebTab: actions.closeWebTab,
    newSession: (folderId) => actions.newSession({ folderId }),
    newPage: (row) => actions.newPage(row.work),
    creationMenu: actions.creationMenu,
    newSubpage: actions.newSubpage,
  };

  const shared: NavShared = {
    state,
    api,
    actions,
    layout: "dual",
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
    homeOwnsNow,
    theme: appTheme,
    lookOf,
    rowCtx,
    press,
    justDragged,
    select,
    focusList,
    focusNav: () => focusIn(),
    renaming,
    setRenaming,
    creatingIn,
    setCreatingIn,
    setDialog,
    moveProjects,
    rowMenu: openMenuAt,
    menuUnder: (request, button) => setRowMenu({ rowId: "", request, anchor: button }),
    toast: onToast,
    fail,
    unreadNotices,
  };

  // ── the column's width (remembered; the work panes keep their least width) ──────────────
  const shownWidth = live ?? width;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const widest = Math.max(SIDE_WIDTH.min, Math.min(SIDE_WIDTH.max, windowWidth - 8 - paneMinimum));
  const startEdge = (event: ReactPointerEvent) => {
    event.preventDefault();
    const x0 = event.clientX;
    let latest = width;
    const move = (pointer: PointerEvent) => { latest = Math.round(clamp(width + pointer.clientX - x0, SIDE_WIDTH.min, widest)); setLive(latest); };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.documentElement.classList.remove("nav-resizing");
      setLive(null);
      if (latest !== width) onWidth(latest);
    };
    document.documentElement.classList.add("nav-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const edgeKey = (event: ReactKeyboardEvent) => {
    const grow = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!grow) return;
    event.preventDefault();
    const next = clamp(width + grow * 16, SIDE_WIDTH.min, widest);
    if (next !== width) onWidth(next);
  };

  // ── dialogs ─────────────────────────────────────────────────────────────────────────────
  const knownTags = useMemo(() => {
    const out: string[] = [];
    const walk = (nodes: TagNode[]) => nodes.forEach((node) => (out.push(node.tag), walk(node.children)));
    walk(tags.nodes);
    return out;
  }, [tags]);
  // One tag per write, in order, per project (nav/tags.ts); a refusal says which went in and which did not.
  const addTags = (works: Work[], added: string[]) =>
    void Promise.all(works.map((work) => addNoteTags(api, work, projects.find((project) => project.work.id === work.id)?.tags ?? work.tags ?? [], added))).then((results) => {
      const notice = tagsNotice(results);
      if (notice) onToast(notice.ok ? notice.text : { kind: "error", text: notice.text });
    });
  const deleteDialog = (folder: Folder) => {
    const parent = folder.parentId ? state.folders[folder.parentId] : undefined;
    const parentName = parent?.name ?? "프로젝트";
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
            .then(() => onToast(`「${folder.name}」 폴더를 지웠습니다. 안의 것은 ${withParticle(`「${parentName}」`, "으로/로")} 옮겼습니다.`))
            .catch(fail);
        }}
        onArchive={() => {
          setDialog(null);
          actions.archive({ kind: "folder", id: folder.id });
        }}
      />
    );
  };

  // Level 1 counts its own rows (for the tests and the probe: how many projects are listed).
  const listedCount = useMemo(
    () => (nav.rail === "projects" && level === "projects" ? levelOneRows(projects, state.folders, { closedFolders: open.closedFolders, query, filter: selected, sortMode, groupBy: nav.groupBy, sort: sortFor(nav, { kind: "root" }), stages, now: Date.now() }).count : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nav.rail, level, projects, state.folders, open.closedFolders, query, selected, sortMode, nav.groupBy, stages],
  );
  const archived =
    Object.values(state.folders).filter((folder) => folder.archivedAt).length +
    Object.values(state.works).filter((work) => work.archivedAt).length +
    Object.values(state.sessions).filter((session) => session.archivedAt).length +
    Object.keys(state.removedArtifacts).length;

  return (
    <aside
      ref={asideRef}
      className="sidebar look-scope nav-column"
      data-screen="S06"
      aria-label="프로젝트 탐색"
      onContextMenu={(event) => {
        if (event.defaultPrevented || !(event.target instanceof Element) || event.target.closest("input,textarea,[contenteditable=true]")) return;
        if (!event.target.closest(".nav-scroll")) return;
        if (!actions.creationMenu) return;
        event.preventDefault();
        actions.creationMenu(insideWork ?? (currentWorkId ? state.works[currentWorkId] ?? null : null), event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        // Alt+← while the column has the focus: back to every project (the list only).
        if (event.altKey && event.key === "ArrowLeft" && level === "project" && nav.rail === "projects") { event.preventDefault(); back(); }
        // Ctrl+F in the column: its filter field (this level's).
        else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === "f" || event.code === "KeyF") && (nav.rail === "projects" || nav.rail === "docs")) {
          event.preventDefault();
          if (level === "projects") setFieldOpen(true);
          window.requestAnimationFrame(() => (asideRef.current?.querySelector<HTMLElement>(".nav-find:not(.pressed)")?.click(), asideRef.current?.querySelector<HTMLInputElement>(".nav-field input")?.focus()));
        }
      }}
      data-theme={appTheme}
      data-layout="one"
      data-rail={atNow ? "now" : nav.rail}
      data-level={nav.rail === "projects" ? level : undefined}
      data-listed={nav.rail === "projects" && level === "projects" ? listedCount : undefined}
      style={{ width: shownWidth }}
    >
      {atNow ? (
        <NowList shared={shared} onProjects={onLeaveNow ?? (() => saveNav({ rail: "projects" }))} />
      ) : nav.rail === "docs" ? (
        <DocsList shared={shared} />
      ) : nav.rail === "activity" ? (
        <ActivityList shared={shared} />
      ) : nav.rail === "vault" ? (
        <VaultList shared={shared} />
      ) : level === "project" && insideWork ? (
        <ProjectLevel key={insideWork.id} shared={shared} work={insideWork} query={insideQuery} setQuery={setInsideQuery} onBack={back} />
      ) : (
        <ProjectsLevel shared={shared} local={local} docCount={(id) => docsByWork.get(id)?.length ?? 0} onChoose={choose} onFolderNew={(parent) => setCreatingIn(parent)} onSort={onSortMode} />
      )}

      <div className="side-foot">
        <UsageCard providers={state.providers} onRefresh={actions.refreshUsage} folded={Boolean(nav.sections.usage)} onFold={(folded) => saveNav({ sections: { ...nav.sections, usage: folded } })} />
        <button type="button" className="side-row" onClick={actions.openArchive} title="보관한 대화·작업·폴더와 지운 문서">
          <Icon name="archive" size={15} className="side-row-icon" />
          <span className="side-row-label">보관함</span>
          {archived ? <span className="side-row-trail muted">{archived}</span> : null}
        </button>
      </div>
      <div
        className="side-resize"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="사이드바 너비"
        aria-valuemin={SIDE_WIDTH.min}
        aria-valuemax={widest}
        aria-valuenow={shownWidth}
        onPointerDown={startEdge}
        onKeyDown={edgeKey}
      />
      <DragGhost store={store} />
      {rowMenu ? <RowMenu request={rowMenu.request} anchor={rowMenu.anchor} onClose={() => setRowMenu(null)} /> : null}
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

/** A folder row for menus built outside the column (e.g. from the archive). */
export const folderRow = (folder: Folder): Row => ({ type: "folder", id: folder.id, depth: 0, folder, open: true, empty: false });
export type { MenuEntry, MenuRequest };
