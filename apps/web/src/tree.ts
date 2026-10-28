import { isUnseen, type Artifact, type Folder, type Session, type Work } from "@workbench/contracts";
import type { State } from "./state.ts";
import { nestDocs } from "./pages.ts";

// The sidebar tree as plain data: what is visible (archived things and everything under them are
// not), in which order, and where a dragged row lands. Kept free of React so it can be tested.

export type SortMode = "manual" | "recent" | "name";

export type TreeOpenState = {
  /** Folders folded by the user (folders start open). */
  closedFolders: string[];
  /** Works unfolded by the user (works start folded, except the one on screen). */
  openWorks: string[];
  /** The work on screen, folded by the user. */
  closedWorks: string[];
  /** Works whose document list is unfolded. */
  openDocs: string[];
};

export const EMPTY_OPEN: TreeOpenState = { closedFolders: [], openWorks: [], closedWorks: [], openDocs: [] };

/** The open state after folding or unfolding a work (the work on screen starts unfolded). */
export function toggleWork(open: TreeOpenState, workId: string, isOpen: boolean): TreeOpenState {
  const without = (list: string[]) => list.filter((id) => id !== workId);
  return isOpen
    ? { ...open, openWorks: without(open.openWorks), closedWorks: [...without(open.closedWorks), workId] }
    : { ...open, openWorks: [...without(open.openWorks), workId], closedWorks: without(open.closedWorks) };
}

/** Read the open state kept in the screen preferences (tolerating older or broken values). */
export function readOpenState(value: unknown): TreeOpenState {
  const list = (key: keyof TreeOpenState) => {
    const raw = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
  };
  return { closedFolders: list("closedFolders"), openWorks: list("openWorks"), closedWorks: list("closedWorks"), openDocs: list("openDocs") };
}

export type Row =
  | { type: "folder"; id: string; depth: number; folder: Folder; open: boolean; empty: boolean }
  | { type: "work"; id: string; depth: number; work: Work; open: boolean; expandable: boolean; sessions: Session[]; docs: Artifact[] }
  | { type: "session"; id: string; depth: number; session: Session; work: Work }
  | { type: "docs"; id: string; depth: number; work: Work; count: number; open: boolean }
  | { type: "doc"; id: string; depth: number; artifact: Artifact; work: Work }
  | { type: "section"; id: string; depth: number; label: string };

/** Archived itself, or inside something archived. */
export function folderHidden(state: State, folderId: string | null): boolean {
  for (let at = folderId; at; at = state.folders[at]?.parentId ?? null) {
    const folder = state.folders[at];
    if (!folder || folder.archivedAt) return true;
  }
  return false;
}

export const workHidden = (state: State, work: Work) => Boolean(work.archivedAt) || folderHidden(state, work.folderId);

export const sessionHidden = (state: State, session: Session) => {
  const work = state.works[session.workId];
  return Boolean(session.archivedAt) || !work || workHidden(state, work);
};

const byName = (a: string, b: string) => a.localeCompare(b, "ko");
const activityOf = (work: Work, sessions: Session[]) => Math.max(work.updatedAt, ...sessions.map((session) => session.previewAt ?? session.updatedAt));

/** Visible sessions of a work in their order. */
export function workSessions(state: State, workId: string): Session[] {
  return Object.values(state.sessions)
    .filter((session) => session.workId === workId && !session.archivedAt)
    .sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
}

