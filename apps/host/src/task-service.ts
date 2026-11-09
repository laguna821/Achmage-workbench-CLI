import { createHash, randomUUID } from "node:crypto";
import type { CommandReceipt, ReceiptObservation, SendResult, Session, SubmitCommand, TaskCommand, TaskSnapshot, TaskSummary, TranscriptItem } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import type { Store } from "./store.ts";
import type { EventBus } from "./bus.ts";

const receiptKey = (id: string) => `task-command:${id}`;
const runKey = (sessionId: string, requestId: string) => `${sessionId}/${requestId}`;
const requestOf = (item: TranscriptItem) => item.id.startsWith("user:") ? item.id.slice(5) : item.id;
const idle = (session: Session) => session.status === "idle" || session.status === "error";

export function reconcileReceipt(current: CommandReceipt, observed: ReceiptObservation): CommandReceipt {
  // Retrying an HTTP request is not evidence that the original external action failed.
  if (observed.kind === "transport_retry" || current.status === "completed" || current.status === "rejected") return current;
  return { ...current, status: observed.status, detail: observed.detail ?? current.detail, updatedAt: Date.now() };
}

type Hooks = {
  submit?(input: SubmitCommand, source?: "schedule"): Promise<SendResult>;
  sessions(): Session[]; items(sessionId: string): TranscriptItem[]; canSteer(session: Session): boolean;
  stop(sessionId: string): Promise<void>; approve(sessionId: string, itemId: string, decision: "accept" | "decline"): Promise<void>;
  cancelQueue(sessionId: string, queuedId: string): unknown; sendQueue(sessionId: string, queuedId: string): Promise<unknown>;
};

/** A projection of the existing sessions/transcripts. Only command receipts and parent bindings
 * are added to the existing local meta table; provider/session history remains authoritative. */
export class TaskService {
  readonly epoch = randomUUID();
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly hooks: Hooks;
  private readonly unsubscribe: () => void;
  constructor(store: Store, bus: EventBus, hooks: Hooks) {
    this.store = store; this.bus = bus; this.hooks = hooks;
    // A previous process may have performed a command without receiving its result. Never replay it.
    for (const row of store.metaEntries("task-command:")) {
      const receipt = JSON.parse(row.value) as CommandReceipt;
      if (receipt.status === "accepted" || receipt.status === "running") this.save({ ...receipt, status: "outcome_unknown", detail: "호스트가 다시 시작되었습니다. 결과를 확인한 뒤 다음 행동을 선택하세요.", updatedAt: Date.now() });
    }
    this.unsubscribe = bus.subscribe(event => {
      if (event.type !== "item.upserted" || event.item.kind !== "user") return;
      const session = hooks.sessions().find(s => s.id === event.sessionId);
      const parentId = session?.documentAgent?.parentSessionId;
      if (!parentId) return;
      const key = `task-parent:${runKey(event.sessionId, requestOf(event.item))}`;
      if (store.getMeta(key) !== null) return;
      const parent = hooks.items(parentId).findLast(item => item.kind === "user");
      store.setMeta(key, JSON.stringify(parent ? runKey(parentId, requestOf(parent)) : null));
    });
  }
  close() { this.unsubscribe(); }

