import { isUnseen, type ProjectPick, type Session, type Work, type WorkAtFolder, type WorksDirView } from "@workbench/contracts";
import type { Api } from "./api.ts";
import { isWorking, recency } from "./overview.ts";
import { folderPath, sessionsOf, type State } from "./state.ts";
import { workHidden, workSessions } from "./tree.ts";

// ① 들어가는 길 (design §3): which session opening a work lands on, and the projects the home input
// offers. Plain data here (no React), so the rules can be tested.

/** A failed turn (or a request that could not be sent) the user has not looked at since. */
export const unseenFailure = (session: Session) =>
  !isWorking(session) && session.status !== "awaitingApproval" && (session.status === "error" || Boolean(session.lastError)) && session.updatedAt > (session.seenAt ?? 0);

/** Why a session asks for the user, strongest first; null when nothing waits. */
export function needOf(session: Session): "approval" | "failure" | "unseen" | null {
  if (session.status === "awaitingApproval") return "approval";
  if (unseenFailure(session)) return "failure";
  if (!isWorking(session) && isUnseen(session)) return "unseen";
  return null;
}

const NEEDS = ["approval", "failure", "unseen"] as const;

/**
 * The session opening a work shows: one waiting for an approval (확인 필요), else one that failed,
 * else one with a reply not seen yet, else the one looked at last. Within a kind the one looked at
 * last stays, otherwise the latest. Null when the work has no session.
 */
export function sessionToOpen(state: State, work: Work): Session | null {
  const live = workSessions(state, work.id).filter((session) => !session.documentAgent);
  for (const need of NEEDS) {
    const waiting = live.filter((session) => needOf(session) === need);
    if (!waiting.length) continue;
    return waiting.find((session) => session.id === work.activeSessionId) ?? [...waiting].sort((a, b) => recency(b) - recency(a))[0]!;
  }
  const last = work.activeSessionId ? state.sessions[work.activeSessionId] : undefined;
  if (last && !last.documentAgent && !last.archivedAt && last.workId === work.id) return last;
  return live.at(-1) ?? sessionsOf(state, work.id).filter((session) => !session.documentAgent).at(-1) ?? null;
}

/**
 * Projects the home input offers: live works, most recently active (its own change or any reply
 * in it) first, filtered by name, classification folder or work folder.
 */
export function projectChoices(state: State, query = "", limit = 12): Work[] {
  const needle = query.trim().toLowerCase();
  const replied = new Map<string, number>();
  for (const session of Object.values(state.sessions)) {
    if (!session.archivedAt) replied.set(session.workId, Math.max(replied.get(session.workId) ?? 0, recency(session)));
  }
  const activity = (work: Work) => Math.max(work.updatedAt, replied.get(work.id) ?? 0);
  return Object.values(state.works)
    .filter((work) => !workHidden(state, work))
    .filter((work) => !needle || [work.title, work.cwdManaged ? "" : work.cwd, ...folderPath(state, work.folderId).map((folder) => folder.name)].some((text) => text.toLowerCase().includes(needle)))
    .sort((a, b) => activity(b) - activity(a))
    .slice(0, limit);
}

/** The work a request from home goes to (null: a new project), as far as the screen knows now. */
export function pickedWork(state: State, pick: ProjectPick, folderWork: Work | null): Work | null {
  const live = (work: Work | null | undefined) => (work && !workHidden(state, work) ? work : null);
  if (pick.kind === "new") return null;
  if (pick.kind === "work") return live(state.works[pick.workId]);
  return folderWork ? live(state.works[folderWork.id] ?? folderWork) : null;
}

/**
 * The existing work a request typed on home goes to, or null for a new project. With the folder
 * deciding ("auto"), the gateway is asked at send time: the chip may not have heard back yet.
 */
export async function homeTarget(state: State, pick: ProjectPick, cwd: string | null, workAt: (path: string) => Promise<Work | null>): Promise<Work | null> {
  if (pick.kind !== "auto") return pickedWork(state, pick, null);
  if (!cwd) return null;
  return pickedWork(state, pick, await workAt(cwd));
}

/** The gateway's side of it: a folder's live work, the location of new project folders. */
export function entryClient(api: Api) {
  return {
    workAt: (path: string) => api.request<WorkAtFolder>("GET", `/api/entry/work?${new URLSearchParams({ path })}`).then((result) => result.work),
    worksDir: () => api.request<WorksDirView>("GET", "/api/entry/works-dir"),
    setWorksDir: (path: string) => api.request<WorksDirView>("PUT", "/api/entry/works-dir", { path }),
    resetWorksDir: () => api.request<WorksDirView>("DELETE", "/api/entry/works-dir"),
  };
}
