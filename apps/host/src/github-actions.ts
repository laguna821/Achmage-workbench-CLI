import { randomUUID } from "node:crypto";
import type { GitHubActionContext, GitHubActionInput, GitHubActionJob, GitHubActionPreview, GitHubDraft, GitHubEffect, GitHubMergeMethod, GitHubRecoveryPreview, GitHubView } from "@workbench/contracts";
import type { Store } from "./store.ts";
import type { GitHubReviews } from "./github.ts";
import { GitHubWriteError, githubRedact, type GitHubWrite, type GitHubWriter } from "./github-reader.ts";
import { array, integer, object, oid, sameRepo, string } from "./github-data.ts";
import { actionInput, actionLabels, actionQuery, actionText, branchName, mutation } from "./github-action-data.ts";
import { HttpError } from "./errors.ts";
import { scmHash } from "./scm-status.ts";
import { GitHubDiscussions, type DiscussionPlan } from "./github-discussions.ts";

type Snapshot = { data: GitHubActionContext; actorId: string; repoId: string; headRepoId: string; pullId: string; updatedAt: string; baseOid: string; remoteHead: string; enableAuto: boolean; disableAuto: boolean; mergeState: string; stamp: string };
type CI = { id: string; label: string; repo: string; check: number; run: number | null; attempt: number; oid: string; allowedOids: string[]; signature: string; lease: string };
type Prepared = { data: GitHubActionPreview; snapshot: Snapshot; ci: CI[]; existingNumbers: number[]; discussion?: DiscussionPlan };
type Record = { job: GitHubActionJob; snapshot: Snapshot; ci: CI[]; scope: string; fingerprint: string; asyncIds: { [effect: string]: string }; existingNumbers: number[]; createdNumber: number | null; discussion?: DiscussionPlan };
const prefix = "github-action:v1:";
const hash = (value: unknown) => scmHash(JSON.stringify(value));
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const fail = (message: string, code = "github_action_changed") => new HttpError(409, code, message);
const errorText = (reason: unknown) => githubRedact(reason instanceof Error ? reason.message : String(reason)).slice(0, 2000);
const failedConclusions = new Set(["failure", "cancelled", "timed_out", "startup_failure"]);
const writable = new Set(["WRITE", "MAINTAIN", "ADMIN"]);
const inFlight = new Set<GitHubEffect["phase"]>(["prepared", "sending", "accepted", "pending"]);
// A new view/baseline must not turn acknowledgement of an unknown result into a replay.
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const replayAction = (action: GitHubActionInput, discussion?: DiscussionPlan): unknown => action.kind === "discussion" ? discussion ? canonical({ kind: action.operation.kind, method: discussion.request.method, endpoint: discussion.request.endpoint, input: discussion.request.endpoint === "graphql" ? object(object(discussion.request.body).variables).input : discussion.request.body }) : action.operation
  : ["merge", "enqueue", "auto-enable"].includes(action.kind) ? { kind: "merge-or-schedule" }
  : action.kind === "create" ? { kind: "create", baseBranch: action.baseBranch } : action;

