export type GitHubMergeMethod = "merge" | "squash" | "rebase";
export type GitHubActionInput =
  | { kind: "create"; title: string; body: string; baseBranch: string; draft: boolean; maintainerCanModify: boolean }
  | { kind: "edit"; title: string; body: string; baseBranch: string }
  | { kind: "close" | "reopen" | "draft" | "ready" | "auto-disable" }
  | { kind: "enqueue" }
  | { kind: "merge" | "auto-enable"; method: GitHubMergeMethod }
  | { kind: "rerun"; failedOnly: boolean; checks: string[] };
export type GitHubDraft = { version: number; title: string; body: string; baseBranch: string; draft: boolean; maintainerCanModify: boolean };
export type GitHubTemplate = { path: string; body: string; commit: string };
export type GitHubStackLayer = { number: number; title: string; position: number; oid: string; state: string; draft: boolean; checks: string; review: string };
export type GitHubActionContext = {
  id: string; workspaceId: string; viewId: string; viewRevision: string; actor: string; repo: string;
  headRepo: string; headBranch: string; headOid: string; baseBranch: string; number: number | null;
  canUpdate: boolean; canMerge: boolean; methods: GitHubMergeMethod[]; defaultMethod: GitHubMergeMethod;
  autoAllowed: boolean; autoEnabled: boolean; queueRequired: boolean; queued: boolean;
  stack: { number: number; layers: GitHubStackLayer[]; complete: boolean } | null;
  state: string; draft: boolean; title: string; body: string; notices: string[];
};
export type GitHubActionPreview = {
  id: string; contextId: string; expiresAt: number; action: GitHubActionInput; actor: string; repo: string;
  number: number | null; headRepo: string; headBranch: string; headOid: string; baseBranch: string;
  effects: string[]; notices: string[];
};
export type GitHubEffect = {
  id: string; label: string; phase: "prepared" | "sending" | "accepted" | "pending" | "complete" | "failed" | "uncertain" | "changed";
  detail: string; outcome?: "created" | "updated" | "merged" | "enqueued" | "auto-enabled" | "auto-disabled" | "rerun";
  number?: number; url?: string;
};
export type GitHubActionJob = {
  id: string; requestId: string; workspaceId: string; preview: GitHubActionPreview;
  phase: "running" | "pending" | "complete" | "partial" | "failed" | "uncertain" | "changed";
  effects: GitHubEffect[]; detail: string; createdAt: number; updatedAt: number;
};
