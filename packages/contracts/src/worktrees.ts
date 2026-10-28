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
};

export type WorktreeFile = { path: string; status: "added" | "modified" | "deleted" | "renamed" };

export type WorktreeChanges = { files: WorktreeFile[]; diff: string; branch: string; base: string };
