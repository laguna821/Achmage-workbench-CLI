import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ScmAction, ScmJob, ScmRequest } from "@workbench/contracts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { SourceControl } from "./source-control.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.quotePath=false", "-C", cwd, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
function fixture(unborn = false) {
  const dir = mkdtempSync(join(tmpdir(), "wb-scm-")), root = join(dir, "repo"); mkdirSync(root);
  git(root, "init", "-q", "-b", "main"); git(root, "config", "user.name", "SCM Test"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "commit.gpgsign", "false"); git(root, "config", "core.hooksPath", join(root, ".git", "hooks"));
  if (!unborn) { writeFileSync(join(root, "한글.md"), "기준\n둘째 줄\n"); git(root, "add", "."); git(root, "commit", "-qm", "base"); }
  const store = new Store(join(dir, "state.sqlite")), manager = new SessionManager(store, new EventBus(), { hostId: "local", hostLabel: "here", dataDir: join(dir, "data"), managedWorksDir: join(dir, "works") });
  cleanup.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const work = manager.createWork({ title: "Git 작업", cwd: root }), id = work.defaultWorkspaceId!, scm = manager.sourceControl;
  const state = () => scm.status(id);
  const finish = async (job: ScmJob) => {
    for (let n = 0; n < 250; n++) { const next = scm.get(job.id); if (next.phase !== "running") return next; await new Promise((resolve) => setTimeout(resolve, 20)); }
    throw new Error("Git job did not settle");
  };
  const request = async (action: ScmAction, fields: Partial<ScmRequest> = {}): Promise<ScmRequest> => ({ requestId: randomUUID(), expectedRevision: (await state()).revision, action, ...fields });
  const act = async (action: ScmAction, fields: Partial<ScmRequest> = {}) => finish(await scm.start(id, await request(action, fields)));
  return { dir, root, manager, store, work, id, scm, state, finish, request, act };
}

