import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ApplyPreparationRequest, PreparationJob, PreparationOptions, PreparationPreview, Work, Workspace, WorkspaceEnvironment } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { physicalPath, withinDirectory } from "./directory-operations.ts";
import { defaultEnvironment, digest, readIncludes, readOrca, selectHook, validateEnvironment } from "./preparation-config.ts";
import { materializePath, previewPaths } from "./preparation-paths.ts";
import type { Store } from "./store.ts";
import type { Workspaces } from "./workspaces.ts";
import type { Terminals } from "./terminals.ts";
import { inspectRepository } from "./worktree-workspaces.ts";

const finished = (phase: PreparationJob["phase"]) => ["complete", "failed", "canceled", "interrupted"].includes(phase);
const text = (error: unknown) => error instanceof Error ? error.message : String(error);
function checkoutRoot(cwd: string) {
  let at = resolve(cwd);
  for (;;) { if (existsSync(join(at, ".git"))) return physicalPath(at); const parent = dirname(at); if (parent === at) throw new HttpError(409, "preparation_repository", "Git 저장소에서 환경을 준비할 수 있습니다."); at = parent; }
}
function options(value: PreparationOptions): PreparationOptions {
  if (!value || !["setup", "archive"].includes(value.kind) || [value.applyPaths, value.runCommands, value.openTabs].some((flag) => typeof flag !== "boolean")) throw new HttpError(400, "preparation_options", "준비할 항목을 선택해 주세요.");
  return { kind: value.kind, applyPaths: value.kind === "setup" && value.applyPaths, runCommands: value.runCommands, openTabs: value.kind === "setup" && value.openTabs };
}

