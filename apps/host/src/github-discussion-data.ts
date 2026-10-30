import { githubReactions, type GitHubDiscussionComment, type GitHubDiscussionOperation, type GitHubInlineSelection, type GitHubReviewEvent } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { object } from "./github-data.ts";

export const discussionError = (message: string) => new HttpError(409, "github_discussion", message);
const bad = (message: string) => new HttpError(400, "github_discussion_input", message);
export function discussionText(value: unknown, required = true) {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 65536 || required && !value.trim()) throw bad("본문을 64 KiB 이내로 입력하세요.");
  return value;
}
export function discussionId(value: unknown) { if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw bad("검토 대상을 다시 선택하세요."); return value; }
export function inlineSelection(raw: unknown): GitHubInlineSelection {
  const v = object(raw), file = discussionId(v.file);
  if (v.side === "FILE") return { file, side: "FILE" };
  if (!["LEFT", "RIGHT"].includes(String(v.side)) || !Number.isSafeInteger(v.start) || !Number.isSafeInteger(v.end) || Number(v.start) < 1 || Number(v.end) < Number(v.start) || Number(v.end) - Number(v.start) > 500) throw bad("파일의 검토할 행 범위를 선택하세요.");
  return { file, side: v.side as "LEFT" | "RIGHT", start: Number(v.start), end: Number(v.end) };
}
export function reviewEvent(value: unknown): GitHubReviewEvent { if (!["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(String(value))) throw bad("리뷰 종류를 선택하세요."); return value as GitHubReviewEvent; }
export function inlineDrafts(value: unknown) {
  if (!Array.isArray(value) || value.length > 50) throw bad("행 의견은 한 번에 50개까지 보낼 수 있습니다.");
  return value.map((row) => { const v = object(row); return { selection: inlineSelection(v.selection), body: discussionText(v.body) }; });
}
export function discussionOperation(raw: unknown): GitHubDiscussionOperation {
  const v = object(raw), kind = v.kind;
  if (kind === "comment") return { kind, body: discussionText(v.body) };
  if (kind === "reply" || kind === "edit-comment") return { kind, target: discussionId(v.target), body: discussionText(v.body) };
  if (kind === "delete-comment" || kind === "remove-reviewer" || kind === "discard-pending") return { kind, target: discussionId(v.target) };
  if (kind === "reaction") { if (!githubReactions.includes(v.content as typeof githubReactions[number]) || typeof v.add !== "boolean") throw bad("반응을 확인하세요."); return { kind, target: discussionId(v.target), content: v.content as typeof githubReactions[number], add: v.add }; }
  if (kind === "resolve") { if (typeof v.resolved !== "boolean") throw bad("해결 상태를 확인하세요."); return { kind, target: discussionId(v.target), resolved: v.resolved }; }
  if (kind === "request-review") {
    if (!Array.isArray(v.reviewers) || !v.reviewers.length || v.reviewers.length > 15 || v.reviewers.some((n) => typeof n !== "string" || !/^[a-z\d](?:[a-z\d-]{0,38})(?:\/[a-z\d_-]{1,100})?$/i.test(n))) throw bad("검토자의 로그인 또는 조직/팀 이름을 입력하세요. 최대 15개입니다.");
    return { kind, reviewers: [...new Set(v.reviewers as string[])].sort() };
  }
  if (kind === "inline") return { kind, selection: inlineSelection(v.selection), body: discussionText(v.body) };
  if (kind === "review") return { kind, event: reviewEvent(v.event), body: discussionText(v.body, false), comments: inlineDrafts(v.comments) };
  if (kind === "submit-pending") return { kind, target: discussionId(v.target), event: reviewEvent(v.event), body: discussionText(v.body, false) };
  throw bad("지원하지 않는 리뷰 작업입니다.");
}
export const discussionLabels: Record<GitHubDiscussionOperation["kind"], string> = { comment: "PR 댓글 게시", reply: "스레드에 답글 게시", "edit-comment": "댓글 수정", "delete-comment": "댓글 삭제", reaction: "댓글 반응 변경", resolve: "스레드 해결 상태 변경", "request-review": "검토 요청", "remove-reviewer": "검토 요청 취소", inline: "파일·행 의견 게시", review: "리뷰 제출", "submit-pending": "작성 중인 리뷰 제출", "discard-pending": "작성 중인 리뷰 삭제" };
export const commonCommentFields = `id fullDatabaseId body createdAt updatedAt url author { login ... on User { id } ... on Bot { id } }
  viewerCanUpdate viewerCanDelete viewerCanReact reactionGroups { content viewerHasReacted reactors { totalCount } }`;
export const inlineCommentFields = `${commonCommentFields} commit { oid } pullRequestReview { id state } replyTo { id fullDatabaseId }`;
export const connectionFields = `pageInfo { hasNextPage endCursor }`;
export const reviewFields = `${commonCommentFields} state commit { oid } comments(first:100) { ${connectionFields} nodes { ${inlineCommentFields} } }`;
export const threadFields = `id path diffSide startDiffSide line startLine originalLine originalStartLine subjectType isResolved isOutdated viewerCanReply viewerCanResolve viewerCanUnresolve comments(first:100) { ${connectionFields} nodes { ${inlineCommentFields} } }`;
export const reviewerFields = `requestedReviewer { __typename ... on User { id login } ... on Bot { id login } ... on Team { id slug organization { login } } }`;
export const discussionIdentityFields = `id number state isDraft locked headRefName headRefOid baseRefName baseRefOid headRepository { id nameWithOwner } author { login } viewerCanUpdate`;
export const discussionQuery = `query WorkbenchDiscussion($owner:String!,$repo:String!,$number:Int!) { viewer { id login } repository(owner:$owner,name:$repo) { id nameWithOwner viewerPermission pullRequest(number:$number) { ${discussionIdentityFields}
  comments(first:100) { ${connectionFields} nodes { ${commonCommentFields} } }
  reviews(first:100) { ${connectionFields} nodes { ${reviewFields} } }
  reviewThreads(first:50) { ${connectionFields} nodes { ${threadFields} } }
  reviewRequests(first:100) { ${connectionFields} nodes { ${reviewerFields} } }
} } }`;
export const reviewState = (event: GitHubReviewEvent) => event === "COMMENT" ? "COMMENTED" : event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED";
export const commentSignature = (c: GitHubDiscussionComment) => [c.id, c.body, c.updatedAt, c.state, c.commit, c.canUpdate, c.canDelete, c.canReact, c.reactions];
