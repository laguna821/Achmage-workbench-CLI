export type ScmFile = {
  path: string;
  oldPath?: string;
  index: string;
  working: string;
  conflicted: boolean;
  submodule: boolean;
};
export type ScmOperation = "merge" | "rebase" | "cherry-pick" | "revert" | null;
export type ScmStatus = {
  workspaceId: string;
  root: string;
  commonDir: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  operation: ScmOperation;
  files: ScmFile[];
  revision: string;
};
export type ScmArea = "staged" | "working";
export type ScmDiff = {
  path: string;
  area: ScmArea;
  revision: string;
  patch: string;
  truncated: boolean;
  binary: boolean;
  /** Raster images only. SVG remains escaped text, never executable markup. */
  images?: { before: string | null; after: string | null };
};
export type ScmAction = "stage" | "unstage" | "commit";
export type ScmRequest = {
  requestId: string;
  expectedRevision: string;
  action: ScmAction;
  paths?: string[];
  message?: string;
};
export type ScmJob = {
  id: string;
  workspaceId: string;
  root: string;
  commonDir: string;
  request: ScmRequest;
  branch: string | null;
  headBefore: string | null;
  headAfter: string | null;
  phase: "running" | "complete" | "failed" | "interrupted";
  output: string;
  outputTruncated: boolean;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};
