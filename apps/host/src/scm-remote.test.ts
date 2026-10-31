import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ScmJob, ScmRemoteRequest } from "@workbench/contracts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { redactGit } from "./scm-remote.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.quotePath=false", "-C", cwd, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
function author(root: string) { git(root, "config", "user.name", "Remote Test"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "commit.gpgsign", "false"); git(root, "config", "core.hooksPath", join(root, ".git", "hooks")); }
function commit(root: string, path: string, content: string, message = "change") { writeFileSync(join(root, path), content); git(root, "add", "--", path); git(root, "commit", "-qm", message); return git(root, "rev-parse", "HEAD"); }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-remote-")), root = join(dir, "local"), bare = join(dir, "remote.git"), peer = join(dir, "peer");
  mkdirSync(root); git(root, "init", "-qb", "main"); author(root); const base = commit(root, "base.md", "base\n", "base");
  git(dir, "init", "--bare", "-q", bare); git(root, "remote", "add", "origin", bare); git(root, "push", "-u", "origin", "main"); git(bare, "symbolic-ref", "HEAD", "refs/heads/main"); git(dir, "clone", "-q", bare, peer); author(peer);
  const store = new Store(join(dir, "state.sqlite")), manager = new SessionManager(store, new EventBus(), { hostId: "local", hostLabel: "here", dataDir: join(dir, "data"), managedWorksDir: join(dir, "works") });
  const work = manager.createWork({ title: "Remote 작업", cwd: root }), id = work.defaultWorkspaceId!, scm = manager.sourceControl;
  cleanup.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const finish = async (job: ScmJob) => { for (let i = 0; i < 500; i++) { const current = scm.get(job.id); if (current.phase !== "running") return current; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error("remote job timeout"); };
  const target = async (overrides: Partial<ScmRemoteRequest> = {}): Promise<ScmRemoteRequest> => ({ remote: "origin", branch: "main", expectedRevision: (await scm.remoteInventory(id)).revision, ...overrides });
  const start = async (action: "fetch" | "pull" | "push", remote?: ScmRemoteRequest) => scm.start(id, { requestId: randomUUID(), expectedRevision: (await scm.status(id)).revision, action, remote: remote ?? await target() });
  const act = async (action: "fetch" | "pull" | "push", remote?: ScmRemoteRequest) => finish(await start(action, remote));
  return { dir, root, bare, peer, base, store, manager, scm, work, id, target, start, finish, act };
}

it("fetches branch refs while preserving dirty working files, index and local HEAD", async () => {
  const f = fixture(), advanced = commit(f.peer, "remote.md", "remote\n"); git(f.peer, "push", "origin", "main");
  writeFileSync(join(f.root, "base.md"), "local staged\n"); git(f.root, "add", "base.md"); writeFileSync(join(f.root, "base.md"), "local unstaged\n");
  const index = readFileSync(join(f.root, ".git", "index")); const job = await f.act("fetch"); expect(job.phase).toBe("complete"); expect(git(f.root, "rev-parse", "origin/main")).toBe(advanced); expect(git(f.root, "rev-parse", "HEAD")).toBe(f.base); expect(readFileSync(join(f.root, ".git", "index"))).toEqual(index); expect(readFileSync(join(f.root, "base.md"), "utf8")).toBe("local unstaged\n");
  await expect(f.start("pull")).rejects.toMatchObject({ code: "scm_pull_dirty" });
});

it("fast-forwards the reviewed branch and refuses divergence without implicitly rebasing", async () => {
  const f = fixture(), first = commit(f.peer, "remote.md", "one\n"); git(f.peer, "push", "origin", "main");
  expect((await f.act("pull", await f.target({ strategy: "ff-only" }))).phase).toBe("complete"); expect(git(f.root, "rev-parse", "HEAD")).toBe(first); expect(readFileSync(join(f.root, "remote.md"), "utf8")).toBe("one\n");
  const local = commit(f.root, "local.md", "ours\n"); commit(f.peer, "remote.md", "two\n"); git(f.peer, "push", "origin", "main");
  const failed = await f.act("pull", await f.target({ strategy: "ff-only" })); expect(failed.phase).toBe("failed"); expect(git(f.root, "rev-parse", "HEAD")).toBe(local); expect((await f.scm.status(f.id)).operation).toBeNull();
  expect(git(f.root, "for-each-ref", "--format=%(refname)", "refs/workbench/fetch/")).toBe("");
});

