import type { GitHubFile } from "./github.ts";
import type { ScmReviewTarget } from "./scm-review.ts";

export const githubReactions = ["THUMBS_UP", "THUMBS_DOWN", "LAUGH", "CONFUSED", "HEART", "HOORAY", "ROCKET", "EYES"] as const;
export type GitHubReaction = typeof githubReactions[number];
export type GitHubDiscussionComment = {
  id: string; kind: "conversation" | "inline" | "review"; author: string; body: string; url: string | null;
  createdAt: string; updatedAt: string; canUpdate: boolean; canDelete: boolean; canReact: boolean;
  reactions: { content: GitHubReaction; count: number; mine: boolean }[];
  state?: string; commit?: string; thread?: string; review?: string;
};
export type GitHubDiscussionThread = {
  id: string; path: string; side: "LEFT" | "RIGHT"; line: number | null; start: number | null;
  originalLine: number | null; originalStart: number | null; file: boolean; resolved: boolean; outdated: boolean;
  canReply: boolean; canResolve: boolean; canUnresolve: boolean; comments: string[];
};
export type GitHubReviewer = { id: string; kind: "User" | "Team" | "Bot"; name: string };
export type GitHubDiscussionView = {
  id: string; revision: string; workspaceId: string; viewId: string; viewRevision: string;
  actor: string; repo: string; number: number; headOid: string; baseOid: string; author: string;
  state: string; canRequest: boolean; locked: boolean; complete: boolean; notices: string[]; checkedAt: number;
  comments: GitHubDiscussionComment[]; threads: GitHubDiscussionThread[]; reviewers: GitHubReviewer[]; files: GitHubFile[];
};
export type GitHubInlineSelection = { file: string; side: "FILE" } | { file: string; side: "LEFT" | "RIGHT"; start: number; end: number };
export type GitHubReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export type GitHubInlineDraft = { selection: GitHubInlineSelection; body: string };
export type GitHubDiscussionOperation =
  | { kind: "comment"; body: string }
  | { kind: "reply" | "edit-comment"; target: string; body: string }
  | { kind: "delete-comment"; target: string }
  | { kind: "reaction"; target: string; content: GitHubReaction; add: boolean }
  | { kind: "resolve"; target: string; resolved: boolean }
  | { kind: "request-review"; reviewers: string[] }
  | { kind: "remove-reviewer"; target: string }
  | { kind: "inline"; selection: GitHubInlineSelection; body: string }
  | { kind: "review"; event: GitHubReviewEvent; body: string; comments: GitHubInlineDraft[] }
  | { kind: "submit-pending"; target: string; event: GitHubReviewEvent; body: string }
  | { kind: "discard-pending"; target: string };
export type GitHubDiscussionDraft = {
  version: number; headOid: string; mode: "comment" | "reply" | "edit-comment" | "inline" | "review";
  target: string; body: string; event: GitHubReviewEvent; selection: GitHubInlineSelection | null; comments: GitHubInlineDraft[];
};
export type GitHubFeedbackBatch = {
  id: string; workspaceId: string; requestId: string; sessionId: string; target: ScmReviewTarget; fingerprint: string;
  text: string; phase: "sending" | "queued" | "accepted" | "failed" | "uncertain" | "changed";
  detail: string | null; createdAt: number; updatedAt: number;
};
export type GitHubFeedbackRequest = { requestId: string; sessionId: string; discussionId: string; revision: string; comments: string[]; checks: string[] };
export type GitHubFeedbackList = { targets: ScmReviewTarget[]; batches: GitHubFeedbackBatch[] };
