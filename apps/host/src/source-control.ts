import { randomUUID } from "node:crypto";
import type { ScmArea, ScmJob, ScmRequest, ScmStatus, ScmRemoteRequest, ScmRecordedRequest, ScmComparisonRequest, ScmComparisonPreferences } from "@workbench/contracts";
import type { Store } from "./store.ts";
import type { Workspaces } from "./workspaces.ts";
import { physicalPath, withinDirectory } from "./directory-operations.ts";
import { HttpError } from "./errors.ts";
import { scmText } from "./scm-git.ts";
import { readScmStatus, scmHash, scmPath } from "./scm-status.ts";
import { readScmDiff } from "./scm-diff.ts";
import { ScmRemotes, redactGit, remoteAction, validateRemoteRequest } from "./scm-remote.ts";
import { applyResolution, createScmRecovery, prepareResolution, readScmConflict, validateResolution } from "./scm-conflict.ts";
import { hunkAction, selectedHunkPatch, validateHunkSelection } from "./scm-hunks.ts";
import { ScmComparisons } from "./scm-comparison.ts";

const PREFIX = "scm-job:";
type Hooks = { sharedLinks: (root: string) => ReadonlySet<string>; assertIdle: (root: string) => void; assertWorkingIdle?: (root: string) => void };
function validateRequest(value: ScmRequest): ScmRequest {
  if (!value || typeof value.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(value.requestId) || typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRevision) || !["stage", "unstage", "commit", "fetch", "pull", "push", "resolve", "continue", "abort", "stage-hunks", "unstage-hunks"].includes(value.action)) throw new HttpError(400, "scm_request", "유효한 Git 작업과 최신 변경 상태가 필요합니다.");
  if (hunkAction(value.action)) return { requestId: value.requestId, expectedRevision: value.expectedRevision, action: value.action, selection: validateHunkSelection(value.selection) };
  if (value.action === "resolve") return { requestId: value.requestId, expectedRevision: value.expectedRevision, action: value.action, resolution: validateResolution(value.resolution) };
  if (value.action === "continue" || value.action === "abort") {
    if (!value.operation || !["merge", "rebase", "cherry-pick", "revert"].includes(value.operation) || value.action === "abort" && value.confirmAbort !== true) throw new HttpError(400, "scm_operation", "진행 중인 작업을 확인하고 취소할 때에는 파일 복구 영향을 확인하세요.");
    return { requestId: value.requestId, expectedRevision: value.expectedRevision, action: value.action, operation: value.operation, ...(value.action === "abort" ? { confirmAbort: true } : {}) };
  }
  if (remoteAction(value.action)) return { requestId: value.requestId, expectedRevision: value.expectedRevision, action: value.action, remote: validateRemoteRequest(value.remote) };
  if (value.action === "commit") {
    if (typeof value.message !== "string" || !value.message.trim() || value.message.includes("\0") || Buffer.byteLength(value.message) > 32 * 1024) throw new HttpError(400, "scm_message", "커밋 내용을 32 KiB 이내로 입력하세요.");
    return { requestId: value.requestId, expectedRevision: value.expectedRevision, action: value.action, message: value.message.trim() };
  }
  if (!Array.isArray(value.paths) || !value.paths.length || value.paths.length > 20_000 || value.paths.some((path) => typeof path !== "string")) throw new HttpError(400, "scm_paths", "변경 파일을 선택하세요.");
  const paths = [...new Set(value.paths.map(scmPath))].sort();
  if (Buffer.byteLength(paths.join("\0")) > 2 * 1024 * 1024) throw new HttpError(413, "scm_paths", "선택한 경로가 너무 많습니다.");
  return { requestId: value.requestId, expectedRevision: value.expectedRevision, action: value.action, paths };
}
function recordedRequest(request: ScmRequest): ScmRecordedRequest {
  if (!request.resolution) return request;
  const { content, ...resolution } = request.resolution;
  return { ...request, resolution: { ...resolution, ...(content !== undefined ? { contentHash: scmHash(content) } : {}) } };
}

