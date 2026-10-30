import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubActionInput } from "@workbench/contracts";
import { GitHubActions } from "./github-actions.ts";
import { GitHubReviews } from "./github.ts";
import { GhReader, GitHubWriteError, type GitHubWrite } from "./github-reader.ts";
import { Store } from "./store.ts";
import { SessionManager } from "./sessions.ts";
import { EventBus } from "./bus.ts";
import { githubActionsFixture, githubActionsRead, githubActionsWrite } from "../../../scripts/fixtures/github-actions.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-gh-actions-")); git(dir, "init", "-qb", "feature"); git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "test@example.invalid"); git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "code.txt"), "local\n"); git(dir, "add", "code.txt"); git(dir, "commit", "-qm", "initial"); git(dir, "remote", "add", "origin", "git@github.com:worker/project.git");
  const store = new Store(join(dir, "state.sqlite")), manager = new SessionManager(store, new EventBus(), { hostId: "local", hostLabel: "here", dataDir: join(dir, "data"), managedWorksDir: join(dir, "works") });
  const work = manager.createWork({ title: "actions fixture", cwd: dir }), id = work.defaultWorkspaceId!, data = githubActionsFixture(git(dir, "rev-parse", "HEAD"));
  let intercept: ((request: GitHubWrite) => Promise<{ status: number; value: unknown }>) | null = null;
  const reader = { json: async (endpoint: string, body?: object) => structuredClone(githubActionsRead(endpoint, data, body)), log: async () => "", close: async () => {}, write: async (request: GitHubWrite) => intercept ? intercept(request) : structuredClone(githubActionsWrite(request, data)) };
  const reviews = new GitHubReviews(manager.sourceControl, reader), active = (workspaceId: string) => { const space = manager.workspaces.get(workspaceId); manager.workspaces.requireActive(workspaceId, space.workId); };
  let actions = new GitHubActions(store, reviews, active, reader), sequence = 0;
  const view = async (workspaceId = id) => { const binding = await reviews.binding(workspaceId); return reviews.load(workspaceId, { binding: binding.revision, head: binding.defaultHead!, base: binding.defaultBase!, fresh: true, ...(data.empty ? {} : { number: 7 }) }); };
  const context = async (workspaceId = id) => { const v = await view(workspaceId); return actions.inspect(workspaceId, v.id, v.revision); };
  const prepare = async (input: GitHubActionInput, workspaceId = id) => { const ctx = await context(workspaceId); return actions.prepare(workspaceId, ctx.id, input); };
  const run = async (input: GitHubActionInput) => { const preview = await prepare(input), job = actions.start(id, preview.id, `test-request-${++sequence}`); await actions.drain(); return actions.get(id, job.id); };
  cleanup.push(async () => { actions.stop(); await reviews.close(); await actions.drain(); await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, id, store, manager, reviews, data, reader, view, context, prepare, run, get actions() { return actions; }, intercept: (handler: typeof intercept) => { intercept = handler; }, restart: async () => { actions.stop(); await actions.drain(); actions = new GitHubActions(store, reviews, active, reader); } };
}