it("honors explicitly selected merge and rebase strategies", async () => {
  for (const strategy of ["merge", "rebase"] as const) {
    const f = fixture(), local = commit(f.root, "local.md", "ours\n"), remote = commit(f.peer, "remote.md", "theirs\n"); git(f.peer, "push", "origin", "main");
    const job = await f.act("pull", await f.target({ strategy })); expect(job.phase, job.error ?? "").toBe("complete"); expect(readFileSync(join(f.root, "local.md"), "utf8")).toBe("ours\n"); expect(readFileSync(join(f.root, "remote.md"), "utf8")).toBe("theirs\n");
    expect(git(f.root, "merge-base", "HEAD", remote)).toBe(remote);
    if (strategy === "merge") expect(git(f.root, "show", "-s", "--format=%P", "HEAD").split(" ")).toEqual([local, remote]); else { expect(git(f.root, "rev-parse", "HEAD")).not.toBe(local); expect(git(f.root, "show", "-s", "--format=%P", "HEAD")).toBe(remote); }
  }
});

it("leaves an actual conflict in progress with output and no false synchronization success", async () => {
  const f = fixture(); commit(f.root, "base.md", "ours\n"); commit(f.peer, "base.md", "theirs\n"); git(f.peer, "push", "origin", "main");
  const job = await f.act("pull", await f.target({ strategy: "merge" })); expect(job.phase).toBe("failed"); expect(job.output).toContain("CONFLICT"); expect((await f.scm.status(f.id)).operation).toBe("merge"); expect(readFileSync(join(f.root, "base.md"), "utf8")).toContain("<<<<<<<");
});

it("uses fork push defaults, preserves pull upstream unless selected, and sends only the reviewed OID", async () => {
  const f = fixture(), fork = join(f.dir, "fork.git"); git(f.dir, "init", "--bare", "-q", fork); git(f.root, "remote", "add", "fork", fork); git(f.root, "config", "remote.pushDefault", "fork");
  git(f.root, "switch", "-qc", "feature"); git(f.root, "config", "branch.feature.remote", "origin"); git(f.root, "config", "branch.feature.merge", "refs/heads/main");
  const reviewed = commit(f.root, "feature.md", "reviewed\n"), inventory = await f.scm.remoteInventory(f.id); expect(inventory.pullTarget).toEqual({ remote: "origin", branch: "main" }); expect(inventory.pushTarget).toEqual({ remote: "fork", branch: "feature" });
  const hook = join(f.root, ".git", "hooks", "pre-push"); writeFileSync(hook, "#!/bin/sh\nprintf 'PRE_PUSH_OK\\n'\n"); chmodSync(hook, 0o755);
  const config = readFileSync(join(f.root, ".git", "config"));
  const job = await f.act("push", await f.target({ remote: "fork", branch: "feature" })); expect(job.phase, job.error ?? "").toBe("complete"); expect(job.output).toContain("PRE_PUSH_OK"); expect(git(fork, "rev-parse", "refs/heads/feature")).toBe(reviewed); expect(git(f.root, "config", "branch.feature.remote")).toBe("origin"); expect(git(f.bare, "rev-parse", "main")).toBe(f.base);
  expect(readFileSync(join(f.root, ".git", "config"))).toEqual(config);
  expect((await f.act("push", await f.target({ remote: "fork", branch: "feature", setUpstream: true }))).phase).toBe("complete"); expect(git(f.root, "config", "branch.feature.remote")).toBe("fork"); expect(git(f.root, "config", "branch.feature.merge")).toBe("refs/heads/feature");
});

it("rejects ordinary non-fast-forward pushes, then enforces a pinned online lease even after background fetch", async () => {
  const f = fixture(); const remote = commit(f.peer, "remote.md", "remote\n"); git(f.peer, "push", "origin", "main"); const local = commit(f.root, "local.md", "local\n");
  const plain = await f.act("push"); expect(plain.phase).toBe("failed"); expect(git(f.bare, "rev-parse", "main")).toBe(remote);
  const target = await f.target(), preview = await f.scm.pushPreview(f.id, target); expect(preview.destinations[0]?.head).toBe(remote);
  const changed = commit(f.peer, "remote.md", "new remote\n"); git(f.peer, "push", "origin", "main"); git(f.root, "fetch", "origin");
  const stale = await f.act("push", { ...await f.target(), forcePreviewId: preview.id }); expect(stale.phase).toBe("failed"); expect(stale.output).toContain("stale info"); expect(git(f.bare, "rev-parse", "main")).toBe(changed);
  const fresh = await f.scm.pushPreview(f.id, await f.target()); const success = await f.act("push", { ...await f.target(), forcePreviewId: fresh.id }); expect(success.phase, success.error ?? "").toBe("complete"); expect(git(f.bare, "rev-parse", "main")).toBe(local);
});

