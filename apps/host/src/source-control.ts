import { randomUUID } from "node:crypto";
import type { ScmArea, ScmJob, ScmRequest, ScmStatus } from "@workbench/contracts";
import type { Store } from "./store.ts";
import type { Workspaces } from "./workspaces.ts";
import { physicalPath, withinDirectory } from "./directory-operations.ts";
import { HttpError } from "./errors.ts";
import { scmText } from "./scm-git.ts";
import { readScmStatus, scmPath } from "./scm-status.ts";
import { readScmDiff } from "./scm-diff.ts";

const PREFIX = "scm-job:";
type Hooks = { sharedLinks: (root: string) => ReadonlySet<string>; assertIdle: (root: string) => void };
function validateRequest(value: ScmRequest): ScmRequest {
  if (!value || typeof value.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(value.requestId) || typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRevision) || !["stage", "unstage", "commit"].includes(value.action)) throw new HttpError(400, "scm_request", "유효한 Git 작업과 최신 변경 상태가 필요합니다.");
  if (value.action === "commit") {
    if (typeof value.message !== "string" || !value.message.trim() || value.message.includes("\0") || Buffer.byteLength(value.message) > 32 * 1024) throw new HttpError(400, "scm_message", "커밋 내용을 32 KiB 이내로 입력하세요.");
    return { requestId: value.requestId, expectedRevision: value.expectedRevision, action: value.action, message: value.message.trim() };
  }
  if (!Array.isArray(value.paths) || !value.paths.length || value.paths.length > 20_000 || value.paths.some((path) => typeof path !== "string")) throw new HttpError(400, "scm_paths", "변경 파일을 선택하세요.");
  const paths = [...new Set(value.paths.map(scmPath))].sort();
  if (Buffer.byteLength(paths.join("\0")) > 2 * 1024 * 1024) throw new HttpError(413, "scm_paths", "선택한 경로가 너무 많습니다.");
  return { requestId: value.requestId, expectedRevision: value.expectedRevision, action: value.action, paths };
}