export class WorkspacePreparation {
  private readonly store: Store; private readonly spaces: Workspaces; private readonly terminals: Terminals;
  private readonly dataDir: string; private readonly work: (id: string) => Work;
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void>; owned: Set<string> }>();
  private stopped = false;
  constructor(store: Store, spaces: Workspaces, terminals: Terminals, dataDir: string, work: (id: string) => Work) {
    this.store = store; this.spaces = spaces; this.terminals = terminals; this.dataDir = dataDir; this.work = work;
    for (const job of store.preparations()) if (!finished(job.phase)) this.save({ ...job, phase: "interrupted", error: "앱이 종료되어 준비를 중단했습니다. 남은 파일·출력을 확인한 뒤 새 미리보기에서 진행하세요. 명령은 다시 실행하지 않았습니다." });
  }
  private save(job: PreparationJob) { const next = { ...job, updatedAt: Date.now() }; this.store.savePreparation(next); return next; }
  get(id: string) { const job = this.store.preparations().find((entry) => entry.id === id); if (!job) throw new HttpError(404, "preparation_missing", "환경 준비 기록이 없습니다."); return job; }
  list(workspaceId: string) { this.spaces.get(workspaceId); return this.store.preparations().filter((entry) => entry.workspaceId === workspaceId).slice(0, 100); }
  settings(workId: string): WorkspaceEnvironment {
    this.work(workId); const raw = this.store.getMeta(`environment:${workId}`);
    return raw ? JSON.parse(raw) as WorkspaceEnvironment : defaultEnvironment();
  }
  saveSettings(workId: string, expected: unknown, value: unknown) {
    const current = this.settings(workId);
    if (expected !== current.revision) throw new HttpError(409, "environment_conflict", "다른 창에서 개인 설정을 바꿨습니다. 다시 불러온 뒤 저장하세요.");
    const next = { ...validateEnvironment(value), revision: current.revision + 1 };
    this.store.setMeta(`environment:${workId}`, JSON.stringify(next)); return next;
  }
  busy(cwd: string) {
    const root = physicalPath(cwd);
    return [...this.running.keys()].some((id) => { const job = this.get(id); if (finished(job.phase)) return false; const path = job.preview.target; return withinDirectory(root, path) || withinDirectory(path, root); });
  }
  /** A directory-only ignore rule does not match its replacement symlink. Hide only our
   * unchanged, still-untracked shared links; changed/staged links remain ordinary Git changes. */
  sharedLinks(target: string) {
    const root = physicalPath(target), result = new Set<string>();
    for (const job of this.store.preparations()) if (job.preview.target === root) {
      for (const applied of job.pathResults) if (applied.outcome === "shared") {
        const entry = job.preview.paths.find((entry) => entry.path === applied.path && entry.mode === "share");
        try { if (entry && lstatSync(entry.target).isSymbolicLink() && physicalPath(entry.target) === entry.source) result.add(entry.path); } catch { /* Removed/replaced entries are not ours to hide. */ }
      }
    }
    return result;
  }
  private configuration(workspace: Workspace, kind: "setup" | "archive") {
    const primary = checkoutRoot(this.work(workspace.workId).cwd), target = workspace.worktree ? physicalPath(workspace.worktree.path) : checkoutRoot(workspace.cwd);
    const original = readOrca(primary), checkedOut = target === primary ? original : readOrca(target), local = this.settings(workspace.workId);
    const selected = kind === "archive" ? selectHook(original.archive, local.archiveScript, local.archiveSource) : selectHook(checkedOut.setup, local.setupScript, local.setupSource);
    const hook = { ...selected, digest: digest([kind, primary, target, selected, local.bashPath]) };
    const waitForSetup = checkedOut.wait || local.waitForSetup;
    return { primary, target, original, checkedOut, local, hook, waitForSetup };
  }
  assertArchiveReady(workspace: Workspace) {
    if (!workspace.worktree) return;
    const { hook } = this.configuration(workspace, "archive");
    if (hook.script && this.list(workspace.id).find((job) => job.preview.options.kind === "archive" && job.preview.hook.digest === hook.digest)?.phase !== "complete") throw new HttpError(409, "archive_hook_required", "보관 명령을 먼저 확인하세요. 작업공간 → 환경 준비에서 실행을 마치거나 명령 건너뛰기를 선택한 뒤 보관·제거할 수 있습니다.");
  }
  assertAgentReady(workspaceId: string) {
    const workspace = this.spaces.get(workspaceId); if (!workspace.worktree) return;
    const { hook, waitForSetup } = this.configuration(workspace, "setup");
    if (waitForSetup && hook.script && this.list(workspaceId).find((job) => job.preview.options.kind === "setup" && job.preview.hook.digest === hook.digest)?.phase !== "complete") throw new HttpError(409, "setup_required", "이 작업공간은 준비 완료 후 AI를 시작하도록 설정되어 있습니다. 환경 준비에서 명령을 완료하거나 명시적으로 건너뛰세요.");
  }
  async preview(workspaceId: string, request: PreparationOptions): Promise<PreparationPreview> {
    const workspace = this.spaces.get(workspaceId); this.spaces.requireActive(workspaceId, workspace.workId);
    const chosen = options(request), config = this.configuration(workspace, chosen.kind);
    const { primary, target, original, checkedOut, local, hook, waitForSetup } = config;
    const [sourceRepo, targetRepo] = await Promise.all([inspectRepository(primary), !existsSync(target) && chosen.kind === "archive" && !chosen.runCommands ? Promise.resolve(null) : inspectRepository(target)]);
    if (targetRepo && sourceRepo.commonDir !== targetRepo.commonDir) throw new HttpError(409, "preparation_repository", "기본 프로젝트와 같은 Git 저장소의 작업공간을 선택해 주세요.");
    const includes = readIncludes(primary), warnings = [...original.warnings, ...(target !== primary ? checkedOut.warnings : []), ...includes.warnings];
    const paths = chosen.applyPaths && primary !== target ? await previewPaths(primary, target, [
      ...local.sharedPaths.map((path) => ({ path, mode: "share" as const, origin: "local" as const })),
      ...original.shared.map((path) => ({ path, mode: "share" as const, origin: "orca.yaml" as const })),
      ...includes.paths.map((path) => ({ path, mode: "copy" as const, origin: ".worktreeinclude" as const })),
    ]) : [];
    if (primary === target && chosen.applyPaths) warnings.push("기본 체크아웃에서는 파일을 복사하거나 공유하지 않습니다.");
    if (paths.some((entry) => entry.links)) warnings.push("복사 폴더 안의 심볼릭 링크는 링크로 유지됩니다. 링크를 통해 수정하면 원본 대상에도 영향을 줍니다.");
    if (paths.some((entry) => !withinDirectory(primary, entry.source))) warnings.push("원본의 링크가 저장소 밖을 가리킵니다. 표시된 실제 원본 경로를 확인하세요.");
    const shell = process.platform === "win32" && !(hook.script.startsWith("#!") || local.bashPath) ? "cmd" as const : "bash" as const;
    if (process.platform === "win32" && shell === "bash" && !local.bashPath) warnings.push("Bash 스크립트를 실행하려면 개인 설정에서 Git Bash 경로를 지정해야 합니다.");
    const shellPath = shell === "cmd" ? process.env.ComSpec || "cmd.exe" : local.bashPath || "bash";
    const environment = { ORCA_ROOT_PATH: primary, ORCA_WORKTREE_PATH: target, ORCA_WORKSPACE_NAME: basename(target), CONDUCTOR_ROOT_PATH: primary, GHOSTX_ROOT_PATH: primary };
    const tabs = chosen.openTabs ? checkedOut.tabs.map((tab, index) => {
      const command = chosen.runCommands && hook.source !== "local-only" ? tab.command : null;
      const key = digest([workspaceId, index, tab.title, command, tab.color ?? null]);
      const id = `prep-tab-${key.slice(0, 40)}`;
      return { ...tab, command, key, terminalId: this.terminals.has(id) ? id : null };
    }) : [];
    const configRevision = digest([original.hash, checkedOut.hash, includes.hash, local]);
    const body = { workspaceId, workId: workspace.workId, primary, target, configRevision, options: chosen, hook, shell, shellPath, environment, waitForSetup, paths, tabs, warnings };
    return { ...body, revision: digest(body) };
  }
  async start(workspaceId: string, request: ApplyPreparationRequest): Promise<PreparationJob> {
    if (!request || !/^[\w-]{12,100}$/.test(request.requestId) || typeof request.expectedRevision !== "string") throw new HttpError(400, "preparation_request", "환경 준비 요청을 확인해 주세요.");
    const chosen = options(request.options);
    const existing = this.store.preparations().find((entry) => entry.id === request.requestId);
    if (existing) {
      if (existing.workspaceId !== workspaceId || existing.preview.revision !== request.expectedRevision || JSON.stringify(existing.preview.options) !== JSON.stringify(chosen)) throw new HttpError(409, "preparation_request_reused", "다른 환경 준비에 사용한 요청 ID입니다.");
      return existing;
    }
    if (this.stopped) throw new HttpError(503, "shutting_down", "앱을 종료 중입니다.");
    const preview = await this.preview(workspaceId, chosen);
    const duplicate = this.store.preparations().find((entry) => entry.id === request.requestId);
    if (duplicate) return this.start(workspaceId, request);
    if (preview.revision !== request.expectedRevision) throw new HttpError(409, "preparation_changed", "설정·원본·목적지가 미리보기 뒤 바뀌었습니다. 다시 확인해 주세요.");
    if (this.busy(preview.target)) throw new HttpError(409, "preparation_busy", "이 작업공간의 환경 준비가 진행 중입니다.");
    if (this.running.size >= 2) throw new HttpError(429, "preparation_limit", "진행 중인 환경 준비를 마친 뒤 다시 시도하세요.");
    if (chosen.runCommands && preview.hook.script && process.platform === "win32" && preview.shell === "bash" && !this.settings(preview.workId).bashPath) throw new HttpError(409, "preparation_bash", "Git Bash 실행 파일을 개인 설정에서 지정해 주세요.");
    const now = Date.now(), job = this.save({ id: request.requestId, workspaceId, workId: preview.workId, preview, phase: "queued", pathResults: [], terminalIds: [], hookTerminalId: null, error: null, createdAt: now, updatedAt: now });
    const abort = new AbortController(), owned = new Set<string>();
    const done = Promise.resolve().then(() => this.run(job, abort.signal, owned)).finally(() => this.running.delete(job.id));
    this.running.set(job.id, { abort, owned, done }); return job;
  }
  private script(job: PreparationJob, key: string, content: string) {
    const directory = join(this.dataDir, "preparation-runners", digest(job.id).slice(0, 32)); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const cmd = job.preview.shell === "cmd", path = join(directory, `${key}.${cmd ? "cmd" : "bash"}`);
    const body = cmd ? "@echo off\r\n" + content.split(/\r?\n/).filter((line) => line.trim()).map((line) => `call ${line}\r\nif errorlevel 1 exit /b %errorlevel%`).join("\r\n") + "\r\n" : "set -e\n" + content + "\n";
    writeFileSync(path, body, { flag: "wx", mode: 0o600 });
    return { shell: job.preview.shellPath, args: cmd ? ["/d", "/c", path] : ["-e", path] };
  }
  private async run(initial: PreparationJob, signal: AbortSignal, owned: Set<string>) {
    let job = initial;
    try {
      signal.throwIfAborted();
      const release = this.spaces.directoryOperations.acquire(job.preview.target);
      try {
        job = this.save({ ...job, phase: "paths" });
        for (const entry of job.preview.paths) {
          const outcome = await materializePath(job.preview.target, entry, signal);
          job = this.save({ ...job, pathResults: [...job.pathResults, { path: entry.path, outcome }] });
        }
      } finally { release(); }
      signal.throwIfAborted();
      if (physicalPath(job.preview.target) !== job.preview.target) throw new Error("작업공간의 실제 경로가 바뀌었습니다.");
      if (job.preview.options.runCommands && job.preview.hook.script) {
        job = this.save({ ...job, phase: "hook" });
        const terminal = this.terminals.create(job.workspaceId, { requestId: `prep-hook-${digest(job.id).slice(0, 40)}`, label: job.preview.options.kind === "setup" ? "환경 준비" : "보관 준비", ...this.script(job, "hook", job.preview.hook.script) }, { cwd: job.preview.target, environment: job.preview.environment });
        owned.add(terminal.id); job = this.save({ ...job, hookTerminalId: terminal.id, terminalIds: [...job.terminalIds, terminal.id] });
        const result = await this.terminals.waitForExit(terminal.id); signal.throwIfAborted();
        if (result.status !== "exited" || result.exitCode !== 0) throw new Error(`준비 명령이 성공하지 않았습니다 (${result.exitCode ?? result.status}). 터미널 출력을 확인하세요.`);
      }
      job = this.save({ ...job, phase: "tabs" });
      for (const [index, tab] of job.preview.tabs.entries()) {
        signal.throwIfAborted();
        const id = `prep-tab-${tab.key.slice(0, 40)}`;
        if (!this.terminals.has(id)) {
          this.terminals.create(job.workspaceId, { requestId: id, label: tab.title, ...(tab.command ? this.script(job, `tab-${index}`, tab.command) : {}) }, { cwd: job.preview.target, environment: job.preview.environment, color: tab.color });
          owned.add(id);
        }
        job = this.save({ ...job, terminalIds: [...job.terminalIds, id] });
      }
      this.save({ ...job, phase: "complete" });
    } catch (error) { this.save({ ...job, phase: signal.aborted ? "canceled" : "failed", error: text(error).slice(0, 4000) }); }
  }
  async cancel(id: string) {
    const job = this.get(id), active = this.running.get(id); if (!active || finished(job.phase)) return job;
    active.abort.abort(); await Promise.all([...active.owned].map((id) => this.terminals.close(id))); await active.done; return this.get(id);
  }
  async shutdown() { this.stopped = true; await Promise.all([...this.running.keys()].map((id) => this.cancel(id))); }
}
