import type { Artifact, Folder, NavLayout, NavSectionId, NavSelection, NavShortcut, NavSort, NavSortKey, ProjectStage, ProjectSummary, Session, Work } from "@workbench/contracts";
import { groupState, leadState, rowState, type RowStateInfo } from "../../row-state.ts";
import { projectMatcher, queryProject } from "../../project-query.ts";
import type { State } from "../../state.ts";
import { folderHidden, workHidden, workTreeRows, type Row, type SortMode } from "../../tree.ts";
import { DIVIDER, MIN_PANE } from "../../panes.ts";

// N1 (the owner's navigation, 2026-11-14): a deep-navy rail of destinations and ONE white list
// column with two levels: every project in its folders (level 1), and inside one project its note,
// 대화 · 문서 · 웹 (level 2). The three old layouts (두 칸 · 위아래 · 한 칸) collapse into it; their
// stored preferences are read and kept (a `layout`, widths, a selected folder or tag, folds, sorts).
//
// The navigator as plain data (no React): the preferences it keeps, the projects a selection lists
// in which order and under which group heads, folder counts, the tag tree and the shortcuts.
// Notebook Navigator's rules where they apply: a folder lists its own projects, or those of its
// subfolders too ("하위 포함"); pinned ones come first; dates group into 오늘·어제·이번 주….

/** At this window width and below the sidebar lies over the work (App.tsx): never two panes there. */
export const COMPACT_WINDOW = 959;
/** The gap the work surface keeps from the window's right edge (panes.css). */
export const FRAME_GAP = 8;
/** The room the automatic choice leaves the work beside two navigator panes: two work panes side by side. */
export const ROOMY = MIN_PANE * 2 + DIVIDER;
/** The one-column sidebar (the tree, and the stacked panes): its width is the app's `sidebarWidth`. */
export const SIDE_WIDTH = { min: 232, max: 480, initial: 288 };
export const NAV_WIDTH = { min: 168, max: 360, initial: 216 };
export const LIST_WIDTH = { min: 240, max: 520, initial: 300 };
export const NAV_HEIGHT = { min: 0.15, max: 0.8, initial: 0.42 };

export type NavPrefs = {
  /** Null: chosen by the window's width. */
  layout: NavLayout | null;
  navWidth: number;
  listWidth: number;
  navHeight: number;
  selected: NavSelection;
  sortDefault: NavSort;
  sortByFolder: Record<string, NavSort>;
  includeSub: boolean;
  density: "standard" | "compact";
  previewLines: 0 | 1 | 2 | 3;
  groupSub: "folder" | "date";
  sections: Partial<Record<NavSectionId, boolean>>;
  openTags: string[];
  /** N1: what the list column shows. */
  rail: RailDest;
  /** N1: level 1 (every project) or level 2 (inside `project`). */
  level: "projects" | "project";
  project: string | null;
  /** N1: level 1 as the folder tree, or one list grouped by the sort. */
  groupBy: "folder" | "list";
  /** N1: the tab strip shows every project's tabs. */
  tabsAll: boolean;
};

/** The rail's destinations that the list column shows (지금 is a page, 찾기 the search). */
export type RailDest = "projects" | "docs" | "activity" | "vault";
export const RAIL_DESTS: RailDest[] = ["projects", "docs", "activity", "vault"];

export const DEFAULT_SORT: NavSort = { key: "activity", desc: true };
const SORT_KEYS: NavSortKey[] = ["activity", "created", "name", "due", "stage"];
const SECTIONS: NavSectionId[] = ["now", "shortcuts", "projects", "tags", "views", "usage", "history", "chats", "docs", "web"];

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const number = (value: unknown, limits: { min: number; max: number; initial: number }) => (typeof value === "number" && Number.isFinite(value) ? clamp(value, limits.min, limits.max) : limits.initial);

function readSort(value: unknown): NavSort | null {
  const raw = record(value);
  return SORT_KEYS.includes(raw.key as NavSortKey) ? { key: raw.key as NavSortKey, desc: raw.desc !== false } : null;
}

function readSelection(value: unknown): NavSelection {
  const raw = record(value);
  if (raw.kind === "folder" && typeof raw.id === "string") return { kind: "folder", id: raw.id };
  if (raw.kind === "tag" && typeof raw.tag === "string" && raw.tag) return { kind: "tag", tag: raw.tag };
  if (raw.kind === "untagged") return { kind: "untagged" };
  return { kind: "root" };
}