export class SourceControl {
  private readonly store: Store; private readonly spaces: Workspaces; private readonly hooks: Hooks;
  private readonly running = new Map<string, { root: string; commonDir: string; done: Promise<void>; abort: AbortController }>();
  private readonly admitting = new Set<string>(); private stopped = false;
  private readonly pending = new Map<string, { key: string; done: Promise<ScmJob> }>();
  constructor(store: Store, spaces: Workspaces, hooks: Hooks) {
    this.store = store; this.spaces = spaces; this.hooks = hooks;
    for (const job of this.all()) if (job.phase === "running") this.save({ ...job, phase: "interrupted", error: "이전 앱 실행에서 결과를 확인하지 못했습니다. 현재 Git 상태를 먼저 확인하세요. 작업을 다시 실행하지 않았습니다." });
  }
  private all() { return this.store.metaEntries(PREFIX).map((row) => JSON.parse(row.value) as ScmJob); }
  private save(job: ScmJob) { const next = { ...job, updatedAt: Date.now() }; this.store.setMeta(PREFIX + job.id, JSON.stringify(next)); return next; }
  get(id: string) { const raw = this.store.getMeta(PREFIX + id); if (!raw) throw new HttpError(404, "scm_job", "Git 작업 기록이 없습니다."); return JSON.parse(raw) as ScmJob; }
  list(workspaceId: string) { this.spaces.get(workspaceId); return this.all().filter((job) => job.workspaceId === workspaceId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100); }
  busy(path: string) { const root = physicalPath(path); return [...this.running.values()].some((job) => withinDirectory(root, job.root) || withinDirectory(job.root, root)); }
  async status(workspaceId: string) {
    const space = this.spaces.get(workspaceId);
    if (space.hostId !== this.spaces.hostId || space.removedAt) throw new HttpError(409, "scm_workspace", "이 컴퓨터에 남아 있는 작업공간에서 Git 상태를 확인하세요.");
    return readScmStatus(space, this.hooks.sharedLinks(space.worktree?.path ?? space.cwd));
  }
  async diff(workspaceId: string, path: string, area: ScmArea, expectedRevision: string) {
    const state = await this.status(workspaceId); this.assertRevision(state, expectedRevision);
    const result = await readScmDiff(state, path, area);
    this.assertRevision(await this.status(workspaceId), expectedRevision);
    return result;
  }
  private assertRevision(state: ScmStatus, expected: string) {
    if (state.revision !== expected) throw new HttpError(409, "scm_changed", "검토한 뒤 Git 상태나 파일이 바뀌었습니다. 새로고침한 뒤 다시 확인하세요.");
  }
  async start(workspaceId: string, value: ScmRequest): Promise<ScmJob> {
    const request = validateRequest(value), existing = this.all().find((job) => job.request.requestId === request.requestId);
    if (existing) {
      if (existing.workspaceId !== workspaceId || JSON.stringify(existing.request) !== JSON.stringify(request)) throw new HttpError(409, "scm_request_reused", "다른 Git 작업에 사용한 요청 ID입니다.");
      return existing;
    }
    const key = JSON.stringify([workspaceId, request]), pending = this.pending.get(request.requestId);
    if (pending) {
      if (pending.key !== key) throw new HttpError(409, "scm_request_reused", "다른 Git 작업에 사용한 요청 ID입니다.");
      return pending.done;
    }
    const done = this.admit(workspaceId, request).finally(() => this.pending.delete(request.requestId));
    this.pending.set(request.requestId, { key, done }); return done;
  }
  private async admit(workspaceId: string, request: ScmRequest): Promise<ScmJob> {
    if (this.stopped) throw new HttpError(503, "scm_stopped", "앱이 종료 중입니다.");
    const space = this.spaces.get(workspaceId); this.spaces.requireActive(workspaceId, space.workId);
    const state = await this.status(workspaceId); this.assertRevision(state, request.expectedRevision);
    if (this.admitting.has(state.commonDir) || [...this.running.values()].some((job) => job.commonDir === state.commonDir)) throw new HttpError(409, "scm_busy", "같은 Git 저장소의 작업이 진행 중입니다. 결과를 확인한 뒤 진행하세요.");
    this.admitting.add(state.commonDir); let release: (() => void) | null = null;
    try {
      this.hooks.assertIdle(state.root);
      release = this.spaces.directoryOperations.acquire(state.root);
      this.assertRevision(await this.status(workspaceId), request.expectedRevision);
      if (this.stopped) throw new HttpError(503, "scm_stopped", "앱이 종료 중입니다.");
      if (request.action === "commit") {
        if (state.files.some((file) => file.conflicted)) throw new HttpError(409, "scm_conflicts", "충돌을 해결하고 스테이징한 뒤 커밋하세요.");
        if (state.operation && state.operation !== "merge") throw new HttpError(409, "scm_operation", "진행 중인 Git 작업을 해당 계속 명령으로 마무리하세요.");
        if (!state.files.some((file) => file.index !== "." && file.index !== "?") && state.operation !== "merge") throw new HttpError(409, "scm_no_staged", "먼저 커밋할 파일을 스테이징하세요.");
      } else {
        for (const path of request.paths!) {
          const file = state.files.find((entry) => entry.path === path);
          if (!file || (request.action === "stage" ? file.working === "." && !file.conflicted : [".", "?"].includes(file.index))) throw new HttpError(409, "scm_file", "선택한 변경이 없습니다. 새로고침해 주세요.");
        }
      }
      const now = Date.now(), job = this.save({ id: randomUUID(), workspaceId, root: state.root, commonDir: state.commonDir, request, branch: state.branch, headBefore: state.head, headAfter: null, phase: "running", output: "", outputTruncated: false, error: null, createdAt: now, updatedAt: now });
      const abort = new AbortController(), unlock = release; release = null;
      const done = Promise.resolve().then(() => this.run(job, state, abort.signal)).finally(() => { unlock(); this.running.delete(job.id); });
      this.running.set(job.id, { root: state.root, commonDir: state.commonDir, done, abort });
      return job;
    } finally { release?.(); this.admitting.delete(state.commonDir); }
  }
  private async run(initial: ScmJob, state: ScmStatus, signal: AbortSignal) {
    let job = initial;
    const append = (text: string) => { if (!text) return; const output = job.output + text; job = this.save({ ...job, output: output.slice(-128 * 1024), outputTruncated: job.outputTruncated || output.length > 128 * 1024 }); };
    try {
      const request = job.request; let args: string[], input: string;
      if (request.action === "commit") { args = ["commit", "--file=-"]; input = request.message! + "\n"; }
      else {
        const selected = state.files.filter((file) => request.paths!.includes(file.path));
        const paths = [...new Set(selected.flatMap((file) => file.oldPath && request.action === "unstage" ? [file.oldPath, file.path] : [file.path]))];
        input = paths.join("\0") + "\0";
        args = request.action === "stage" ? ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"] : state.head ? ["restore", "--staged", "--source=" + state.head, "--pathspec-from-file=-", "--pathspec-file-nul"] : ["rm", "--cached", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"];
      }
      await scmText(job.root, args, { input, signal, onOutput: append });
      job = { ...job, phase: "complete" };
    } catch (error) { job = { ...job, phase: signal.aborted ? "interrupted" : "failed", error: error instanceof Error ? error.message : String(error) }; }
    finally { const headAfter = (await scmText(job.root, ["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim() || null; this.save({ ...job, headAfter }); }
  }
  async interrupt(id: string) {
    const entry = this.running.get(id); if (entry) { entry.abort.abort(); await entry.done; }
    return this.get(id);
  }
  async shutdown() { this.stopped = true; await Promise.allSettled([...this.pending.values()].map((entry) => entry.done)); for (const entry of this.running.values()) entry.abort.abort(); await Promise.allSettled([...this.running.values()].map((entry) => entry.done)); }
}