/** Documents of a work, newest change first. */
export function workDocs(state: State, workId: string): Artifact[] {
  return Object.values(state.artifacts)
    .filter((artifact) => artifact.workId === workId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function orderWorks(state: State, works: Work[], mode: SortMode) {
  const sessions = (work: Work) => workSessions(state, work.id);
  return [...works].sort((a, b) => {
    if (mode === "name") return byName(a.title, b.title);
    if (mode === "recent") return activityOf(b, sessions(b)) - activityOf(a, sessions(a));
    return a.sort - b.sort || b.createdAt - a.createdAt;
  });
}

const orderFolders = (folders: Folder[], mode: SortMode) =>
  [...folders].sort((a, b) => (mode === "name" ? byName(a.name, b.name) : a.sort - b.sort || byName(a.name, b.name)));

/**
 * The rows of the tree in display order. A work unfolds to its sessions (when it has more than
 * one) and a "문서" row (when it has documents), which unfolds to the documents.
 */
export function treeRows(state: State, open: TreeOpenState, mode: SortMode, currentWorkId: string | null): Row[] {
  const rows: Row[] = [];
  const folders = Object.values(state.folders).filter((folder) => !folder.archivedAt);
  const works = Object.values(state.works).filter((work) => !work.archivedAt);
  const closed = new Set(open.closedFolders);
  const openWorks = new Set(open.openWorks);
  const closedWorks = new Set(open.closedWorks);
  const openDocs = new Set(open.openDocs);

  const workRows = (work: Work, depth: number) => {
    const sessions = workSessions(state, work.id);
    const docs = workDocs(state, work.id);
    const expandable = sessions.length > 1 || docs.length > 0;
    const isOpen = expandable && (openWorks.has(work.id) || (work.id === currentWorkId && !closedWorks.has(work.id)));
    rows.push({ type: "work", id: work.id, depth, work, open: isOpen, expandable, sessions, docs });
    if (!isOpen) return;
    if (sessions.length > 1) for (const session of sessions) rows.push({ type: "session", id: session.id, depth: depth + 1, session, work });
    if (docs.length) {
      const docsOpen = openDocs.has(work.id);
      rows.push({ type: "docs", id: `docs:${work.id}`, depth: depth + 1, work, count: docs.length, open: docsOpen });
      // Subpages (`A/` beside `A.md`) sit under their page.
      if (docsOpen) for (const { artifact, depth: nested } of nestDocs(docs)) rows.push({ type: "doc", id: artifact.id, depth: depth + 2 + nested, artifact, work });
    }
  };

  const folderRows = (folder: Folder, depth: number) => {
    const children = orderFolders(folders.filter((child) => child.parentId === folder.id), mode);
    const inside = orderWorks(state, works.filter((work) => work.folderId === folder.id), mode);
    const isOpen = !closed.has(folder.id);
    rows.push({ type: "folder", id: folder.id, depth, folder, open: isOpen, empty: !children.length && !inside.length });
    if (!isOpen) return;
    for (const child of children) folderRows(child, depth + 1);
    for (const work of inside) workRows(work, depth + 1);
  };

  for (const folder of orderFolders(folders.filter((folder) => folder.parentId === null || !state.folders[folder.parentId]), mode)) folderRows(folder, 0);
  const loose = orderWorks(state, works.filter((work) => !work.folderId || !state.folders[work.folderId]), mode);
  if (loose.length) {
    if (folders.length) rows.push({ type: "section", id: "section:loose", depth: 0, label: "분류 없음" });
    for (const work of loose) workRows(work, 0);
  }
  return rows;
}

/** Sessions that need the user now: waiting for an answer, working, then new replies. */
export function nowSessions(state: State, visibleSessionId: string | null) {
  const live = Object.values(state.sessions).filter((session) => !sessionHidden(state, session));
  const recent = (a: Session, b: Session) => (b.previewAt ?? b.updatedAt) - (a.previewAt ?? a.updatedAt);
  return {
    attention: live.filter((session) => session.status === "awaitingApproval").sort(recent),
    running: live.filter((session) => session.status === "starting" || session.status === "running" || session.status === "interrupting").sort(recent),
    unseen: live
      .filter((session) => session.id !== visibleSessionId && (session.status === "idle" || session.status === "error") && isUnseen(session))
      .sort(recent)
      .slice(0, 6),
  };
}

/** Pinned works and sessions that are not archived. */
export function pinnedItems(state: State) {
  const works = Object.values(state.works)
    .filter((work) => work.pinned && !workHidden(state, work))
    .sort((a, b) => byName(a.title, b.title));
  const sessions = Object.values(state.sessions)
    .filter((session) => session.pinned && !sessionHidden(state, session))
    .sort((a, b) => byName(a.purpose, b.purpose));
  return { works, sessions };
}

/** An order key between two neighbours (either may be missing). */
export function between(before: number | undefined, after: number | undefined) {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

export type DropZone = "before" | "inside" | "after";

export type Move =
  | { kind: "folder"; id: string; parentId: string | null; sort: number }
  | { kind: "work"; id: string; folderId: string | null; sort: number }
  | { kind: "session"; id: string; sort: number };

/** Where a drop zone is on a row: top quarter before, bottom quarter after, the middle inside. */
export function zoneAt(offsetY: number, height: number, canHoldInside: boolean): DropZone {
  const ratio = height > 0 ? offsetY / height : 0.5;
  if (!canHoldInside) return ratio < 0.5 ? "before" : "after";
  if (ratio < 0.25) return "before";
  if (ratio > 0.75) return "after";
  return "inside";
}

/** Can this row take the dragged one inside it? (folders take folders and works). */
export const holds = (target: Row, dragged: Row) => target.type === "folder" && (dragged.type === "folder" || dragged.type === "work");

/**
 * What a drop does, or null when it is not allowed: folders move among folders (never into
 * themselves), works into folders or next to other works, sessions only within their own work.
 */
export function moveFor(state: State, dragged: Row, target: Row, zone: DropZone, mode: SortMode): Move | null {
  if (dragged.id === target.id) return null;
  if (dragged.type === "folder") {
    let parentId: string | null;
    let siblings: Folder[];
    let anchor: Folder | null;
    if (target.type === "folder") {
      if (zone === "inside") {
        parentId = target.folder.id;
        anchor = null;
      } else {
        parentId = target.folder.parentId;
        anchor = target.folder;
      }
    } else if (target.type === "section") {
      parentId = null;
      anchor = null;
    } else {
      return null;
    }
    for (let at = parentId; at; at = state.folders[at]?.parentId ?? null) if (at === dragged.folder.id) return null;
    siblings = orderFolders(Object.values(state.folders).filter((folder) => !folder.archivedAt && folder.parentId === parentId && folder.id !== dragged.folder.id), "manual");
    return { kind: "folder", id: dragged.folder.id, parentId, sort: keyAround(siblings.map((folder) => folder.sort), anchor ? siblings.indexOf(anchor) : -1, zone) };
  }
  if (dragged.type === "work") {
    let folderId: string | null;
    let anchor: Work | null;
    if (target.type === "folder" && zone === "inside") {
      folderId = target.folder.id;
      anchor = null;
    } else if (target.type === "work") {
      folderId = target.work.folderId;
      anchor = target.work;
    } else if (target.type === "section") {
      folderId = null;
      anchor = null;
    } else {
      return null;
    }
    const siblings = orderWorks(state, Object.values(state.works).filter((work) => !work.archivedAt && (work.folderId ?? null) === folderId && work.id !== dragged.work.id), "manual");
    // Dropped into a folder (or on the section): first in it. In "recent"/"name" order the position
    // among works follows that order anyway, so only the folder changes.
    const keys = siblings.map((work) => work.sort);
    const sort = anchor && mode === "manual" ? keyAround(keys, siblings.indexOf(anchor), zone) : between(undefined, keys[0]);
    return { kind: "work", id: dragged.work.id, folderId, sort };
  }
  if (dragged.type === "session" && target.type === "session" && target.work.id === dragged.work.id && zone !== "inside") {
    const siblings = workSessions(state, dragged.work.id).filter((session) => session.id !== dragged.session.id);
    return { kind: "session", id: dragged.session.id, sort: keyAround(siblings.map((session) => session.sort), siblings.findIndex((session) => session.id === target.session.id), zone) };
  }
  return null;
}

/** An order key just before / after the anchor at `index` (or first when there is none). */
function keyAround(keys: number[], index: number, zone: DropZone) {
  if (index < 0) return between(undefined, keys[0]);
  if (zone === "after") return between(keys[index], keys[index + 1]);
  return between(keys[index - 1], keys[index]);
}

/** A sibling move with Alt+↑/↓: the row swaps place with its neighbour of the same kind. */
export function nudge(state: State, row: Row, direction: -1 | 1, mode: SortMode): Move | null {
  if (row.type === "folder") {
    const siblings = orderFolders(Object.values(state.folders).filter((folder) => !folder.archivedAt && folder.parentId === row.folder.parentId), mode);
    const index = siblings.findIndex((folder) => folder.id === row.folder.id);
    const neighbour = siblings[index + direction];
    if (!neighbour) return null;
    const rest = siblings.filter((folder) => folder.id !== row.folder.id);
    const at = rest.indexOf(neighbour);
    return { kind: "folder", id: row.folder.id, parentId: row.folder.parentId, sort: keyAround(rest.map((folder) => folder.sort), at, direction === 1 ? "after" : "before") };
  }
  if (row.type === "work") {
    const siblings = orderWorks(state, Object.values(state.works).filter((work) => !work.archivedAt && (work.folderId ?? null) === (row.work.folderId ?? null)), "manual");
    const index = siblings.findIndex((work) => work.id === row.work.id);
    const neighbour = siblings[index + direction];
    if (!neighbour) return null;
    const rest = siblings.filter((work) => work.id !== row.work.id);
    const at = rest.indexOf(neighbour);
    return { kind: "work", id: row.work.id, folderId: row.work.folderId, sort: keyAround(rest.map((work) => work.sort), at, direction === 1 ? "after" : "before") };
  }
  if (row.type === "session") {
    const siblings = workSessions(state, row.work.id);
    const index = siblings.findIndex((session) => session.id === row.session.id);
    const neighbour = siblings[index + direction];
    if (!neighbour) return null;
    const rest = siblings.filter((session) => session.id !== row.session.id);
    const at = rest.indexOf(neighbour);
    return { kind: "session", id: row.session.id, sort: keyAround(rest.map((session) => session.sort), at, direction === 1 ? "after" : "before") };
  }
  return null;
}

/** Folders in tree order, for "옮기기" menus. */
export function folderChoices(state: State): { id: string; name: string; depth: number }[] {
  const out: { id: string; name: string; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of orderFolders(Object.values(state.folders).filter((folder) => !folder.archivedAt && folder.parentId === parentId), "manual")) {
      out.push({ id: folder.id, name: folder.name, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
