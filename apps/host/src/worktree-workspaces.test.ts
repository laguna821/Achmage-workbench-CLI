import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CreateWorktreeWorkspaceRequest, WorktreeCreation } from "@workbench/contracts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { WorktreeWorkspaces, inspectRepository } from "./worktree-workspaces.ts";
import * as gitModule from "./worktrees.ts";
import { HttpError } from "./errors.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-worktree-jobs-")), root = join(dir, "repo"); mkdirSync(root);
  git(root, "init", "-q", "-b", "main"); writeFileSync(join(root, "readme.md"), "기준 판\n"); git(root, "add", "."); git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD"); git(root, "tag", "-a", "starting", "-m", "base tag");
  writeFileSync(join(root, "readme.md"), "최신 판\n"); git(root, "commit", "-qam", "next");
  const store = new Store(join(dir, "state.sqlite")), bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "local", hostLabel: "here", dataDir: join(dir, "data"), managedWorksDir: join(dir, "works") });
  cleanup.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const work = manager.createWork({ title: "Git 작업", cwd: root });
  const request = (branch = "feature/new"): CreateWorktreeWorkspaceRequest => ({ requestId: randomUUID(), sourceWorkspaceId: work.defaultWorkspaceId!, label: "새 작업", branch, baseRef: "refs/tags/starting", expectedBase: base, parentWorkspaceId: work.defaultWorkspaceId });
  const finish = async (id: string): Promise<WorktreeCreation> => {
    for (let i = 0; i < 150; i++) {
      const job = manager.worktreeWorkspaces.list(work.id).find((item) => item.id === id)!;
      if (!["checking", "creating"].includes(job.phase)) return job;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Creation did not settle");
  };
  return { dir, root, base, manager, work, store, bus, request, finish };
}

it("discovers exact newline paths and refs without changing Git index or external files", async () => {
  const { dir, root, manager, work, base } = setup();
  const path = join(dir, "외부\n워크트리\t"); git(root, "worktree", "add", "-b", "external", path);
  writeFileSync(join(path, "untracked.md"), "그대로\n");
  const index = readFileSync(join(root, ".git", "index"));
  const inventory = await manager.worktreeWorkspaces.inspect(work.defaultWorkspaceId!);
  expect(inventory.worktrees.find((tree) => tree.branch === "external")?.path).toBe(path);
  expect(inventory.refs).toContainEqual({ name: "refs/tags/starting", commit: base, kind: "tag" });
  expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
  const tree = inventory.worktrees.find((entry) => entry.path === path)!;
  const linked = await manager.worktreeWorkspaces.connect(work.defaultWorkspaceId!, path, tree.head);
  expect(linked).toMatchObject({ managed: false, kind: "worktree", cwd: path, parentWorkspaceId: work.defaultWorkspaceId });
  const one = manager.createSession(work.id, { provider: "codex", workspaceId: linked.id });
  const two = manager.createSession(work.id, { provider: "claude", workspaceId: linked.id });
  expect(one.worktree).toEqual(two.worktree);
  expect((await manager.worktreeChanges(one.id)).files).toContainEqual({ path: "untracked.md", status: "added" });
  await expect(manager.discardWorktree(one.id)).rejects.toMatchObject({ code: "worktree_external" });
  expect(readFileSync(join(path, "untracked.md"), "utf8")).toBe("그대로\n");
  expect((await manager.worktreeWorkspaces.connect(work.defaultWorkspaceId!, path, tree.head)).id).toBe(linked.id);
});