  list(filter: { workId?: string; workspaceId?: string; parentSessionId?: string; activeOnly?: boolean } = {}): TaskSnapshot {
    const sessions = this.hooks.sessions().filter(s => !s.archivedAt && (!filter.workId || s.workId === filter.workId)
      && (!filter.workspaceId || s.workspaceId === filter.workspaceId) && (!filter.parentSessionId || s.documentAgent?.parentSessionId === filter.parentSessionId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const tasks = sessions.flatMap(session => this.forSession(session));
    const active = new Set(["queued", "running", "waiting_input", "outcome_unknown"]);
    return { epoch: this.epoch, seq: this.bus.currentSeq, tasks: tasks.filter(t => !filter.activeOnly || active.has(t.state))
      .sort((a, b) => Number(active.has(b.state)) - Number(active.has(a.state)) || b.updatedAt - a.updatedAt) };
  }

  private forSession(session: Session): TaskSummary[] {
    const items = this.hooks.items(session.id);
    const at = items.findLastIndex(item => item.kind === "user");
    const request = items[at];
    const requestId = request ? requestOf(request) : null;
    const recent = at >= 0 ? items.slice(at) : items;
    const end = recent.findLast(item => item.kind === "turnEnd");
    const approvalIds = recent.filter(item => item.kind === "approval" && item.decision === null).map(item => item.id);
    const runId = runKey(session.id, requestId ?? "idle");
    const binding = this.store.getMeta(`task-parent:${runId}`);
    const error = recent.find(item => item.kind === "notice" && item.level === "error");
    const finishedReply = recent.some(item => item.kind === "assistant" && !item.streaming && item.text.trim());
    const state: TaskSummary["state"] = approvalIds.length ? "waiting_input" : end?.kind === "turnEnd"
      ? end.status === "completed" ? "completed" : end.cause === "stop" ? "cancelled" : end.status === "failed" ? "failed" : "interrupted"
      : session.status === "error" || error ? "failed" : !idle(session) ? "running" : request && !finishedReply ? "outcome_unknown" : "completed";
    const base: TaskSummary = {
      hostId: session.hostId, workspaceId: session.workspaceId ?? null, sessionId: session.id, nativeSessionId: session.nativeSessionId,
      runId, parentRunId: binding ? JSON.parse(binding) as string | null : null, executorKind: session.documentAgent ? "office" : "session",
      workId: session.workId, parentSessionId: session.documentAgent?.parentSessionId ?? null, provider: session.provider,
      title: session.purpose, requestId, state, activity: session.activity, preview: session.preview, updatedAt: Math.max(session.updatedAt, recent.at(-1)?.at ?? 0),
      approvalIds, sourceItemId: request?.id ?? null,
      capabilities: { observe: true, send: true, queue: true, steer: !idle(session) && this.hooks.canSteer(session), stop: !idle(session), approve: approvalIds.length > 0 },
    };
    const tasks = request || !idle(session) ? [base] : [];
    for (const queued of session.queued) tasks.push({ ...base, runId: runKey(session.id, queued.id), requestId: queued.id, state: "queued",
      title: queued.text.slice(0, 100), preview: queued.text.slice(0, 240), activity: queued.held ? "보내기를 기다리는 요청" : "현재 응답 뒤에 실행", updatedAt: queued.at,
      sourceItemId: null, approvalIds: [], capabilities: { ...base.capabilities, steer: false, stop: false, approve: false } });
    const children = new Map<string, TaskSummary>();
    for (const item of recent) if (item.kind === "tool" && item.tool === "agent") {
      const observations = item.agent?.children.length ? item.agent.children : [{ nativeSessionId: "", state: item.status === "running" ? "running" as const : item.status === "failed" ? "failed" as const : item.status === "declined" ? "cancelled" as const : "completed" as const }];
      for (const child of observations) {
        const key = child.nativeSessionId || item.id;
        children.set(key, { ...base, runId: `${runId}/agent:${key}`, parentRunId: runId, parentSessionId: session.id,
          nativeSessionId: child.nativeSessionId || null, executorKind: "native_agent", title: child.title ?? item.title, state: child.state,
          activity: "공급자 하위 작업", preview: child.result ?? item.output, updatedAt: item.at, approvalIds: [], sourceItemId: item.id,
          capabilities: { observe: true, send: false, queue: false, steer: false, stop: false, approve: false } });
      }
    }
    return [...tasks, ...children.values()];
  }

  receipt(commandId: string): CommandReceipt | null {
    const raw = this.store.getMeta(receiptKey(commandId));
    return raw ? JSON.parse(raw) as CommandReceipt : null;
  }
  private save(receipt: CommandReceipt) { this.store.setMeta(receiptKey(receipt.commandId), JSON.stringify(receipt)); return receipt; }

  /** CLI, MCP and UI automation share the existing session send gate and request journal. */
  async submit(input: SubmitCommand, source?: "schedule"): Promise<CommandReceipt> {
    if (!input || typeof input.commandId !== "string" || !/^[\w.-]{1,160}$/.test(input.commandId) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 100_000)
      throw new HttpError(400, "task_submit_invalid", "명령 ID와 요청 본문이 필요합니다.");
    if (input.mode !== undefined && !["auto", "queue", "steer"].includes(input.mode)) throw new HttpError(400, "task_mode", "지원하지 않는 전송 방식입니다.");
    if (input.profileId !== undefined && input.profileId !== null && typeof input.profileId !== "string") throw new HttpError(400, "task_profile", "역할 ID를 확인하세요.");
    const hash = createHash("sha256").update(JSON.stringify(["submit", input.hostId, input.workspaceId, input.sessionId, input.text, input.mode ?? "auto", input.profileId])).digest("hex");
    const previous = this.receipt(input.commandId);
    if (previous) {
      if (previous.payloadHash !== hash) throw new HttpError(409, "task_command_conflict", "같은 명령 ID의 내용이 달라졌습니다.");
      return reconcileReceipt(previous, { kind: "transport_retry" });
    }
    const session = this.hooks.sessions().find(entry => entry.id === input.sessionId && !entry.archivedAt);
    if (!session || session.hostId !== input.hostId || session.workspaceId !== input.workspaceId) throw new HttpError(409, "task_target_mismatch", "다른 호스트 또는 작업공간의 세션입니다.");
    if (!this.hooks.submit) throw new HttpError(409, "task_submit_unavailable", "이 호스트는 공통 입력을 지원하지 않습니다.");
    const now = Date.now();
    let receipt: CommandReceipt = { commandId: input.commandId, targetRunId: runKey(session.id, input.commandId), sessionId: session.id, payloadHash: hash,
      status: "accepted", resultRef: null, detail: null, createdAt: now, updatedAt: now };
    this.save(receipt);
    try {
      const result = await this.hooks.submit(input, source);
      receipt = { ...reconcileReceipt(receipt, { kind: "observed", status: "completed", detail: result.delivery === "queued" ? "다음 요청으로 대기합니다." : result.delivery === "steered" ? "진행 중인 작업에 전달했습니다." : "요청을 전달했습니다." }), resultRef: runKey(session.id, input.commandId) };
    } catch (error) {
      receipt = { ...receipt, status: error instanceof HttpError && error.status < 500 ? "rejected" : "outcome_unknown", detail: error instanceof Error ? error.message : String(error), updatedAt: Date.now() };
    }
    return this.save(receipt);
  }

  async command(input: TaskCommand): Promise<CommandReceipt> {
    if (!input || typeof input.commandId !== "string" || !/^[\w.-]{1,160}$/.test(input.commandId) || !input.target) throw new HttpError(400, "task_command_invalid", "작업 명령 ID와 대상이 필요합니다.");
    const hash = createHash("sha256").update(JSON.stringify([input.kind, input.target.hostId, input.target.workspaceId, input.target.sessionId, input.target.nativeSessionId, input.target.runId, input.target.parentRunId, input.target.executorKind, input.itemId, input.decision, input.queuedId])).digest("hex");
    const previous = this.receipt(input.commandId);
    if (previous) {
      if (previous.payloadHash !== hash) throw new HttpError(409, "task_command_conflict", "같은 명령 ID의 내용이 달라졌습니다.");
      return reconcileReceipt(previous, { kind: "transport_retry" });
    }
    const session = this.hooks.sessions().find(s => s.id === input.target.sessionId && !s.archivedAt);
    if (!session || session.hostId !== input.target.hostId || (session.workspaceId ?? null) !== input.target.workspaceId) throw new HttpError(409, "task_target_mismatch", "다른 호스트 또는 작업공간의 작업입니다.");
    const task = this.forSession(session).find(t => t.runId === input.target.runId && t.executorKind === input.target.executorKind);
    if (!task || task.executorKind === "native_agent") throw new HttpError(409, "task_target_stale", "작업이 바뀌었거나 이 하위 작업은 관찰만 지원합니다. 목록을 새로 확인하세요.");
    const now = Date.now();
    let receipt: CommandReceipt = { commandId: input.commandId, targetRunId: task.runId, sessionId: session.id, payloadHash: hash,
      status: "accepted", resultRef: task.runId, detail: null, createdAt: now, updatedAt: now };
    this.save(receipt);
    try {
      if (input.kind === "stop" && task.capabilities.stop) await this.hooks.stop(session.id);
      else if (input.kind === "approve" && input.itemId && task.approvalIds.includes(input.itemId) && (input.decision === "accept" || input.decision === "decline")) await this.hooks.approve(session.id, input.itemId, input.decision);
      else if ((input.kind === "cancel_queue" || input.kind === "send_queue") && task.state === "queued" && input.queuedId === task.requestId) {
        if (input.kind === "cancel_queue") this.hooks.cancelQueue(session.id, input.queuedId);
        else await this.hooks.sendQueue(session.id, input.queuedId);
      } else throw new HttpError(409, "task_action_unavailable", "이 작업에서 현재 지원하는 동작이 아닙니다.");
      receipt = reconcileReceipt(receipt, { kind: "observed", status: "completed" });
    } catch (error) {
      receipt = { ...receipt, status: error instanceof HttpError && error.status < 500 ? "rejected" : "outcome_unknown",
        detail: error instanceof Error ? error.message : String(error), updatedAt: Date.now() };
    }
    return this.save(receipt);
  }
}