it("preserves PR drafts with a compare-and-swap version across windows and service restart", async () => {
  const f = fixture(), ctx = await f.context(), first = f.actions.draft(f.id, ctx.id);
  f.actions.saveDraft(f.id, ctx.id, { ...first, title: "한글 제목", body: "내용\n@/literal $(not executed)" });
  expect(() => f.actions.saveDraft(f.id, ctx.id, first)).toThrow("다른 창");
  await f.restart(); const next = await f.context(); expect(f.actions.draft(f.id, next.id)).toMatchObject({ version: 1, title: "한글 제목", body: "내용\n@/literal $(not executed)" }); expect(f.data.action.requests).toEqual([]);
});
it("allows the automatically resolved single PR while retaining discovery candidates", async () => {
  const f = fixture(), binding = await f.reviews.binding(f.id), view = await f.reviews.load(f.id, { binding: binding.revision, head: binding.defaultHead!, base: binding.defaultBase!, fresh: true });
  expect(view.candidates).toHaveLength(1); expect(view.pull?.number).toBe(7); expect((await f.actions.inspect(f.id, view.id, view.revision)).number).toBe(7);
});
it("creates from an explicitly published fork head with exact body and no local Git change", async () => {
  const f = fixture(); f.data.empty = true; const index = readFileSync(join(f.dir, ".git/index"));
  const job = await f.run({ kind: "create", title: "새 PR", body: "# 검사\n\nliteral @file $(x)", baseBranch: "main", draft: true, maintainerCanModify: false });
  expect(job.phase).toBe("complete"); expect(job.effects[0]).toMatchObject({ outcome: "created", number: 7 });
  const input = f.data.action.requests[0]!.body.variables.input; expect(input).toMatchObject({ repositoryId: "R10", headRepositoryId: "R11", headRefName: "worker:feature", baseRefName: "main", title: "새 PR", body: "# 검사\n\nliteral @file $(x)", draft: true, maintainerCanModify: false });
  expect(readFileSync(join(f.dir, ".git/index"))).toEqual(index); expect(git(f.dir, "status", "--porcelain", "--", "code.txt")).toBe("");
});
it("blocks unpublished local heads and refuses create if another open PR appears", async () => {
  const f = fixture(); f.data.empty = true; f.data.action.remoteHead = "b".repeat(40); await expect(f.context()).rejects.toMatchObject({ code: "github_head_unpublished" });
  f.data.action.remoteHead = f.data.pull.head.sha; const ctx = await f.context(); f.data.empty = false;
  await expect(f.actions.prepare(f.id, ctx.id, { kind: "create", title: "new", body: "", baseBranch: "main", draft: true, maintainerCanModify: false })).rejects.toThrow("열린 PR"); expect(f.data.action.requests).toEqual([]);
});
it("edits and toggles ready/draft/closed/reopened state against current remote identities", async () => {
  const f = fixture(); expect((await f.run({ kind: "edit", title: "새 제목", body: "새 설명", baseBranch: "release" })).phase).toBe("complete");
  for (const kind of ["ready", "draft", "close", "reopen"] as const) expect((await f.run({ kind })).phase).toBe("complete");
  expect(f.data.pull).toMatchObject({ title: "새 제목", body: "새 설명", draft: true, state: "open", base: { ref: "release" } }); expect(f.data.action.requests).toHaveLength(5);
});
it("refuses stale account and local branch changes before transmitting any mutation", async () => {
  const f = fixture(), preview = await f.prepare({ kind: "ready" }); f.data.action.actorId = "other-account";
  const job = f.actions.start(f.id, preview.id, "changed-account"); await f.actions.drain(); expect((await f.actions.get(f.id, job.id)).phase).toBe("changed"); expect(f.data.action.requests).toEqual([]);
  f.data.action.actorId = "U1"; const next = await f.prepare({ kind: "ready" }); git(f.dir, "switch", "-qc", "another");
  const local = f.actions.start(f.id, next.id, "changed-branch"); await f.actions.drain(); expect((await f.actions.get(f.id, local.id)).phase).toBe("changed"); expect(f.data.action.requests).toEqual([]);
});
it("marks non-CAS post-write races changed instead of claiming the reviewed commit was modified", async () => {
  const f = fixture(); f.intercept(async (request) => { const result = githubActionsWrite(request, f.data); f.data.pull.head.sha = "f".repeat(40); return result; });
  const job = await f.run({ kind: "ready" }); expect(job.phase).toBe("changed"); expect(job.effects[0]?.detail).toContain("전송 후"); expect(f.data.action.requests).toHaveLength(1);
});
it("returns one durable job for duplicate submits and never replays a lost response after restart", async () => {
  const f = fixture(), preview = await f.prepare({ kind: "ready" });
  f.intercept(async (request) => { githubActionsWrite(request, f.data); throw new GitHubWriteError("lost response", false); });
  const first = f.actions.start(f.id, preview.id, "same-request"); expect(f.actions.start(f.id, preview.id, "same-request").id).toBe(first.id);
  expect(f.actions.start(f.id, preview.id, "other-request").id).toBe(first.id); await f.actions.drain(); expect((await f.actions.get(f.id, first.id)).phase).toBe("uncertain");
  await f.restart(); expect(f.actions.start(f.id, preview.id, "same-request").id).toBe(first.id); expect(f.actions.start(f.id, preview.id, "other-request").id).toBe(first.id); expect(f.data.action.requests).toHaveLength(1);
  const recovered = await f.actions.get(f.id, first.id, true); expect(recovered.phase).toBe("complete"); expect(f.data.action.requests).toHaveLength(1);
});
it("keeps malformed acknowledgements uncertain and preserves the request journal", async () => {
  const f = fixture(); f.intercept(async () => ({ status: 200, value: {} })); const job = await f.run({ kind: "ready" });
  expect(job.phase).toBe("uncertain"); await f.restart(); expect(f.actions.list(f.id)[0]?.preview.action.kind).toBe("ready"); expect((await f.actions.get(f.id, job.id, true)).phase).toBe("uncertain");
});
it("deduplicates selected checks by workflow run and excludes accepted run attempts across workspaces", async () => {
  const f = fixture(); const duplicate = structuredClone(f.data.commit.statusCheckRollup.contexts.nodes[0]!); duplicate.databaseId = 102; f.data.commit.statusCheckRollup.contexts.nodes.push(duplicate);
  const preview = await f.prepare({ kind: "rerun", failedOnly: true, checks: [] }); expect(preview.effects).toHaveLength(1);
  // The transport accepts without new run visibility, so the persisted attempt lease is essential.
  f.intercept(async (request) => { f.data.action.requests.push(request); return { status: 201, value: null }; });
  const job = f.actions.start(f.id, preview.id, "rerun-one-request"); await f.actions.drain(); expect((await f.actions.get(f.id, job.id)).phase).toBe("complete");
  const other = f.manager.createWork({ title: "same repository", cwd: f.dir }).defaultWorkspaceId!, cross = await f.prepare({ kind: "rerun", failedOnly: false, checks: [] }, other);
  expect(() => f.actions.start(other, cross.id, "rerun-other-window")).toThrow("같은 검사 회차"); expect(f.data.action.requests).toHaveLength(1);
});
it("retains partial CI outcomes and reconciles only the uncertain effect without rerunning accepted jobs", async () => {
  const f = fixture(); const second = structuredClone(f.data.commit.statusCheckRollup.contexts.nodes[0]!); second.databaseId = 102; second.checkSuite!.workflowRun.databaseId = 202; f.data.commit.statusCheckRollup.contexts.nodes.push(second);
  f.data.action.extraChecks[102] = { id: 102, head_sha: f.data.pull.head.sha, status: "completed", conclusion: "failure" };
  f.data.action.extraRuns[202] = { id: 202, run_attempt: 3, head_sha: f.data.pull.head.sha, repository: f.data.repo, status: "completed", conclusion: "failure" };
  f.intercept(async (request) => { const result = githubActionsWrite(request, f.data); if (request.endpoint.includes("/202/")) throw new GitHubWriteError("connection dropped", false); return result; });
  const job = await f.run({ kind: "rerun", failedOnly: true, checks: [] }); expect(job.phase).toBe("partial"); expect(job.effects.map((item) => item.phase)).toEqual(["complete", "uncertain"]);
  await f.restart(); expect((await f.actions.get(f.id, job.id, true)).phase).toBe("complete"); expect(f.data.action.requests).toHaveLength(2);
});
it("shares a run-attempt lease between head and test-merge check identities", async () => {
  const f = fixture(), mergeCheck = structuredClone(f.data.commit.statusCheckRollup.contexts.nodes[0]!); mergeCheck.databaseId = 103; mergeCheck.checkSuite!.commit.oid = f.data.merge.oid;
  f.data.merge.statusCheckRollup.contexts.nodes.push(mergeCheck as unknown as typeof f.data.merge.statusCheckRollup.contexts.nodes[number]);
  f.data.action.extraChecks[103] = { id: 103, head_sha: f.data.merge.oid, status: "completed", conclusion: "failure" };
  f.intercept(async (request) => { f.data.action.requests.push(request); return { status: 201, value: null }; });
  const view = await f.view(), ctx = await f.actions.inspect(f.id, view.id, view.revision), head = view.checks.find((check) => check.details && check.source === "head")!, merge = view.checks.find((check) => check.details && check.source === "merge")!;
  const first = await f.actions.prepare(f.id, ctx.id, { kind: "rerun", failedOnly: true, checks: [head.id] }); f.actions.start(f.id, first.id, "head-run-request"); await f.actions.drain();
  const second = await f.actions.prepare(f.id, ctx.id, { kind: "rerun", failedOnly: false, checks: [merge.id] });
  expect(() => f.actions.start(f.id, second.id, "merge-run-request")).toThrow("같은 검사 회차"); expect(f.data.action.requests).toHaveLength(1);
});
it("uses expected head for auto merge and distinguishes setting auto merge from actual merge", async () => {
  const f = fixture(); f.data.pull.draft = false;
  const enabled = await f.run({ kind: "auto-enable", method: "squash" }); expect(enabled.effects[0]).toMatchObject({ outcome: "auto-enabled", phase: "complete" }); expect(enabled.detail).toContain("아직 병합 완료가 아닙니다");
  expect(f.data.action.requests[0]!.body.variables.input).toMatchObject({ expectedHeadOid: f.data.pull.head.sha, mergeMethod: "SQUASH" });
  expect((await f.run({ kind: "auto-disable" })).effects[0]?.outcome).toBe("auto-disabled");
});
it("persists async merge UUID and uses read-only polling after restart", async () => {
  const f = fixture(); f.data.pull.draft = false; const job = await f.run({ kind: "merge", method: "squash" }); expect(job.phase).toBe("pending");
  expect(f.data.action.requests[0]).toMatchObject({ method: "PUT", endpoint: "repos/fixture/project/pulls/7/merge-async", body: { sha: f.data.pull.head.sha, merge_method: "squash", merge_action: "direct_merge" } });
  await f.restart(); f.data.action.asyncResult = "merged"; const final = await f.actions.get(f.id, job.id, true); expect(final.phase).toBe("complete"); expect(final.effects[0]?.outcome).toBe("merged"); expect(f.data.action.requests).toHaveLength(1);
});
it("reports queue admission separately and never sends an invented merge method for a queue", async () => {
  const f = fixture(); f.data.pull.draft = false; f.data.action.queueRequired = true;
  await expect(f.prepare({ kind: "merge", method: "squash" })).rejects.toThrow("대기열");
  const job = await f.run({ kind: "enqueue" }); f.data.action.asyncResult = "enqueued"; const done = await f.actions.get(f.id, job.id, true);
  expect(done.effects[0]?.outcome).toBe("enqueued"); expect(done.detail).toContain("아직 병합 완료가 아닙니다"); expect(f.data.action.requests[0]!.body).not.toHaveProperty("merge_method");
});
it("requires complete registered stack metadata and explicitly lists included downstack PRs", async () => {
  const f = fixture(); f.data.pull.draft = false; const layer = (number: number, position: number) => ({ position, pullRequest: { number, title: `layer${number}`, headRefOid: number === 7 ? f.data.pull.head.sha : "d".repeat(40), state: "OPEN", isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: { state: "SUCCESS" } } });
  f.data.action.stack = { number: 3, size: 2, entries: { pageInfo: { hasNextPage: true }, nodes: [layer(6, 0), layer(7, 1)] } };
  await expect(f.prepare({ kind: "merge", method: "squash" })).rejects.toThrow("스택 전체"); f.data.action.stack.entries.pageInfo.hasNextPage = false;
  const preview = await f.prepare({ kind: "merge", method: "squash" }); expect(preview.effects[0]).toContain("#6 dddddddddddd"); expect(preview.effects[0]).toContain("#7");
  await expect(f.prepare({ kind: "auto-enable", method: "squash" })).rejects.toThrow("자동 병합");
});
it("never retries uncertain transport writes and treats rejection vs process loss distinctly", async () => {
  let count = 0, mode = "lost";
  const reader = new GhReader(async (args, input) => { count++; expect(args).toContain("POST"); expect(JSON.parse(input!).variables.input.title).toBe("$(literal)"); if (mode === "lost") throw new Error("connection lost"); return { code: 1, stdout: "HTTP/2.0 403 Forbidden\n\n{\"message\":\"denied\"}", stderr: "" }; }); cleanup.push(() => reader.close());
  const request = { method: "POST" as const, endpoint: "graphql", body: { query: "mutation { test }", variables: { input: { title: "$(literal)" } } } };
  await expect(reader.write(request)).rejects.toMatchObject({ certain: false }); expect(count).toBe(1); mode = "rejected"; await expect(reader.write(request)).rejects.toMatchObject({ certain: true }); expect(count).toBe(2);
  await expect(reader.write({ method: "POST", endpoint: "repos/a/b/issues" })).rejects.toMatchObject({ certain: true }); expect(count).toBe(2);
});
it("reads explicit templates from the pinned commit, excluding symlink blobs and uncommitted text", async () => {
  const f = fixture(); mkdirSync(join(f.dir, ".github/PULL_REQUEST_TEMPLATE"), { recursive: true });
  writeFileSync(join(f.dir, ".github/PULL_REQUEST_TEMPLATE.md"), "# committed template\n"); symlinkSync("../../private.md", join(f.dir, ".github/PULL_REQUEST_TEMPLATE/link.md"));
  git(f.dir, "add", ".github"); git(f.dir, "commit", "-qm", "templates"); const head = git(f.dir, "rev-parse", "HEAD");
  f.data.pull.head.sha = head; f.data.action.remoteHead = head; f.data.commit.oid = head; f.data.commit.statusCheckRollup.contexts.nodes[0]!.checkSuite!.commit.oid = head;
  writeFileSync(join(f.dir, ".github/PULL_REQUEST_TEMPLATE.md"), "not committed\n");
  const view = await f.view(), templates = await f.reviews.templates(f.id, view.id, view.revision);
  expect(templates).toEqual([{ path: ".github/PULL_REQUEST_TEMPLATE.md", body: "# committed template\n", commit: head }]); expect(readFileSync(join(f.dir, ".github/PULL_REQUEST_TEMPLATE.md"), "utf8")).toBe("not committed\n");
});
it("recovers a stopped in-flight write without overwriting its uncertain journal or replaying it", async () => {
  const f = fixture(); let entered: () => void = () => {}, release: () => void = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  f.intercept(async (request) => { entered(); await gate; return githubActionsWrite(request, f.data); });
  const preview = await f.prepare({ kind: "ready" }), job = f.actions.start(f.id, preview.id, "shutdown-in-flight"); await started; f.actions.stop(); release(); await f.actions.drain();
  await f.restart(); expect((await f.actions.get(f.id, job.id)).phase).toBe("uncertain"); expect((await f.actions.get(f.id, job.id, true)).phase).toBe("complete"); expect(f.data.action.requests).toHaveLength(1);
});
it("does not mistake an unrelated pending merge option set for the reviewed request", async () => {
  const f = fixture(); f.data.pull.draft = false;
  f.intercept(async (request) => { githubActionsWrite(request, f.data); return { status: 409, value: { status: "pending", details: { uuid: "another-merge-uuid", expected_head_sha: "c".repeat(40), merge_action: "direct_merge", merge_method: "merge", bypass_rules: true } } }; });
  const job = await f.run({ kind: "merge", method: "squash" }); expect(job.phase).toBe("uncertain"); expect(job.detail).toContain("요청과 다릅니다"); expect(f.data.action.requests).toHaveLength(1);
});

