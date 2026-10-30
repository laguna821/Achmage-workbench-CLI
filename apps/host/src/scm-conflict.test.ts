import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ScmAction, ScmJob, ScmRequest, ScmResolution } from "@workbench/contracts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.quotePath=false", "-C", cwd, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const conflict = (cwd: string, ...args: string[]) => { expect(() => git(cwd, ...args)).toThrow(); expect(git(cwd, "ls-files", "-u")).not.toBe(""); };
function fixture(path = "한글 충돌.md", base: string | Buffer = "기준\n") {
  const dir = mkdtempSync(join(tmpdir(), "wb-conflict-")), root = join(dir, "repo"); mkdirSync(root);
  git(root, "init", "-q", "-b", "main"); git(root, "config", "user.name", "Conflict Test"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "commit.gpgsign", "false"); git(root, "config", "core.autocrlf", "false"); git(root, "config", "core.hooksPath", join(root, ".git", "hooks"));
  writeFileSync(join(root, path), base); git(root, "add", "."); git(root, "commit", "-qm", "base"); const baseHead = git(root, "rev-parse", "HEAD");
  const store = new Store(join(dir, "state.sqlite")), manager = new SessionManager(store, new EventBus(), { hostId: "local", hostLabel: "here", dataDir: join(dir, "data"), managedWorksDir: join(dir, "works") });
  const work = manager.createWork({ title: "충돌 작업", cwd: root }), id = work.defaultWorkspaceId!, scm = manager.sourceControl;
  cleanup.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const state = () => scm.status(id), preview = async () => scm.conflict(id, path, (await state()).revision);
  const finish = async (job: ScmJob) => { for (let n = 0; n < 500; n++) { const next = scm.get(job.id); if (next.phase !== "running") return next; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("conflict job timeout"); };
  const request = async (action: ScmAction, fields: Partial<ScmRequest> = {}): Promise<ScmRequest> => ({ requestId: randomUUID(), expectedRevision: (await state()).revision, action, ...fields });
  const act = async (action: ScmAction, fields: Partial<ScmRequest> = {}) => finish(await scm.start(id, await request(action, fields)));
  const resolution = async (choice: ScmResolution["choice"], fields: Partial<ScmResolution> = {}): Promise<ScmResolution> => ({ path, expectedRevision: (await preview()).revision, choice, stage: true, ...fields });
  const resolve = async (choice: ScmResolution["choice"], fields: Partial<ScmResolution> = {}) => act("resolve", { resolution: await resolution(choice, fields) });
  const branches = (ours: string | Buffer = "현재 쪽\n", theirs: string | Buffer = "가져온 쪽\n") => {
    git(root, "switch", "-qc", "other"); writeFileSync(join(root, path), theirs); git(root, "commit", "-qam", "other"); const other = git(root, "rev-parse", "HEAD");
    git(root, "switch", "main"); writeFileSync(join(root, path), ours); git(root, "commit", "-qam", "main"); return { ours: git(root, "rev-parse", "HEAD"), theirs: other };
  };
  return { dir, root, path, baseHead, store, manager, work, id, scm, state, preview, finish, request, act, resolution, resolve, branches };
}

it("reads all three exact stages and working text with literal unusual paths without changing the index", async () => {
  const f = fixture(":(glob) 한글\n탭\t.md"); f.branches(); conflict(f.root, "merge", "other", "--no-edit");
  const index = readFileSync(join(f.root, ".git", "index")), view = await f.preview();
  expect(view).toMatchObject({ operation: "merge", path: f.path, base: { kind: "text", text: "기준\n" }, ours: { text: "현재 쪽\n" }, theirs: { text: "가져온 쪽\n" } });
  expect(view.working.text).toContain("<<<<<<<"); expect(readFileSync(join(f.root, ".git", "index"))).toEqual(index);
  await expect(f.scm.start(f.id, await f.request("stage", { paths: [f.path] }))).rejects.toMatchObject({ code: "scm_conflicts" });
  await expect(f.scm.start(f.id, await f.request("continue", { operation: "merge" }))).rejects.toMatchObject({ code: "scm_conflicts" });
  await expect(f.scm.start(f.id, await f.request("resolve", { resolution: await f.resolution("working") }))).rejects.toMatchObject({ code: "scm_conflict" });
});

it("saves a draft separately, keeps recovery bytes, deduplicates by content hash and completes a merge with real hooks", async () => {
  const f = fixture(), heads = f.branches(); conflict(f.root, "merge", "other", "--no-edit"); const before = readFileSync(join(f.root, f.path));
  const req = await f.request("resolve", { resolution: await f.resolution("edited", { content: "양쪽을 검토한 해결\n", stage: false }) });
  const job = await f.finish(await f.scm.start(f.id, req)); expect(job.phase, job.error ?? "").toBe("complete"); expect((await f.state()).files[0]?.conflicted).toBe(true);
  expect(job.request.resolution).not.toHaveProperty("content"); expect(job.request.resolution?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(readFileSync(join(job.recoveryPath!, "0.bin"))).toEqual(before); expect(existsSync(join(job.recoveryPath!, "index.bin"))).toBe(true);
  writeFileSync(join(f.root, f.path), "외부에서 추가한 해결\n"); expect((await f.scm.start(f.id, req)).id).toBe(job.id); expect(readFileSync(join(f.root, f.path), "utf8")).toBe("외부에서 추가한 해결\n");
  await expect(f.scm.start(f.id, { ...req, resolution: { ...req.resolution!, content: "different" } })).rejects.toMatchObject({ code: "scm_request_reused" });
  expect((await f.resolve("working")).phase).toBe("complete"); expect((await f.state()).files.some((file) => file.conflicted)).toBe(false);
  const hook = join(f.root, ".git", "hooks", "pre-commit"); writeFileSync(hook, "#!/bin/sh\nprintf 'CONFLICT_HOOK_STOP\\n' >&2\nexit 1\n"); chmodSync(hook, 0o755);
  const failed = await f.act("continue", { operation: "merge" }); expect(failed.phase).toBe("failed"); expect(failed.output).toContain("CONFLICT_HOOK_STOP"); expect((await f.state()).operation).toBe("merge");
  rmSync(hook); const done = await f.act("continue", { operation: "merge" }); expect(done.phase, done.error ?? "").toBe("complete"); expect((await f.state()).operation).toBeNull();
  expect(git(f.root, "show", "-s", "--format=%P", "HEAD").split(" ")).toEqual([heads.ours, heads.theirs]); expect(git(f.root, "show", `HEAD:${f.path}`)).toBe("외부에서 추가한 해결");
});

it("rejects stale conflict views and changed operation metadata even with unchanged HEAD and files", async () => {
  const f = fixture(); f.branches(); conflict(f.root, "merge", "other", "--no-edit");
  const resolution = await f.resolution("ours"); writeFileSync(join(f.root, f.path), "external\n");
  await expect(f.scm.start(f.id, await f.request("resolve", { resolution }))).rejects.toMatchObject({ code: "scm_changed" }); expect(f.scm.list(f.id)).toHaveLength(0);
  const abort = await f.request("abort", { operation: "merge", confirmAbort: true }); writeFileSync(join(f.root, ".git", "MERGE_MSG"), "another merge message\n");
  await expect(f.scm.start(f.id, abort)).rejects.toMatchObject({ code: "scm_changed" });
  await expect(f.scm.start(f.id, await f.request("abort", { operation: "merge" }))).rejects.toMatchObject({ code: "scm_operation" });
  await expect(f.scm.start(f.id, await f.request("abort", { operation: "rebase", confirmAbort: true }))).rejects.toMatchObject({ code: "scm_operation" });
});

it("preserves UTF-8 BOM, CRLF, executable mode and intentional marker-like lines", async () => {
  const f = fixture(); chmodSync(join(f.root, f.path), 0o755); git(f.root, "commit", "-qam", "executable"); f.branches(); conflict(f.root, "merge", "other", "--no-edit");
  writeFileSync(join(f.root, f.path), "\uFEFF해결 중\r\n=======\r\n");
  const view = await f.preview(); expect(view.working.text).toBe("\uFEFF해결 중\r\n=======\r\n");
  await expect(f.scm.start(f.id, await f.request("resolve", { resolution: await f.resolution("edited", { content: "\uFEFF최종\n=======\n" }) }))).rejects.toMatchObject({ code: "scm_conflict" });
  const job = await f.resolve("edited", { content: "\uFEFF최종\n=======\n", allowMarkers: true }); expect(job.phase, job.error ?? "").toBe("complete");
  expect(readFileSync(join(f.root, f.path), "utf8")).toBe("\uFEFF최종\r\n=======\r\n"); expect(lstatSync(join(f.root, f.path)).mode & 0o111).not.toBe(0); expect(git(f.root, "ls-files", "--stage")).toMatch(/^100755 /);
});

it("keeps rebase side meanings and continues through successive genuine conflicts", async () => {
  const f = fixture(); f.branches(); writeFileSync(join(f.root, f.path), "현재 쪽 두 번째\n"); git(f.root, "commit", "-qam", "second local");
  conflict(f.root, "rebase", "other"); let view = await f.preview(); expect(view.operation).toBe("rebase"); expect(view.ours.text).toBe("가져온 쪽\n"); expect(view.theirs.text).toBe("현재 쪽\n");
  expect((await f.resolve("edited", { content: "첫 번째 통합\n" })).phase).toBe("complete");
  const next = await f.act("continue", { operation: "rebase" }); expect(next.phase).toBe("failed"); expect((await f.state()).operation).toBe("rebase");
  view = await f.preview(); expect(view.ours.text).toBe("첫 번째 통합\n"); expect(view.theirs.text).toBe("현재 쪽 두 번째\n");
  await f.resolve("edited", { content: "두 번째 통합\n" }); const done = await f.act("continue", { operation: "rebase" }); expect(done.phase, done.error ?? "").toBe("complete");
  expect((await f.state()).operation).toBeNull(); expect((await f.state()).branch).toBe("main"); expect(git(f.root, "rev-list", "--count", "other..main")).toBe("2");
});

it("continues real cherry-pick and revert conflicts using their own operations", async () => {
  for (const operation of ["cherry-pick", "revert"] as const) {
    const f = fixture(), heads = f.branches(); conflict(f.root, operation, heads.theirs);
    expect((await f.state()).operation).toBe(operation); await f.resolve("edited", { content: `${operation} 해결\n` });
    const done = await f.act("continue", { operation }); expect(done.phase, done.error ?? "").toBe("complete"); expect((await f.state()).operation).toBeNull(); expect(git(f.root, "show", `HEAD:${f.path}`)).toBe(`${operation} 해결`);
  }
});

it("blocks resolution, abort and continuation while a real document writer holds the file", async () => {
  const f = fixture(); f.branches(); conflict(f.root, "merge", "other");
  const artifact = f.manager.openFile(f.work.id, f.path);
  const open = () => f.manager.documents.registry.open(artifact.id, { viewId: "conflict-editor", windowId: "editor-window", claim: true, dirty: true });
  const close = () => f.manager.documents.registry.close("conflict-editor", "editor-window"); open();
  await expect(f.scm.start(f.id, await f.request("resolve", { resolution: await f.resolution("ours") }))).rejects.toMatchObject({ code: "editor_busy" });
  await expect(f.scm.start(f.id, await f.request("abort", { operation: "merge", confirmAbort: true }))).rejects.toMatchObject({ code: "editor_busy" });
  close(); await f.resolve("edited", { content: "resolved\n" }); open();
  await expect(f.scm.start(f.id, await f.request("continue", { operation: "merge" }))).rejects.toMatchObject({ code: "editor_busy" });
  close(); expect((await f.act("continue", { operation: "merge" })).phase).toBe("complete");
});

it("honors custom marker lengths and retains private file permissions on atomic edits", async () => {
  const f = fixture(); writeFileSync(join(f.root, ".gitattributes"), "*.md conflict-marker-size=4\n"); git(f.root, "add", "."); git(f.root, "commit", "-qm", "custom markers"); f.branches(); conflict(f.root, "merge", "other");
  const view = await f.preview(); expect(view.markerSize).toBe(4); expect(view.working.text).toContain("<<<< HEAD");
  await expect(f.scm.start(f.id, await f.request("resolve", { resolution: await f.resolution("working") }))).rejects.toMatchObject({ code: "scm_conflict" });
  chmodSync(join(f.root, f.path), 0o600); expect((await f.resolve("edited", { content: "private resolution" })).phase).toBe("complete"); expect(lstatSync(join(f.root, f.path)).mode & 0o777).toBe(0o600); expect(readFileSync(join(f.root, f.path), "utf8")).toBe("private resolution");
});

it("uses a linked worktree's own conflict stages and operation files while preserving its primary checkout", async () => {
  const f = fixture(); const heads = f.branches(), path = join(f.dir, "linked"); git(f.root, "worktree", "add", "-b", "linked", path); conflict(path, "merge", "other");
  const linked = f.manager.createWork({ title: "linked conflict", cwd: path }), id = linked.defaultWorkspaceId!, state = await f.scm.status(id), view = await f.scm.conflict(id, f.path, state.revision);
  expect(state.operation).toBe("merge"); expect((await f.state()).operation).toBeNull();
  let job = await f.finish(await f.scm.start(id, { requestId: randomUUID(), expectedRevision: state.revision, action: "resolve", resolution: { path: f.path, expectedRevision: view.revision, choice: "theirs", stage: true } })); expect(job.phase, job.error ?? "").toBe("complete");
  job = await f.finish(await f.scm.start(id, { requestId: randomUUID(), expectedRevision: (await f.scm.status(id)).revision, action: "continue", operation: "merge" })); expect(job.phase, job.error ?? "").toBe("complete"); expect(git(f.root, "rev-parse", "HEAD")).toBe(heads.ours); expect(readFileSync(join(f.root, f.path), "utf8")).toBe("현재 쪽\n");
});

it("preserves Git's refusal to abort over an untracked file without forcing cleanup", async () => {
  const f = fixture(); writeFileSync(join(f.root, "restored.txt"), "original tracked\n"); git(f.root, "add", "."); git(f.root, "commit", "-qm", "original file"); f.branches();
  git(f.root, "switch", "other"); git(f.root, "rm", "restored.txt"); git(f.root, "commit", "-qm", "upstream removes file"); git(f.root, "switch", "main"); conflict(f.root, "rebase", "other");
  expect(existsSync(join(f.root, "restored.txt"))).toBe(false); writeFileSync(join(f.root, "restored.txt"), "new untracked manual work\n");
  const job = await f.act("abort", { operation: "rebase", confirmAbort: true }); expect(job.phase).toBe("failed"); expect(job.error).toContain("untracked working tree files"); expect((await f.state()).operation).toBe("rebase");
  expect(readFileSync(join(f.root, "restored.txt"), "utf8")).toBe("new untracked manual work\n");
  renameSync(join(f.root, "restored.txt"), join(f.dir, "retained-manual.txt"));
  const retried = await f.act("abort", { operation: "rebase", confirmAbort: true }); expect(retried.phase, retried.error ?? "").toBe("complete"); expect(readFileSync(join(f.root, "restored.txt"), "utf8")).toBe("original tracked\n"); expect(readFileSync(join(f.dir, "retained-manual.txt"), "utf8")).toBe("new untracked manual work\n");
});

it("aborts merge and rebase explicitly while retaining manual resolution and unrelated files for recovery", async () => {
  for (const operation of ["merge", "rebase"] as const) {
    const f = fixture(), heads = f.branches(); conflict(f.root, operation, "other");
    writeFileSync(join(f.root, f.path), "취소 전 수작업 해결\n"); writeFileSync(join(f.root, "개인 메모.txt"), "보존\n");
    const job = await f.act("abort", { operation, confirmAbort: true }); expect(job.phase, job.error ?? "").toBe("complete"); expect((await f.state()).operation).toBeNull(); expect(git(f.root, "rev-parse", "HEAD")).toBe(heads.ours);
    expect(readFileSync(join(f.root, "개인 메모.txt"), "utf8")).toBe("보존\n"); const manifest = JSON.parse(readFileSync(join(job.recoveryPath!, "manifest.json"), "utf8"));
    const entry = manifest.entries.find((value: { path: string }) => value.path === f.path); expect(readFileSync(join(job.recoveryPath!, entry.storedAs), "utf8")).toBe("취소 전 수작업 해결\n");
  }
});

it("represents missing stages in modify/delete and add/add conflicts and resolves explicit deletion", async () => {
  const f = fixture(); git(f.root, "switch", "-qc", "other"); git(f.root, "rm", "--", f.path); git(f.root, "commit", "-qm", "deleted"); git(f.root, "switch", "main"); writeFileSync(join(f.root, f.path), "수정\n"); git(f.root, "commit", "-qam", "modified"); conflict(f.root, "merge", "other");
  expect((await f.preview()).theirs.kind).toBe("missing"); await expect(f.scm.start(f.id, await f.request("resolve", { resolution: await f.resolution("theirs") }))).rejects.toMatchObject({ code: "scm_conflict" });
  expect((await f.resolve("delete")).phase).toBe("complete"); expect(existsSync(join(f.root, f.path))).toBe(false); expect(git(f.root, "ls-files", "-u")).toBe("");
  const add = fixture(); git(add.root, "switch", "-qc", "other"); writeFileSync(join(add.root, "새 파일"), "다른 추가\n"); git(add.root, "add", "."); git(add.root, "commit", "-qm", "other add"); git(add.root, "switch", "main"); writeFileSync(join(add.root, "새 파일"), "현재 추가\n"); git(add.root, "add", "."); git(add.root, "commit", "-qm", "our add"); conflict(add.root, "merge", "other");
  const state = await add.state(), view = await add.scm.conflict(add.id, "새 파일", state.revision); expect(view.base.kind).toBe("missing");
  expect((await add.act("resolve", { resolution: { path: "새 파일", expectedRevision: view.revision, choice: "theirs", stage: true } })).phase).toBe("complete"); expect(readFileSync(join(add.root, "새 파일"), "utf8")).toBe("다른 추가\n");
});

it("chooses exact binary bytes and preserves symlink objects without touching their external targets", async () => {
  const f = fixture("data.bin", Buffer.from([0, 1])); f.branches(Buffer.from([0, 2]), Buffer.from([0, 3])); conflict(f.root, "merge", "other"); expect((await f.preview()).ours.kind).toBe("binary");
  expect((await f.resolve("theirs")).phase).toBe("complete"); expect(readFileSync(join(f.root, f.path))).toEqual(Buffer.from([0, 3]));
  const link = fixture(), a = join(link.dir, "outside-a"), b = join(link.dir, "outside-b"); writeFileSync(a, "A"); writeFileSync(b, "B");
  rmSync(join(link.root, link.path)); symlinkSync(a, join(link.root, link.path)); git(link.root, "commit", "-qam", "link base");
  git(link.root, "switch", "-qc", "other"); rmSync(join(link.root, link.path)); symlinkSync(b, join(link.root, link.path)); git(link.root, "commit", "-qam", "link other");
  git(link.root, "switch", "main"); rmSync(join(link.root, link.path)); symlinkSync("missing-target", join(link.root, link.path)); git(link.root, "commit", "-qam", "link ours"); conflict(link.root, "merge", "other");
  expect((await link.preview()).theirs).toMatchObject({ kind: "symlink", text: b }); expect((await link.resolve("theirs")).phase).toBe("complete"); expect(readlinkSync(join(link.root, link.path))).toBe(b); expect(readFileSync(a, "utf8")).toBe("A"); expect(readFileSync(b, "utf8")).toBe("B");
});

it("rejects a symlinked parent and preserves unmerged state when the index is locked", async () => {
  const f = fixture(); f.branches(); conflict(f.root, "merge", "other"); writeFileSync(join(f.root, ".git", "index.lock"), "external owner");
  const job = await f.resolve("edited", { content: "저장됐지만 스테이징 실패\n" }); expect(job.phase).toBe("failed"); expect(readFileSync(join(f.root, f.path), "utf8")).toBe("저장됐지만 스테이징 실패\n"); expect((await f.state()).files[0]?.conflicted).toBe(true); expect(job.recoveryPath).toBeTruthy(); rmSync(join(f.root, ".git", "index.lock"));
  const nested = fixture(); mkdirSync(join(nested.root, "folder")); git(nested.root, "mv", nested.path, "folder/file.md"); git(nested.root, "commit", "-qm", "move");
  git(nested.root, "switch", "-qc", "other"); writeFileSync(join(nested.root, "folder/file.md"), "other\n"); git(nested.root, "commit", "-qam", "other"); git(nested.root, "switch", "main"); writeFileSync(join(nested.root, "folder/file.md"), "ours\n"); git(nested.root, "commit", "-qam", "ours"); conflict(nested.root, "merge", "other");
  const outside = join(nested.dir, "outside"); mkdirSync(outside); writeFileSync(join(outside, "file.md"), "external secret\n"); rmSync(join(nested.root, "folder"), { recursive: true }); symlinkSync(outside, join(nested.root, "folder"));
  const state = await nested.state(); await expect(nested.scm.conflict(nested.id, "folder/file.md", state.revision)).rejects.toMatchObject({ code: "scm_conflict" }); expect(readFileSync(join(outside, "file.md"), "utf8")).toBe("external secret\n");
});