it("rejects changed remote configuration before a job and redacts URL credentials", async () => {
  const f = fixture(), target = await f.target(); git(f.root, "remote", "set-url", "origin", join(f.dir, "elsewhere.git"));
  await expect(f.start("push", target)).rejects.toMatchObject({ code: "scm_remote_changed" }); expect(f.scm.list(f.id)).toHaveLength(0);
  git(f.root, "remote", "set-url", "origin", "https://secret-user:secret-pass@example.invalid/repo.git?token=secret-query");
  const inventory = await f.scm.remoteInventory(f.id), serialized = JSON.stringify(inventory); expect(serialized).not.toContain("secret-user"); expect(serialized).not.toContain("secret-pass"); expect(serialized).not.toContain("secret-query"); expect(serialized).toContain("***");
  expect(redactGit("fatal: https://token@example.invalid/repo?q=private failed")).not.toContain("token@");
});

it("reports multiple push destinations separately and retains an earlier success on later failure", async () => {
  const f = fixture(), second = join(f.dir, "second.git"); git(f.dir, "init", "--bare", "-q", second); git(f.root, "remote", "set-url", "--add", "--push", "origin", f.bare); git(f.root, "remote", "set-url", "--add", "--push", "origin", second);
  const head = commit(f.root, "first.md", "first\n"), first = await f.act("push"); expect(first.phase).toBe("complete"); expect(first.remoteResults?.map((entry) => entry.phase)).toEqual(["complete", "complete"]); expect(git(second, "rev-parse", "main")).toBe(head);
  const reject = join(second, "hooks", "pre-receive"); writeFileSync(reject, "#!/bin/sh\nprintf 'SECOND_REJECT\\n' >&2\nexit 1\n"); chmodSync(reject, 0o755);
  const next = commit(f.root, "second.md", "second\n"), partial = await f.act("push"); expect(partial.phase).toBe("failed"); expect(partial.remoteResults?.map((entry) => entry.phase)).toEqual(["complete", "failed"]); expect(git(f.bare, "rev-parse", "main")).toBe(next); expect(git(second, "rev-parse", "main")).toBe(head);
});

it("rejects a local edit made during fetch before integration", async () => {
  const f = fixture(); commit(f.peer, "remote.md", "remote\n"); git(f.peer, "push", "origin", "main");
  // A real upload-pack process pauses the transfer while an external editor changes the file.
  const upload = join(f.dir, "upload-pack.sh"), marker = join(f.dir, "fetching"); writeFileSync(upload, `#!/bin/sh\nprintf start > '${marker}'\nsleep 0.3\nexec git-upload-pack "$@"\n`); chmodSync(upload, 0o755); git(f.root, "config", "remote.origin.uploadpack", upload);
  const job = await f.start("pull");
  for (let n = 0; n < 100 && !existsSync(marker); n++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(existsSync(marker)).toBe(true); writeFileSync(join(f.root, "base.md"), "external\n");
  const failed = await f.finish(job); expect(failed.phase).toBe("failed"); expect(failed.error).toContain("가져오는 동안"); expect(existsSync(join(f.root, "remote.md"))).toBe(false); expect(readFileSync(join(f.root, "base.md"), "utf8")).toBe("external\n");
});

it("pins the sent commit even if another terminal commits while pre-push runs", async () => {
  const f = fixture(), reviewed = commit(f.root, "reviewed.md", "reviewed\n"), marker = join(f.dir, "pushing");
  const hook = join(f.root, ".git", "hooks", "pre-push"); writeFileSync(hook, `#!/bin/sh\nprintf start > '${marker}'\nsleep 0.4\n`); chmodSync(hook, 0o755);
  const job = await f.start("push"); for (let n = 0; n < 100 && !existsSync(marker); n++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(existsSync(marker)).toBe(true); const later = commit(f.root, "later.md", "unreviewed\n");
  const done = await f.finish(job); expect(done.phase, done.error ?? "").toBe("complete"); expect(git(f.bare, "rev-parse", "main")).toBe(reviewed); expect(git(f.root, "rev-parse", "HEAD")).toBe(later); expect(done.remoteResults?.[0]?.head).toBe(reviewed);
});

it("probes the actual push URL and never substitutes the fetch repository's HEAD", async () => {
  const f = fixture(), pushOnly = join(f.dir, "push-only.git"); git(f.dir, "clone", "--bare", "-q", f.bare, pushOnly);
  const fromFetch = commit(f.peer, "remote.md", "fetch-only\n"); git(f.peer, "push", "origin", "main"); git(f.root, "fetch", "origin");
  git(f.root, "remote", "set-url", "--push", "origin", pushOnly); const local = commit(f.root, "local.md", "local\n");
  const preview = await f.scm.pushPreview(f.id, await f.target()); expect(preview.destinations).toEqual([{ url: pushOnly, head: f.base }]);
  const job = await f.act("push", { ...await f.target(), forcePreviewId: preview.id }); expect(job.phase).toBe("complete"); expect(git(pushOnly, "rev-parse", "main")).toBe(local); expect(git(f.bare, "rev-parse", "main")).toBe(fromFetch); expect(git(f.root, "rev-parse", "origin/main")).toBe(fromFetch);
});