/** prefs `navigator` as the screen uses it (tolerating older or broken values). */
export function readNavigator(value: unknown): NavPrefs {
  const raw = record(value);
  const sortByFolder: Record<string, NavSort> = {};
  for (const [key, entry] of Object.entries(record(raw.sortByFolder))) {
    const sort = readSort(entry);
    if (sort) sortByFolder[key] = sort;
  }
  const sections: Partial<Record<NavSectionId, boolean>> = {};
  for (const [key, folded] of Object.entries(record(raw.sections))) if (SECTIONS.includes(key as NavSectionId) && folded === true) sections[key as NavSectionId] = true;
  const lines = raw.previewLines;
  return {
    layout: raw.layout === "dual" || raw.layout === "stacked" || raw.layout === "tree" ? raw.layout : null,
    navWidth: number(raw.navWidth, NAV_WIDTH),
    listWidth: number(raw.listWidth, LIST_WIDTH),
    navHeight: number(raw.navHeight, NAV_HEIGHT),
    selected: readSelection(raw.selected),
    sortDefault: readSort(raw.sortDefault) ?? DEFAULT_SORT,
    sortByFolder,
    includeSub: raw.includeSub !== false,
    // N1: one row per project unless the person asked for the detailed rows ("자세히", the old standard).
    density: raw.density === "standard" ? "standard" : "compact",
    previewLines: lines === 0 || lines === 1 || lines === 2 || lines === 3 ? lines : 1,
    groupSub: raw.groupSub === "folder" ? "folder" : "date",
    sections,
    openTags: Array.isArray(raw.openTags) ? raw.openTags.filter((tag): tag is string => typeof tag === "string") : [],
    rail: RAIL_DESTS.includes(raw.rail as RailDest) ? (raw.rail as RailDest) : "projects",
    level: raw.level === "project" && typeof raw.project === "string" && raw.project ? "project" : "projects",
    project: typeof raw.project === "string" && raw.project ? raw.project : null,
    groupBy: raw.groupBy === "list" ? "list" : "folder",
    tabsAll: raw.tabsAll === true,
  };
}

/** Level 1's filter: a tag or "태그 없음" chosen (from the tag section, a shortcut, or an old selection); a folder or the root filter nothing. */
export const filterOf = (selection: NavSelection): Extract<NavSelection, { kind: "tag" } | { kind: "untagged" }> | null => (selection.kind === "tag" || selection.kind === "untagged" ? selection : null);

/** Two navigator panes side by side: both, and the hairline between them. */
export const dualWidth = (prefs: Pick<NavPrefs, "navWidth" | "listWidth">) => prefs.navWidth + prefs.listWidth + 1;

/** What a window leaves the work panes beside a sidebar this wide. */
export const roomBeside = (windowWidth: number, sidebar: number) => windowWidth - sidebar - FRAME_GAP;

/** How far below its threshold the automatic choice keeps two panes that are already drawn. */
export const HOLD = 24;

/**
 * The layout drawn. Nothing stored: two panes where two work panes would still fit beside them,
 * stacked on a narrower window; two panes already drawn (`was`) hold on for `HOLD` px below that,
 * so a window's edge dragged across the threshold does not swap the sidebar on every pixel. A
 * stored choice stands; chosen two panes are drawn stacked only where the work panes could not
 * keep their least width (`paneMinimum`, panes.ts `minimumSize`) — which nothing ever goes below.
 */
export function layoutFor(prefs: Pick<NavPrefs, "layout" | "navWidth" | "listWidth">, windowWidth: number, paneMinimum = MIN_PANE, was: NavLayout | null = null): NavLayout {
  if (prefs.layout === "tree" || prefs.layout === "stacked") return prefs.layout;
  if (windowWidth <= COMPACT_WINDOW) return "stacked";
  const roomy = Math.max(paneMinimum, ROOMY);
  const needed = prefs.layout === "dual" ? paneMinimum : was === "dual" ? Math.max(paneMinimum, roomy - HOLD) : roomy;
  return roomBeside(windowWidth, dualWidth(prefs)) >= needed ? "dual" : "stacked";
}

/** The sidebar's width in a layout (`single`: the one-column width the app keeps). */
export const sidebarWidthFor = (layout: NavLayout, prefs: Pick<NavPrefs, "navWidth" | "listWidth">, single: number) => (layout === "dual" ? dualWidth(prefs) : single);

export const LAYOUTS: { id: NavLayout; label: string; icon: "columns" | "rows" | "list" }[] = [
  { id: "dual", label: "두 칸", icon: "columns" },
  { id: "stacked", label: "위아래", icon: "rows" },
  { id: "tree", label: "한 칸 (트리)", icon: "list" },
];

export type LayoutChoice = { id: NavLayout | "auto"; label: string; icon: "columns" | "rows" | "list" | "sidebar"; checked: boolean; hint?: string };

/** The layouts as the menus offer them: the stored one checked, else "창 너비에 맞추기" with what it gives now. */
export function layoutChoices(stored: NavLayout | null, drawn: NavLayout): LayoutChoice[] {
  const now = LAYOUTS.find((entry) => entry.id === drawn)!.label;
  return [
    ...LAYOUTS.map((entry) => ({ ...entry, checked: stored === entry.id, ...(stored === entry.id && drawn !== entry.id ? { hint: `지금은 ${now}` } : {}) })),
    { id: "auto", label: "창 너비에 맞추기", icon: "sidebar", checked: stored === null, ...(stored === null ? { hint: `지금 ${now}` } : {}) },
  ];
}