it("creates exactly one named branch from the selected commit and preserves project paths and dirty files", async () => {
  const { root, manager, work, base, request, finish } = setup();
  writeFileSync(join(root, "readme.md"), "사람의 미저장 작업\n");
  const req = request(), started = manager.worktreeWorkspaces.start(work.id, req);
  expect(manager.worktreeWorkspaces.start(work.id, req).id).toBe(started.id);
  expect(() => manager.worktreeWorkspaces.start(work.id, { ...req, branch: "different" })).toThrow("다른 생성");
  const done = await finish(started.id); expect(done.phase, done.error).toBe("ready");
  const workspace = manager.workspaces.get(done.workspaceId!);
  expect(workspace).toMatchObject({ managed: true, label: "새 작업", parentWorkspaceId: work.defaultWorkspaceId });
  expect(git(workspace.cwd, "rev-parse", "HEAD")).toBe(base); expect(git(workspace.cwd, "branch", "--show-current")).toBe("feature/new");
  expect(readFileSync(join(workspace.cwd, "readme.md"), "utf8")).toBe("기준 판\n");
  expect(readFileSync(join(root, "readme.md"), "utf8")).toBe("사람의 미저장 작업\n");
  expect(manager.snapshot().works.find((item) => item.id === work.id)?.cwd).toBe(root);
  expect(manager.worktreeWorkspaces.start(work.id, req).workspaceId).toBe(workspace.id);
  expect((await inspectRepository(root)).worktrees).toHaveLength(2);
  const a = manager.createSession(work.id, { provider: "codex", workspaceId: workspace.id });
  const b = manager.createSession(work.id, { provider: "claude", workspaceId: workspace.id });
  manager.sink.updateSession(b.id, { status: "running" });
  await expect(manager.discardWorktree(a.id)).rejects.toMatchObject({ code: "workspace_busy" });
  expect(existsSync(workspace.cwd)).toBe(true);
});

it("rejects stale base/connection commits, existing branches and parents in another repository", async () => {
  const { dir, root, manager, work, request, finish } = setup();
  const stale = manager.worktreeWorkspaces.start(work.id, { ...request(), expectedBase: "0".repeat(40) });
  expect((await finish(stale.id)).error).toContain("기준 커밋이 바뀌");
  const conflict = manager.worktreeWorkspaces.start(work.id, request("main"));
  expect((await finish(conflict.id)).phase).toBe("failed");
  expect((await inspectRepository(root)).worktrees).toHaveLength(1);
  await expect(manager.worktreeWorkspaces.connect(work.defaultWorkspaceId!, root, "0".repeat(40))).rejects.toMatchObject({ code: "worktree_changed" });
  const another = join(dir, "other"); mkdirSync(another); git(another, "init", "-q", "-b", "main");
  const parent = manager.createWorkspace(work.id, { cwd: another });
  const wrong = manager.worktreeWorkspaces.start(work.id, { ...request(), parentWorkspaceId: parent.id });
  expect((await finish(wrong.id)).error).toContain("같은 저장소");
});

it("blocks checkout removal while another project runs there or a document has a live editor", async () => {
  const { manager, work, request, finish } = setup();
  const job = await finish(manager.worktreeWorkspaces.start(work.id, request()).id);
  const space = manager.workspaces.get(job.workspaceId!);
  const owner = manager.createSession(work.id, { provider: "codex", workspaceId: space.id });
  const otherWork = manager.createWork({ title: "같은 폴더의 다른 프로젝트", cwd: space.cwd });
  const other = manager.createSession(otherWork.id, { provider: "claude" });
  manager.sink.updateSession(other.id, { status: "running" });
  await expect(manager.discardWorktree(owner.id)).rejects.toMatchObject({ code: "workspace_busy" });
  manager.sink.updateSession(other.id, { status: "idle" });
  const artifact = manager.openFile(otherWork.id, "readme.md");
  manager.documents.registry.open(artifact.id, { viewId: "live-editor", windowId: "one", claim: true, dirty: true });
  await expect(manager.discardWorktree(owner.id)).rejects.toMatchObject({ code: "editor_busy" });
  expect(existsSync(space.cwd)).toBe(true);
  manager.documents.registry.close("live-editor", "one");
  await manager.discardWorktree(owner.id);
  expect(existsSync(space.cwd)).toBe(false);
  expect(manager.workspaces.get(otherWork.defaultWorkspaceId!).removedAt).toBeTypeOf("number");
  expect(manager.snapshot().sessions.find((entry) => entry.id === other.id)?.archivedAt).toBeTypeOf("number");
  expect(manager.snapshot().works.find((entry) => entry.id === otherWork.id)?.cwd).toBe(space.cwd);
});