async function unknownReady(f: ReturnType<typeof fixture>) {
  f.intercept(async (request) => { githubActionsWrite(request, f.data); throw new GitHubWriteError("lost response", false); });
  const job = await f.run({ kind: "ready" }); f.data.pull.draft = true; f.intercept(null); return job;
}
it("preserves request aliases and the unknown audit while releasing the PR scope across workspaces", async () => {
  const f = fixture(), job = await unknownReady(f), other = f.manager.createWork({ title: "other window", cwd: f.dir }).defaultWorkspaceId!;
  const close = await f.prepare({ kind: "close" }, other); expect(() => f.actions.start(other, close.id, "other-window-before")).toThrow("이전 요청");
  await expect(f.actions.prepareRecovery(other, job.id, (await f.context(other)).id)).rejects.toMatchObject({ status: 404 });
  const preview = await f.actions.prepareRecovery(f.id, job.id, (await f.context()).id), acknowledged = await f.actions.acknowledgeRecovery(f.id, job.id, preview.id);
  expect(acknowledged.effects).toEqual(preview.job.effects); expect(acknowledged.phase).toBe("uncertain");
  await f.restart(); expect(f.actions.start(f.id, job.preview.id, job.requestId).id).toBe(job.id);
  expect(await f.actions.acknowledgeRecovery(f.id, job.id, preview.id)).toEqual(acknowledged);
  const repeat = await f.prepare({ kind: "ready" }, other);
  expect(() => f.actions.start(other, repeat.id, "other-window-replay")).toThrow("같은 작업");
  const different = await f.prepare({ kind: "close" }, other), next = f.actions.start(other, different.id, "other-window-after"); await f.actions.drain();
  expect((await f.actions.get(other, next.id)).phase).toBe("complete"); expect(f.data.action.requests).toHaveLength(2);
  expect((await f.actions.get(f.id, job.id)).recovery).toEqual(acknowledged.recovery);
});
it.each(["actor", "head", "branch", "journal", "expiry"])("rejects recovery when the reviewed %s changes", async (change) => {
  const f = fixture(), job = await unknownReady(f), p = await f.actions.prepareRecovery(f.id, job.id, (await f.context()).id);
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    if (change === "actor") f.data.action.actorId = "another-account";
    if (change === "head") f.data.pull.head.sha = "f".repeat(40);
    if (change === "branch") git(f.dir, "switch", "-qc", "other-branch");
    if (change === "journal") { f.data.pull.draft = false; expect((await f.actions.get(f.id, job.id, true)).phase).toBe("complete"); }
    if (change === "expiry") clock = vi.spyOn(Date, "now").mockReturnValue(p.expiresAt + 1);
    await expect(f.actions.acknowledgeRecovery(f.id, job.id, p.id)).rejects.toThrow();
    expect((await f.actions.get(f.id, job.id)).recovery).toBeUndefined(); expect(f.data.action.requests).toHaveLength(1);
  } finally { clock?.mockRestore(); }
});
it("refuses running and pending requests and never acknowledges during a concurrent remote check", async () => {
  const f = fixture(), job = await unknownReady(f), p = await f.actions.prepareRecovery(f.id, job.id, (await f.context()).id);
  const original = f.reader.json; let entered: () => void = () => {}, release: () => void = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  f.reader.json = async (endpoint, body) => { entered(); await gate; return original(endpoint, body); };
  const checking = f.actions.get(f.id, job.id, true); await started;
  try { await expect(f.actions.acknowledgeRecovery(f.id, job.id, p.id)).rejects.toMatchObject({ code: "github_recovery_busy" }); }
  finally { release(); await checking; f.reader.json = original; }
  const g = fixture(); g.data.pull.draft = false; const merge = await g.run({ kind: "merge", method: "squash" });
  await expect(g.actions.prepareRecovery(g.id, merge.id, (await g.context()).id)).rejects.toMatchObject({ code: "github_recovery_busy" });
  let sending: () => void = () => {}, finish: () => void = () => {};
  const sent = new Promise<void>((resolve) => { sending = resolve; }), writeGate = new Promise<void>((resolve) => { finish = resolve; });
  const h = fixture(), ctx = await h.context(), ready = await h.actions.prepare(h.id, ctx.id, { kind: "ready" });
  h.intercept(async (request) => { sending(); await writeGate; return githubActionsWrite(request, h.data); });
  const running = h.actions.start(h.id, ready.id, "still-sending-request"); await sent;
  try { await expect(h.actions.prepareRecovery(h.id, running.id, ctx.id)).rejects.toMatchObject({ code: "github_recovery_busy" }); }
  finally { finish(); await h.actions.drain(); }
});
it("keeps partial CI results and cross-workspace attempt leases after explicit acknowledgement", async () => {
  const f = fixture(), extra = structuredClone(f.data.commit.statusCheckRollup.contexts.nodes[0]!); extra.databaseId = 102; extra.checkSuite!.workflowRun.databaseId = 202; f.data.commit.statusCheckRollup.contexts.nodes.push(extra);
  f.data.action.extraChecks[102] = { id: 102, head_sha: f.data.pull.head.sha, status: "completed", conclusion: "failure" };
  f.data.action.extraRuns[202] = { id: 202, run_attempt: 3, head_sha: f.data.pull.head.sha, repository: f.data.repo, status: "completed", conclusion: "failure" };
  f.intercept(async (request) => { if (request.endpoint.includes("/202/")) { f.data.action.requests.push(request); throw new GitHubWriteError("lost response", false); } return githubActionsWrite(request, f.data); });
  const job = await f.run({ kind: "rerun", failedOnly: true, checks: [] }); expect(job.phase).toBe("partial");
  const preview = await f.actions.prepareRecovery(f.id, job.id, (await f.context()).id), result = await f.actions.acknowledgeRecovery(f.id, job.id, preview.id);
  expect(result.effects.map((e) => e.phase)).toEqual(["complete", "uncertain"]); expect(result.recovery?.effects).toEqual(result.effects);
  await f.restart(); const other = f.manager.createWork({ title: "same CI", cwd: f.dir }).defaultWorkspaceId!, duplicate = await f.prepare({ kind: "rerun", failedOnly: false, checks: [] }, other);
  expect(() => f.actions.start(other, duplicate.id, "no-ci-replay")).toThrow("같은 검사 회차");
  f.intercept(null); expect((await f.run({ kind: "ready" })).phase).toBe("complete"); expect(f.data.action.requests).toHaveLength(3);
});
it("does not replay an unknown merge by changing its method or scheduling mode", async () => {
  const f = fixture(); f.data.pull.draft = false;
  f.intercept(async (request) => { f.data.action.requests.push(request); throw new GitHubWriteError("lost response", false); });
  const job = await f.run({ kind: "merge", method: "squash" }), preview = await f.actions.prepareRecovery(f.id, job.id, (await f.context()).id);
  await f.actions.acknowledgeRecovery(f.id, job.id, preview.id);
  for (const action of [{ kind: "merge", method: "merge" }, { kind: "auto-enable", method: "squash" }] as const) {
    const other = await f.prepare(action); expect(() => f.actions.start(f.id, other.id, `no-merge-replay-${action.kind}`)).toThrow("같은 작업");
  }
  expect(f.data.action.requests).toHaveLength(1);
});
it("can retain an old unknown CI attempt after the PR head advances without relaxing preview freshness", async () => {
  const f = fixture(), oldHead = f.data.pull.head.sha, original = f.reader.json;
  const check = await original("repos/fixture/project/check-runs/101"), run = await original("repos/fixture/project/actions/runs/201");
  f.intercept(async (request) => { f.data.action.requests.push(request); throw new GitHubWriteError("lost response", false); });
  const job = await f.run({ kind: "rerun", failedOnly: true, checks: [] });
  f.reader.json = async (endpoint, body) => endpoint.endsWith("/check-runs/101") ? structuredClone(check) : endpoint.endsWith("/actions/runs/201") ? structuredClone(run) : original(endpoint, body);
  const newHead = "e".repeat(40); f.data.pull.head.sha = newHead; f.data.action.remoteHead = newHead; f.data.commit.oid = newHead; f.data.commit.statusCheckRollup.contexts.nodes = [];
  const preview = await f.actions.prepareRecovery(f.id, job.id, (await f.context()).id);
  expect(preview.headOid).toBe(newHead); expect(preview.job.preview.headOid).toBe(oldHead);
  const saved = await f.actions.acknowledgeRecovery(f.id, job.id, preview.id);
  expect(saved.phase).toBe("uncertain"); expect(saved.recovery?.headOid).toBe(newHead); expect(saved.preview.headOid).toBe(oldHead); expect(f.data.action.requests).toHaveLength(1);
});
