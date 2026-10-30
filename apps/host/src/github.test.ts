import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubReviews } from "./github.ts";
import { GhReader, githubRedact, githubResponse } from "./github-reader.ts";
import { githubRemote } from "./github-data.ts";
import { Store } from "./store.ts";
import { SessionManager } from "./sessions.ts";
import { EventBus } from "./bus.ts";
import { githubFixture, githubFixtureResponse } from "../../../scripts/fixtures/github.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-github-")); git(dir, "init", "-qb", "feature"); git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "test@example.invalid"); git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "code.txt"), "local\n"); git(dir, "add", "code.txt"); git(dir, "commit", "-qm", "initial"); git(dir, "remote", "add", "origin", "git@github.com:worker/project.git");
  const store = new Store(join(dir, "state.sqlite")), manager = new SessionManager(store, new EventBus(), { hostId: "local", hostLabel: "here", dataDir: join(dir, "data"), managedWorksDir: join(dir, "works") });
  const work = manager.createWork({ title: "PR fixture", cwd: dir }), id = work.defaultWorkspaceId!, data = githubFixture(git(dir, "rev-parse", "HEAD"));
  let intercept: ((endpoint: string) => unknown) | null = null;
  const service = new GitHubReviews(manager.sourceControl, { json: async (endpoint) => { const result = intercept?.(endpoint); return structuredClone(result === undefined ? githubFixtureResponse(endpoint, data) : result); }, log: async (endpoint) => String(githubFixtureResponse(endpoint, data)), close: async () => {} });
  const selection = async () => { const b = await service.binding(id); return { binding: b.revision, head: b.defaultHead!, base: b.defaultBase!, fresh: true }; };
  const load = async () => service.load(id, await selection());
  cleanup.push(async () => { await service.close(); await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, manager, service, data, id, selection, load, intercept: (handler: (endpoint: string) => unknown) => { intercept = handler; } };
}

