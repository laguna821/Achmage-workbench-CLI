import type { HostUpdateStatus, NativeTaskSnapshot } from "@workbench/contracts";
import type { SessionManager } from "./sessions.ts";
import type { Store } from "./store.ts";
import { STORE_SCHEMA_VERSION } from "./store.ts";
import { HttpError } from "./errors.ts";

/** Reuses the existing session, execution lease and owned PTY authorities. No second supervisor. */
export class UpdatePolicy {
  private requestedAt: number | null = null;
  private stopping = false;
  /**
   * Runs once at the start of "stop all work", before any turn is interrupted (not on a drain): the
   * gateway closes the messenger channel here, so turns ended by the stop are not sent while it exits.
   */
  beforeInterrupt: (() => Promise<void>) | null = null;
  private readonly manager: SessionManager;
  private readonly store: Store;
  private readonly resumed: () => void;
  constructor(manager: SessionManager, store: Store, resumed: () => void = () => undefined) {
    this.manager = manager; this.store = store; this.resumed = resumed;
    manager.tasks.admitNewWork = () => this.requireAdmission();
  }
  status(): HostUpdateStatus {
    const blockers: HostUpdateStatus["blockers"] = [];
    for (const task of this.manager.tasks.list().tasks) if (["running", "waiting_input", "queued"].includes(task.state)) blockers.push({ kind: "task", id: task.runId, label: task.title });
    for (const view of this.manager.documents.registry.list()) if (view.dirty) blockers.push({ kind: "office", id: view.viewId, label: `저장하지 않은 문서 ${view.artifactId}` });
    for (const lease of this.manager.documents.registry.executions.list()) blockers.push({ kind: "office", id: lease.id, label: lease.artifactId });
    for (const workspace of this.manager.workspaces.list()) for (const terminal of this.manager.terminals.list(workspace.id).terminals)
      if (["starting", "running", "stopping"].includes(terminal.status)) blockers.push({ kind: "terminal", id: terminal.id, label: terminal.label });
    return { state: this.stopping ? "stopping" : this.requestedAt === null ? "running" : blockers.length ? "draining" : "ready", requestedAt: this.requestedAt,
      blockers, backupPath: this.store.migration.backupPath, schemaVersion: STORE_SCHEMA_VERSION };
  }
  prepare() { this.requestedAt ??= Date.now(); this.manager.schedules.stop(); return this.status(); }
  cancel() { if (this.stopping) throw new HttpError(409, "host_stopping", "종료 중인 호스트는 되돌릴 수 없습니다."); this.requestedAt = null; this.resumed(); return this.status(); }
  requireAdmission() { if (this.requestedAt !== null || this.stopping) throw new HttpError(409, "host_draining", "업데이트를 준비하고 있습니다. 진행 중인 작업을 마치거나 업데이트 준비를 취소한 뒤 새 요청을 보내세요."); }
  assertRequest(method: string, path: string, access?: { viewId: string; writeToken: string }) {
    if (this.requestedAt === null || ["GET", "HEAD", "OPTIONS"].includes(method) || path.startsWith("/api/host/")) return;
    // The messenger channel's gates at the PC (pause, lock, unlock, disconnect) only close or reopen
    // a chat; an unlock admits nothing new while draining, because the channel checks admission itself.
    if (method === "PATCH" && /^\/api\/channels\/bindings\/[^/]+$/.test(path)) return;
    // A live execution grant may finish its already-approved original tool/save lifecycle.
    // Authentication and the existing artifact/path authority still check every actual write.
    if (access?.writeToken && this.manager.documents.registry.executions.list().some(lease =>
      [lease.access, lease.sourceAccess].some(owner => owner.viewId === access.viewId && owner.writeToken === access.writeToken))) return;
    // Existing operations may finish, release a lease, save their result or answer an approval.
    if (/\/(?:stop|interrupt|approve|approval|answer|answers|release|commit|save|write|heartbeat|poll|reply|presence|read|claim)(?:\/|$)/.test(path)
      || path.startsWith("/api/office-output/") || path.startsWith("/api/office-executor/") || path === "/api/task-commands" || method === "DELETE") return;
    this.requireAdmission();
  }
  async stop(mode: "drain" | "interrupt") {
    this.prepare();
    const current = this.status();
    if (mode === "drain" && current.blockers.length) throw new HttpError(409, "host_active_work", `아직 ${current.blockers.length}개 작업 또는 실행기가 남아 있습니다. 기존 작업을 마친 뒤 다시 종료하세요.`);
    this.stopping = true;
    if (mode === "drain") return;
    await this.beforeInterrupt?.().catch(() => undefined);
    // Finishing an interrupted parent must not start its already-queued next request during exit.
    for (const session of this.manager.view.sessions.values()) if (session.queued.length)
      this.manager.sink.updateSession(session.id, { queued: session.queued.map(request => ({ ...request, held: true })) });
    const tasks = this.manager.tasks.list().tasks.filter(task => ["running", "waiting_input"].includes(task.state));
    // This is the user's explicit 'stop all work' path, not automatic update behavior.
    await Promise.allSettled(tasks.filter(task => task.executorKind === "native_agent" && task.capabilities.stop).map(task => this.manager.tasks.command({ commandId: `shutdown-${Date.now()}-${task.nativeTask?.childId ?? "child"}`.replace(/[^\w.-]/g, "_").slice(0, 160), target: task, kind: "stop" })));
    await Promise.allSettled([...new Set(tasks.filter(task => task.executorKind !== "native_agent").map(task => task.sessionId))].map(id => this.manager.interrupt(id)));
    for (const task of tasks) {
      if (task.executorKind === "native_agent") continue;
      const session = this.manager.view.sessions.get(task.sessionId);
      if (!session || ["idle", "error"].includes(session.status)) continue;
      this.manager.sink.upsertItem(session.id, { kind: "turnEnd", id: `shutdown:${task.runId}`, status: "interrupted", cause: "stop", durationMs: null, requestId: task.requestId, at: Date.now() });
      this.manager.sink.updateSession(session.id, { status: "idle", activity: null });
    }
    // Preserve unconfirmed native outcomes; never label an unacknowledged provider stop completed.
    for (const session of this.manager.view.sessions.values()) {
      const current = this.manager.tasks.list().tasks.filter(task => task.sessionId === session.id && task.nativeTask && ["running", "waiting_input"].includes(task.state));
      const observations: NativeTaskSnapshot[] = current.map(task => ({ identity: task.nativeTask!, parentRequestId: task.requestId, parentChildId: null, title: task.title,
        state: "outcome_unknown", preview: task.preview, activity: null, updatedAt: Date.now(), sourceItemId: task.sourceItemId, approvalIds: [],
        capabilities: { observe: true, send: false, queue: false, steer: false, stop: false, approve: false }, controlDetail: "호스트 종료 시점에 공급자 하위 작업의 최종 결과를 확인하지 못했습니다." }));
      if (observations.length) this.manager.tasks.observeNative(session.id, observations);
    }
  }
}
