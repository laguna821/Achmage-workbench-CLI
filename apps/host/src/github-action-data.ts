import type { GitHubActionInput, GitHubMergeMethod } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { object } from "./github-data.ts";
import { discussionId, discussionOperation } from "./github-discussion-data.ts";

export const actionQuery = `query WorkbenchActions($owner:String!,$repo:String!,$headOwner:String!,$headRepo:String!,$ref:String!,$number:Int!,$hasPull:Boolean!) {
  viewer { id login }
  head: repository(owner:$headOwner,name:$headRepo) { id nameWithOwner ref(qualifiedName:$ref) { target { oid } } }
  repository(owner:$owner,name:$repo) { id nameWithOwner viewerPermission defaultBranchRef { name }
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed viewerDefaultMergeMethod
    pullRequest(number:$number) @include(if:$hasPull) { id number title body state isDraft updatedAt
      headRefName headRefOid baseRefName baseRefOid headRepository { id nameWithOwner }
      viewerCanUpdate viewerCanEnableAutoMerge viewerCanDisableAutoMerge
      isMergeQueueEnabled isInMergeQueue autoMergeRequest { mergeMethod } mergeStateStatus reviewDecision
      stack { number size entries(first:100) { pageInfo { hasNextPage } nodes { position pullRequest {
        number title headRefOid state isDraft reviewDecision statusCheckRollup { state }
      } } } }
    }
  }
}`;

const bad = (text: string) => new HttpError(400, "github_action_input", text);
export function actionText(value: unknown, limit: number, label: string, required = false) {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > limit || required && !value.trim()) throw bad(`${label}을 확인하세요. 최대 ${limit}바이트입니다.`);
  return value;
}
export function branchName(value: unknown) {
  const name = actionText(value, 1024, "기준 브랜치", true);
  if (/^[./-]|[./]$|[\s~^:?*\[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|(?:^|\/)\.[^/]*|\.lock(?:\/|$)/.test(name) || name === "@") throw bad("기준 브랜치 이름을 확인하세요.");
  return name;
}
export function actionInput(raw: unknown): GitHubActionInput {
  const value = object(raw), kind = value.kind;
  if (kind === "discussion") return { kind, discussionId: discussionId(value.discussionId), revision: discussionId(value.revision), operation: discussionOperation(value.operation) };
  if (kind === "create" || kind === "edit") {
    const text = { title: actionText(value.title, 1024, "제목", true), body: actionText(value.body, 65536, "설명"), baseBranch: branchName(value.baseBranch) };
    if (kind === "edit") return { kind, ...text };
    if (typeof value.draft !== "boolean" || typeof value.maintainerCanModify !== "boolean") throw bad("PR 초안·관리자 수정 설정을 확인하세요.");
    return { kind, ...text, draft: value.draft, maintainerCanModify: value.maintainerCanModify };
  }
  if (["close", "reopen", "draft", "ready", "auto-disable", "enqueue"].includes(String(kind))) return { kind } as GitHubActionInput;
  if (kind === "merge" || kind === "auto-enable") {
    if (!["merge", "squash", "rebase"].includes(String(value.method))) throw bad("병합 방법을 선택하세요.");
    return { kind, method: value.method as GitHubMergeMethod };
  }
  if (kind === "rerun") {
    if (typeof value.failedOnly !== "boolean" || !Array.isArray(value.checks) || value.checks.length > 200 || value.checks.some((id) => typeof id !== "string" || id.length > 100)) throw bad("재실행할 검사를 선택하세요.");
    return { kind, failedOnly: value.failedOnly, checks: [...new Set(value.checks as string[])].sort() };
  }
  throw bad("지원하지 않는 PR 작업입니다.");
}
export const actionLabels: Record<GitHubActionInput["kind"], string> = { create: "PR 만들기", edit: "PR 제목·설명·기준 수정", close: "PR 닫기", reopen: "PR 다시 열기", draft: "초안으로 전환", ready: "검토 준비 완료", "auto-disable": "자동 병합 끄기", "auto-enable": "자동 병합 켜기", merge: "PR 병합", enqueue: "병합 대기열에 등록", rerun: "검사 재실행", discussion: "리뷰 대화 변경" };
export function mutation(name: string, input: object) {
  const type = name[0]!.toUpperCase() + name.slice(1) + "Input";
  // Fixed operation names from the host, never an interpolated user string.
  return { query: `mutation WorkbenchAction($input:${type}!) { ${name}(input:$input) { clientMutationId${name === "createPullRequest" ? " pullRequest { number id }" : ""} } }`, variables: { input } };
}
