import type { Folder, NavLayout, NavSectionId, NavSelection, NavShortcut, NavSort, NavSortKey, ProjectStage, ProjectSummary, Session, Work } from "@workbench/contracts";
import { isUnseen } from "@workbench/contracts";
import { projectMatcher, queryProject } from "../../project-query.ts";
import type { State } from "../../state.ts";
import { folderHidden, workHidden } from "../../tree.ts";

// The navigator as plain data (no React): the preferences it keeps, the projects a selection lists
// in which order and under which group heads, folder counts, the tag tree and the shortcuts.
// Notebook Navigator's rules where they apply: a folder lists its own projects, or those of its
// subfolders too ("하위 포함"); pinned ones come first; dates group into 오늘·어제·이번 주….

/** Below this window width the navigator stacks its panes unless the person chose a layout. */
export const WIDE_WINDOW = 1200;
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
};

export const DEFAULT_SORT: NavSort = { key: "activity", desc: true };
const SORT_KEYS: NavSortKey[] = ["activity", "created", "name", "due", "stage"];
const SECTIONS: NavSectionId[] = ["now", "shortcuts", "projects", "tags", "views"];

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
    density: raw.density === "compact" ? "compact" : "standard",
    previewLines: lines === 0 || lines === 1 || lines === 2 || lines === 3 ? lines : 1,
    groupSub: raw.groupSub === "folder" ? "folder" : "date",
    sections,
    openTags: Array.isArray(raw.openTags) ? raw.openTags.filter((tag): tag is string => typeof tag === "string") : [],
  };
}

/** The layout in use: the person's, else two panes on a wide window and stacked on a narrow one. */
export const layoutFor = (prefs: Pick<NavPrefs, "layout">, windowWidth: number): NavLayout => prefs.layout ?? (windowWidth >= WIDE_WINDOW ? "dual" : "stacked");

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
      attention: sessions.some((session) => session.status === "awaitingApproval"),
      busy: sessions.some((session) => session.status === "starting" || session.status === "running" || session.status === "interrupting"),
      unseen: sessions.some((session) => session.id !== visibleSessionId && isUnseen(session)),
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
export const countText = (count: { own: number; below: number } | undefined) => (!count || (!count.own && !count.below) ? "" : count.below ? `${count.own} · ${count.below}` : String(count.own));

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