/** The key a selection keeps its own sort under (Notebook Navigator sorts per folder). */
export const selectionKey = (selection: NavSelection) => (selection.kind === "folder" ? selection.id : selection.kind === "tag" ? `tag:${selection.tag}` : selection.kind);

export const sortFor = (prefs: Pick<NavPrefs, "sortDefault" | "sortByFolder">, selection: NavSelection): NavSort => prefs.sortByFolder[selectionKey(selection)] ?? prefs.sortDefault;

export const SORT_LABEL: Record<NavSortKey, string> = { activity: "최근 활동", created: "만든 날", name: "이름", due: "마감일", stage: "단계" };

// ── projects as the list reads them ─────────────────────────────────────────────────────────

export type ListProject = {
  work: Work;
  summary: ProjectSummary | undefined;
  /** Visible sessions in their order. */
  sessions: Session[];
  /** Last activity: the work, its sessions' replies, its note's last change. */
  activity: number;
  /** The note's tags, else the work's own. */
  tags: string[];
  stage: string | null;
  /** The "마감일" property as a local day (ms at local midnight), or null. */
  due: number | null;
  /** The note's first words, else the start of the latest reply. */
  preview: string | null;
  /** Conversations that need the person (확인 필요 + 실패): the number pill. */
  needs: number;
  attention: boolean;
  busy: boolean;
  unseen: boolean;
};

const DUE_KEYS = ["마감일", "마감일:", "마감", "due"];

/** A date property's first value ("2026-11-02", "2026-11-02T10:00") as a local day, or null. */
export function dayOf(value: string | undefined): number | null {
  const match = value ? /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value.trim()) : null;
  if (!match) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(day.getTime()) ? null : day.getTime();
}

export const tagsOf = (work: Work, summary: ProjectSummary | undefined) => (summary?.tags.length ? summary.tags : (work.tags ?? [])).map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean);

/** A project's marks by its conversations' one state: how many need the person (확인 필요 + 실패), at work, unseen. */
function marksOf(sessions: Session[], visibleSessionId: string | null) {
  const marks = groupState(sessions, visibleSessionId);
  return { needs: marks.needs, attention: marks.needs > 0, busy: marks.running > 0, unseen: marks.unseen > 0 };
}

/** Every project not in the archive (nor under an archived folder), with what lists show of it. */
export function projectsOf(state: Pick<State, "works" | "sessions" | "folders">, summaries: Map<string, ProjectSummary>, visibleSessionId: string | null = null): ListProject[] {
  const byWork = new Map<string, Session[]>();
  for (const session of Object.values(state.sessions)) {
    if (session.archivedAt) continue;
    const list = byWork.get(session.workId);
    if (list) list.push(session);
    else byWork.set(session.workId, [session]);
  }
  const out: ListProject[] = [];
  for (const work of Object.values(state.works)) {
    if (workHidden(state as State, work)) continue;
    const summary = summaries.get(work.id);
    const sessions = (byWork.get(work.id) ?? []).sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
    // The latest reply any of its sessions has (a newer session may not have answered yet).
    const latest = sessions.reduce<Session | null>((best, session) => (session.preview && (!best || (session.previewAt ?? 0) > (best.previewAt ?? 0)) ? session : best), null);
    const due = summary?.properties.find((entry) => DUE_KEYS.includes(entry.key) && entry.values.length)?.values[0];
    out.push({
      work,
      summary,
      sessions,
      activity: Math.max(work.updatedAt, summary?.noteUpdatedAt ?? 0, ...sessions.map((session) => session.previewAt ?? session.updatedAt)),
      tags: tagsOf(work, summary),
      stage: summary?.stage ?? null,
      due: dayOf(due),
      preview: summary?.preview ?? latest?.preview ?? null,
      ...marksOf(sessions, visibleSessionId),
    });
  }
  return out;
}

// ── dates as groups ─────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const midnight = (at: number) => {
  const day = new Date(at);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
};
/** Monday 00:00 of the week `at` is in (weeks start on Monday, as Korean calendars do). */
const mondayOf = (at: number) => {
  const day = new Date(midnight(at));
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7)).getTime();
};

/** Past dates: 오늘 · 어제 · 이번 주 · 지난 주 · 이번 달 · 더 이전 (Notebook Navigator's groups). */
export function dateGroup(at: number, now: number): { key: string; label: string } {
  const today = midnight(now);
  if (at >= today) return { key: "today", label: "오늘" };
  if (at >= today - DAY) return { key: "yesterday", label: "어제" };
  const monday = mondayOf(now);
  if (at >= monday) return { key: "week", label: "이번 주" };
  if (at >= monday - 7 * DAY) return { key: "lastWeek", label: "지난 주" };
  const first = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
  if (at >= first) return { key: "month", label: "이번 달" };
  return { key: "older", label: "더 이전" };
}