/** All externally visible effects are journaled before transmission. Recovery only reads. */
export class GitHubActions {
  readonly discussions: GitHubDiscussions;
  private store: Store; private reviews: GitHubReviews; private writer: GitHubWriter; private assertActive: (workspaceId: string) => void;
  private contexts = new Map<string, Snapshot>(); private previews = new Map<string, Prepared>();
  private recoveries = new Map<string, { data: GitHubRecoveryPreview; snapshot: Snapshot; journal: string }>();
  private running = new Map<string, Promise<void>>(); private reconciling = new Map<string, Promise<GitHubActionJob>>();
  private stopped = false;
  constructor(store: Store, reviews: GitHubReviews, assertActive: (workspaceId: string) => void, writer = reviews.reader as typeof reviews.reader & GitHubWriter) {
    this.store = store; this.reviews = reviews; this.writer = writer; this.assertActive = assertActive;
    this.discussions = new GitHubDiscussions(store, reviews, (id) => this.active(id));
    for (const record of this.records()) {
      let changed = false;
      for (const effect of record.job.effects) {
        if (effect.phase === "sending") { effect.phase = "uncertain"; effect.detail = "앱이 종료되어 전송 결과를 확인하지 못했습니다. 원격 상태만 다시 확인합니다."; changed = true; }
        if (effect.phase === "prepared") { effect.phase = "failed"; effect.detail = "앱 종료 전에 전송하지 않았습니다."; changed = true; }
      }
      if (changed) this.save(record);
    }
  }
  private active(workspaceId: string) { if (this.stopped) throw fail("GitHub 작업을 종료했습니다."); this.assertActive(workspaceId); }
  private records() { return this.store.metaEntries(prefix).map((row) => JSON.parse(row.value) as Record); }
  private record(workspaceId: string, id: string) {
    const raw = this.store.getMeta(prefix + id), record: Record | null = raw ? JSON.parse(raw) : null;
    if (!record || record.job.workspaceId !== workspaceId) throw new HttpError(404, "github_action_job", "이 작업공간의 GitHub 실행 기록이 아닙니다.");
    return record;
  }
  private save(record: Record) {
    const phases = record.job.effects.map((effect) => effect.phase), someDone = phases.includes("complete");
    record.job.phase = phases.some((p) => p === "prepared" || p === "sending") ? "running" : phases.includes("pending") || phases.includes("accepted") ? "pending" : phases.every((p) => p === "complete") ? "complete" : someDone ? "partial" : phases.includes("uncertain") ? "uncertain" : phases.includes("changed") ? "changed" : "failed";
    record.job.detail = record.job.effects.map((effect) => `${effect.label}: ${effect.detail}`).join("\n"); record.job.updatedAt = Date.now();
    this.store.setMeta(prefix + record.job.id, JSON.stringify(record)); return copy(record.job);
  }
  list(workspaceId: string) { this.active(workspaceId); return this.records().filter((item) => item.job.workspaceId === workspaceId).sort((a, b) => b.job.createdAt - a.job.createdAt).slice(0, 100).map((item) => item.job); }
  private blocks(record: Record) { return record.job.effects.some((effect) => inFlight.has(effect.phase) || effect.phase === "uncertain" && !record.job.recovery?.effects.some((old) => old.id === effect.id && old.phase === "uncertain")); }
  private recoverable(record: Record) {
    if (this.running.has(record.job.id) || this.reconciling.has(record.job.id) || record.job.effects.some((effect) => inFlight.has(effect.phase))) throw fail("전송 중이거나 원격 처리 중인 요청은 해제할 수 없습니다.", "github_recovery_busy");
    if (record.job.recovery || !record.job.effects.some((effect) => effect.phase === "uncertain")) throw fail("아직 확인되지 않은 요청만 검토할 수 있습니다. 실행 기록을 다시 확인하세요.", "github_recovery_changed");
  }
  private recoveryScope(record: Record, current: Snapshot) {
    const old = record.snapshot, a = old.data, b = current.data;
    if (old.actorId !== current.actorId || old.repoId !== current.repoId || old.headRepoId !== current.headRepoId || old.pullId !== current.pullId || a.number !== b.number || a.headBranch !== b.headBranch) throw fail("미확정 요청의 계정·저장소·PR·브랜치와 현재 화면이 다릅니다. 원래 대상을 선택하고 원격 결과를 확인하세요.", "github_recovery_changed");
  }
  async prepareRecovery(workspaceId: string, id: string, contextId: string) {
    const snapshot = this.context(workspaceId, contextId);
    this.recoverable(this.record(workspaceId, id));
    await this.get(workspaceId, id, true);
    await this.current(snapshot);
    const record = this.record(workspaceId, id); this.recoverable(record); this.recoveryScope(record, snapshot);
    const data: GitHubRecoveryPreview = {
      id: randomUUID(), expiresAt: Date.now() + 5 * 60000, job: copy(record.job), actor: snapshot.data.actor,
      repo: snapshot.data.repo, number: snapshot.data.number, headOid: snapshot.data.headOid, baseBranch: snapshot.data.baseBranch,
      notices: ["이 요청의 성공·실패는 확정되지 않았으며 나중에 원격에 반영될 수 있습니다.", "원래 요청·미확정 결과를 보존하고 다른 작업만 허용합니다. 같은 요청과 같은 CI 회차를 다시 보내지 않습니다.", "이 확인은 앱의 실행 기록만 바꿉니다. GitHub 요청을 취소하거나 다시 실행하지 않습니다."],
    };
    this.remember(this.recoveries, data.id, { data, snapshot: copy(snapshot), journal: hash(record.job) }); return copy(data);
  }
  async acknowledgeRecovery(workspaceId: string, id: string, previewId: string) {
    this.active(workspaceId); const before = this.record(workspaceId, id);
    if (before.job.recovery?.previewId === previewId) return copy(before.job);
    const preview = this.recoveries.get(previewId);
    if (!preview || preview.data.job.id !== id || preview.data.job.workspaceId !== workspaceId || preview.data.expiresAt < Date.now()) throw fail("미확정 기록의 검토가 만료되었습니다. 다시 확인하세요.", "github_recovery_changed");
    this.recoverable(before);
    await this.current(preview.snapshot);
    await this.reviews.actionScope(workspaceId, preview.snapshot.data.viewId, preview.snapshot.data.viewRevision);
    this.active(workspaceId);
    return this.store.transaction(() => {
      const record = this.record(workspaceId, id);
      if (record.job.recovery?.previewId === previewId) return copy(record.job);
      this.recoverable(record); this.recoveryScope(record, preview.snapshot);
      if (hash(record.job) !== preview.journal || preview.data.expiresAt < Date.now()) throw fail("검토 중 실행 기록이 바뀌었습니다. 원격 결과와 미확정 내용을 다시 확인하세요.", "github_recovery_changed");
      record.job.recovery = { previewId, acknowledgedAt: Date.now(), actor: preview.data.actor, headOid: preview.data.headOid, effects: copy(record.job.effects) };
      return this.save(record);
    });
  }
  private remember<T>(map: Map<string, T>, id: string, value: T) { map.set(id, value); while (map.size > 64) map.delete(map.keys().next().value!); }
  private context(workspaceId: string, id: string) {
    this.active(workspaceId); const snapshot = this.contexts.get(id);
    if (!snapshot || snapshot.data.workspaceId !== workspaceId) throw fail("PR 작업 정보가 만료되었습니다. 다시 확인하세요."); return snapshot;
  }
  private async snapshot(view: Pick<GitHubView, "id" | "revision" | "workspaceId" | "head" | "base" | "pull" | "localHead">): Promise<Snapshot> {
    const [owner, repo] = view.base.repo.split("/"), [headOwner, headRepo] = view.head.repo.split("/"), headBranch = view.head.branch!;
    const raw = object(await this.reviews.reader.json("graphql", { query: actionQuery, variables: { owner, repo, headOwner, headRepo, ref: `refs/heads/${headBranch}`, number: view.pull?.number ?? 0, hasPull: !!view.pull } }, true));
    const result = object(raw.data), actor = object(result.viewer), base = object(result.repository), head = object(result.head), p = object(base.pullRequest);
    if (!string(actor.id) || !string(actor.login) || !string(base.id) || !string(head.id) || !sameRepo(string(base.nameWithOwner), view.base.repo) || !sameRepo(string(head.nameWithOwner), view.head.repo)) throw fail("로그인 계정이나 저장소 식별자를 확인하지 못했습니다.");
    const remoteHead = oid(object(object(head.ref).target).oid) ?? "";
    if (view.pull && (!string(p.id) || p.number !== view.pull.number || p.headRefName !== headBranch || !sameRepo(string(object(p.headRepository).nameWithOwner), view.head.repo) || object(p.headRepository).id !== head.id || !oid(p.headRefOid) || !oid(p.baseRefOid))) throw fail("PR의 원본 저장소·브랜치를 확인하지 못했습니다.");
    if (!view.pull && (!remoteHead || !view.localHead || remoteHead !== view.localHead)) throw fail("현재 로컬 커밋을 선택한 원격 브랜치로 먼저 보내세요. Git 변경의 푸시 기능에서 대상을 확인할 수 있습니다.", "github_head_unpublished");
    const stack = object(p.stack), entries = object(stack.entries), layers = array(entries.nodes).map((item) => { const e = object(item), pr = object(e.pullRequest); return { number: integer(pr.number) ?? 0, title: string(pr.title, 1024), position: Number(e.position), oid: oid(pr.headRefOid) ?? "", state: string(pr.state), draft: pr.isDraft === true, checks: string(object(pr.statusCheckRollup).state), review: string(pr.reviewDecision) }; });
    const methods: GitHubMergeMethod[] = []; if (base.mergeCommitAllowed === true) methods.push("merge"); if (base.squashMergeAllowed === true) methods.push("squash"); if (base.rebaseMergeAllowed === true) methods.push("rebase");
    const defaultMethod = string(base.viewerDefaultMergeMethod).toLowerCase() as GitHubMergeMethod;
    const data: GitHubActionContext = {
      id: randomUUID(), workspaceId: view.workspaceId, viewId: view.id, viewRevision: view.revision, actor: string(actor.login), repo: view.base.repo, headRepo: view.head.repo, headBranch,
      headOid: view.pull ? string(p.headRefOid) : remoteHead, baseBranch: view.pull ? string(p.baseRefName) : string(object(base.defaultBranchRef).name), number: view.pull?.number ?? null,
      canUpdate: view.pull ? p.viewerCanUpdate === true : true, canMerge: writable.has(string(base.viewerPermission)), methods, defaultMethod: methods.includes(defaultMethod) ? defaultMethod : methods[0] ?? "squash",
      autoAllowed: base.autoMergeAllowed === true, autoEnabled: !!p.autoMergeRequest, queueRequired: p.isMergeQueueEnabled === true, queued: p.isInMergeQueue === true,
      stack: integer(stack.number) ? { number: Number(stack.number), layers, complete: entries.pageInfo !== undefined && object(entries.pageInfo).hasNextPage === false && layers.length === stack.size && layers.every((layer) => layer.number > 0 && layer.oid && Number.isSafeInteger(layer.position)) } : null,
      state: view.pull ? string(p.state).toLowerCase() : "new", draft: p.isDraft === true, title: string(p.title, 1024), body: string(p.body), notices: [],
    };
    if (data.stack) data.notices.push(`등록된 스택 #${data.stack.number}입니다. 병합하면 선택 PR까지의 열린 하위 PR도 함께 처리합니다.`);
    if (data.queueRequired) data.notices.push("이 기준 브랜치는 병합 대기열을 사용합니다. 등록 완료와 실제 병합 완료를 구분합니다.");
    const fields = { actorId: string(actor.id), repoId: string(base.id), headRepoId: string(head.id), pullId: string(p.id), updatedAt: string(p.updatedAt), baseOid: string(p.baseRefOid), remoteHead, enableAuto: p.viewerCanEnableAutoMerge === true, disableAuto: p.viewerCanDisableAutoMerge === true, mergeState: string(p.mergeStateStatus) };
    const { id: _id, viewId: _view, viewRevision: _revision, workspaceId: _workspace, notices: _notices, ...stable } = data;
    return { data, ...fields, stamp: hash([stable, fields]) };
  }
  async inspect(workspaceId: string, id: string, revision: string) {
    this.active(workspaceId); const scope = await this.reviews.actionScope(workspaceId, id, revision);
    if (scope.view.stale || !scope.view.pull && scope.view.candidates.length) throw fail("PR을 새로고침하고 작업할 PR 하나를 선택하세요.");
    const snapshot = await this.snapshot(scope.view);
    if (scope.view.pull && (snapshot.data.headOid !== scope.view.pull.headOid || snapshot.baseOid !== scope.view.pull.baseOid || snapshot.data.title !== scope.view.pull.title || snapshot.data.body !== scope.view.pull.body || snapshot.data.state !== scope.view.pull.state || snapshot.data.draft !== scope.view.pull.draft)) throw fail("PR 내용이 검토 화면과 달라졌습니다. PR을 새로고침하세요.");
    await this.reviews.actionScope(workspaceId, id, revision); this.remember(this.contexts, snapshot.data.id, snapshot); return copy(snapshot.data);
  }
  private draftKey(s: Snapshot) { return `github-draft:v1:${hash([s.data.workspaceId, s.repoId, s.headRepoId, s.data.headBranch, s.data.number])}`; }
  draft(workspaceId: string, contextId: string): GitHubDraft {
    const s = this.context(workspaceId, contextId), raw = this.store.getMeta(this.draftKey(s));
    return raw ? JSON.parse(raw) : { version: 0, title: s.data.title, body: s.data.body, baseBranch: s.data.baseBranch, draft: s.data.number ? s.data.draft : true, maintainerCanModify: false };
  }
  saveDraft(workspaceId: string, contextId: string, value: GitHubDraft) {
    const s = this.context(workspaceId, contextId), title = actionText(value.title, 1024, "제목"), body = actionText(value.body, 65536, "설명"), baseBranch = actionText(value.baseBranch, 1024, "기준 브랜치");
    if (typeof value.draft !== "boolean" || typeof value.maintainerCanModify !== "boolean") throw fail("초안 설정을 확인하세요.");
    return this.store.transaction(() => { const old = this.draft(workspaceId, contextId); if (old.version !== value.version) throw fail("다른 창에서 PR 초안이 바뀌었습니다. 입력을 유지한 채 저장된 초안을 다시 확인하세요.", "github_draft_conflict"); const next = { version: old.version + 1, title, body, baseBranch, draft: value.draft, maintainerCanModify: value.maintainerCanModify }; this.store.setMeta(this.draftKey(s), JSON.stringify(next)); return next; });
  }
  private async current(s: Snapshot) {
    this.active(s.data.workspaceId);
    const { view } = await this.reviews.actionScope(s.data.workspaceId, s.data.viewId, s.data.viewRevision), now = await this.snapshot(view);
    if (now.stamp !== s.stamp) throw fail("계정·PR 내용·커밋·권한이 바뀌었습니다. 새로고침한 뒤 실행 내용을 다시 확인하세요.");
    return now;
  }
  private async ref(repo: string, branch: string) {
    const value = object(await this.reviews.reader.json(`repos/${repo}/git/ref/heads/${encodeURIComponent(branchName(branch))}`, undefined, true));
    if (value.ref !== `refs/heads/${branch}` || !oid(object(value.object).sha)) throw fail("기준 브랜치를 확인하지 못했습니다."); return string(object(value.object).sha);
  }
  private async ciState(ci: CI) {
    const check = object(await this.reviews.reader.json(`repos/${ci.repo}/check-runs/${ci.check}`, undefined, true));
    if (check.id !== ci.check || check.head_sha !== ci.oid) throw fail("검사의 커밋이 바뀌었습니다.");
    if (!ci.run) return { attempt: 0, status: string(check.status), conclusion: string(check.conclusion), signature: hash([check.id, check.head_sha, check.status, check.conclusion, check.started_at, check.completed_at]) };
    const run = object(await this.reviews.reader.json(`repos/${ci.repo}/actions/runs/${ci.run}`, undefined, true));
    if (run.id !== ci.run || !integer(run.run_attempt) || !ci.allowedOids.includes(string(run.head_sha)) || !sameRepo(string(object(run.repository).full_name), ci.repo)) throw fail("Actions 실행의 저장소·커밋을 확인하지 못했습니다.");
    return { attempt: Number(run.run_attempt), status: string(run.status), conclusion: string(run.conclusion), signature: hash([run.id, run.head_sha, run.run_attempt, run.status, run.conclusion]) };
  }
  async prepare(workspaceId: string, contextId: string, raw: unknown) {
    const s = this.context(workspaceId, contextId), action = actionInput(raw), d = s.data, ci: CI[] = [], existingNumbers: number[] = [];
    await this.current(s);
    let discussion: DiscussionPlan | undefined;
    if (action.kind === "discussion") {
      if (!d.number) throw fail("리뷰할 PR을 선택하세요.");
      discussion = await this.discussions.prepare(workspaceId, d, action.discussionId, action.revision, action.operation);
    } else if (action.kind === "create") {
      if (d.number) throw fail("이미 연결된 PR이 있습니다."); await this.ref(d.repo, action.baseBranch); if (sameRepo(d.repo, d.headRepo) && action.baseBranch === d.headBranch) throw fail("작업 브랜치와 기준 브랜치는 달라야 합니다.");
      const previous = array(await this.reviews.reader.json(this.creationLookup(d, action.baseBranch), undefined, true));
      if (previous.length >= 100) throw fail("같은 브랜치의 이전 PR이 너무 많아 생성 복구 기준을 확정하지 못했습니다.");
      for (const item of previous) { const p = object(item); if (p.state === "open") throw fail("이 대상에 열린 PR이 생겼습니다. 새로고침하세요."); const number = integer(p.number); if (number) existingNumbers.push(number); }
    }
    else {
      if (!d.number || d.state === "merged") throw fail("작업할 미병합 PR을 선택하세요.");
      if (action.kind !== "rerun" && !d.canUpdate && !["merge", "enqueue", "auto-enable", "auto-disable"].includes(action.kind)) throw fail("이 PR을 수정할 권한이 없습니다.");
      if (["ready", "draft", "merge", "enqueue", "auto-enable", "rerun"].includes(action.kind) && d.state !== "open") throw fail("열린 PR에서 실행할 수 있습니다.");
      if (action.kind === "close" && d.state !== "open" || action.kind === "reopen" && d.state !== "closed" || action.kind === "ready" && !d.draft || action.kind === "draft" && d.draft) throw fail("이미 요청한 상태입니다. PR을 새로고침하세요.");
      if (action.kind === "edit") await this.ref(d.repo, action.baseBranch);
      if (action.kind === "merge" || action.kind === "enqueue" || action.kind === "auto-enable") {
        if (!d.canMerge || d.draft || d.queued || action.kind !== "enqueue" && !d.methods.includes(action.method)) throw fail("현재 권한·PR 상태에서 선택한 병합을 실행할 수 없습니다.");
        if (d.stack && (!d.stack.complete || !d.stack.layers.some((layer) => layer.number === d.number))) throw fail("스택 전체를 확인하지 못했습니다. GitHub에서 스택을 확인하세요.");
        if (action.kind === "merge" && d.queueRequired || action.kind === "enqueue" && !d.queueRequired) throw fail("기준 브랜치의 병합 대기열 설정이 선택한 작업과 다릅니다.");
        if (action.kind === "auto-enable" && (!d.autoAllowed || !s.enableAuto || d.autoEnabled || d.stack || d.queueRequired)) throw fail("이 PR은 일반 자동 병합을 설정할 수 없습니다. 스택·대기열은 해당 병합 기능을 사용하세요.");
      }
      if (action.kind === "auto-disable" && (!d.autoEnabled || !s.disableAuto)) throw fail("현재 계정으로 자동 병합을 해제할 수 없습니다.");
      if (action.kind === "rerun") {
        const scope = await this.reviews.actionScope(workspaceId, d.viewId, d.viewRevision), identities = new Map(scope.checks), seen = new Set<string>();
        const labels = action.checks.length ? action.checks.map((id) => { const check = scope.view.checks.find((entry) => entry.id === id); if (!check) throw fail("이 검토의 검사가 아닙니다."); return check; }) : scope.view.checks.filter((check) => check.details);
        for (const label of labels) {
          const identity = identities.get(label.id); if (!identity) throw fail("재실행할 수 없는 검사입니다.");
          const key = `${identity.repo.toLowerCase()}/${identity.run ? `run/${identity.run}` : `check/${identity.id}`}`; if (seen.has(key)) continue;
          const item: CI = { id: randomUUID(), label: identity.run ? `Actions #${identity.run}` : label.name, repo: identity.repo, check: identity.id, run: identity.run, attempt: 0, oid: identity.oid, allowedOids: [d.headOid, ...(scope.mergeOid ? [scope.mergeOid] : [])], signature: "", lease: "" }, state = await this.ciState(item);
          if (state.status !== "completed" || action.failedOnly && !failedConclusions.has(state.conclusion)) continue;
          seen.add(key); Object.assign(item, { attempt: state.attempt, signature: state.signature, lease: hash(identity.run ? [key, state.attempt] : [key, identity.oid, state.signature]) }); ci.push(item);
        }
        if (!ci.length) throw fail("완료된 재실행 대상이 없습니다. 검사 상태를 새로고침하세요.");
      }
    }
    const effects = ci.length ? ci.map((item) => `${item.label} · ${item.run ? `${item.attempt}회차 다음 실행` : "검사 다시 요청"}`) : [discussion?.label ?? actionLabels[action.kind]];
    if ((action.kind === "merge" || action.kind === "enqueue") && d.stack) { const selected = d.stack.layers.find((layer) => layer.number === d.number)!; effects[0] += ` · 스택: ${d.stack.layers.filter((layer) => layer.position <= selected.position && layer.state === "OPEN").map((layer) => `#${layer.number} ${layer.oid.slice(0, 12)}`).join(", ")}`; }
    const notices = [...d.notices];
    if (["create", "edit", "close", "reopen", "draft", "ready", "auto-disable", "discussion"].includes(action.kind)) notices.push("GitHub의 이 작업에는 커밋 조건부 쓰기가 없습니다. 전송 전후 상태를 확인하고, 도중에 바뀌면 별도로 표시합니다.");
    const data: GitHubActionPreview = { id: randomUUID(), contextId, expiresAt: Date.now() + 5 * 60000, action, actor: d.actor, repo: d.repo, number: d.number, headRepo: d.headRepo, headBranch: d.headBranch, headOid: d.headOid, baseBranch: action.kind === "create" || action.kind === "edit" ? action.baseBranch : d.baseBranch, effects, notices };
    if (discussion) data.evidence = discussion.evidence;
    this.remember(this.previews, data.id, { data, snapshot: s, ci, existingNumbers, discussion }); return copy(data);
  }
  start(workspaceId: string, previewId: string, requestId: string) {
    this.active(workspaceId); if (!/^[\w-]{8,100}$/.test(requestId)) throw new HttpError(400, "github_request", "요청 ID를 확인하세요.");
    const requestKey = `github-action-request:v1:${requestId}`, alias = this.store.getMeta(requestKey);
    if (alias) { const saved = JSON.parse(alias); if (saved.workspaceId !== workspaceId || saved.previewId !== previewId) throw fail("다른 작업에 사용한 요청 ID입니다."); return copy(this.record(workspaceId, String(saved.id)).job); }
    const existing = this.records().find((item) => item.job.requestId === requestId);
    if (existing) { if (existing.job.workspaceId !== workspaceId || existing.job.preview.id !== previewId) throw fail("다른 작업에 사용한 요청 ID입니다."); return copy(existing.job); }
    const p = this.previews.get(previewId); if (!p || p.snapshot.data.workspaceId !== workspaceId || p.data.expiresAt < Date.now()) throw fail("실행할 작업을 다시 확인하세요.");
    const d = p.snapshot.data, scope = hash([p.snapshot.repoId, d.number ?? [p.snapshot.headRepoId, d.headBranch, p.data.baseBranch]]);
    const action = p.data.action.kind === "rerun" ? { kind: "rerun", failedOnly: p.data.action.failedOnly } : p.data.action.kind === "discussion" ? { kind: "discussion", operation: p.data.action.operation, baseline: p.discussion?.baseline, before: p.discussion?.before } : p.data.action;
    const fingerprint = hash([scope, p.snapshot.stamp, action, p.ci.map((item) => item.lease).sort()]);
    const record = this.store.transaction(() => {
      const records = this.records(), same = records.find((item) => item.fingerprint === fingerprint && !["failed", "changed"].includes(item.job.phase));
      if (same) { if (same.job.workspaceId !== workspaceId) throw fail("다른 작업공간에서 같은 요청을 이미 전송했습니다. 원격 결과를 확인하세요.", "github_duplicate"); this.store.setMeta(requestKey, JSON.stringify({ workspaceId, previewId, id: same.job.id })); return same; }
      if (records.some((item) => item.scope === scope && this.blocks(item))) throw fail("이 PR의 이전 요청 결과를 먼저 확인하세요. 대조할 수 없는 미확정 요청은 실행 기록에서 검토할 수 있습니다.", "github_action_busy");
      if (records.some((item) => item.scope === scope && item.snapshot.data.headOid === d.headOid && item.job.effects.some((effect) => effect.phase === "uncertain") && hash(replayAction(item.job.preview.action, item.discussion)) === hash(replayAction(p.data.action, p.discussion)))) throw fail("미확정 요청과 같은 작업은 다시 보내지 않습니다. 원격 결과를 먼저 확인하세요.", "github_unknown_replay");
      for (const item of p.ci) if (records.some((record) => record.ci.some((old) => old.lease === item.lease && !["failed", "changed"].includes(record.job.effects.find((effect) => effect.id === old.id)?.phase ?? "uncertain")))) throw fail("같은 검사 회차의 재실행을 이미 요청했습니다. 새 회차를 확인한 뒤 진행하세요.", "github_ci_duplicate");
      const now = Date.now(), job: GitHubActionJob = { id: randomUUID(), requestId, workspaceId, preview: copy(p.data), phase: "running", effects: p.data.effects.map((label, i) => ({ id: p.ci[i]?.id ?? randomUUID(), label, phase: "prepared", detail: "전송 준비" })), detail: "", createdAt: now, updatedAt: now };
      const next: Record = { job, snapshot: copy(p.snapshot), ci: copy(p.ci), scope, fingerprint, asyncIds: {}, existingNumbers: p.existingNumbers, createdNumber: null, ...(p.discussion ? { discussion: copy(p.discussion) } : {}) }; this.save(next); this.store.setMeta(requestKey, JSON.stringify({ workspaceId, previewId, id: job.id })); return next;
    });
    if (record.job.phase === "running" && !this.running.has(record.job.id)) { const promise = this.run(record).finally(() => this.running.delete(record.job.id)); this.running.set(record.job.id, promise); }
    return copy(record.job);
  }
  private request(record: Record, effect: GitHubEffect): GitHubWrite {
    const action = record.job.preview.action, s = record.snapshot, d = s.data, baseInput = { pullRequestId: s.pullId, clientMutationId: `${record.job.id}:${effect.id}` };
    if (action.kind === "discussion") { if (!record.discussion) throw fail("리뷰 실행 근거가 없습니다."); return this.discussions.request(record.discussion, baseInput.clientMutationId); }
    if (action.kind === "rerun") { const ci = record.ci.find((item) => item.id === effect.id)!; return { method: "POST", endpoint: ci.run ? `repos/${ci.repo}/actions/runs/${ci.run}/${action.failedOnly ? "rerun-failed-jobs" : "rerun"}` : `repos/${ci.repo}/check-runs/${ci.check}/rerequest` }; }
    if (action.kind === "merge" || action.kind === "enqueue") return { method: "PUT", endpoint: `repos/${d.repo}/pulls/${d.number}/merge-async`, body: { sha: d.headOid, merge_action: action.kind === "enqueue" ? "merge_queue" : "direct_merge", ...(action.kind === "merge" ? { merge_method: action.method } : {}) } };
    let name: string, input: object;
    switch (action.kind) {
      case "create": name = "createPullRequest"; input = { repositoryId: s.repoId, headRepositoryId: s.headRepoId, headRefName: sameRepo(d.repo, d.headRepo) ? d.headBranch : `${d.headRepo.split("/")[0]}:${d.headBranch}`, baseRefName: action.baseBranch, title: action.title, body: action.body, draft: action.draft, maintainerCanModify: action.maintainerCanModify, clientMutationId: baseInput.clientMutationId }; break;
      case "edit": name = "updatePullRequest"; input = { ...baseInput, title: action.title, body: action.body, baseRefName: action.baseBranch }; break;
      case "close": name = "closePullRequest"; input = baseInput; break;
      case "reopen": name = "reopenPullRequest"; input = baseInput; break;
      case "draft": name = "convertPullRequestToDraft"; input = baseInput; break;
      case "ready": name = "markPullRequestReadyForReview"; input = baseInput; break;
      case "auto-enable": name = "enablePullRequestAutoMerge"; input = { ...baseInput, expectedHeadOid: d.headOid, mergeMethod: action.method.toUpperCase() }; break;
      case "auto-disable": name = "disablePullRequestAutoMerge"; input = baseInput; break;
    }
    return { method: "POST", endpoint: "graphql", body: mutation(name, input) };
  }
  private async run(record: Record) {
    try {
      for (const effect of record.job.effects) {
        if (this.stopped) break;
        try {
          await this.current(record.snapshot);
          const action = record.job.preview.action;
          if (record.discussion) await this.discussions.current(record.discussion);
          if (action.kind === "create" || action.kind === "edit") await this.ref(record.snapshot.data.repo, action.baseBranch);
          const ci = record.ci.find((item) => item.id === effect.id);
          if (ci) { const state = await this.ciState(ci); if (state.signature !== ci.signature) throw fail("검사 실행 회차·상태가 바뀌었습니다. 전송하지 않았습니다."); }
          if (this.stopped) break;
          // Validate the local binding once more after remote preflight reads.
          await this.reviews.actionScope(record.job.workspaceId, record.snapshot.data.viewId, record.snapshot.data.viewRevision);
          if (this.stopped) break;
          effect.phase = "sending"; effect.detail = "GitHub에 요청을 보내는 중"; this.save(record);
          const request = this.request(record, effect), response = await this.writer.write(request);
          if (this.stopped) break;
          if (request.endpoint === "graphql") {
            const payloads = Object.values(object(object(response.value).data)).map(object), payload = payloads.find((item) => item.clientMutationId === `${record.job.id}:${effect.id}`);
            if (!payload) throw new GitHubWriteError("GitHub 변경 응답의 요청 식별자를 확인하지 못했습니다.", false);
            if (action.kind === "create") { record.createdNumber = integer(object(payload.pullRequest).number); if (!record.createdNumber) throw new GitHubWriteError("생성 응답의 PR 번호를 확인하지 못했습니다.", false); }
          }
          if (record.discussion) this.discussions.acknowledge(record.discussion, response.value);
          effect.phase = "accepted"; effect.detail = "GitHub 응답을 받았습니다. 실제 상태를 확인합니다."; this.save(record);
          if (action.kind === "merge" || action.kind === "enqueue") { this.mergeResult(record, effect, response.value); if ((effect as GitHubEffect).phase === "complete") await this.reconcileEffect(record, effect); }
          else if (action.kind === "rerun") { effect.phase = "complete"; effect.outcome = "rerun"; effect.detail = "GitHub가 재실행 요청을 수락했습니다. 새 실행의 성공 여부는 검사 화면에서 확인하세요."; }
          else await this.reconcileEffect(record, effect);
        } catch (error) {
          if (this.stopped) break;
          if (effect.phase === "sending") { effect.phase = error instanceof GitHubWriteError && error.certain ? "failed" : "uncertain"; effect.detail = `${errorText(error)}${effect.phase === "uncertain" ? " 자동 재전송 없이 결과를 확인하세요." : ""}`; }
          else if (effect.phase === "accepted") { effect.phase = "uncertain"; effect.detail = `응답 후 상태를 확인하지 못했습니다. ${errorText(error)}`; }
          else { effect.phase = "changed"; effect.detail = `전송하지 않았습니다. ${errorText(error)}`; }
        }
        this.save(record);
      }
    } catch (error) { for (const effect of record.job.effects) if (["prepared", "sending", "accepted"].includes(effect.phase)) { effect.phase = effect.phase === "prepared" ? "failed" : "uncertain"; effect.detail = errorText(error); } }
    finally { if (!this.stopped) this.save(record); }
  }
  private mergeResult(record: Record, effect: GitHubEffect, raw: unknown) {
    const value = object(raw), details = object(value.details), result = string(value.status), id = string(details.uuid, 128), action = record.job.preview.action;
    if (result === "pending" && /^[a-zA-Z0-9_-]{8,128}$/.test(id)) {
      record.asyncIds[effect.id] = id;
      if (details.expected_head_sha !== record.snapshot.data.headOid || details.bypass_rules !== false || details.merge_action !== (action.kind === "enqueue" ? "merge_queue" : "direct_merge") || action.kind === "merge" && details.merge_method !== action.method) { effect.phase = "uncertain"; effect.detail = "이미 진행 중인 병합의 커밋·방법·규칙 설정이 요청과 다릅니다. 재전송하지 않습니다."; }
      else { effect.phase = "pending"; effect.detail = "GitHub가 비동기 병합을 처리하고 있습니다. 원격 결과를 확인하세요."; }
    }
    else if (result === "merged" || result === "enqueued") { effect.phase = "complete"; effect.outcome = result; effect.detail = result === "merged" ? "GitHub가 병합 완료를 확인했습니다." : "병합 대기열에 등록되었습니다. 아직 병합 완료가 아닙니다."; }
    else if (result === "failed") { effect.phase = "failed"; effect.detail = `GitHub가 병합을 거절했습니다. ${githubRedact(string(details.message) || JSON.stringify(value.errors ?? "")).slice(0, 1800)}`; }
    else { effect.phase = "uncertain"; effect.detail = "병합 응답 형식을 확인하지 못했습니다. 원격 상태를 확인하세요."; }
  }
  private creationLookup(d: GitHubActionContext, base: string) { return `repos/${d.repo}/pulls?state=all&head=${encodeURIComponent(`${d.headRepo.split("/")[0]}:${d.headBranch}`)}&base=${encodeURIComponent(base)}&per_page=100`; }
  private async remote(record: Record) {
    const d = record.snapshot.data;
    let number = d.number ?? record.createdNumber;
    if (!number) {
      const action = record.job.preview.action;
      if (action.kind !== "create") throw fail("생성 요청 기록을 확인하지 못했습니다.");
      const rows = array(await this.reviews.reader.json(this.creationLookup(d, action.baseBranch), undefined, true));
      const matching = rows.filter((row) => { const p = object(row), h = object(p.head); return !record.existingNumbers.includes(Number(p.number)) && sameRepo(string(object(h.repo).full_name), d.headRepo) && h.ref === d.headBranch && object(p.base).ref === action.baseBranch && p.title === action.title && (p.body ?? "") === action.body && p.draft === action.draft; });
      if (matching.length !== 1) throw fail("요청 내용과 일치하는 PR 하나를 확인하지 못했습니다. 자동으로 다시 만들지 않습니다."); number = integer(object(matching[0]).number);
      if (!number) throw fail("생성된 PR 번호를 확인하지 못했습니다.");
    }
    // Reconciliation remains valid after restart; no expired in-memory view is required.
    return this.snapshot({ id: d.viewId, revision: d.viewRevision, workspaceId: d.workspaceId, head: { id: "", repo: d.headRepo, remote: "", branch: d.headBranch }, base: { id: "", repo: d.repo, remote: "" }, pull: { number } as GitHubView["pull"], localHead: d.headOid });
  }
  private async reconcileEffect(record: Record, effect: GitHubEffect) {
    const action = record.job.preview.action, old = record.snapshot, d = old.data, ci = record.ci.find((item) => item.id === effect.id);
    if (record.discussion) { await this.discussions.reconcile(record.discussion, effect); return; }
    if (ci) {
      const state = await this.ciState(ci);
      if (ci.run ? state.attempt > ci.attempt : state.signature !== ci.signature && ["queued", "in_progress"].includes(state.status)) { effect.phase = "complete"; effect.outcome = "rerun"; effect.detail = "원격에서 새 실행을 확인했습니다. 다른 사용자의 실행일 수도 있어 요청의 인과관계까지 보장하지 않습니다."; }
      else { effect.phase = "uncertain"; effect.detail = "새 실행을 아직 확인하지 못했습니다. 같은 회차를 자동 재전송하지 않습니다."; } return;
    }
    const now = await this.remote(record);
    if (now.repoId !== old.repoId || now.headRepoId !== old.headRepoId || now.actorId !== old.actorId || now.data.headOid !== d.headOid || d.number && now.pullId !== old.pullId) { effect.phase = "changed"; effect.detail = "전송 후 계정·저장소·PR·커밋이 바뀌었습니다. 결과를 직접 확인하세요."; return; }
    const n = now.data;
    if (action.kind !== "create" && action.kind !== "edit" && (n.baseBranch !== d.baseBranch || n.title !== d.title || n.body !== d.body) || action.kind === "edit" && (n.state !== d.state || n.draft !== d.draft)) { effect.phase = "changed"; effect.detail = "요청 외 PR 내용·상태도 전송 도중 바뀌었습니다. 원격 결과를 확인하세요."; return; }
    if (action.kind === "merge" || action.kind === "enqueue") {
      if (n.state === "merged") { effect.phase = "complete"; effect.outcome = "merged"; effect.detail = "원격 PR의 병합 완료를 확인했습니다."; }
      else if (n.queued) { effect.phase = "complete"; effect.outcome = "enqueued"; effect.detail = "원격 PR의 대기열 등록을 확인했습니다. 아직 병합 완료가 아닙니다."; }
      else { effect.phase = "uncertain"; effect.detail = "원격에서 병합·대기열 등록을 확인하지 못했습니다. 재전송하지 않습니다."; } return;
    }
    const matches = action.kind === "create" ? n.title === action.title && n.body === action.body && n.baseBranch === action.baseBranch && n.draft === action.draft
      : action.kind === "edit" ? n.title === action.title && n.body === action.body && n.baseBranch === action.baseBranch
      : action.kind === "close" ? n.state === "closed" : action.kind === "reopen" ? n.state === "open" : action.kind === "draft" ? n.draft : action.kind === "ready" ? !n.draft : action.kind === "auto-enable" ? n.autoEnabled || n.state === "merged" : action.kind === "auto-disable" ? !n.autoEnabled : false;
    if (matches) { effect.phase = "complete"; effect.outcome = action.kind === "create" ? "created" : action.kind === "auto-enable" ? n.state === "merged" ? "merged" : "auto-enabled" : action.kind === "auto-disable" ? "auto-disabled" : "updated"; effect.number = n.number!; effect.url = `https://github.com/${n.repo}/pull/${n.number}`; effect.detail = action.kind === "auto-enable" ? n.state === "merged" ? "원격에서 실제 병합을 확인했습니다." : "자동 병합 설정을 확인했습니다. 아직 병합 완료가 아닙니다." : "원격에서 요청한 상태를 확인했습니다."; }
    else { effect.phase = "uncertain"; effect.detail = "원격 상태가 요청 내용과 다릅니다. 변경 여부를 확인하고 새로고침하세요. 재전송하지 않습니다."; }
  }
  async get(workspaceId: string, id: string, reconcile = false) {
    this.active(workspaceId); const record = this.record(workspaceId, id);
    if (!reconcile || this.running.has(id)) return copy(record.job);
    const existing = this.reconciling.get(id); if (existing) return existing;
    const promise = (async () => {
      for (const effect of record.job.effects) {
        if (!["pending", "accepted", "uncertain"].includes(effect.phase)) continue;
        try { const uuid = record.asyncIds[effect.id]; if (uuid) { this.mergeResult(record, effect, await this.reviews.reader.json(`repos/${record.snapshot.data.repo}/pulls/${record.snapshot.data.number}/merge-async/${uuid}`, undefined, true)); if (effect.phase === "complete") await this.reconcileEffect(record, effect); } else await this.reconcileEffect(record, effect); }
        catch (error) { effect.detail = `원격 결과를 확인하지 못했습니다. ${errorText(error)}`; }
      }
      return this.stopped ? record.job : this.save(record);
    })().finally(() => this.reconciling.delete(id));
    this.reconciling.set(id, promise); return promise;
  }
  stop() {
    this.stopped = true;
    for (const id of this.running.keys()) { const raw = this.store.getMeta(prefix + id); if (!raw) continue; const record: Record = JSON.parse(raw); for (const effect of record.job.effects) if (["prepared", "sending", "accepted"].includes(effect.phase)) { effect.phase = effect.phase === "prepared" ? "failed" : "uncertain"; effect.detail = "앱을 종료했습니다. 전송한 요청은 원격 상태 확인으로 복구합니다."; } this.save(record); }
    this.contexts.clear(); this.previews.clear(); this.recoveries.clear();
  }
  async drain() { await Promise.allSettled([...this.running.values(), ...this.reconciling.values()]); }
}
