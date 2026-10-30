// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ScmDiff, ScmReviewList, ScmReviewNote, Workspace } from "@workbench/contracts";
import { ApiRequestError, type Api } from "./api.ts";
import { ScmReviewsProvider } from "./components/ScmReviewNotes.tsx";
import { ScmDiffText } from "./components/ScmDiffText.tsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const workspace = { id: "space", workId: "work", cwd: "/fixture" } as Workspace;
const diff: ScmDiff = { path: "note.txt", area: "working", revision: "diff", patch: "@@ -1 +1 @@\n-old\n+new\n", binary: false, truncated: false, review: { id: "snap", expiresAt: Date.now() + 60_000, lines: true } };
const note: ScmReviewNote = { id: "note", workspaceId: "space", version: 1, body: "original", resolved: false, deleted: false, createdAt: 1, updatedAt: 1, anchor: { repositoryId: "repository", path: "note.txt", source: { kind: "local", area: "working", head: null, statusRevision: "status" }, diffRevision: "diff", selection: { side: "after", start: 1, end: 1 }, quote: ["new"], prefix: [], suffix: [], contentHash: "hash" } };
const empty = (): ScmReviewList => ({ notes: [], placements: {}, batches: [], targets: [] });
function view(api: Partial<Api>) {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  return render(<ScmReviewsProvider api={api as Api} workspace={workspace}><ScmDiffText diff={diff} /></ScmReviewsProvider>);
}
it("retains the draft after a lost response and retries exactly the same create request", async () => {
  let data = empty();
  const createScmReview = vi.fn().mockRejectedValueOnce(new TypeError("lost response")).mockImplementationOnce(async (_id, value) => { data = { ...data, notes: [{ ...note, body: value.body }] }; return data.notes[0]; });
  const ui = view({ scmReviews: vi.fn(async () => data), createScmReview });
  fireEvent.click(ui.getByRole("button", { name: "이후 1행 의견 추가" }));
  fireEvent.change(ui.getByRole("textbox", { name: "검토 의견 내용" }), { target: { value: "keep this draft" } });
  fireEvent.keyDown(ui.getByRole("textbox"), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(ui.getByRole("alert").textContent).toContain("lost response"));
  expect((ui.getByRole("textbox") as HTMLTextAreaElement).value).toBe("keep this draft"); expect((ui.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(true);
  fireEvent.click(ui.getByRole("button", { name: "저장 결과 다시 확인" }));
  await waitFor(() => expect(ui.queryByRole("textbox")).toBeNull());
  expect(createScmReview).toHaveBeenCalledTimes(2); expect(createScmReview.mock.calls[0]).toEqual(createScmReview.mock.calls[1]); expect(ui.container.querySelector(".scm-note-markdown")?.textContent).toBe("keep this draft");
});
it("keeps a conflicting edit and requires adoption of the shown newer note version before replacement", async () => {
  let data: ScmReviewList = { ...empty(), notes: [note] };
  const editScmReview = vi.fn().mockImplementationOnce(async () => { data = { ...data, notes: [{ ...note, version: 2, body: "other window" }] }; throw new ApiRequestError(409, { code: "scm_review_changed", message: "다른 창에서 수정됨" }); }).mockImplementationOnce(async (_id, _note, value) => { data = { ...data, notes: [{ ...note, version: 3, body: value.body }] }; return data.notes[0]; });
  const ui = view({ scmReviews: vi.fn(async () => data), editScmReview });
  fireEvent.click(ui.getByRole("button", { name: /검토 의견 ·/ })); await waitFor(() => expect(ui.container.querySelector(".scm-note-edit")).not.toBeNull());
  fireEvent.click(ui.container.querySelector(".scm-note-edit")!); fireEvent.change(ui.getByRole("textbox"), { target: { value: "my edit" } }); fireEvent.click(ui.getByRole("button", { name: "의견 저장" }));
  await waitFor(() => expect(ui.container.querySelector(".scm-note-markdown")?.textContent).toBe("other window")); expect((ui.getByRole("textbox") as HTMLTextAreaElement).value).toBe("my edit");
  fireEvent.click(ui.getByRole("button", { name: /아래 최신 의견을 확인했음/ })); fireEvent.click(ui.getByRole("button", { name: "의견 저장" }));
  await waitFor(() => expect(ui.queryByRole("textbox")).toBeNull()); expect(editScmReview.mock.calls[1]![2]).toEqual({ version: 2, body: "my edit" });
});