/** Deadlines: 지남 · 오늘 · 이번 주 · 다음 주 · 이번 달 · 나중 · 마감일 없음. */
export function dueGroup(day: number | null, now: number): { key: string; label: string } {
  if (day === null) return { key: "none", label: "마감일 없음" };
  const today = midnight(now);
  if (day < today) return { key: "past", label: "지남" };
  if (day < today + DAY) return { key: "today", label: "오늘" };
  const nextMonday = mondayOf(now) + 7 * DAY;
  if (day < nextMonday) return { key: "week", label: "이번 주" };
  if (day < nextMonday + 7 * DAY) return { key: "nextWeek", label: "다음 주" };
  const nextMonth = new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 1).getTime();
  if (day < nextMonth) return { key: "month", label: "이번 달" };
  return { key: "later", label: "나중" };
}

/** The date a row shows for its sort: the deadline, the day it was made, else its last activity. */
export const dateFor = (project: ListProject, key: NavSortKey) => (key === "due" ? project.due : key === "created" ? project.work.createdAt : project.activity);

/** "14:20" today, "어제", "10월 29일" this year, "2025. 3. 2." before. */
export function shortDate(at: number | null, now = Date.now(), withTime = true): string {
  if (at === null) return "";
  const today = midnight(now);
  const date = new Date(at);
  if (withTime && at >= today && at < today + DAY) return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (withTime && at >= today - DAY && at < today) return "어제";
  if (date.getFullYear() === new Date(now).getFullYear()) return `${date.getMonth() + 1}월 ${date.getDate()}일`;
  return `${date.getFullYear()}. ${date.getMonth() + 1}. ${date.getDate()}.`;
}

// ── what a selection lists ──────────────────────────────────────────────────────────────────

export type ListEntry = { type: "group"; key: string; label: string; count: number } | { type: "project"; project: ListProject; folder: string | null };

/** Folder ids in tree order (manual order, then name), from `parentId` down, with their depth. */
export function folderOrder(folders: Record<string, Folder>, parentId: string | null): { folder: Folder; depth: number }[] {
  const out: { folder: Folder; depth: number }[] = [];
  const children = new Map<string | null, Folder[]>();
  for (const folder of Object.values(folders)) {
    if (folder.archivedAt) continue;
    const parent = folder.parentId && folders[folder.parentId] ? folder.parentId : null;
    const list = children.get(parent);
    if (list) list.push(folder);
    else children.set(parent, [folder]);
  }
  const walk = (at: string | null, depth: number, seen: Set<string>) => {
    for (const folder of (children.get(at) ?? []).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "ko"))) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      out.push({ folder, depth });
      walk(folder.id, depth + 1, seen);
    }
  };
  walk(parentId, 0, new Set(parentId ? [parentId] : []));
  return out;
}

/** The folder a project lives in, as the list knows it (one that is gone counts as none). */
const folderOf = (folders: Record<string, Folder>, work: Work) => (work.folderId && folders[work.folderId] ? work.folderId : null);

/** A tag, or one under it ("강의" holds "강의/2026-2"); case does not matter, as in Obsidian. */
export const hasTag = (tags: string[], tag: string) => {
  const wanted = tag.toLocaleLowerCase("ko");
  return tags.some((entry) => {
    const lower = entry.toLocaleLowerCase("ko");
    return lower === wanted || lower.startsWith(`${wanted}/`);
  });
};

function compare(sort: NavSort, stages: ProjectStage[]) {
  const stageIndex = (stage: string | null) => {
    if (stage === null) return Number.POSITIVE_INFINITY;
    const index = stages.findIndex((entry) => entry.name === stage);
    return index === -1 ? stages.length : index;
  };
  const byName = (a: ListProject, b: ListProject) => a.work.title.localeCompare(b.work.title, "ko") || a.work.id.localeCompare(b.work.id);
  const sign = sort.desc ? -1 : 1;
  return (a: ListProject, b: ListProject): number => {
    if (sort.key === "name") return sign * byName(a, b);
    if (sort.key === "stage") {
      // Projects without a stage stay last either way, as "값 없음" does in every list.
      const left = stageIndex(a.stage);
      const right = stageIndex(b.stage);
      if (left !== right) return left === Number.POSITIVE_INFINITY ? 1 : right === Number.POSITIVE_INFINITY ? -1 : sign * (left - right);
      return b.activity - a.activity || byName(a, b);
    }
    if (sort.key === "due") {
      if (a.due !== b.due) return a.due === null ? 1 : b.due === null ? -1 : sign * (a.due - b.due);
      return byName(a, b);
    }
    const left = sort.key === "created" ? a.work.createdAt : a.activity;
    const right = sort.key === "created" ? b.work.createdAt : b.activity;
    return sign * (left - right) || byName(a, b);
  };
}

