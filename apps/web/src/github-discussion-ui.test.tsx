// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitHubDiscussionView, GitHubDiscussionDraft, GitHubView } from "@workbench/contracts";
import type { Api } from "./api.ts";
import { GitHubDiscussion } from "./components/GitHubDiscussion.tsx";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const head = "a".repeat(40), base = "b".repeat(40);
const view = { id: "view", revision: "rev", workspaceId: "space", base: { repo: "fixture/project" }, pull: { number: 7 }, checks: [{ id: "ci", name: "build", conclusion: "failure", status: "completed", oid: head }], stale: false } as GitHubView;
const common = { author: "worker", body: "원래 의견", url: "https://github.com/fixture/project/pull/7", createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z", canUpdate: true, canDelete: true, canReact: true, reactions: [] };
const data: GitHubDiscussionView = { id: "discussion", revision: "discussion-revision", workspaceId: "space", viewId: "view", viewRevision: "rev", actor: "worker", author: "other", repo: "fixture/project", number: 7, headOid: head, baseOid: base, state: "OPEN", locked: false, canRequest: true, complete: true, notices: [], checkedAt: Date.now(), comments: [{ ...common, id: "conversation", kind: "conversation" }, { ...common, id: "root", kind: "inline", thread: "thread", body: "루트 의견" }, { ...common, id: "child", kind: "inline", thread: "thread", body: "자식 답글" }, { ...common, id: "approval", kind: "review", body: "", state: "APPROVED" }], threads: [{ id: "thread", path: "한글.txt", side: "RIGHT", line: 1, start: null, originalLine: 1, originalStart: null, file: false, resolved: false, outdated: false, canReply: true, canResolve: true, canUnresolve: true, comments: ["root", "child"] }], reviewers: [], files: [{ id: "file", path: "한글.txt", oldPath: null, status: "modified", additions: 1, deletions: 1, patch: "@@ -1,2 +1,2 @@\n-old\n+new\n same\n", notice: null }] };
const draft: GitHubDiscussionDraft = { version: 0, headOid: head, mode: "comment", body: "", target: "", event: "COMMENT", comments: [], selection: null };
function setup(extra: Partial<Api> = {}, props = { active: true, fixEpoch: 0 }) {
  const api = { githubDiscussion: vi.fn(async () => structuredClone(data)), githubDiscussionDraft: vi.fn(async () => ({ ...draft })), githubDiscussionDraftSave: vi.fn(async (_w, _id, d) => ({ ...d, version: d.version + 1 })), githubActionContext: vi.fn(async () => ({ id: "context" })), githubActionPreview: vi.fn(async (_w, _id, action) => ({ id: "preview", action, actor: "worker", repo: "fixture/project", number: 7, headOid: head, effects: ["리뷰 게시"], notices: [] })), githubActionStart: vi.fn(async () => ({ id: "job" })), githubActionJobs: vi.fn(async () => []), githubFeedback: vi.fn(async () => ({ targets: [{ id: "session", provider: "codex", purpose: "fix", status: "idle" }], batches: [] })), githubFeedbackSend: vi.fn(async () => ({ id: "batch" })), ...extra } as unknown as Api;
  const ui = render(<GitHubDiscussion api={api} workspaceId="space" view={view} disabled={false} {...props} />);
  const ready = async () => waitFor(() => expect(ui.container.querySelector(".scm-gh-discussion-body")).not.toBeNull());
  return { api, ui, ready };
}
it("does not load hidden discussions and displays empty approval reviews when opened", async () => {
  const f = setup({}, { active: false, fixEpoch: 0 }); expect(f.api.githubDiscussion).not.toHaveBeenCalled(); f.ui.rerender(<GitHubDiscussion api={f.api} workspaceId="space" view={view} active disabled={false} />); await f.ready(); expect(f.ui.getByText("본문 없는 리뷰")).toBeTruthy(); expect(f.ui.getByText("승인")).toBeTruthy();
});
it("renders hosted Markdown while leaving raw HTML inert and remote images unloaded", async () => {
  const hosted = structuredClone(data); hosted.comments[0]!.body = "**굵은 의견**\n\n```ts\nconst x = 1;\n```\n\n![외부 이미지](https://example.invalid/tracker.png)\n\n<script>window.injected = true</script>";
  const f = setup({ githubDiscussion: vi.fn(async () => hosted) }); await f.ready(); const c = f.ui.container.querySelector('[data-comment="conversation"]')!;
  expect(c.querySelector("strong")?.textContent).toBe("worker"); expect([...c.querySelectorAll("strong")].some((e) => e.textContent === "굵은 의견")).toBe(true); expect(c.querySelector("code")?.textContent).toContain("const x = 1"); expect(c.querySelector("script")).toBeNull(); expect(c.querySelector("img")).toBeNull(); expect(c.textContent).toContain("외부 이미지");
});
it("keeps unsaved text after CAS conflict and does not prepare a public write", async () => {
  const f = setup({ githubDiscussionDraftSave: vi.fn(async () => { throw new Error("다른 창의 초안 변경"); }) }); await f.ready();
  fireEvent.change(f.ui.getByLabelText("리뷰 본문"), { target: { value: "내가 입력한 한글" } }); await waitFor(() => expect(f.ui.getByRole("alert").textContent).toContain("다른 창")); fireEvent.click(f.ui.getByRole("button", { name: "PR 댓글 내용 확인" }));
  await waitFor(() => expect(f.ui.getByRole("alert").textContent).toContain("초안 저장 오류")); expect((f.ui.getByLabelText("리뷰 본문") as HTMLTextAreaElement).value).toBe("내가 입력한 한글"); expect(f.api.githubActionPreview).not.toHaveBeenCalled();
});
it("keeps the last discussion and draft but disables mutations after a refresh failure", async () => {
  const load = vi.fn().mockResolvedValueOnce(structuredClone(data)).mockRejectedValue(new Error("조회 실패")), f = setup({ githubDiscussion: load }); await f.ready();
  fireEvent.change(f.ui.getByLabelText("리뷰 본문"), { target: { value: "보존할 초안" } }); await waitFor(() => expect(f.ui.getByText("초안 저장됨")).toBeTruthy()); fireEvent.click(f.ui.getByRole("button", { name: "리뷰 대화 새로고침" }));
  await waitFor(() => expect(f.ui.getByRole("alert").textContent).toContain("조회 실패")); expect((f.ui.getByLabelText("리뷰 본문") as HTMLTextAreaElement).value).toBe("보존할 초안"); expect((f.ui.getByRole("button", { name: "PR 댓글 내용 확인" }) as HTMLButtonElement).disabled).toBe(true); expect(f.ui.getByText("본문 없는 리뷰")).toBeTruthy();
});
it("previews a child reply with exact body and reuses the request after HTTP response loss", async () => {
  const start = vi.fn(async () => { throw new Error("lost response"); }), f = setup({ githubActionStart: start }); await f.ready();
  fireEvent.click(f.ui.container.querySelector('[data-comment="child"] .scm-gh-reply')!); fireEvent.change(f.ui.getByLabelText("리뷰 본문"), { target: { value: "답글입니다.\n$(literal)" } }); fireEvent.click(f.ui.getByRole("button", { name: "스레드 답글 내용 확인" }));
  await waitFor(() => expect(f.api.githubActionPreview).toHaveBeenCalledWith("space", "context", expect.objectContaining({ operation: { kind: "reply", target: "child", body: "답글입니다.\n$(literal)" } })));
  expect(start).not.toHaveBeenCalled(); fireEvent.click(f.ui.getByRole("button", { name: "이 내용으로 GitHub에 반영" })); await waitFor(() => expect(f.ui.getByRole("alert").textContent).toContain("lost response")); fireEvent.click(f.ui.getByRole("button", { name: "이 내용으로 GitHub에 반영" })); await waitFor(() => expect(start).toHaveBeenCalledTimes(2)); expect(start.mock.calls[0]).toEqual(start.mock.calls[1]);
});
it("collects a left-side range into a persisted review and previews the chosen review event", async () => {
  const f = setup(); await f.ready(); fireEvent.click(f.ui.getByRole("button", { name: "이전 1행 GitHub 의견" })); fireEvent.click(f.ui.getByRole("button", { name: "이전 2행 GitHub 의견" }), { shiftKey: true });
  fireEvent.change(f.ui.getByLabelText("리뷰 본문"), { target: { value: "이 두 행 확인" } }); fireEvent.click(f.ui.getByRole("button", { name: "리뷰 묶음에 담기" }));
  fireEvent.click(f.ui.getByRole("radio", { name: "변경 요청" })); fireEvent.change(f.ui.getByLabelText("리뷰 본문"), { target: { value: "수정이 필요합니다." } }); fireEvent.click(f.ui.getByRole("button", { name: "리뷰 제출 내용 확인" }));
  await waitFor(() => expect(f.api.githubActionPreview).toHaveBeenCalledWith("space", "context", expect.objectContaining({ operation: { kind: "review", event: "REQUEST_CHANGES", body: "수정이 필요합니다.", comments: [{ selection: { file: "file", side: "LEFT", start: 1, end: 2 }, body: "이 두 행 확인" }] } })));
  expect(vi.mocked(f.api.githubDiscussionDraftSave).mock.calls.map((c) => c[2].version)).toEqual([0, 1, 2, 3, 4, 5]);
});
it("opens failed-check feedback and sends only selected comments/checks to the chosen session", async () => {
  const f = setup({}, { active: true, fixEpoch: 1 }); await f.ready(); await waitFor(() => expect(f.ui.container.querySelector(".scm-gh-feedback-target")).not.toBeNull());
  fireEvent.click(f.ui.container.querySelector('[data-comment="child"] .scm-gh-feedback-comment')!); fireEvent.click(f.ui.container.querySelector(".scm-gh-feedback-target")!); fireEvent.click(f.ui.getByRole("button", { name: "선택한 리뷰·실패 검사 수정 요청" }));
  await waitFor(() => expect(f.api.githubFeedbackSend).toHaveBeenCalledWith("space", expect.objectContaining({ sessionId: "session", comments: ["child"], checks: ["ci"], discussionId: "discussion", revision: "discussion-revision" })));
  expect(f.api.githubActionStart).not.toHaveBeenCalled();
});
