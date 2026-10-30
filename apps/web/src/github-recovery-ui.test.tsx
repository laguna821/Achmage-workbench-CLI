// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitHubActionJob, GitHubRecoveryPreview, GitHubView } from "@workbench/contracts";
import type { Api } from "./api.ts";
import { GitHubRecovery } from "./components/GitHubRecovery.tsx";

afterEach(cleanup);
const view = { id: "view", revision: "revision", stale: false } as GitHubView;
const job: GitHubActionJob = {
  id: "job", requestId: "request", workspaceId: "space", phase: "uncertain", createdAt: 10, updatedAt: 20, detail: "응답 유실",
  effects: [{ id: "effect", label: "댓글 게시", phase: "uncertain", detail: "게시한 댓글을 찾지 못했습니다." }],
  preview: { id: "action-preview", contextId: "context", expiresAt: 100, actor: "worker", repo: "fixture/project", number: 7, headRepo: "worker/project", headBranch: "feature", baseBranch: "main", headOid: "a".repeat(40), action: { kind: "discussion", discussionId: "discussion", revision: "revision", operation: { kind: "comment", body: "원래 의견\n$(literal)" } }, effects: ["댓글 게시"], evidence: [], notices: [] },
};
const preview: GitHubRecoveryPreview = { id: "recovery-preview", expiresAt: Date.now() + 60000, job: { ...job, updatedAt: 25 }, actor: "worker", repo: "fixture/project", number: 7, headOid: job.preview.headOid, baseBranch: "main", notices: ["나중에 원격에 반영될 수 있습니다.", "원래 미확정 결과를 보존합니다."] };
function setup(extra: Partial<Api> = {}, selected = job) {
  const acknowledged = { ...job, updatedAt: 30, recovery: { previewId: preview.id, acknowledgedAt: 30, actor: "worker", headOid: preview.headOid, effects: job.effects } };
  const api = { githubActionContext: vi.fn(async () => ({ id: "fresh-context" })), githubRecoveryPreview: vi.fn(async () => preview), githubRecoveryAcknowledge: vi.fn(async () => acknowledged), githubActionStart: vi.fn(), ...extra } as unknown as Api, updated = vi.fn();
  const props = { api, workspaceId: "space", view, job: selected, disabled: false, updated }, ui = render(<GitHubRecovery {...props} />);
  return { api, updated, props, ui, acknowledged };
}
it("shows the immutable original body and requires a separate acknowledgement before allowing other work", async () => {
  const f = setup(); fireEvent.click(f.ui.getByRole("button", { name: "미확정 기록 검토" }));
  await waitFor(() => expect(f.ui.getByRole("region", { name: "미확정 요청 확인" }).textContent).toContain("$(literal)"));
  expect(f.api.githubRecoveryPreview).toHaveBeenCalledWith("space", "job", "fresh-context");
  const button = f.ui.getByRole("button", { name: "미확정으로 보관하고 다른 작업 허용" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true); expect(f.api.githubRecoveryAcknowledge).not.toHaveBeenCalled();
  fireEvent.click(f.ui.getByRole("checkbox")); fireEvent.click(button);
  await waitFor(() => expect(f.updated).toHaveBeenCalledWith(f.acknowledged)); expect(f.api.githubActionStart).not.toHaveBeenCalled();
});
it("reuses the recovery preview after a lost local HTTP response without resending a GitHub action", async () => {
  const acknowledge = vi.fn().mockRejectedValueOnce(new Error("응답 유실")).mockResolvedValue({ ...job, recovery: { previewId: preview.id } }), f = setup({ githubRecoveryAcknowledge: acknowledge });
  fireEvent.click(f.ui.getByRole("button", { name: "미확정 기록 검토" })); await waitFor(() => expect(f.ui.getByRole("checkbox")).toBeTruthy());
  fireEvent.click(f.ui.getByRole("checkbox")); fireEvent.click(f.ui.getByRole("button", { name: "미확정으로 보관하고 다른 작업 허용" }));
  await waitFor(() => expect(f.ui.getByRole("alert").textContent).toContain("응답 유실")); fireEvent.click(f.ui.getByRole("button", { name: "미확정으로 보관하고 다른 작업 허용" }));
  await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2)); expect(acknowledge.mock.calls[0]).toEqual(acknowledge.mock.calls[1]); expect(f.api.githubActionStart).not.toHaveBeenCalled();
});
it("discards a preview when the journal changes and hides recovery for active or acknowledged requests", async () => {
  const f = setup(); fireEvent.click(f.ui.getByRole("button", { name: "미확정 기록 검토" })); await waitFor(() => expect(f.ui.getByRole("checkbox")).toBeTruthy());
  fireEvent.click(f.ui.getByRole("checkbox")); f.ui.rerender(<GitHubRecovery {...f.props} job={preview.job} />); expect((f.ui.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  f.ui.rerender(<GitHubRecovery {...f.props} job={{ ...job, updatedAt: 40 }} />); expect(f.ui.queryByRole("checkbox")).toBeNull();
  f.ui.rerender(<GitHubRecovery {...f.props} job={{ ...job, phase: "pending", effects: [...job.effects, { id: "pending", label: "병합", phase: "pending", detail: "원격 처리 중" }] }} />); expect(f.ui.queryByRole("button")).toBeNull();
  f.ui.rerender(<GitHubRecovery {...f.props} job={f.acknowledged} />); expect(f.ui.queryByRole("button")).toBeNull(); expect(f.ui.container.textContent).toContain("미확정 당시 기록을 보존");
});