it("uses exact public GitHub remotes, rejecting credentials, hostile hosts and ambiguous protocols", () => {
  expect(githubRemote("git@github.com:worker/project.git")).toBe("worker/project");
  expect(githubRemote("ssh://git@github.com/worker/project.git")).toBe("worker/project");
  expect(githubRemote("https://github.com/Worker/Project")).toBe("Worker/Project");
  for (const url of ["https://token@github.com/a/b", "https://github.com.evil/a/b", "ssh://user@github.com/a/b", "https://github.com/a/b?token=secret", "https://github.com:444/a/b", "http://github.com/a/b", "/tmp/github.com/a/b"]) expect(githubRemote(url)).toBeNull();
});
it("finds a fork parent without a local upstream remote and pins files, both CI sources and approval", async () => {
  const f = fixture(), index = readFileSync(join(f.dir, ".git/index")), bytes = readFileSync(join(f.dir, "code.txt"));
  const binding = await f.service.binding(f.id); expect(binding.bases.find((x) => x.id === binding.defaultBase)?.repo).toBe("fixture/project");
  const view = await f.service.load(f.id, { binding: binding.revision, head: binding.defaultHead!, base: binding.defaultBase! });
  expect(view.pull?.number).toBe(7); expect(view.files[0]).toMatchObject({ oldPath: "이전.txt", notice: null }); expect(view.files[1]?.notice).toContain("바이너리");
  expect(view.checks.map((x) => x.kind)).toEqual(["check", "status", "approval", "status"]); expect(view.checks.at(-1)?.source).toBe("merge");
  expect(readFileSync(join(f.dir, ".git/index"))).toEqual(index); expect(readFileSync(join(f.dir, "code.txt"))).toEqual(bytes); expect(git(f.dir, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/feature");
});
it("rejects an unrelated fork's PR even when the owner and branch query matches", async () => {
  const f = fixture(); f.data.pull.head.repo = { ...f.data.fork, id: 99, full_name: "worker/other" };
  expect((await f.load()).pull).toBeNull();
  await expect(f.service.load(f.id, { ...await f.selection(), number: 7 })).rejects.toMatchObject({ code: "github_pull_scope" });
});
it("rejects a stale local branch or changed remote binding before API reads", async () => {
  const f = fixture(), selection = await f.selection(), count = f.data.calls.length;
  git(f.dir, "remote", "set-url", "origin", "https://github.com/worker/elsewhere");
  await expect(f.service.load(f.id, selection)).rejects.toMatchObject({ code: "github_binding_changed" }); expect(f.data.calls).toHaveLength(count);
});
it("distinguishes no open PR, explicit closed PR and network failure", async () => {
  const f = fixture(); f.data.empty = true; expect((await f.load()).pull).toBeNull();
  f.data.pull.state = "closed"; f.data.pull.merged_at = "2026-10-30T00:00:00Z";
  expect((await f.service.load(f.id, { ...await f.selection(), number: 7 })).pull?.state).toBe("merged");
  f.data.fail = true; const latest = await f.service.load(f.id, { ...await f.selection(), number: 7 }); expect(latest.stale).toBe(true); expect(latest.pull?.number).toBe(7); expect(latest.error).toContain("unavailable");
});
it("never turns a first-load error into an empty successful PR list", async () => {
  const f = fixture(), selection = await f.selection(); f.data.fail = true;
  await expect(f.service.load(f.id, selection)).rejects.toThrow("unavailable");
});
it("rejects PR changes between file read and final identity check", async () => {
  const f = fixture(); let reads = 0;
  f.intercept((endpoint) => { if (endpoint === "repos/fixture/project/pulls/7" && ++reads === 2) return { ...f.data.pull, head: { ...f.data.pull.head, sha: "e".repeat(40) } }; });
  await expect(f.load()).rejects.toMatchObject({ code: "github_pull_changed" });
});
it("shows partial CI errors explicitly and refuses mismatched check commit identity", async () => {
  const f = fixture(); f.data.checkFail = true; const incomplete = await f.load(); expect(incomplete.checks).toEqual([]); expect(incomplete.notices.join(" ")).toContain("성공 여부를 판단하지");
  f.data.checkFail = false; f.data.commit.oid = "f".repeat(40);
  const retained = await f.load(); expect(retained.stale).toBe(true); expect(retained.error).toContain("커밋이 바뀌었습니다");
});
it("binds job logs to the reviewed check, repository, SHA and run attempt", async () => {
  const f = fixture(), view = await f.load(), check = view.checks.find((x) => x.details)!;
  const detail = await f.service.details(f.id, view.id, view.revision, check.id); expect(detail.jobs).toHaveLength(1);
  const log = await f.service.log(f.id, view.id, view.revision, detail.jobs[0]!.id); expect(log.text).toContain("expected boundary");
  f.data.jobMismatch = true;
  await expect(f.service.log(f.id, view.id, view.revision, detail.jobs[0]!.id)).rejects.toMatchObject({ code: "github_job_changed" });
  expect(f.data.calls.filter((x) => x.endsWith("/logs"))).toHaveLength(1);
});
it("blocks other workspace and unknown check/job IDs without network requests", async () => {
  const f = fixture(), view = await f.load(), other = f.manager.createWork({ title: "other", cwd: f.dir }); const count = f.data.calls.length;
  await expect(f.service.details(other.defaultWorkspaceId!, view.id, view.revision, view.checks[0]!.id)).rejects.toMatchObject({ code: "github_expired" });
  await expect(f.service.log(f.id, view.id, view.revision, "301")).rejects.toMatchObject({ code: "github_job" }); expect(f.data.calls).toHaveLength(count);
});
it("keeps existing view immutable after remote data changes and marks missing patches", async () => {
  const f = fixture(), view = await f.load(); f.data.pull.title = "changed elsewhere";
  expect(view.pull?.title).toBe("한글 PR 검토"); expect(view.files[1]?.patch).toBe("");
  const selected = await f.selection(), calls = f.data.calls.length;
  const reused = await f.service.load(f.id, { ...selected, fresh: false }); expect(reused.id).toBe(view.id); expect(f.data.calls).toHaveLength(calls);
});
it("labels partial GitHub patches instead of claiming a whole file diff", async () => {
  const f = fixture(); f.intercept((endpoint) => endpoint.includes("/files?") ? [{ filename: "code.txt", status: "modified", additions: 20, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new\n" }] : undefined);
  const view = await f.load(); expect(view.files[0]?.notice).toContain("일부"); expect(view.notices.join(" ")).toContain("2개 중 1개");
});
it("reports paginated checks and excludes a check attached to another commit", async () => {
  const f = fixture(); f.data.commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true;
  f.data.commit.statusCheckRollup.contexts.nodes[0]!.checkSuite!.commit.oid = "d".repeat(40);
  const view = await f.load(); expect(view.checks.some((check) => check.name === "Linux 검사")).toBe(false);
  expect(view.notices.join(" ")).toContain("100개"); expect(view.notices.join(" ")).toContain("다른 커밋");
});
it("passes explicit read-only methods and JSON stdin, coalesces reads and parses redirect headers", async () => {
  const calls: { args: string[]; input: string | undefined }[] = [];
  const reader = new GhReader(async (args, input) => { calls.push({ args, input }); return { code: 0, stdout: 'HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 2\r\n\r\n{"ok":true}', stderr: "" }; }); cleanup.push(() => reader.close());
  await Promise.all([reader.json("repos/a/b"), reader.json("repos/a/b")]); expect(calls).toHaveLength(1); expect(calls[0]!.args).toContain("GET"); expect(calls[0]!.args).toContain("github.com");
  const body = { query: "query($value:String!) { viewer { login } }", variables: { value: "@/secret/$(test)" } };
  await reader.json("graphql", body); expect(calls[1]!.args.slice(-2)).toEqual(["--input", "-"]); expect(calls[1]!.input).toBe(JSON.stringify(body));
  expect(githubResponse("HTTP/2.0 302 Found\nLocation: https://example.invalid/x\n\nHTTP/1.1 200 OK\nContent-Type: text/plain\n\nlogs")).toMatchObject({ status: 200, text: "logs" });
  await expect(reader.json("https://evil.invalid")).rejects.toThrow("허용되지"); await expect(reader.json("graphql", { query: "mutation {x}" })).rejects.toThrow("허용되지");
});
it("honors rate-limit response headers without probing or automatic retries", async () => {
  let now = 100000, count = 0;
  const reader = new GhReader(async () => { count++; return count === 1 ? { code: 1, stdout: "HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: 220\n\nrate limit", stderr: "" } : { code: 0, stdout: "HTTP/2.0 200 OK\n\n{}", stderr: "" }; }, () => now); cleanup.push(() => reader.close());
  await expect(reader.json("repos/a/b")).rejects.toMatchObject({ code: "github_rate_limit" }); await expect(reader.json("repos/a/c")).rejects.toMatchObject({ code: "github_rate_limit" }); expect(count).toBe(1);
  now = 221000; await reader.json("repos/a/c"); expect(count).toBe(2);
});
it("allows escape sequences only in known job log reads, stripping CSI/OSC and reporting old gh", async () => {
  const calls: string[][] = []; let old = false;
  const reader = new GhReader(async (args) => { calls.push(args); return old ? { code: 1, stdout: "", stderr: "unknown flag: --allow-escape-sequences" } : { code: 0, stdout: "HTTP/2.0 200 OK\n\n\x1b[31mError\x1b[0m\x1b]0;invisible title\x07\nline", stderr: "" }; }); cleanup.push(() => reader.close());
  expect(await reader.log("repos/a/b/actions/jobs/1/logs")).toBe("Error\nline"); expect(calls[0]).toContain("--allow-escape-sequences");
  await expect(reader.log("repos/a/b/arbitrary")).rejects.toThrow("작업 로그"); expect(calls).toHaveLength(1);
  old = true; await expect(reader.log("repos/a/b/actions/jobs/2/logs")).rejects.toMatchObject({ code: "github_version" });
});
it("redacts credential-shaped errors and interrupts owned in-flight reads on shutdown", async () => {
  expect(githubRedact("token ghp_12345Abc https://alice:secret@github.com/a/b?token=secret")).not.toContain("secret");
  const reader = new GhReader(async (_args, _input, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
  const read = reader.json("repos/a/b"); const rejection = expect(read).rejects.toThrow("aborted"); await reader.close(); await rejection;
  await expect(reader.json("repos/a/b")).rejects.toMatchObject({ code: "github_stopped" });
});
