// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitHubActionContext, GitHubActionJob, GitHubActionPreview, GitHubDraft, GitHubView } from "@workbench/contracts";
import type { Api } from "./api.ts";
import { GitHubActions } from "./components/GitHubActions.tsx";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const context: GitHubActionContext = { id: "ctx", workspaceId: "space", viewId: "view", viewRevision: "revision", actor: "worker", repo: "fixture/project", headRepo: "worker/project", headBranch: "feature", headOid: "a".repeat(40), baseBranch: "main", number: null, canUpdate: true, canMerge: true, methods: ["squash", "merge"], defaultMethod: "squash", autoAllowed: true, autoEnabled: false, queueRequired: false, queued: false, stack: null, state: "new", draft: false, title: "", body: "", notices: [] };
const draft: GitHubDraft = { version: 0, title: "저장된 제목", body: "저장된 설명", baseBranch: "main", draft: true, maintainerCanModify: false };
const view = { id: "view", revision: "revision", pull: null, candidates: [], checks: [], stale: false } as unknown as GitHubView;
function setup(extra: Partial<Api> = {}, ctx = context, selectedView = view) {
  const preview: GitHubActionPreview = { id: "preview", contextId: "ctx", expiresAt: Date.now() + 60000, action: { kind: "create", ...draft }, actor: "worker", repo: "fixture/project", number: null, headRepo: "worker/project", headBranch: "feature", headOid: "a".repeat(40), baseBranch: "main", effects: ["PR 만들기"], notices: [] };
  const api = { githubActionContext: vi.fn(async () => ctx), githubDraft: vi.fn(async () => draft), githubDraftSave: vi.fn(async (_w, _c, value) => ({ ...value, version: value.version + 1 })), githubActionJobs: vi.fn(async () => []), githubActionPreview: vi.fn(async (_w, _c, action) => ({ ...preview, action })), githubActionStart: vi.fn(async () => ({ id: "job", preview, createdAt: Date.now(), phase: "uncertain", effects: [{ id: "effect", label: "PR 만들기", detail: "결과 확인 필요", phase: "uncertain" }] } as GitHubActionJob)), ...extra } as unknown as Api;
  const ui = render(<GitHubActions api={api} workspaceId="space" view={selectedView} disabled={false} refresh={() => {}} />);
  const open = async () => { fireEvent.click(ui.getByRole("button", { name: "PR 작성" })); await waitFor(() => expect(ui.container.querySelector(".scm-gh-title")).not.toBeNull()); };
  return { api, ui, open };
}
it("preserves typed content after a draft conflict without sending a public mutation", async () => {
  const f = setup({ githubDraftSave: vi.fn(async () => { throw new Error("다른 창에서 초안 변경"); }) }); await f.open();
  fireEvent.change(f.ui.container.querySelector(".scm-gh-body")!, { target: { value: "내 창의 입력" } });
  await waitFor(() => expect(f.ui.getByRole("alert").textContent).toContain("다른 창")); expect((f.ui.container.querySelector(".scm-gh-body") as HTMLTextAreaElement).value).toBe("내 창의 입력"); expect(f.api.githubActionStart).not.toHaveBeenCalled();
});
it("shows an immutable target/body preview and reuses the same request ID after a lost HTTP response", async () => {
  const start = vi.fn(async () => { throw new Error("response lost"); }); const f = setup({ githubActionStart: start }); await f.open();
  fireEvent.click(f.ui.getByRole("button", { name: "실행 내용 확인" })); await waitFor(() => expect(f.ui.container.querySelector(".scm-gh-action-preview")?.textContent).toContain("저장된 설명")); expect(start).not.toHaveBeenCalled();
  fireEvent.click(f.ui.getByRole("button", { name: "이 내용으로 실행" })); await waitFor(() => expect(f.ui.getByRole("alert").textContent).toContain("response lost"));
  fireEvent.click(f.ui.getByRole("button", { name: "이 내용으로 실행" })); await waitFor(() => expect(start).toHaveBeenCalledTimes(2)); expect(start.mock.calls[0]).toEqual(start.mock.calls[1]);
});
it("serializes quick edits with the returned draft version before preparing a mutation", async () => {
  const f = setup(); await f.open(); const body = f.ui.container.querySelector(".scm-gh-body")!;
  fireEvent.change(body, { target: { value: "first" } }); fireEvent.change(body, { target: { value: "last" } }); fireEvent.click(f.ui.getByRole("button", { name: "실행 내용 확인" }));
  await waitFor(() => expect(f.api.githubActionPreview).toHaveBeenCalledTimes(1)); const calls = vi.mocked(f.api.githubDraftSave).mock.calls;
  expect(calls.map((call) => call[2].version)).toEqual([0, 1]); expect(vi.mocked(f.api.githubActionPreview).mock.calls[0]![2]).toMatchObject({ body: "last" });
});
it("shows queue completion as admission, without selecting a merge method or claiming merged", async () => {
  const ctx = { ...context, number: 7, state: "open", queueRequired: true };
  const f = setup({}, ctx); fireEvent.click(f.ui.getByRole("button", { name: "PR 작성" }));
  await waitFor(() => expect(f.ui.container.querySelector(".scm-gh-merge-preview")).not.toBeNull()); expect(f.ui.container.querySelector('[name="github-merge-method"]')).toBeNull();
  fireEvent.click(f.ui.getByRole("button", { name: "병합 대기열 등록 확인" })); await waitFor(() => expect(f.api.githubActionPreview).toHaveBeenCalledWith("space", "ctx", { kind: "enqueue" }));
});
it("opens a single auto-discovered PR despite the retained candidate entry", async () => {
  const f = setup({}, { ...context, number: 7, state: "open" }, { ...view, pull: { number: 7 } as GitHubView["pull"], candidates: [{ number: 7, title: "PR", headOid: context.headOid }] });
  const button = f.ui.getByRole("button", { name: "PR 작업 열기" }) as HTMLButtonElement; expect(button.disabled).toBe(false); fireEvent.click(button);
  await waitFor(() => expect(f.ui.container.querySelector(".scm-gh-actor")).not.toBeNull());
});