export class SourceControl {
  private readonly comparisons = new ScmComparisons();
  private readonly remotes = new ScmRemotes();
  private readonly store: Store; private readonly spaces: Workspaces; private readonly hooks: Hooks;
  private readonly recoveryDir: string | undefined;
  private readonly running = new Map<string, { root: string; commonDir: string; done: Promise<void>; abort: AbortController }>();
  private readonly admitting = new Set<string>(); private stopped = false;
  private readonly pending = new Map<string, { key: string; done: Promise<ScmJob> }>();
  constructor(store: Store, spaces: Workspaces, hooks: Hooks, recoveryDir?: string) {
    this.store = store; this.spaces = spaces; this.hooks = hooks; this.recoveryDir = recoveryDir;
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
  async remoteInventory(workspaceId: string) { return this.remotes.inspect(await this.status(workspaceId)); }
  comparisonPreferences(workspaceId: string): ScmComparisonPreferences | null {
    this.spaces.get(workspaceId); const raw = this.store.getMeta(`scm-comparison-prefs:${workspaceId}`);
    return raw ? JSON.parse(raw) as ScmComparisonPreferences : null;
  }
  saveComparisonPreferences(workspaceId: string, value: ScmComparisonPreferences): ScmComparisonPreferences {
    this.spaces.get(workspaceId);
    if (!value || !["combined", "branch", "commit"].includes(value.mode) || typeof value.base !== "string" || typeof value.head !== "string" || value.base.length > 1024 || value.head.length > 1024 || /[\0\r\n]/.test(value.base + value.head) || typeof value.merge !== "boolean" || !Number.isInteger(value.parent) || value.parent < 1 || value.parent > 100 || typeof value.wrap !== "boolean") throw new HttpError(400, "scm_compare_preferences", "비교 설정 형식을 확인하세요.");
    const saved: ScmComparisonPreferences = { mode: value.mode, base: value.base, head: value.head, merge: value.merge, parent: value.parent, wrap: value.wrap };
    this.store.setMeta(`scm-comparison-prefs:${workspaceId}`, JSON.stringify(saved)); return saved;
  }
  async compare(workspaceId: string, request: ScmComparisonRequest) {
    const state = await this.status(workspaceId), workspace = this.spaces.get(workspaceId);
    const result = await this.comparisons.create(state, request, workspace.worktree?.base ?? (state.head ? "HEAD" : null));
    this.comparisons.assertCurrent(await this.status(workspaceId), result); return result;
  }
  async compareDiff(workspaceId: string, id: string, revision: string, path: string) {
    const result = await this.comparisons.diff(await this.status(workspaceId), id, revision, path);
    // Revalidate mutable endpoints after the patch and image reads as well.
    this.comparisons.assertCurrent(await this.status(workspaceId), { id, revision }); return result;
  }
  async conflict(workspaceId: string, path: string, expectedRevision: string) {
    const state = await this.status(workspaceId); this.assertRevision(state, expectedRevision);
    const result = await readScmConflict(state, path);
    this.assertRevision(await this.status(workspaceId), expectedRevision); return result;
  }
  async pushPreview(workspaceId: string, request: ScmRemoteRequest) {
    const state = await this.status(workspaceId), result = await this.remotes.preview(state, request);
    this.assertRevision(await this.status(workspaceId), state.revision); return result;
  }
  private assertRevision(state: ScmStatus, expected: string) {
    if (state.revision !== expected) throw new HttpError(409, "scm_changed", "검토한 뒤 Git 상태나 파일이 바뀌었습니다. 새로고침한 뒤 다시 확인하세요.");
  }
  async start(workspaceId: string, value: ScmRequest): Promise<ScmJob> {
    const request = validateRequest(value), existing = this.all().find((job) => job.request.requestId === request.requestId);
    if (existing) {
      if (existing.workspaceId !== workspaceId || JSON.stringify(existing.request) !== JSON.stringify(recordedRequest(request))) throw new HttpError(409, "scm_request_reused", "다른 Git 작업에 사용한 요청 ID입니다.");
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
      if (hunkAction(request.action)) {
        const selection = request.selection!, diff = await readScmDiff(state, selection.path, request.action === "stage-hunks" ? "working" : "staged");
        selectedHunkPatch(diff, selection); this.assertRevision(await this.status(workspaceId), request.expectedRevision);
      } else if (["resolve", "continue", "abort"].includes(request.action)) {
        this.hooks.assertWorkingIdle?.(state.root);
        if ((request.action === "resolve" || request.action === "abort") && !this.recoveryDir) throw new HttpError(503, "scm_recovery", "복구 파일을 보관할 앱 데이터 폴더가 필요합니다.");
        if (request.action === "resolve") await prepareResolution(state, request.resolution!);
        else {
          if (!state.operation || state.operation !== request.operation) throw new HttpError(409, "scm_operation", "진행 중인 Git 작업이 바뀌었습니다. 새로고침하세요.");
          if (request.action === "continue" && state.files.some((file) => file.conflicted)) throw new HttpError(409, "scm_conflicts", "남은 충돌을 해결하고 스테이징한 뒤 계속하세요.");
        }
        this.assertRevision(await this.status(workspaceId), request.expectedRevision);
      } else if (remoteAction(request.action)) {
        await this.remotes.validate(state, { request });
        if (request.action === "pull") this.hooks.assertWorkingIdle?.(state.root);
      } else if (request.action === "commit") {
        if (state.files.some((file) => file.conflicted)) throw new HttpError(409, "scm_conflicts", "충돌을 해결하고 스테이징한 뒤 커밋하세요.");
        if (state.operation && state.operation !== "merge") throw new HttpError(409, "scm_operation", "진행 중인 Git 작업을 해당 계속 명령으로 마무리하세요.");
        if (!state.files.some((file) => file.index !== "." && file.index !== "?") && state.operation !== "merge") throw new HttpError(409, "scm_no_staged", "먼저 커밋할 파일을 스테이징하세요.");
      } else {
        for (const path of request.paths!) {
          const file = state.files.find((entry) => entry.path === path);
          if (file?.conflicted) throw new HttpError(409, "scm_conflicts", "충돌 파일은 3방향 검토에서 해결 내용을 확인하고 스테이징하세요.");
          if (!file || (request.action === "stage" ? file.working === "." && !file.conflicted : [".", "?"].includes(file.index))) throw new HttpError(409, "scm_file", "선택한 변경이 없습니다. 새로고침해 주세요.");
        }
      }
      const now = Date.now(), job = this.save({ id: randomUUID(), workspaceId, root: state.root, commonDir: state.commonDir, request: recordedRequest(request), branch: state.branch, headBefore: state.head, headAfter: null, phase: "running", output: "", outputTruncated: false, error: null, createdAt: now, updatedAt: now });
      const abort = new AbortController(), unlock = release; release = null;
      const done = Promise.resolve().then(() => this.run(job, state, abort.signal, request)).finally(() => { unlock(); this.running.delete(job.id); });
      this.running.set(job.id, { root: state.root, commonDir: state.commonDir, done, abort });
      return job;
    } finally { release?.(); this.admitting.delete(state.commonDir); }
  }
  private async run(initial: ScmJob, state: ScmStatus, signal: AbortSignal, request: ScmRequest) {
    let job = initial, pendingOutput = "";
    const persistOutput = (text: string) => { if (!text) return; const output = job.output + redactGit(text); job = this.save({ ...job, output: output.slice(-128 * 1024), outputTruncated: job.outputTruncated || output.length > 128 * 1024 }); };
    // Do not persist a credential URL split across subprocess chunks before its line is complete.
    const append = (text: string) => { pendingOutput += text; const at = Math.max(pendingOutput.lastIndexOf("\n"), pendingOutput.lastIndexOf("\r")); if (at >= 0) { persistOutput(pendingOutput.slice(0, at + 1)); pendingOutput = pendingOutput.slice(at + 1); } if (pendingOutput.length > 128 * 1024) { persistOutput("\n… (너무 긴 출력 행은 생략했습니다)\n"); pendingOutput = ""; } };
    try {
      let args: string[], input: string;
      const assertCurrent = async () => this.assertRevision(await this.status(job.workspaceId), state.revision);
      if (hunkAction(request.action)) {
        const selection = request.selection!, diff = await readScmDiff(state, selection.path, request.action === "stage-hunks" ? "working" : "staged");
        const patch = selectedHunkPatch(diff, selection), args = ["apply", "--cached", "--whitespace=nowarn", ...(request.action === "unstage-hunks" ? ["--reverse"] : [])];
        await assertCurrent();
        await scmText(job.root, [...args, "--check", "-"], { input: patch, signal, onOutput: append });
        await assertCurrent();
        await scmText(job.root, [...args, "-"], { input: patch, signal, onOutput: append });
        append(`${selection.path}: ${selection.hunks.length}개 구간 ${request.action === "stage-hunks" ? "스테이징" : "스테이징 취소"}. 작업 파일은 그대로 유지했습니다.\n`);
        job = { ...job, phase: "complete" }; return;
      }
      if (request.action === "resolve" || request.action === "abort") {
        const view = request.action === "resolve" ? await prepareResolution(state, request.resolution!) : null;
        const paths = request.action === "resolve" ? [request.resolution!.path] : state.files.filter((file) => file.index !== "?").flatMap((file) => file.oldPath ? [file.path, file.oldPath] : [file.path]);
        const recoveryPath = await createScmRecovery(state, paths, this.recoveryDir!, job.id, (path) => { job = this.save({ ...job, recoveryPath: path }); });
        job = this.save({ ...job, recoveryPath }); await assertCurrent();
        if (view) await applyResolution(state, request.resolution!, view, { signal, onOutput: append }, assertCurrent);
        else await scmText(job.root, ["-c", "submodule.recurse=false", request.operation!, "--abort"], { signal, onOutput: append });
        job = { ...job, phase: "complete" }; return;
      }
      if (request.action === "continue") {
        await assertCurrent();
        await scmText(job.root, ["-c", "submodule.recurse=false", request.operation!, "--continue"], { signal, onOutput: append });
        job = { ...job, phase: "complete" }; return;
      }
      if (remoteAction(request.action)) {
        await this.remotes.run(job, state, { signal, onOutput: append }, () => this.status(job.workspaceId), (remoteResults) => { job = this.save({ ...job, remoteResults }); });
        job = { ...job, phase: "complete" }; return;
      }
      if (request.action === "commit") { args = ["commit", "--file=-"]; input = request.message! + "\n"; }
      else {
        const selected = state.files.filter((file) => request.paths!.includes(file.path));
        const paths = [...new Set(selected.flatMap((file) => file.oldPath && request.action === "unstage" ? [file.oldPath, file.path] : [file.path]))];
        input = paths.join("\0") + "\0";
        args = request.action === "stage" ? ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"] : state.head ? ["restore", "--staged", "--source=" + state.head, "--pathspec-from-file=-", "--pathspec-file-nul"] : ["rm", "--cached", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"];
      }
      await scmText(job.root, args, { input, signal, onOutput: append });
      job = { ...job, phase: "complete" };
    } catch (error) { job = { ...job, phase: signal.aborted ? "interrupted" : "failed", error: redactGit(error instanceof Error ? error.message : String(error)) }; }
    finally { const phase = job.phase; job = { ...job, phase: "running" }; persistOutput(pendingOutput); const headAfter = (await scmText(job.root, ["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim() || null; this.save({ ...job, phase, headAfter }); }
  }
  async interrupt(id: string) {
    const entry = this.running.get(id); if (entry) { entry.abort.abort(); await entry.done; }
    return this.get(id);
  }
  async shutdown() { this.stopped = true; this.comparisons.clear(); await this.remotes.shutdown(); await Promise.allSettled([...this.pending.values()].map((entry) => entry.done)); for (const entry of this.running.values()) entry.abort.abort(); await Promise.allSettled([...this.running.values()].map((entry) => entry.done)); }
}