it("inspects staged, working and untracked changes with literal unusual paths and no index writes", async () => {
  const f = fixture(), paths = ["한글 공백\n탭\t.md", "[x].txt", ":(glob)*.txt", "--option.txt"];
  for (const path of paths) writeFileSync(join(f.root, path), "새 파일\n");
  writeFileSync(join(f.root, "한글.md"), "스테이징\n둘째 줄\n"); git(f.root, "add", "한글.md"); writeFileSync(join(f.root, "한글.md"), "작업 파일\n둘째 줄\n");
  const before = readFileSync(join(f.root, ".git", "index")), status = await f.state();
  expect(status).toMatchObject({ branch: "main", operation: null, ahead: 0, behind: 0 });
  expect(status.files.find((file) => file.path === "한글.md")).toMatchObject({ index: "M", working: "M" });
  for (const path of paths) expect(status.files.some((file) => file.path === path)).toBe(true);
  const staged = await f.scm.diff(f.id, "한글.md", "staged", status.revision), working = await f.scm.diff(f.id, "한글.md", "working", status.revision);
  expect(staged.patch).toContain("+스테이징"); expect(staged.patch).not.toContain("작업 파일"); expect(working.patch).toContain("-스테이징"); expect(working.patch).toContain("+작업 파일");
  expect(readFileSync(join(f.root, ".git", "index"))).toEqual(before);
  const job = await f.act("stage", { paths: [paths[1]!] }); expect(job.phase).toBe("complete");
  expect(git(f.root, "diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean).sort()).toEqual([paths[1], "한글.md"].sort());
  expect((await f.act("stage", { paths: [paths[0]!, paths[2]!, paths[3]!] })).phase).toBe("complete");
  expect(git(f.root, "ls-files", "-z").split("\0")).toContain(paths[2]);
});

it("unstages before the first commit without removing working files, then commits only staged bytes", async () => {
  const f = fixture(true); writeFileSync(join(f.root, "new.md"), "original\n");
  expect((await f.state()).head).toBeNull(); expect((await f.act("stage", { paths: ["new.md"] })).phase).toBe("complete");
  writeFileSync(join(f.root, "new.md"), "later\n");
  expect((await f.act("unstage", { paths: ["new.md"] })).phase).toBe("complete"); expect(readFileSync(join(f.root, "new.md"), "utf8")).toBe("later\n"); expect(git(f.root, "ls-files")).toBe("");
  await f.act("stage", { paths: ["new.md"] }); writeFileSync(join(f.root, "new.md"), "unstaged\n");
  const job = await f.act("commit", { message: "첫 커밋\n\n한글 설명" }); expect(job.phase).toBe("complete"); expect(job.headBefore).toBeNull(); expect(job.headAfter).toMatch(/^[a-f0-9]{40,64}$/);
  expect(git(f.root, "show", "HEAD:new.md")).toBe("later"); expect(readFileSync(join(f.root, "new.md"), "utf8")).toBe("unstaged\n"); expect((await f.state()).files[0]).toMatchObject({ index: ".", working: "M" });
});

it("rejects stale bytes, index or HEAD and forged paths before creating a job", async () => {
  const f = fixture(); writeFileSync(join(f.root, "한글.md"), "first\n"); const request = await f.request("stage", { paths: ["한글.md"] });
  writeFileSync(join(f.root, "한글.md"), "other\n");
  await expect(f.scm.start(f.id, request)).rejects.toMatchObject({ code: "scm_changed" }); expect(f.scm.list(f.id)).toHaveLength(0);
  const fresh = await f.request("stage", { paths: ["한글.md"] }); git(f.root, "add", "한글.md");
  await expect(f.scm.start(f.id, fresh)).rejects.toMatchObject({ code: "scm_changed" });
  const commit = await f.request("commit", { message: "would be stale" }); git(f.root, "commit", "-qm", "external");
  await expect(f.scm.start(f.id, commit)).rejects.toMatchObject({ code: "scm_changed" });
  await expect(f.scm.start(f.id, await f.request("stage", { paths: ["../outside"] }))).rejects.toMatchObject({ code: "scm_path" });
  await expect(f.scm.start(f.id, await f.request("stage", { paths: ["not-listed"] }))).rejects.toMatchObject({ code: "scm_file" });
  expect(f.scm.list(f.id)).toHaveLength(0);
});

it("deduplicates concurrent commands and retained requests without committing twice", async () => {
  const f = fixture(); writeFileSync(join(f.root, "한글.md"), "updated\n");
  const request = await f.request("stage", { paths: ["한글.md"] }); const [a, b] = await Promise.all([f.scm.start(f.id, request), f.scm.start(f.id, request)]); expect(a.id).toBe(b.id); await f.finish(a);
  const commit = await f.request("commit", { message: "exactly once" }), job = await f.finish(await f.scm.start(f.id, commit));
  expect((await f.scm.start(f.id, commit)).id).toBe(job.id); expect(git(f.root, "rev-list", "--count", "HEAD")).toBe("2");
  await expect(f.scm.start(f.id, { ...commit, message: "different" })).rejects.toMatchObject({ code: "scm_request_reused" });
});

it("shows actual hook failure output and preserves staged work until an explicit new attempt", async () => {
  const f = fixture(); writeFileSync(join(f.root, "한글.md"), "new\n"); await f.act("stage", { paths: ["한글.md"] });
  const hook = join(f.root, ".git", "hooks", "pre-commit"); writeFileSync(hook, "#!/bin/sh\nprintf '검사 실패 HOOK_STOP\\n' >&2\nexit 7\n"); chmodSync(hook, 0o755);
  const request = await f.request("commit", { message: "keep this draft" }), job = await f.finish(await f.scm.start(f.id, request));
  expect(job.phase).toBe("failed"); expect(job.output).toContain("HOOK_STOP"); expect(job.headAfter).toBe(job.headBefore); expect(git(f.root, "diff", "--cached", "--name-only")).toContain("한글");
  rmSync(hook); expect((await f.scm.start(f.id, request)).phase).toBe("failed"); expect((await f.act("commit", { message: request.message })).phase).toBe("complete");
});

it("unstages both ends of a rename while preserving its working file and deletion", async () => {
  const f = fixture(); renameSync(join(f.root, "한글.md"), join(f.root, "새 이름.md")); git(f.root, "add", "-A");
  const state = await f.state(); expect(state.files).toContainEqual({ path: "새 이름.md", oldPath: "한글.md", index: "R", working: ".", conflicted: false, submodule: false });
  expect((await f.scm.diff(f.id, "새 이름.md", "staged", state.revision)).patch).toContain("rename from");
  expect((await f.act("unstage", { paths: ["새 이름.md"] })).phase).toBe("complete"); expect(git(f.root, "diff", "--cached", "--name-only")).toBe("");
  expect(existsSync(join(f.root, "한글.md"))).toBe(false); expect(readFileSync(join(f.root, "새 이름.md"), "utf8")).toContain("기준");
});

it("serializes linked-worktree writes and blocks archive/new execution while a hook is running", async () => {
  const f = fixture(), path = join(f.dir, "linked"); git(f.root, "worktree", "add", "-b", "linked", path);
  const inventory = await f.manager.worktreeWorkspaces.inspect(f.id), tree = inventory.worktrees.find((entry) => entry.path === path)!;
  const linked = await f.manager.worktreeWorkspaces.connect(f.id, path, tree.head);
  writeFileSync(join(f.root, "한글.md"), "primary\n"); await f.act("stage", { paths: ["한글.md"] }); writeFileSync(join(path, "한글.md"), "linked\n");
  const hook = join(f.root, ".git", "hooks", "pre-commit"); writeFileSync(hook, "#!/bin/sh\nprintf 'HOOK_RUNNING\\n'\nsleep 0.4\n"); chmodSync(hook, 0o755);
  const job = await f.scm.start(f.id, await f.request("commit", { message: "hook" }));
  expect(() => f.manager.updateWorkspace(f.id, { archived: true })).toThrow();
  expect(() => f.manager.createSession(f.work.id, { provider: "codex", workspaceId: f.id })).toThrow();
  await expect(f.scm.start(linked.id, { requestId: randomUUID(), expectedRevision: (await f.scm.status(linked.id)).revision, action: "stage", paths: ["한글.md"] })).rejects.toMatchObject({ code: "scm_busy" });
  expect((await f.finish(job)).phase).toBe("complete"); expect(git(path, "diff", "--cached", "--name-only")).toBe("");
});

it("persists interrupted history without replaying a saved command or adopting a PID", async () => {
  const f = fixture(); writeFileSync(join(f.root, "한글.md"), "new\n"); const job = await f.act("stage", { paths: ["한글.md"] });
  f.store.setMeta("scm-job:" + job.id, JSON.stringify({ ...job, phase: "running", request: { ...job.request, action: "commit", message: "must not replay" } }));
  const restarted = new SourceControl(f.store, f.manager.workspaces, { sharedLinks: () => new Set(), assertIdle: () => {} });
  expect(restarted.get(job.id).phase).toBe("interrupted"); expect(git(f.root, "rev-list", "--count", "HEAD")).toBe("1"); expect(git(f.root, "diff", "--cached", "--name-only")).toContain("한글"); await restarted.shutdown();
});

it("reads conflict stages and blocks committing unresolved changes without modifying the index", async () => {
  const f = fixture(); git(f.root, "switch", "-qc", "other"); writeFileSync(join(f.root, "한글.md"), "other\n"); git(f.root, "commit", "-qam", "other");
  git(f.root, "switch", "main"); writeFileSync(join(f.root, "한글.md"), "main\n"); git(f.root, "commit", "-qam", "main");
  try { git(f.root, "merge", "other", "--no-edit"); } catch { /* expected content conflict */ }
  const before = readFileSync(join(f.root, ".git", "index")), state = await f.state(); expect(state.operation).toBe("merge"); expect(state.files[0]).toMatchObject({ path: "한글.md", conflicted: true });
  await expect(f.scm.start(f.id, await f.request("commit", { message: "unresolved" }))).rejects.toMatchObject({ code: "scm_conflicts" }); expect(readFileSync(join(f.root, ".git", "index"))).toEqual(before);
});

it("renders binary raster versions, bounds large patches and never follows shared links for previews", async () => {
  const f = fixture(), png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  writeFileSync(join(f.root, "image.png"), png); const state = await f.state(), image = await f.scm.diff(f.id, "image.png", "working", state.revision); expect(image.binary).toBe(true); expect(image.images?.before).toBeNull(); expect(image.images?.after).toContain("data:image/png;base64,");
  writeFileSync(join(f.root, "large.txt"), "large line\n".repeat(60_000)); const next = await f.state(), large = await f.scm.diff(f.id, "large.txt", "working", next.revision); expect(large.truncated).toBe(true); expect(Buffer.byteLength(large.patch)).toBeLessThanOrEqual(512 * 1024 + 3);
  const outside = join(f.dir, "outside"); mkdirSync(outside); writeFileSync(join(outside, "secret.png"), png); symlinkSync(outside, join(f.root, "shared"), "dir");
  const final = await f.state(); expect(final.files.some((file) => file.path === "shared/secret.png")).toBe(false);
  await expect(f.scm.diff(f.id, "shared/secret.png", "working", final.revision)).rejects.toMatchObject({ code: "scm_file" });
});

it("interrupts only the owned Git process group and retains its partial state and output", async () => {
  const f = fixture(); writeFileSync(join(f.root, "한글.md"), "pending\n"); await f.act("stage", { paths: ["한글.md"] });
  const hook = join(f.root, ".git", "hooks", "pre-commit"); writeFileSync(hook, "#!/bin/sh\nprintf 'OWNED_LONG_HOOK\\n'\nsleep 30\nprintf 'must not reach\\n'\n"); chmodSync(hook, 0o755);
  const job = await f.scm.start(f.id, await f.request("commit", { message: "interrupted" }));
  for (let n = 0; n < 100 && !f.scm.get(job.id).output.includes("OWNED_LONG_HOOK"); n++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(f.scm.get(job.id).output).toContain("OWNED_LONG_HOOK");
  const stopped = await f.scm.interrupt(job.id); expect(stopped.phase).toBe("interrupted"); expect(stopped.output).not.toContain("must not reach"); expect(stopped.headAfter).toBe(stopped.headBefore);
  expect(f.scm.busy(f.root)).toBe(false); expect(git(f.root, "diff", "--cached", "--name-only")).toBe("한글.md");
});