/** The group a project falls in under a sort (none for names). */
function groupOf(project: ListProject, sort: NavSort, now: number): { key: string; label: string } | null {
  if (sort.key === "name") return null;
  if (sort.key === "stage") return project.stage ? { key: `stage:${project.stage}`, label: project.stage } : { key: "stage:", label: "단계 없음" };
  if (sort.key === "due") return dueGroup(project.due, now);
  return dateGroup(dateFor(project, sort.key)!, now);
}

export type ListOptions = {
  includeSub: boolean;
  /** The filter box (project-query.ts). */
  query: string;
  sort: NavSort;
  groupSub: "folder" | "date";
  stages: ProjectStage[];
  folders: Record<string, Folder>;
  now: number;
};

/** What the folder or tag selected lists, in order, under its group heads ("고정" always first). */
export function listFor(projects: ListProject[], selection: NavSelection, options: ListOptions): { entries: ListEntry[]; count: number } {
  const { folders } = options;
  const top = selection.kind === "folder" && folders[selection.id] && !folderHidden({ folders } as State, selection.id) ? selection.id : null;
  const names = (folderId: string | null) => {
    const out: string[] = [];
    for (let at = folderId; at && at !== top && folders[at] && out.length < 32; at = folders[at]!.parentId) out.unshift(folders[at]!.name);
    return out.join("/") || null;
  };
  // Which projects: a tag's (or "태그 없음"), else a folder's own or the root's, with "하위 포함" those below too.
  let inside: (project: ListProject) => boolean;
  let mixed = true;
  if (selection.kind === "tag") inside = (project) => hasTag(project.tags, selection.tag);
  else if (selection.kind === "untagged") inside = (project) => project.tags.length === 0;
  else if (options.includeSub) {
    const within = new Set([...(top ? [top] : []), ...folderOrder(folders, top).map((entry) => entry.folder.id)]);
    inside = (project) => top === null || within.has(folderOf(folders, project.work) ?? "");
  } else {
    inside = (project) => folderOf(folders, project.work) === top;
    mixed = false;
  }
  // The filter box reads each project only when something is typed.
  const matcher = options.query.trim() ? projectMatcher(options.query) : null;
  const chosen = projects.filter((project) => inside(project) && (!matcher || matcher(queryProject(project.work, project.summary, folders))));
  const order = compare(options.sort, options.stages);
  const pinned = chosen.filter((project) => project.work.pinned).sort(order);
  const rest = chosen.filter((project) => !project.work.pinned).sort(order);
  const byFolder = mixed && options.groupSub === "folder";
  // Rows say their folder where a list mixes folders (relative to the folder selected), unless a folder head says it.
  const folderLabel = (project: ListProject) => (mixed ? names(folderOf(folders, project.work)) : null);
  const entries: ListEntry[] = [];
  const pushGroup = (key: string, label: string | null, members: ListProject[], withFolder: (project: ListProject) => string | null) => {
    if (!members.length) return;
    if (label !== null) entries.push({ type: "group", key, label, count: members.length });
    for (const project of members) entries.push({ type: "project", project, folder: withFolder(project) });
  };
  pushGroup("pinned", "고정", pinned, folderLabel);
  if (byFolder) {
    // Folder heads in tree order: the selection's own projects first, then each folder below it.
    const groups = new Map<string | null, ListProject[]>();
    for (const project of rest) {
      const at = folderOf(folders, project.work);
      groups.set(at, [...(groups.get(at) ?? []), project]);
    }
    for (const head of [top, ...folderOrder(folders, top).map((entry) => entry.folder.id)]) {
      const label = head === null ? "폴더 밖" : head === top ? folders[head]!.name : names(head)!;
      pushGroup(`folder:${head ?? ""}`, label, groups.get(head) ?? [], () => null);
    }
    return { entries, count: chosen.length };
  }
  const groups: { key: string; label: string; members: ListProject[] }[] = [];
  for (const project of rest) {
    const group = groupOf(project, options.sort, options.now) ?? { key: "rest", label: "프로젝트" };
    const last = groups.at(-1);
    if (last && last.key === group.key) last.members.push(project);
    else groups.push({ ...group, members: [project] });
  }
  // A name sort has no heads: its projects follow "고정" under a plain one (or none without pins).
  for (const group of groups) pushGroup(group.key, group.key === "rest" && !pinned.length ? null : group.label, group.members, folderLabel);
  return { entries, count: chosen.length };
}

// ── counts and tags for the navigation pane ─────────────────────────────────────────────────

