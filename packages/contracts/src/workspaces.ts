import type { SessionWorktree } from "./worktrees.ts";

/** A stable execution/file boundary inside a project. Closing a view never archives or deletes it. */
export type Workspace = {
  id: string;
  workId: string;
  hostId: string;
  label: string;
  kind: "folder" | "worktree";
  cwd: string;
  managed: boolean;
  worktree: SessionWorktree | null;
  /** Visual grouping only; never implies Git ancestry or permission to delete children. */
  parentWorkspaceId?: string | null;
  archivedAt: number | null;
  /** Only set after the underlying app-owned worktree was successfully removed. */
  removedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type CreateWorkspaceRequest = { cwd: string; label?: string };
export type UpdateWorkspaceRequest = { label?: string; archived?: boolean };
