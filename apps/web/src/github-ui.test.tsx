// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitHubBinding, GitHubView } from "@workbench/contracts";
import type { Api } from "./api.ts";
import { GitHubReview } from "./components/GitHubReview.tsx";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const head = { id: "head", repo: "worker/project", remote: "origin", branch: "feature" }, base = { id: "base", repo: "fixture/project", remote: "포크 원본" };
const binding: GitHubBinding = { workspaceId: "space", revision: "binding", branch: "feature", localHead: "local", heads: [head], bases: [base, { id: "fork", repo: "worker/project", remote: "origin" }], defaultHead: head.id, defaultBase: base.id, warnings: [] };
const data: GitHubView = { id: "view", revision: "view-revision", workspaceId: "space", binding: "binding", head, base, localHead: "local", pull: { number: 7, title: "PR fixture", body: "**bold** ![tracking](https://example.invalid/tracker.png)", author: "worker", url: "https://github.com/fixture/project/pull/7", state: "open", draft: true, baseRepo: base.repo, baseBranch: "main", baseOid: "b".repeat(40), headRepo: head.repo, headBranch: "feature", headOid: "a".repeat(40), changedFiles: 1, updatedAt: "2026-10-30" }, candidates: [], files: [{ id: "file", path: "code.txt", oldPath: null, status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new\n", notice: null }], checks: [{ id: "check", name: "Test", status: "completed", conclusion: "failure", url: null, source: "head", oid: "a".repeat(40), repo: base.repo, kind: "check", details: true }], notices: [], checkedAt: 123456, stale: false, error: null };
function view(extra: Partial<Api> = {}) { const api = { githubBinding: vi.fn(async () => binding), githubLoad: vi.fn(async () => data), ...extra } as unknown as Api; return { api, ui: render(<GitHubReview api={api} workspaceId="space" refreshEpoch={0} />) }; }
it("renders pinned remote changes and safely displays Markdown without loading remote images", async () => {
  const { ui } = view(); await waitFor(() => expect(ui.container.querySelector(".scm-gh-pull")?.textContent).toContain("PR fixture"));
  expect(ui.container.textContent).toContain("현재 로컬 커밋(local)과 PR 커밋이 다릅니다"); expect(ui.container.querySelector(".scm-gh-markdown strong")?.textContent).toBe("bold"); expect(ui.container.querySelector("img")).toBeNull();
  expect(ui.container.querySelector(".scm-lines")?.textContent).toContain("+new");
});
it("keeps last-known PR with an explicit stale error after refresh failure", async () => {
  const load = vi.fn().mockResolvedValueOnce(data).mockRejectedValueOnce(new Error("offline")); const { ui } = view({ githubLoad: load });
  await waitFor(() => expect(ui.container.querySelector(".scm-gh-pull")).not.toBeNull()); fireEvent.click(ui.getByRole("button", { name: "PR·CI 새로고침" }));
  await waitFor(() => expect(ui.container.querySelector(".scm-gh-stale")?.textContent).toContain("offline")); expect(ui.container.querySelector(".scm-gh-pull")?.textContent).toContain("PR fixture"); expect(ui.container.querySelector(".scm-gh-empty")).toBeNull();
});
it("discards a delayed check response after repository selection changes", async () => {
  let complete: (value: unknown) => void = () => {};
  const githubCheck = vi.fn(() => new Promise((resolve) => { complete = resolve; })) as unknown as Api["githubCheck"];
  const { ui } = view({ githubCheck }); await waitFor(() => expect(ui.container.querySelector(".scm-gh-pull")).not.toBeNull());
  fireEvent.click(ui.getByRole("button", { name: "검사 1" })); fireEvent.click(ui.getByRole("button", { name: "상세·로그" }));
  fireEvent.click(ui.container.querySelector('.scm-gh-base[value="fork"]')!); complete({ name: "old repo", summary: "must not appear", text: "", jobs: [], notices: [] });
  await waitFor(() => expect(ui.container.querySelector(".scm-gh-pull")).toBeNull()); expect(ui.container.textContent).not.toContain("must not appear");
});