/** Projects in each folder ("이 폴더 · 하위") and at the root (outside folders · in folders). */
export function folderCounts(projects: ListProject[], folders: Record<string, Folder>): { folders: Map<string, { own: number; below: number }>; root: { own: number; below: number } } {
  const own = new Map<string, number>();
  let loose = 0;
  for (const project of projects) {
    const at = folderOf(folders, project.work);
    if (at) own.set(at, (own.get(at) ?? 0) + 1);
    else loose += 1;
  }
  const counts = new Map<string, { own: number; below: number }>();
  const total = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const kids = Object.values(folders).filter((folder) => folder.parentId === id && !folder.archivedAt);
    const below = kids.reduce((sum, kid) => sum + total(kid.id, seen), 0);
    counts.set(id, { own: own.get(id) ?? 0, below });
    return (own.get(id) ?? 0) + below;
  };
  let inFolders = 0;
  for (const { folder } of folderOrder(folders, null).filter((entry) => entry.depth === 0)) inFolders += total(folder.id, new Set());
  return { folders: counts, root: { own: loose, below: inFolders } };
}

/** "3 · 9" (this folder · below), "3", or nothing. */
export const countText = (count: { own: number; below: number } | undefined) => (!count || (!count.own && !count.below) ? "" : count.below ? `${count.own}/${count.below}` : String(count.own));

export type TagNode = { tag: string; name: string; count: number; children: TagNode[] };

/** The projects' tags as a tree split on "/", each with how many projects carry it (or one under it). */
export function tagTree(projects: ListProject[]): { nodes: TagNode[]; untagged: number } {
  type Building = { tag: string; name: string; members: Set<string>; children: Map<string, Building> };
  const roots = new Map<string, Building>();
  let untagged = 0;
  for (const project of projects) {
    if (!project.tags.length) {
      untagged += 1;
      continue;
    }
    for (const tag of project.tags) {
      let level = roots;
      let path = "";
      for (const part of tag.split("/").filter(Boolean)) {
        path = path ? `${path}/${part}` : part;
        const key = part.toLocaleLowerCase("ko");
        let node = level.get(key);
        if (!node) {
          node = { tag: path, name: part, members: new Set(), children: new Map() };
          level.set(key, node);
        }
        node.members.add(project.work.id);
        level = node.children;
      }
    }
  }
  const done = (level: Map<string, Building>): TagNode[] =>
    [...level.values()].sort((a, b) => a.name.localeCompare(b.name, "ko")).map((node) => ({ tag: node.tag, name: node.name, count: node.members.size, children: done(node.children) }));
  return { nodes: done(roots), untagged };
}

// ── shortcuts ("바로가기") ──────────────────────────────────────────────────────────────────

const SHORTCUT_KINDS = new Set(["work", "folder", "tag", "view", "session"]);

/** prefs `navShortcuts`, or null when it was never set (then it is seeded once). */
export function readShortcuts(value: unknown): NavShortcut[] | null {
  if (!Array.isArray(value)) return null;
  const out: NavShortcut[] = [];
  for (const entry of value) {
    const raw = record(entry);
    if (!SHORTCUT_KINDS.has(raw.kind as string) || typeof raw.id !== "string" || !raw.id) continue;
    if (out.some((other) => other.kind === raw.kind && other.id === raw.id)) continue;
    out.push({ kind: raw.kind as NavShortcut["kind"], id: raw.id, ...(typeof raw.label === "string" && raw.label.trim() ? { label: raw.label.trim() } : {}) });
  }
  return out;
}

/** The first shortcuts: what was pinned before (works, then sessions), so nothing pinned goes missing. */
export function seedShortcuts(state: Pick<State, "works" | "sessions" | "folders">): NavShortcut[] {
  const works = Object.values(state.works)
    .filter((work) => work.pinned && !workHidden(state as State, work))
    .sort((a, b) => a.title.localeCompare(b.title, "ko"));
  const sessions = Object.values(state.sessions)
    .filter((session) => session.pinned && !session.archivedAt && state.works[session.workId] && !workHidden(state as State, state.works[session.workId]!))
    .sort((a, b) => a.purpose.localeCompare(b.purpose, "ko"));
  return [...works.map((work) => ({ kind: "work" as const, id: work.id })), ...sessions.map((session) => ({ kind: "session" as const, id: session.id }))];
}

export const sameShortcut = (a: Pick<NavShortcut, "kind" | "id">, b: Pick<NavShortcut, "kind" | "id">) => a.kind === b.kind && a.id === b.id;

/** Shortcuts with `added` put at `index` (those already there move there, keeping their labels). */
export function addShortcuts(list: NavShortcut[], added: NavShortcut[], index = list.length): NavShortcut[] {
  const unique = added.filter((entry, at) => added.findIndex((other) => sameShortcut(entry, other)) === at);
  const isAdded = (entry: NavShortcut) => unique.some((other) => sameShortcut(entry, other));
  const merged = unique.map((entry) => list.find((other) => sameShortcut(entry, other)) ?? entry);
  return [...list.slice(0, index).filter((entry) => !isAdded(entry)), ...merged, ...list.slice(index).filter((entry) => !isAdded(entry))];
}

