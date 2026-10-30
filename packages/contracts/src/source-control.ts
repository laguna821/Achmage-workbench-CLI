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
  /** Ignores remote tracking counts; used to recheck files after a fetch. */
  localRevision: string;
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
export type ScmAction = "stage" | "unstage" | "commit" | "fetch" | "pull" | "push";
export type ScmRemote = { name: string; fetchUrls: string[]; pushUrls: string[] };
export type ScmRemoteInventory = {
  revision: string;
  remotes: ScmRemote[];
  pullTarget: { remote: string; branch: string } | null;
  pushTarget: { remote: string; branch: string } | null;
};
export type ScmRemoteRequest = {
  remote: string;
  branch: string;
  expectedRevision: string;
  strategy?: "ff-only" | "merge" | "rebase";
  setUpstream?: boolean;
  forcePreviewId?: string;
};
export type ScmPushPreview = {
  id: string;
  workspaceId: string;
  remote: string;
  branch: string;
  head: string;
  remoteRevision: string;
  destinations: { url: string; head: string | null }[];
  expiresAt: number;
};
export type ScmRemoteResult = { url: string; phase: "pending" | "complete" | "failed"; head?: string; error?: string };
export type ScmRequest = {
  requestId: string;
  expectedRevision: string;
  action: ScmAction;
  paths?: string[];
  message?: string;
  remote?: ScmRemoteRequest;
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
  remoteResults?: ScmRemoteResult[];
  createdAt: number;
  updatedAt: number;
};
