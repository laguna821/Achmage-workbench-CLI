import type { ProjectPick, Work, WorkAtFolder } from "@workbench/contracts";
import type { Api } from "./api.ts";
import { recency } from "./overview.ts";
import { folderPath, type State } from "./state.ts";
import { workHidden } from "./tree.ts";

// ① 들어가는 길 (design §3): the projects the home input offers and where its request goes. Plain
// data here (no React), so the rules can be tested.

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

/** The gateway's side of it: a folder's live work. */
export function entryClient(api: Api) {
  return {
    workAt: (path: string) => api.request<WorkAtFolder>("GET", `/api/entry/work?${new URLSearchParams({ path })}`).then((result) => result.work),
  };
}