/** A shortcut moved from one place to another (`to` counts in the list before the move). */
export function moveShortcut(list: NavShortcut[], from: number, to: number): NavShortcut[] {
  const entry = list[from];
  if (!entry || to === from || to === from + 1) return list;
  const rest = list.filter((_, at) => at !== from);
  rest.splice(to > from ? to - 1 : to, 0, entry);
  return rest;
}


// ── N1: level 1 (every project in its folders) and level 2 (inside one project) ─────────────

/** The person's own projects: every project that is not a messenger's place (`Work.messengerHome`). */
export const ownProjects = (projects: ListProject[]) => projects.filter((project) => !project.work.messengerHome);

/**
 * The messengers' own places ("텔레그램 대화", "Slack 대화") for level 1's "메신저" section: Telegram's first.
 * A query narrows them by name as it does projects; they have no tags (a tag filter shows projects only).
 */
export function messengerHomes(projects: ListProject[], query = "", filtered = false): ListProject[] {
  if (filtered) return [];
  const text = query.trim().toLocaleLowerCase("ko");
  return projects
    .filter((project) => project.work.messengerHome && (!text || project.work.title.toLocaleLowerCase("ko").includes(text)))
    .sort((a, b) => (a.work.messengerHome!.kind === b.work.messengerHome!.kind ? a.work.createdAt - b.work.createdAt : a.work.messengerHome!.kind === "telegram" ? -1 : 1));
}

export type LevelOneRow =
  /** `needs`: what needs the person in the projects under it (its folded row says so: the projects are hidden). */
  | { type: "folder"; id: string; folder: Folder; depth: number; open: boolean; count: number; children: boolean; needs: number }
  | { type: "project"; id: string; project: ListProject; depth: number }
  | { type: "group"; id: string; label: string; count: number };

/** What a project holds, by kind (a document's AI belongs to its document): for the row's quiet count. */
export function holdings(project: ListProject, docs: number) {
  const web = project.sessions.filter((session) => session.pageAgent).length;
  const chats = project.sessions.filter((session) => !session.pageAgent && !session.documentAgent).length;
  return { chats, docs, web, total: chats + docs + web };
}

/** The one status of a project: the most pressing state of its conversations (row-state.ts). */
export function projectTone(project: ListProject, visibleSessionId: string | null = null): RowStateInfo | null {
  return leadState(project.sessions, (session) => rowState(session, { onScreen: session.id === visibleSessionId }))?.state ?? null;
}

const byManual = (a: ListProject, b: ListProject) => a.work.sort - b.work.sort || b.work.createdAt - a.work.createdAt;
const orderBy = (mode: SortMode) => (a: ListProject, b: ListProject) =>
  mode === "name" ? a.work.title.localeCompare(b.work.title, "ko") : mode === "recent" ? b.activity - a.activity || byManual(a, b) : byManual(a, b);

export type LevelOneOptions = {
  closedFolders: string[];
  query: string;
  filter: NavSelection;
  sortMode: SortMode;
  groupBy: "folder" | "list";
  sort: NavSort;
  stages: ProjectStage[];
  now: number;
};

/**
 * Level 1's rows: every folder (Obsidian-style, folding) with its projects inside, in the tree's
 * order (직접 · 최근 · 이름), and the projects outside folders under "폴더 밖" last. A query or a tag
 * narrows it: folders without a match drop out and those with one open; a folder whose name
 * matches keeps all its projects. "list" groups one flat list by the sort instead (the old list).
 */
