import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CreateWorktreeWorkspaceRequest, DetectedWorktree, GitRef, SessionWorktree, Work, Workspace, WorkspaceRepository, WorktreeCreation } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import type { Store } from "./store.ts";
import type { Workspaces } from "./workspaces.ts";
import { git } from "./worktrees.ts";

const terminal = (phase: WorktreeCreation["phase"]) => ["ready", "failed", "canceled", "interrupted"].includes(phase);
const line = (value: string) => value.replace(/\n$/, "");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** Git's -z format is required: a valid path may contain newlines or tabs. */
export function parseWorktrees(text: string): DetectedWorktree[] {
  const result: DetectedWorktree[] = [];
  let current: DetectedWorktree | null = null;
  for (const field of text.split("\0")) {
    if (field.startsWith("worktree ")) { current = { path: field.slice(9), head: "", branch: "", detached: false, bare: false, locked: null, prunable: null, missing: false }; result.push(current); }
    else if (current) {
      if (field.startsWith("HEAD ")) current.head = field.slice(5);
      else if (field.startsWith("branch ")) current.branch = field.slice(7).replace(/^refs\/heads\//, "");
      else if (field === "detached") current.detached = true;
      else if (field === "bare") current.bare = true;
      else if (field === "locked" || field.startsWith("locked ")) current.locked = field.slice(7) || "잠김";
      else if (field === "prunable" || field.startsWith("prunable ")) current.prunable = field.slice(9) || "정리 대상";
    }
  }
  return result;
}

export async function inspectRepository(cwd: string, signal?: AbortSignal): Promise<WorkspaceRepository> {
  const call = (args: string[]) => git(cwd, args, undefined, signal);
  const root = realpathSync(line(await call(["rev-parse", "--show-toplevel"])));
  const commonDir = realpathSync(line(await call(["rev-parse", "--path-format=absolute", "--git-common-dir"])));
  const head = (await call(["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim();
  const branch = (await call(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
  const worktrees = parseWorktrees(await call(["worktree", "list", "--porcelain", "-z"]));
  for (const tree of worktrees) {
    tree.path = canonical(tree.path);
    try { tree.missing = !statSync(tree.path).isDirectory(); } catch { tree.missing = true; }
  }
  const rawRefs = await call(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)", "refs/heads", "refs/remotes", "refs/tags"]);
  const refs = rawRefs.split("\n").flatMap((row): GitRef[] => {
    const [name, object, type, peeled, peeledType] = row.split("\0");
    if (!name || (!name.startsWith("refs/heads/") && !name.startsWith("refs/remotes/") && !name.startsWith("refs/tags/"))) return [];
    const commit = type === "commit" ? object : peeledType === "commit" ? peeled : null;
    return commit ? [{ name, commit, kind: name.startsWith("refs/heads/") ? "branch" : name.startsWith("refs/remotes/") ? "remote" : "tag" }] : [];
  });
  return { root, commonDir, head, branch, refs, worktrees };
}

/** Durable creation outcomes are separate from sessions and tab visibility. No cleanup runs on
 * cancellation or restart: partial checkout paths and branches remain available for inspection.
 */
export class WorktreeWorkspaces {
  private readonly store: Store;
  private readonly spaces: Workspaces;
  private readonly getWork: (id: string) => Work;
  private readonly dataDir: string;
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private stopped = false;
  constructor(store: Store, spaces: Workspaces, dataDir: string, getWork: (id: string) => Work) {
    this.store = store; this.spaces = spaces; this.dataDir = dataDir; this.getWork = getWork;
    for (const job of store.worktreeCreations()) if (!terminal(job.phase)) this.save({ ...job, phase: "interrupted", error: "앱이 종료되어 생성 완료를 확인하지 못했습니다. 남은 경로와 브랜치를 확인하세요." });
  }
  private save(job: WorktreeCreation) { const next = { ...job, updatedAt: Date.now() }; this.store.saveWorktreeCreation(next); return next; }
  private get(id: string) {
    const job = this.store.worktreeCreations().find((item) => item.id === id);
    if (!job) throw new HttpError(404, "worktree_job_missing", "생성 기록을 찾지 못했습니다.");
    return job;
  }
  list(workId: string) { this.getWork(workId); return this.store.worktreeCreations().filter((item) => item.workId === workId).slice(0, 100); }
  busy(workspaceId: string) { return this.store.worktreeCreations().some((job) => this.running.has(job.id) && (job.request.sourceWorkspaceId === workspaceId || job.request.parentWorkspaceId === workspaceId || job.workspaceId === workspaceId)); }
  async inspect(workspaceId: string) {
    const workspace = this.spaces.get(workspaceId);
    this.spaces.requireActive(workspaceId, workspace.workId);
    let repo: WorkspaceRepository;
    try { repo = await inspectRepository(workspace.cwd); }
    catch (error) { throw new HttpError(409, "repository_unavailable", `Git 저장소를 읽지 못했습니다: ${errorText(error)}`); }
    for (const tree of repo.worktrees) {
      tree.workspaceId = this.spaces.list().find((entry) => entry.workId === workspace.workId && entry.hostId === workspace.hostId && entry.removedAt === null && canonical(entry.cwd) === tree.path)?.id;
    }
    return repo;
  }
  async connect(sourceWorkspaceId: string, path: string, expectedHead: string) {
    const source = this.spaces.get(sourceWorkspaceId), work = this.getWork(source.workId);
    const repo = await this.inspect(sourceWorkspaceId);
    const tree = repo.worktrees.find((entry) => entry.path === canonical(path));
    if (!tree || tree.bare || tree.missing || tree.prunable) throw new HttpError(409, "worktree_unavailable", "현재 Git 목록에 있는 사용 가능한 워크트리를 선택하세요.");
    if (!expectedHead || tree.head !== expectedHead) throw new HttpError(409, "worktree_changed", "목록을 읽은 뒤 워크트리의 커밋이 바뀌었습니다. 새로고침해 주세요.");
    const actual = await inspectRepository(tree.path);
    if (actual.commonDir !== repo.commonDir || actual.root !== tree.path || actual.head !== expectedHead) throw new HttpError(409, "worktree_changed", "워크트리의 저장소나 경로가 바뀌었습니다.");
    if (tree.workspaceId) return this.spaces.get(tree.workspaceId);
    if (tree.path === repo.root) return this.spaces.create(work, { cwd: tree.path, label: basename(tree.path) });
    return this.spaces.connectWorktree(work, { root: repo.root, commonDir: repo.commonDir, path: tree.path, cwd: tree.path, branch: tree.branch, base: tree.head, detached: tree.detached }, { managed: false, parentWorkspaceId: source.id });
  }
  start(workId: string, request: CreateWorktreeWorkspaceRequest) {
    this.getWork(workId); this.spaces.requireActive(request.sourceWorkspaceId, workId);
    if (this.stopped) throw new HttpError(503, "shutting_down", "앱을 종료 중입니다.");
    if (!/^[a-zA-Z0-9_-]{12,100}$/.test(request.requestId) || typeof request.branch !== "string" || !request.branch.trim() || request.branch.length > 200 || request.branch.startsWith("-") || typeof request.baseRef !== "string" || !request.baseRef.trim() || request.baseRef.length > 1024 || request.baseRef.includes("\0") || typeof request.label !== "string" || request.label.length > 80) throw new HttpError(400, "worktree_request", "작업공간 이름·브랜치·기준 ref를 확인해 주세요.");
    const normalized = { requestId: request.requestId, sourceWorkspaceId: request.sourceWorkspaceId, label: request.label.trim(), branch: request.branch.trim(), baseRef: request.baseRef.trim(), ...(request.expectedBase ? { expectedBase: request.expectedBase } : {}), parentWorkspaceId: request.parentWorkspaceId ?? null };
    const existing = this.store.worktreeCreations().find((item) => item.id === request.requestId);
    if (existing) {
      if (existing.workId !== workId || JSON.stringify(existing.request) !== JSON.stringify(normalized)) throw new HttpError(409, "worktree_request_reused", "다른 생성 요청에 사용한 식별자입니다.");
      return existing;
    }
    if (this.running.size >= 2) throw new HttpError(429, "worktree_busy", "다른 작업공간 생성이 끝난 뒤 다시 시도하세요.");
    if (normalized.parentWorkspaceId) this.spaces.requireActive(normalized.parentWorkspaceId, workId);
    const job = this.save({ id: normalized.requestId, workId, request: normalized, phase: "checking", createdAt: Date.now(), updatedAt: Date.now() });
    const abort = new AbortController();
    const done = Promise.resolve().then(() => this.create(job, abort.signal)).finally(() => this.running.delete(job.id));
    this.running.set(job.id, { abort, done });
    return job;
  }
  cancel(id: string) { const job = this.get(id); if (!terminal(job.phase)) this.running.get(id)?.abort.abort(); return this.get(id); }
  private async create(initial: WorktreeCreation, signal: AbortSignal) {
    let job = initial, descriptor: SessionWorktree | undefined;
    const attach = () => descriptor && this.spaces.connectWorktree(this.getWork(job.workId), descriptor, { managed: true, label: job.request.label, parentWorkspaceId: job.request.parentWorkspaceId });
    try {
      signal.throwIfAborted();
      const source = this.spaces.requireActive(job.request.sourceWorkspaceId, job.workId);
      const repo = await inspectRepository(source.cwd, signal);
      if (job.request.parentWorkspaceId) {
        const parent = this.spaces.requireActive(job.request.parentWorkspaceId, job.workId);
        if ((await inspectRepository(parent.cwd, signal)).commonDir !== repo.commonDir) throw new HttpError(409, "worktree_parent", "같은 저장소의 상위 작업공간을 선택하세요.");
      }
      await git(repo.root, ["check-ref-format", "--branch", job.request.branch], undefined, signal);
      const base = (await git(repo.root, ["rev-parse", "--verify", "--end-of-options", `${job.request.baseRef}^{commit}`], undefined, signal)).trim();
      if (job.request.expectedBase && base !== job.request.expectedBase) throw new HttpError(409, "worktree_base_changed", "선택한 기준 커밋이 바뀌었습니다. 새로고침한 뒤 다시 생성하세요.");
      const folder = createHash("sha256").update(job.id).digest("hex").slice(0, 24);
      const path = join(this.dataDir, "worktrees", folder);
      if (existsSync(path)) throw new HttpError(409, "worktree_path_exists", "생성 경로에 이미 파일이 있습니다. 기존 파일은 바꾸지 않았습니다.");
      mkdirSync(join(this.dataDir, "worktrees"), { recursive: true });
      job = this.save({ ...job, root: repo.root, path, branch: job.request.branch, base, phase: "creating" });
      await git(repo.root, ["worktree", "add", "-b", job.request.branch, path, base], undefined, signal);
      const subfolder = relative(repo.root, canonical(source.cwd));
      if (isAbsolute(subfolder) || subfolder === ".." || subfolder.startsWith(`..${sep}`)) throw new Error("기준 작업공간이 저장소 밖으로 바뀌었습니다.");
      const cwd = join(path, subfolder);
      mkdirSync(cwd, { recursive: true });
      descriptor = { root: repo.root, commonDir: repo.commonDir, path: canonical(path), cwd: canonical(cwd), branch: job.request.branch, base };
      const workspace = attach();
      this.save({ ...job, workspaceId: workspace?.id, phase: signal.aborted ? "canceled" : "ready", ...(signal.aborted ? { error: "생성은 완료됐지만 취소 요청이 들어왔습니다. 폴더와 브랜치는 보존했습니다." } : {}) });
    } catch (error) {
      // Git may have created its checkout before a hook/abort failed. Adopt only the exact
      // recorded path/branch/base, and never remove either the checkout or the branch here.
      if (!descriptor && job.path && job.root && job.base) {
        try {
          const repo = await inspectRepository(job.root);
          const tree = repo.worktrees.find((entry) => entry.path === canonical(job.path!) && entry.branch === job.branch && entry.head === job.base && !entry.missing);
          if (tree) descriptor = { root: repo.root, commonDir: repo.commonDir, path: tree.path, cwd: tree.path, branch: tree.branch, base: tree.head };
        } catch { /* retain the exact job path for explicit recovery */ }
      }
      let workspace: Workspace | undefined;
      try { workspace = attach() || undefined; } catch { /* job records remain even if metadata cannot be attached */ }
      this.save({ ...job, workspaceId: workspace?.id, phase: signal.aborted ? "canceled" : "failed", error: errorText(error).slice(0, 4000) });
    }
  }
  async shutdown() { this.stopped = true; for (const entry of this.running.values()) entry.abort.abort(); await Promise.all([...this.running.values()].map((entry) => entry.done)); }
}
