import { isUnseen, type Artifact, type Session, type Work } from "@workbench/contracts";
import type { State } from "./state.ts";
import { folderHidden, sessionHidden, workDocs, workHidden, workSessions } from "./tree.ts";

// Home overview modes (design 3.3): the same sessions, works and documents grouped along five
// axes — what waits for me, where things stall, where things are, when they happened, what was
// made. Plain data here (no React), so the grouping rules can be tested. No model is involved.

export type HomeMode = "now" | "projects" | "flow" | "docs";

// Four modes (프로젝트 노트 설계 v2 §9): "보드" (sessions by state) is what "지금" already groups,
// and "지도" (folders › works) became the cards of "프로젝트", next to its table and kanban.
export const HOME_MODES: { id: HomeMode; label: string; question: string }[] = [
  { id: "now", label: "지금", question: "무엇이 나를 기다리나" },
  { id: "projects", label: "프로젝트", question: "프로젝트는 어디쯤인가" },
  { id: "flow", label: "흐름", question: "언제 무엇을 했나" },
  { id: "docs", label: "문서", question: "무엇이 만들어졌나" },
];

/** The saved mode; the old "보드" opens "지금" and the old "지도" opens "프로젝트". */
export const readHomeMode = (value: unknown): HomeMode =>
  value === "board" ? "now" : value === "map" ? "projects" : HOME_MODES.some((mode) => mode.id === value) ? (value as HomeMode) : "now";

/** Groups of "지금", in the order they ask for the user. */
export type Bucket = "attention" | "trouble" | "unseen" | "running" | "queued";

export const BUCKETS: { id: Bucket; label: string }[] = [
  { id: "attention", label: "확인 필요" },
  { id: "trouble", label: "오류·멈춤" },
  { id: "unseen", label: "새 답" },
  { id: "running", label: "진행" },
  { id: "queued", label: "예약 있음" },
];

export const isWorking = (session: Session) => session.status === "starting" || session.status === "running" || session.status === "interrupting";

/** Requests kept after a stop, a failure or a restart: they go only when the user sends them. */
export const heldCount = (session: Session) => session.queued.filter((entry) => entry.held).length;

/**
 * Where a session stands in "지금", first match wins: waiting for an approval; failed, or holding
 * requests a stop left behind; a reply not looked at; working; requests waiting for the turn to
 * end. Null when nothing waits.
 */
export function bucketOf(session: Session): Bucket | null {
  if (session.status === "awaitingApproval") return "attention";
  const working = isWorking(session);
  if (session.status === "error" || (!working && (Boolean(session.lastError) || heldCount(session) > 0))) return "trouble";
  if (!working && isUnseen(session)) return "unseen";
  if (working) return "running";
  if (session.queued.length) return "queued";
  return null;
}

/** Latest sign of life of a session (a reply, else any change). */
export const recency = (session: Session) => Math.max(session.previewAt ?? 0, session.updatedAt);

const liveSessions = (state: State) => Object.values(state.sessions).filter((session) => !sessionHidden(state, session));

export type NowGroup = { bucket: Bucket; label: string; sessions: Session[] };

/** "지금": every session that waits for something, grouped and newest first. */
export function nowGroups(state: State): NowGroup[] {
  const groups = new Map<Bucket, Session[]>();
  for (const session of liveSessions(state)) {
    const bucket = bucketOf(session);
    if (!bucket) continue;
    groups.set(bucket, [...(groups.get(bucket) ?? []), session]);
  }
  return BUCKETS.filter((bucket) => groups.has(bucket.id)).map((bucket) => ({
    bucket: bucket.id,
    label: bucket.label,
    sessions: groups.get(bucket.id)!.sort((a, b) => recency(b) - recency(a)),
  }));
}

/** Sessions to pick up again: recent replies not already listed above. */
export function resumeSessions(state: State, listed: Set<string>, limit = 6): Session[] {
  return liveSessions(state)
    .filter((session) => !listed.has(session.id) && session.previewAt)
    .sort((a, b) => (b.previewAt ?? 0) - (a.previewAt ?? 0))
    .slice(0, limit);
}

export function recentWorks(state: State, limit = 6): Work[] {
  return Object.values(state.works)
    .filter((work) => !workHidden(state, work))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

export type ColumnId = "attention" | "running" | "trouble" | "unseen" | "rest";
export type BoardColumn = { id: ColumnId; label: string; sessions: Session[] };

const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: "attention", label: "확인 필요" },
  { id: "running", label: "진행 중" },
  { id: "trouble", label: "오류·멈춤" },
  { id: "unseen", label: "새 답" },
  { id: "rest", label: "쉬는 중" },
];