it("rejects new session/editor admission and overlapping removal until Git finishes", async () => {
  const { manager, work, request, finish } = setup();
  const job = await finish(manager.worktreeWorkspaces.start(work.id, request()).id);
  const space = manager.workspaces.get(job.workspaceId!);
  const session = manager.createSession(work.id, { provider: "codex", workspaceId: space.id });
  const otherWork = manager.createWork({ title: "같은 폴더", cwd: space.cwd });
  const artifact = manager.openFile(otherWork.id, "readme.md");
  const realRemove = gitModule.removeWorktree;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(gitModule, "removeWorktree").mockImplementation(async (tree) => { await wait; return realRemove(tree); });
  const removing = manager.discardWorktree(session.id);
  try {
    expect(() => manager.createSession(otherWork.id, { provider: "claude" })).toThrow("제거 중");
    expect(() => manager.createWork({ title: "늦은 연결", cwd: space.cwd })).toThrow("제거 중");
    expect(() => manager.documents.registry.open(artifact.id, { viewId: "late", windowId: "one", claim: true })).toThrow("제거 중");
    expect(() => manager.documents.registry.assertPath(join(space.cwd, "new.md"))).toThrow("제거 중");
    await expect(manager.discardWorktree(session.id)).rejects.toMatchObject({ code: "workspace_removing" });
  } finally { release(); await removing; }
  expect(() => manager.createSession(otherWork.id, { provider: "claude" })).toThrow("보관되거나 제거");
});

it("records an actually removed checkout even if branch cleanup subsequently fails", async () => {
  const { manager, work, request, finish } = setup();
  const job = await finish(manager.worktreeWorkspaces.start(work.id, request()).id);
  const space = manager.workspaces.get(job.workspaceId!);
  const session = manager.createSession(work.id, { provider: "codex", workspaceId: space.id });
  const realRemove = gitModule.removeWorktree;
  vi.spyOn(gitModule, "removeWorktree").mockImplementation(async (tree) => {
    await realRemove(tree);
    throw new HttpError(409, "worktree_branch_cleanup_failed", "폴더 삭제 뒤 브랜치 정리 오류");
  });
  await expect(manager.discardWorktree(session.id)).rejects.toMatchObject({ code: "worktree_branch_cleanup_failed" });
  expect(existsSync(space.cwd)).toBe(false);
  expect(manager.workspaces.get(space.id).removedAt).toBeTypeOf("number");
  expect(manager.snapshot().sessions.find((entry) => entry.id === session.id)?.archivedAt).toBeTypeOf("number");
});

it("records immediate cancellation without creating or deleting a checkout", async () => {
  const { root, manager, work, request, finish } = setup();
  const started = manager.worktreeWorkspaces.start(work.id, request());
  manager.worktreeWorkspaces.cancel(started.id);
  expect((await finish(started.id)).phase).toBe("canceled");
  expect((await inspectRepository(root)).worktrees).toHaveLength(1);
});

it("retains an already created checkout when cancellation arrives before registration", async () => {
  const { root, manager, work, request, finish } = setup();
  const realGit = gitModule.git;
  let release!: () => void, created!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const observed = new Promise<void>((resolve) => { created = resolve; });
  vi.spyOn(gitModule, "git").mockImplementation(async (...args) => {
    const result = await realGit(...args);
    if (args[1][0] === "worktree" && args[1][1] === "add") { created(); await wait; }
    return result;
  });
  const started = manager.worktreeWorkspaces.start(work.id, request());
  await observed;
  expect(() => manager.updateWorkspace(work.defaultWorkspaceId!, { archived: true })).toThrow("생성 중");
  manager.worktreeWorkspaces.cancel(started.id); release();
  const done = await finish(started.id);
  expect(done.phase).toBe("canceled"); expect(done.workspaceId).toBeTruthy();
  expect(existsSync(done.path!)).toBe(true); expect(git(root, "rev-parse", "refs/heads/feature/new")).toBe(done.base);
  expect(manager.workspaces.get(done.workspaceId!).removedAt).toBeNull();
});

it("marks unfinished durable creation records interrupted after restart and leaves files intact", () => {
  const { dir, manager, store, work, request } = setup();
  const path = join(dir, "partial"); mkdirSync(path); writeFileSync(join(path, "keep.txt"), "사용자 작업");
  const req = request(); store.saveWorktreeCreation({ id: req.requestId, workId: work.id, request: req, phase: "creating", path, branch: req.branch, createdAt: 1, updatedAt: 1 });
  const restored = new WorktreeWorkspaces(store, manager.workspaces, join(dir, "data"), () => work);
  expect(restored.list(work.id)[0]).toMatchObject({ phase: "interrupted", path, branch: req.branch });
  expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("사용자 작업");
  expect(restored.start(work.id, req).phase).toBe("interrupted");
});
