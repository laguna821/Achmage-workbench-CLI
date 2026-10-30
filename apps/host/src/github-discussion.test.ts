import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubDiscussionOperation, ScmReviewTarget, SendResult } from "@workbench/contracts";
import { GitHubActions } from "./github-actions.ts";
import { GitHubReviews } from "./github.ts";
import { GitHubFeedback } from "./github-feedback.ts";
import { GhReader, GitHubWriteError, type GitHubWrite } from "./github-reader.ts";
import { Store } from "./store.ts";
import { SessionManager } from "./sessions.ts";
import { EventBus } from "./bus.ts";
import { githubDiscussionFixture, githubDiscussionRead, githubDiscussionWrite } from "../../../scripts/fixtures/github-discussion.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-gh-discussion-")); git(dir, "init", "-qb", "feature"); git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "test@example.invalid"); git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "code.txt"), "local\n"); git(dir, "add", "code.txt"); git(dir, "commit", "-qm", "initial"); git(dir, "remote", "add", "origin", "git@github.com:worker/project.git");
  const store = new Store(join(dir, "state.sqlite")), manager = new SessionManager(store, new EventBus(), { hostId: "local", hostLabel: "here", dataDir: join(dir, "data"), managedWorksDir: join(dir, "works") });
  const id = manager.createWork({ title: "discussion fixture", cwd: dir }).defaultWorkspaceId!, data = githubDiscussionFixture(git(dir, "rev-parse", "HEAD"));
  let intercept: ((r: GitHubWrite) => Promise<{ status: number; value: unknown }>) | null = null;
  const reader = { json: async (endpoint: string, body?: object) => structuredClone(githubDiscussionRead(endpoint, data, body)), log: async () => "", close: async () => {}, write: async (request: GitHubWrite) => intercept ? intercept(request) : structuredClone(githubDiscussionWrite(request, data)) };
  const reviews = new GitHubReviews(manager.sourceControl, reader), active = (workspaceId: string) => { const s = manager.workspaces.get(workspaceId); manager.workspaces.requireActive(workspaceId, s.workId); };
  let actions = new GitHubActions(store, reviews, active, reader), count = 0;
  const load = async () => { const binding = await reviews.binding(id), view = await reviews.load(id, { binding: binding.revision, head: binding.defaultHead!, base: binding.defaultBase!, number: 7, fresh: true }); const discussion = await actions.discussions.load(id, view.id, view.revision); const context = await actions.inspect(id, view.id, view.revision); return { view, discussion, context }; };
  const prepare = async (op: GitHubDiscussionOperation, loaded?: Awaited<ReturnType<typeof load>>) => { const s = loaded ?? await load(); return actions.prepare(id, s.context.id, { kind: "discussion", discussionId: s.discussion.id, revision: s.discussion.revision, operation: op }); };
  const run = async (op: GitHubDiscussionOperation, loaded?: Awaited<ReturnType<typeof load>>) => { const p = await prepare(op, loaded), j = actions.start(id, p.id, `discussion-request-${++count}`); await actions.drain(); return actions.get(id, j.id); };
  cleanup.push(async () => { actions.stop(); await actions.drain(); await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, id, store, manager, data, reviews, reader, load, prepare, run, get actions() { return actions; }, intercept: (v: typeof intercept) => { intercept = v; }, restart: async () => { actions.stop(); await actions.drain(); actions = new GitHubActions(store, reviews, active, reader); } };
}
it("reads nested pagination, preserves empty approvals and scopes stable IDs to the PR", async () => {
  const f = fixture(); f.data.discussion.pageSize = 1; const { discussion: d } = await f.load();
  expect(d.complete).toBe(true); expect(d.comments).toHaveLength(6); expect(d.threads[0]?.comments).toHaveLength(2);
  expect(d.comments.find((c) => c.state === "APPROVED")).toMatchObject({ body: "", kind: "review" }); expect(d.comments.every((c) => !/^[ICR]\d+$/.test(c.id))).toBe(true);
  const next = await f.load(); expect(next.discussion.comments.map((c) => c.id)).toEqual(d.comments.map((c) => c.id));
});
it("labels bounded or malformed sources incomplete and refuses to mutate an incomplete discussion", async () => {
  const f = fixture(); f.data.discussion.pageSize = 1; f.data.discussion.reviews.push({ ...f.data.discussion.reviews[0], id: "R4" }); const s = await f.load();
  expect(s.discussion.complete).toBe(false); await expect(f.prepare({ kind: "comment", body: "must not send" }, s)).rejects.toThrow("일부만");
  f.data.discussion.pageSize = 100; f.data.discussion.malformed = "reviewThreads"; const next = await f.load(); expect(next.discussion.notices.join()).toContain("온전히"); expect(f.data.action.requests).toEqual([]);
});
it("posts an exact conversation body, deduplicates requests and recovers a lost response without replay", async () => {
  const f = fixture(), p = await f.prepare({ kind: "comment", body: "한글\n$(literal) @file" });
  f.intercept(async (r) => { githubDiscussionWrite(r, f.data); throw new GitHubWriteError("response lost", false); });
  const job = f.actions.start(f.id, p.id, "same-comment-request"); expect(f.actions.start(f.id, p.id, "same-comment-request").id).toBe(job.id); expect(f.actions.start(f.id, p.id, "other-comment-request").id).toBe(job.id);
  await f.actions.drain(); expect((await f.actions.get(f.id, job.id)).phase).toBe("uncertain"); await f.restart();
  const recovered = await f.actions.get(f.id, job.id, true); expect(recovered.phase).toBe("complete"); expect(f.data.action.requests).toHaveLength(1); expect(f.data.discussion.comments.at(-1)?.body).toBe("한글\n$(literal) @file"); expect(recovered.detail).toContain("다른 게시일 가능성");
});
it("binds successful acknowledgements and replies from a child to the real thread root", async () => {
  const f = fixture(), s = await f.load(), child = s.discussion.comments.find((c) => c.body.includes("이 답글"))!;
  const index = readFileSync(join(f.dir, ".git/index")), job = await f.run({ kind: "reply", target: child.id, body: "답변입니다." }, s);
  expect(job.phase).toBe("complete"); expect(f.data.action.requests[0]!.endpoint).toBe("repos/fixture/project/pulls/7/comments/501/replies"); expect(job.detail).not.toContain("다른 게시일 가능성"); expect(readFileSync(join(f.dir, ".git/index"))).toEqual(index); expect(readFileSync(join(f.dir, "code.txt"), "utf8")).toBe("local\n");
});
it("rejects changed comments, cross-PR IDs, changed actors and lost permissions before transmission", async () => {
  const f = fixture(), s = await f.load(), own = s.discussion.comments.find((c) => c.kind === "conversation")!;
  await expect(f.prepare({ kind: "edit-comment", target: "arbitrary-node", body: "x" }, s)).rejects.toThrow("댓글이 없습니다");
  const p = await f.prepare({ kind: "edit-comment", target: own.id, body: "x" }, s); f.data.discussion.comments[0]!.body = "changed externally";
  const j = f.actions.start(f.id, p.id, "changed-comment-request"); await f.actions.drain(); expect((await f.actions.get(f.id, j.id)).phase).toBe("changed");
  const current = await f.load(), p2 = await f.prepare({ kind: "comment", body: "x" }, current); f.data.action.actorId = "another-actor"; const j2 = f.actions.start(f.id, p2.id, "changed-actor-request"); await f.actions.drain(); expect((await f.actions.get(f.id, j2.id)).phase).toBe("changed");
  f.data.action.actorId = "U1"; f.data.discussion.comments[0]!.viewerCanUpdate = false; const newer = await f.load(); await expect(f.prepare({ kind: "edit-comment", target: own.id, body: "x" }, newer)).rejects.toThrow("권한"); expect(f.data.action.requests).toEqual([]);
});
it("supports body edits, deletion, all reaction types and resolving/reopening threads", async () => {
  const f = fixture(); let s = await f.load(); const own = s.discussion.comments.find((c) => c.kind === "conversation")!;
  expect((await f.run({ kind: "edit-comment", target: own.id, body: "수정한 댓글" }, s)).phase).toBe("complete");
  for (const content of ["THUMBS_UP", "THUMBS_DOWN", "LAUGH", "CONFUSED", "HEART", "HOORAY", "ROCKET", "EYES"] as const) expect((await f.run({ kind: "reaction", target: own.id, content, add: true })).phase).toBe("complete");
  expect((await f.run({ kind: "reaction", target: own.id, content: "HEART", add: false })).phase).toBe("complete");
  s = await f.load(); expect((await f.run({ kind: "resolve", target: s.discussion.threads[0]!.id, resolved: true }, s)).phase).toBe("complete");
  expect((await f.run({ kind: "resolve", target: s.discussion.threads[0]!.id, resolved: false })).phase).toBe("complete");
  expect((await f.run({ kind: "delete-comment", target: own.id })).phase).toBe("complete"); expect(f.data.discussion.comments).toEqual([]);
});
it("allows non-author reviewers to comment without PR edit permission", async () => {
  const f = fixture(); f.data.action.permission = "READ";
  expect((await f.run({ kind: "comment", body: "참여자의 의견" })).phase).toBe("complete");
  const s = await f.load(); await expect(f.prepare({ kind: "request-review", reviewers: ["teammate"] }, s)).rejects.toThrow("권한");
});
it("rejects self-approval and self-requested changes while allowing an author's comment review", async () => {
  const f = fixture(); f.data.pull.user.login = "worker";
  for (const event of ["APPROVE", "REQUEST_CHANGES"] as const) await expect(f.prepare({ kind: "review", event, body: "own review", comments: [] })).rejects.toThrow("본인의 PR");
  expect(f.data.action.requests).toEqual([]); expect((await f.run({ kind: "review", event: "COMMENT", body: "작성자의 검토 의견", comments: [] })).phase).toBe("complete");
});
it("derives exact left/right ranges and file comments from pinned server patches", async () => {
  const f = fixture(); let s = await f.load(); const file = s.discussion.files.find((f) => f.path === "한글.txt")!;
  const selection = { file: file.id, side: "LEFT" as const, start: 1, end: 2 }; const j = await f.run({ kind: "inline", selection, body: "이전 두 행 검토" }, s); expect(j.phase).toBe("complete");
  expect(f.data.action.requests[0]!.body).toMatchObject({ commit_id: s.discussion.headOid, path: "한글.txt", side: "LEFT", line: 2, start_line: 1, start_side: "LEFT" });
  s = await f.load(); await expect(f.prepare({ kind: "inline", selection: { ...selection, end: 30 }, body: "invalid" }, s)).rejects.toThrow("연속된 행");
  expect((await f.run({ kind: "inline", selection: { file: file.id, side: "FILE" }, body: "파일 전체" })).phase).toBe("complete");
});
it("submits a batched review pinned to the commit and retains empty-body approval state", async () => {
  const f = fixture(), s = await f.load(), file = s.discussion.files.find((f) => f.path === "한글.txt")!;
  expect((await f.run({ kind: "review", event: "REQUEST_CHANGES", body: "수정 후 다시 검토하겠습니다.", comments: [{ selection: { file: file.id, side: "RIGHT", start: 1, end: 2 }, body: "경계값 추가" }] }, s)).phase).toBe("complete");
  expect(f.data.action.requests[0]!.body.variables.input).toMatchObject({ commitOID: s.discussion.headOid, event: "REQUEST_CHANGES", threads: [{ path: "한글.txt", line: 2, side: "RIGHT", startLine: 1, startSide: "RIGHT", body: "경계값 추가" }] });
  expect((await f.run({ kind: "review", event: "APPROVE", body: "", comments: [] })).phase).toBe("complete");
});
it("does not consume an existing pending review and previews all its comments before explicit submission", async () => {
  const f = fixture(); f.data.discussion.reviews[1]!.state = "PENDING"; f.data.discussion.threads[0]!.comments[1].pullRequestReview.state = "PENDING";
  const s = await f.load(), pending = s.discussion.comments.find((c) => c.kind === "review" && c.state === "PENDING")!;
  await expect(f.prepare({ kind: "review", event: "APPROVE", body: "", comments: [] }, s)).rejects.toThrow("작성 중인 리뷰");
  const p = await f.prepare({ kind: "submit-pending", target: pending.id, event: "APPROVE", body: "확인했습니다." }, s); expect(p.evidence!.join()).toContain("이 답글에서도");
  const j = f.actions.start(f.id, p.id, "submit-existing-pending"); await f.actions.drain(); expect((await f.actions.get(f.id, j.id)).phase).toBe("complete");
});
it("explicitly discards own pending reviews and removes their unpublished comments", async () => {
  const f = fixture(); f.data.discussion.reviews[1]!.state = "PENDING"; const s = await f.load(), pending = s.discussion.comments.find((c) => c.kind === "review" && c.state === "PENDING")!;
  expect((await f.run({ kind: "discard-pending", target: pending.id }, s)).phase).toBe("complete"); expect(f.data.discussion.threads[0]!.comments).toHaveLength(1);
});
it("resolves user/team identities and preserves other requests when removing one reviewer", async () => {
  const f = fixture(); expect((await f.run({ kind: "request-review", reviewers: ["teammate", "fixture/core"] })).phase).toBe("complete");
  const s = await f.load(), user = s.discussion.reviewers.find((r) => r.name === "reviewer")!; expect((await f.run({ kind: "remove-reviewer", target: user.id }, s)).phase).toBe("complete");
  expect((await f.load()).discussion.reviewers.map((r) => r.name).sort()).toEqual(["fixture/core", "teammate"]);
  expect(f.data.action.requests.at(-1)).toMatchObject({ method: "DELETE", endpoint: "repos/fixture/project/pulls/7/requested_reviewers", body: { reviewers: ["reviewer"], team_reviewers: [] } });
});
it("removing one user preserves a concurrent additional reviewer", async () => {
  const f = fixture(), s = await f.load();
  f.intercept(async (request) => { f.data.discussion.requests.push({ requestedReviewer: { __typename: "User", id: "U3", login: "teammate" } }); return githubDiscussionWrite(request, f.data); });
  expect((await f.run({ kind: "remove-reviewer", target: s.discussion.reviewers[0]!.id }, s)).phase).toBe("complete"); expect(f.data.discussion.requests.map((r) => r.requestedReviewer.login)).toEqual(["teammate"]);
});
it("persists drafts with CAS and does not rewrite old commit anchors on restart", async () => {
  const f = fixture(), s = await f.load(), d = f.actions.discussions.draft(f.id, s.discussion.id), file = s.discussion.files[0]!;
  const next = f.actions.discussions.saveDraft(f.id, s.discussion.id, { ...d, mode: "review", body: "미완성 입력", comments: [{ selection: { file: file.id, side: "RIGHT", start: 1, end: 1 }, body: "행 의견" }] });
  expect(() => f.actions.discussions.saveDraft(f.id, s.discussion.id, d)).toThrow("다른 창"); await f.restart(); const current = await f.load(); expect(f.actions.discussions.draft(f.id, current.discussion.id)).toEqual(next); expect(f.data.action.requests).toEqual([]);
});
it("retains unknown acknowledgements and marks a post-write head change separately", async () => {
  const f = fixture(); f.intercept(async () => ({ status: 200, value: {} })); expect((await f.run({ kind: "comment", body: "unknown" })).phase).toBe("uncertain");
  const other = fixture(); other.intercept(async (r) => { const value = githubDiscussionWrite(r, other.data); other.data.pull.head.sha = "f".repeat(40); return value; }); expect((await other.run({ kind: "comment", body: "head race" })).phase).toBe("changed");
});
it("delivers immutable selected review/failed-check evidence to the same-workspace queue exactly once", async () => {
  const f = fixture(), s = await f.load(), target: ScmReviewTarget = { id: "same-space-session", provider: "codex", purpose: "fix", status: "running" };
  const evidence = { receipt: false, queued: null as string | null, sent: null as string | null, failure: null as string | null };
  const send = vi.fn(async (_id: string, _requestId: string, text: string): Promise<SendResult> => { evidence.receipt = true; evidence.queued = text; return { duplicate: false, delivery: "queued" as const }; });
  const hooks = { targets: (id: string) => id === f.id ? [target] : [], send, evidence: () => evidence }, service = new GitHubFeedback(f.store, f.reviews, f.actions.discussions, hooks);
  const request = { requestId: "hosted-feedback-request", sessionId: target.id, discussionId: s.discussion.id, revision: s.discussion.revision, comments: [s.discussion.comments.find((c) => c.body.includes("경계값"))!.id], checks: [s.view.checks.find((c) => c.conclusion === "failure")!.id] };
  const [a, b] = await Promise.all([service.send(f.id, request), service.send(f.id, request)]); expect(a.id).toBe(b.id); expect(a.phase).toBe("queued"); expect(send).toHaveBeenCalledTimes(1); expect(a.text).toContain("경계값"); expect(a.text).toContain(s.view.pull!.headOid); expect(a.text).toContain("failedChecks");
  evidence.sent = evidence.queued; evidence.queued = null; expect(service.list(f.id).batches[0]?.phase).toBe("accepted");
  const recovered = new GitHubFeedback(f.store, f.reviews, f.actions.discussions, hooks); expect((await recovered.send(f.id, request)).id).toBe(a.id); expect(send).toHaveBeenCalledTimes(1);
  await expect(recovered.send(f.id, { ...request, requestId: "wrong-session-request", sessionId: "other-space-session" })).rejects.toThrow("같은 작업공간"); expect(f.data.action.requests).toEqual([]); expect(f.data.discussion.threads[0]!.isResolved).toBe(false);
});
it("detects changed queue text and does not claim a provider failure was accepted", async () => {
  const f = fixture(), s = await f.load(), target: ScmReviewTarget = { id: "target", provider: "codex", purpose: "fix", status: "idle" };
  const evidence = { receipt: true, queued: null as string | null, sent: null as string | null, failure: "provider failed" as string | null }, hooks = { targets: () => [target], send: async (_id: string, _requestId: string, text: string): Promise<SendResult> => { evidence.sent = text; return { duplicate: false, delivery: "turn" as const }; }, evidence: () => evidence };
  const service = new GitHubFeedback(f.store, f.reviews, f.actions.discussions, hooks), request = { requestId: "failed-provider-request", sessionId: target.id, discussionId: s.discussion.id, revision: s.discussion.revision, comments: [s.discussion.comments[0]!.id], checks: [] };
  expect((await service.send(f.id, request)).phase).toBe("failed"); evidence.failure = null; evidence.queued = "edited queue";
  expect((await service.send(f.id, { ...request, requestId: "edited-queue-request" })).phase).toBe("changed");
});
it("allows only scoped REST inline/reply routes through gh and sends exact JSON over stdin", async () => {
  const runner = vi.fn(async () => ({ code: 0, stdout: 'HTTP/2.0 201 OK\r\n\r\n{"node_id":"C1"}', stderr: "" })), reader = new GhReader(runner);
  await reader.write({ method: "POST", endpoint: "repos/fixture/project/pulls/7/comments/501/replies", body: { body: "literal $(not a shell)\n한글" } });
  expect(runner.mock.calls[0]).toEqual(expect.arrayContaining([expect.arrayContaining(["--hostname", "github.com", "--input", "-"]), JSON.stringify({ body: "literal $(not a shell)\n한글" }), expect.any(AbortSignal)]));
  await expect(reader.write({ method: "DELETE", endpoint: "repos/fixture/project/pulls/7/comments" })).rejects.toThrow("허용되지"); await reader.close();
});
