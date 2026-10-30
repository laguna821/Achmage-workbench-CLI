/** Hosted review data is pinned by the host. The browser never supplies API endpoints or OIDs. */
export type GitHubTarget = { id: string; repo: string; remote: string; branch?: string };
export type GitHubBinding = {
  workspaceId: string; revision: string; branch: string | null; localHead: string | null;
  heads: GitHubTarget[]; bases: GitHubTarget[]; defaultHead: string | null; defaultBase: string | null; warnings: string[];
};
export type GitHubSelection = { binding: string; head: string; base: string; number?: number; fresh?: boolean };
export type GitHubPull = {
  number: number; title: string; body: string; author: string; url: string;
  state: "open" | "closed" | "merged"; draft: boolean; baseRepo: string; baseBranch: string; baseOid: string;
  headRepo: string; headBranch: string; headOid: string; changedFiles: number; updatedAt: string;
};
export type GitHubFile = { id: string; path: string; oldPath: string | null; status: string; additions: number; deletions: number; patch: string; notice: string | null };
export type GitHubCheck = {
  id: string; name: string; status: string; conclusion: string | null; url: string | null;
  source: "head" | "merge"; oid: string; repo: string | null; kind: "check" | "status" | "approval"; details: boolean;
};
export type GitHubView = {
  id: string; revision: string; workspaceId: string; binding: string; head: GitHubTarget; base: GitHubTarget;
  localHead: string | null; pull: GitHubPull | null; candidates: Pick<GitHubPull, "number" | "title" | "headOid">[];
  files: GitHubFile[]; checks: GitHubCheck[]; notices: string[]; checkedAt: number; stale: boolean; error: string | null;
};
export type GitHubJob = { id: string; name: string; status: string; conclusion: string | null; steps: { name: string; status: string; conclusion: string | null }[] };
export type GitHubCheckDetails = { name: string; summary: string; text: string; jobs: GitHubJob[]; notices: string[] };
export type GitHubLog = { name: string; text: string; truncated: boolean; fetchedAt: number };
