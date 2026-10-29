// "격리 사본": a session working in a git worktree of its work's repository.

/** Where a session works apart: the repository, the worktree, its branch and starting commit. */
export type SessionWorktree = {
  /** The repository's top folder (the original checkout). */
  root: string;
  /** The worktree folder. */
  path: string;
  branch: string;
  /** The commit the copy started from (changes are counted against it). */
  base: string;
  /** Where the engine works: the work's subfolder inside the copy. */
  cwd: string;
  /** Repository identity captured at creation/connection; older descriptors did not have it. */
  commonDir?: string;
  detached?: boolean;
};

export type GitRef = { name: string; commit: string; kind: "branch" | "remote" | "tag" };
export type DetectedWorktree = { path: string; head: string; branch: string; detached: boolean; bare: boolean; locked: string | null; prunable: string | null; missing: boolean; workspaceId?: string };
export type WorkspaceRepository = { root: string; commonDir: string; head: string; branch: string; refs: GitRef[]; worktrees: DetectedWorktree[] };
export type CreateWorktreeWorkspaceRequest = { requestId: string; sourceWorkspaceId: string; label: string; branch: string; baseRef: string; expectedBase?: string; parentWorkspaceId?: string | null };
export type WorktreeCreation = {
  id: string; workId: string; request: CreateWorktreeWorkspaceRequest;
  phase: "checking" | "creating" | "ready" | "failed" | "canceled" | "interrupted";
  root?: string; path?: string; branch?: string; base?: string; workspaceId?: string;
  error?: string; createdAt: number; updatedAt: number;
};

export type WorktreeFile = { path: string; status: "added" | "modified" | "deleted" | "renamed" };

export type WorktreeChanges = { files: WorktreeFile[]; diff: string; branch: string; base: string };