export function levelOneRows(projects: ListProject[], folders: Record<string, Folder>, options: LevelOneOptions): { rows: LevelOneRow[]; count: number } {
  const filter = filterOf(options.filter);
  const tagged = filter ? projects.filter((project) => (filter.kind === "tag" ? hasTag(project.tags, filter.tag) : project.tags.length === 0)) : projects;
  if (options.groupBy === "list") {
    const listed = listFor(tagged, { kind: "root" }, { includeSub: true, query: options.query, sort: options.sort, groupSub: "date", stages: options.stages, folders, now: options.now });
    return {
      count: listed.count,
      rows: listed.entries.map((entry) => (entry.type === "group" ? { type: "group" as const, id: `group:${entry.key}`, label: entry.label, count: entry.count } : { type: "project" as const, id: entry.project.work.id, project: entry.project, depth: 0 })),
    };
  }
  const text = options.query.trim();
  const matcher = text ? projectMatcher(text) : null;
  const folderHit = (folder: Folder) => Boolean(text) && !/[#:]/.test(text) && folder.name.toLocaleLowerCase("ko").includes(text.toLocaleLowerCase("ko"));
  const tree = folderOrder(folders, null);
  const parentOf = (id: string) => (folders[id]?.parentId && folders[folders[id]!.parentId!] ? folders[id]!.parentId : null);
  const hitFolders = new Set<string>();
  for (const { folder } of tree) {
    for (let at: string | null = folder.id; at; at = parentOf(at)) if (folderHit(folders[at]!)) { hitFolders.add(folder.id); break; }
  }
  const shown = tagged.filter((project) => {
    const at = folderOf(folders, project.work);
    if (at && hitFolders.has(at)) return true;
    return !matcher || matcher(queryProject(project.work, project.summary, folders));
  });
  const order = orderBy(options.sortMode);
  const byFolder = new Map<string | null, ListProject[]>();
  for (const project of shown) {
    const at = folderOf(folders, project.work);
    byFolder.set(at, [...(byFolder.get(at) ?? []), project]);
  }
  for (const list of byFolder.values()) list.sort(order);
  // Projects in each folder and below it (what the folder row counts), and what needs the person there.
  const below = new Map<string, number>();
  const needsBelow = new Map<string, number>();
  for (const { folder } of [...tree].reverse()) {
    const own = byFolder.get(folder.id) ?? [];
    const kids = tree.filter((entry) => parentOf(entry.folder.id) === folder.id);
    below.set(folder.id, own.length + kids.reduce((sum, entry) => sum + (below.get(entry.folder.id) ?? 0), 0));
    needsBelow.set(folder.id, own.reduce((sum, project) => sum + project.needs, 0) + kids.reduce((sum, entry) => sum + (needsBelow.get(entry.folder.id) ?? 0), 0));
  }
  const narrowing = Boolean(matcher || filter);
  const closed = new Set(options.closedFolders);
  const rows: LevelOneRow[] = [];
  let hiddenUnder: number | null = null;
  for (const { folder, depth } of tree) {
    if (hiddenUnder !== null && depth > hiddenUnder) continue;
    hiddenUnder = null;
    const count = below.get(folder.id) ?? 0;
    if (narrowing && !count && !hitFolders.has(folder.id)) {
      hiddenUnder = depth;
      continue;
    }
    const children = tree.some((entry) => parentOf(entry.folder.id) === folder.id) || Boolean(byFolder.get(folder.id)?.length);
    const open = narrowing || !closed.has(folder.id);
    rows.push({ type: "folder", id: folder.id, folder, depth, open, count, children, needs: needsBelow.get(folder.id) ?? 0 });
    // Folded, a folder hides everything under it (0.5.6, the owner: "접어지면서 가려져야"); until then
    // it kept the project open now and those needing the person, so a fold often hid nothing. The
    // open project stays reachable from its tab; its row says what needs the person.
    if (!open) {
      hiddenUnder = depth;
      continue;
    }
    for (const project of byFolder.get(folder.id) ?? []) rows.push({ type: "project", id: project.work.id, project, depth: depth + 1 });
  }
  // Projects in a folder come after that folder's subfolders in Obsidian; here they come first,
  // right under their folder's name, so a folder's own projects never hide below its children.
  const loose = byFolder.get(null) ?? [];
  if (loose.length) {
    if (tree.length) rows.push({ type: "group", id: "group:loose", label: "폴더 밖", count: loose.length });
    for (const project of loose) rows.push({ type: "project", id: project.work.id, project, depth: 0 });
  }
  return { rows, count: shown.length };
}

/** Folder names from the top down to a project's folder ("강의 / 2026-2학기"), or "" outside folders. */
export function folderPath(folders: Record<string, Folder>, folderId: string | null): string {
  const names: string[] = [];
  for (let at = folderId && folders[folderId] ? folderId : null, guard = 0; at && guard < 32; at = folders[at]?.parentId ?? null, guard += 1) names.unshift(folders[at]!.name);
  return names.join(" / ");
}

export type InsideSections = {
  chats: Extract<Row, { type: "session" }>[];
  docs: Extract<Row, { type: "doc" }>[];
  web: Extract<Row, { type: "session" }>[];
};

/** Level 2's three sections: 대화, 문서 (subpages under their page, each with its AI), 웹 — the tree's rows, drawn flat. */
export function insideSections(state: Parameters<typeof workTreeRows>[0], work: Work, sessions?: Session[], docs?: Artifact[]): InsideSections {
  const rows = workTreeRows(state, work, { closedFolders: [], openWorks: [work.id], closedWorks: [], openDocs: [work.id] }, null, -2, sessions, docs);
  const out: InsideSections = { chats: [], docs: [], web: [] };
  let kind: "chat" | "web" | "docs" | null = null;
  for (const row of rows) {
    if (row.type === "section") kind = row.kind ?? null;
    else if (row.type === "docs") kind = "docs";
    else if (row.type === "session") (kind === "web" ? out.web : out.chats).push(row);
    else if (row.type === "doc") out.docs.push(row);
  }
  return out;
}

/** A document's kind as its file says it: "MD", "PPTX", "HWPX" (the extension), else the format. */
export function docKind(name: string, format: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1];
  if (ext) return ext.toUpperCase();
  return format === "markdown" ? "MD" : format.toUpperCase().slice(0, 5);
}