/** "보드": one column per state the engine is in (the engine decides it, so cards are not dragged). */
export function boardColumns(state: State): BoardColumn[] {
  const columns = new Map<ColumnId, Session[]>(COLUMNS.map((column) => [column.id, []]));
  for (const session of liveSessions(state)) {
    const bucket = bucketOf(session);
    const column: ColumnId = bucket === "attention" || bucket === "running" || bucket === "trouble" || bucket === "unseen" ? bucket : "rest";
    columns.get(column)!.push(session);
  }
  return COLUMNS.map((column) => ({ ...column, sessions: columns.get(column.id)!.sort((a, b) => recency(b) - recency(a)) }));
}

export type MapSection = { folderId: string | null; path: string[]; works: Work[] };

const byOrder = (a: Work, b: Work) => a.sort - b.sort || b.createdAt - a.createdAt;

/** "지도": folders in tree order, each with the works right inside it; loose works last. */
export function mapSections(state: State): MapSection[] {
  const sections: MapSection[] = [];
  const works = Object.values(state.works).filter((work) => !workHidden(state, work));
  const walk = (parentId: string | null, path: string[]) => {
    const folders = Object.values(state.folders)
      .filter((folder) => folder.parentId === parentId && !folderHidden(state, folder.id))
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "ko"));
    for (const folder of folders) {
      const inside = works.filter((work) => work.folderId === folder.id).sort(byOrder);
      if (inside.length) sections.push({ folderId: folder.id, path: [...path, folder.name], works: inside });
      walk(folder.id, [...path, folder.name]);
    }
  };
  walk(null, []);
  const loose = works.filter((work) => !work.folderId || !state.folders[work.folderId]).sort(byOrder);
  if (loose.length) sections.push({ folderId: null, path: [], works: loose });
  return sections;
}

/** Text Mermaid reads as a plain mind-map node (no shapes, icons or classes). */
export const nodeText = (text: string) =>
  text
    .replace(/[()[\]{}<>"'`:;#|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 28) || "제목 없음";

/** "지도" as a mind map (drawn by Pele): folders › works › sessions, kept small enough to read. */
export function mindmapSource(state: State, sections: MapSection[], limits = { sections: 10, works: 5, sessions: 3 }) {
  const lines = ["mindmap", "  root((작업 지도))"];
  for (const section of sections.slice(0, limits.sections)) {
    lines.push(`    ${nodeText(section.path.length ? section.path.join(" / ") : "분류 없음")}`);
    for (const work of section.works.slice(0, limits.works)) {
      lines.push(`      ${nodeText(work.title)}`);
      const sessions = workSessions(state, work.id);
      for (const session of sessions.slice(0, limits.sessions)) lines.push(`        ${nodeText(session.purpose)}`);
      if (sessions.length > limits.sessions) lines.push(`        외 ${sessions.length - limits.sessions}개`);
    }
    if (section.works.length > limits.works) lines.push(`      작업 ${section.works.length - limits.works}개 더`);
  }
  if (sections.length > limits.sections) lines.push(`    폴더 ${sections.length - limits.sections}개 더`);
  return lines.join("\n");
}

export type DocEntry = { artifact: Artifact; work: Work; pending: number; running: number };

/** "문서": every document of the visible works, the latest change first, with its waiting proposals. */
export function docEntries(state: State): DocEntry[] {
  const pending = new Map<string, number>();
  const running = new Map<string, number>();
  for (const proposal of Object.values(state.proposals)) {
    if (proposal.status === "pending") pending.set(proposal.artifactId, (pending.get(proposal.artifactId) ?? 0) + 1);
    if (proposal.status === "running") running.set(proposal.artifactId, (running.get(proposal.artifactId) ?? 0) + 1);
  }
  return Object.values(state.artifacts)
    .flatMap((artifact) => {
      const work = state.works[artifact.workId];
      return work && !workHidden(state, work) && artifact.role !== "project-note" ? [{ artifact, work, pending: pending.get(artifact.id) ?? 0, running: running.get(artifact.id) ?? 0 }] : [];
    })
    .sort((a, b) => b.artifact.updatedAt - a.artifact.updatedAt);
}

/** A work's sessions and documents for its card (visible ones only). */
export const workContents = (state: State, work: Work) => ({ sessions: workSessions(state, work.id), docs: workDocs(state, work.id) });

/** The last request and the reply after it (several reply parts joined), for a row opened in "지금". */
export function lastExchange(items: { kind: string; text?: string }[]) {
  let start = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]!.kind === "user") {
      start = index;
      break;
    }
  }
  const turn = start >= 0 ? items.slice(start) : items;
  const answer = turn
    .filter((item) => item.kind === "assistant" && item.text?.trim())
    .map((item) => item.text!)
    .join("\n\n")
    .trim();
  return { request: start >= 0 ? (items[start]!.text ?? "") : null, answer: answer || null };
}
