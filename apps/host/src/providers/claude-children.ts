import { randomUUID } from "node:crypto";
import { getSubagentMessages, listSubagents, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeTaskProtocolSource } from "@workbench/paseo-server-transport/provider-children/claude";
import { ClaudeTranscriptMapper } from "@workbench/provider-claude";
import type { NativeTaskControl, NativeTaskIdentity, NativeTaskSnapshot, TranscriptItem } from "@workbench/contracts";
import { claudeHistory } from "../imports.ts";
import { HttpError } from "../errors.ts";

type Child = { value: NativeTaskSnapshot; canonicalId: string; toolUseId: string | null; background: boolean; live: boolean; runId: string | null; mapper: ClaudeTranscriptMapper; items: Map<string, TranscriptItem> };
const ended = (state: NativeTaskSnapshot["state"]) => ["completed", "failed", "cancelled", "interrupted"].includes(state);
type Ports = { query(): Query | null; publish(tasks: NativeTaskSnapshot[], source: "live" | "refresh"): void; settled(): void };

/** The original Paseo task protocol source owns canonical tool/task identity, aliases, filtering,
 * nested ownership and presentation. This adapter adds Workbench receipts and the SDK controls. */
export class ClaudeChildren {
  private generation = randomUUID();
  private parentNativeSessionId: string | null;
  private readonly ports: Ports;
  private readonly source = new ClaudeTaskProtocolSource();
  private readonly children = new Map<string, Child>();
  private readonly waiters = new Set<() => void>();
  constructor(parentNativeSessionId: string | null, ports: Ports) { this.parentNativeSessionId = parentNativeSessionId; this.ports = ports; }
  list() { return [...this.children.values()].map(child => structuredClone(child.value)); }
  hasActive() { return [...this.children.values()].some(child => child.live && !ended(child.value.state)); }
  private capabilities(child: Child) {
    const query = this.ports.query(), active = child.live && Boolean(query) && child.value.identity.nativeRunId !== null && !ended(child.value.state);
    child.value.capabilities = { observe: true, send: false, queue: false, steer: false, stop: active && typeof query?.stopTask === "function", background: active && !child.background && Boolean(child.toolUseId) && typeof query?.backgroundTasks === "function", approve: child.live && Boolean(query) && child.value.approvalIds.length > 0 };
    child.value.controlDetail = child.live ? "Claude SDK stopTask(taskId) · backgroundTasks(toolUseId). 이 SDK에는 특정 하위 작업에 직접 메시지를 보내는 제어 API가 없습니다." : "원본 하위 대화 기록입니다. 현재 SDK 실행이 이 task를 다시 알리면 지원 제어가 표시됩니다.";
  }
  private emit(source: "live" | "refresh" = "live") { for (const child of this.children.values()) this.capabilities(child); this.ports.publish(this.list(), source); for (const wake of this.waiters) wake(); if (!this.hasActive()) this.ports.settled(); }
  private put(child: Child, item: TranscriptItem) { child.items.set(item.id, item); while (child.items.size > 500) child.items.delete(child.items.keys().next().value!); }
  private create(taskId: string, canonicalId: string, requestId: string | null) {
    const child: Child = { canonicalId, toolUseId: null, background: false, live: false, runId: null, mapper: new ClaudeTranscriptMapper(), items: new Map(), value: {
      identity: { provider: "claude", parentNativeSessionId: this.parentNativeSessionId ?? "", childId: taskId, generation: this.generation, nativeRunId: null },
      parentRequestId: requestId, parentChildId: null, title: "Claude 하위 작업", state: "outcome_unknown", preview: null, activity: null, updatedAt: Date.now(), sourceItemId: null,
      approvalIds: [], capabilities: { observe: true, send: false, queue: false, steer: false, stop: false, approve: false }, controlDetail: "원본 task 기록",
    } };
    this.children.set(taskId, child); return child;
  }
  /** Returns true for sidechain frames, which must not flow into the parent transcript mapper. */
  observe(message: SDKMessage, requestId: string | null): boolean {
    if (message.type === "system" && message.subtype === "init") {
      this.parentNativeSessionId = message.session_id;
      for (const child of this.children.values()) child.value.identity.parentNativeSessionId = message.session_id;
    }
    if (message.type === "system" && message.subtype === "background_tasks_changed") {
      const activeIds = new Set<string>();
      for (const task of message.tasks) {
        if (task.ambient || task.subagent_type === "main-session" || !["local_agent", "local_workflow"].includes(task.task_type)) continue;
        const child = this.children.get(task.task_id) ?? this.create(task.task_id, task.task_id, requestId);
        if (child.runId && task.run_id && task.run_id < child.runId) continue;
        activeIds.add(task.task_id); child.live = true; child.background = true;
        child.runId = task.run_id ?? child.runId;
        child.value.identity = { provider: "claude", parentNativeSessionId: message.session_id, childId: task.task_id, generation: this.generation, nativeRunId: task.run_id ?? child.value.identity.nativeRunId ?? message.uuid };
        child.value.title = task.description || child.value.title;
        child.value.parentChildId = task.parent_task_id ?? child.value.parentChildId;
        child.value.state = child.value.approvalIds.length ? "waiting_input" : "running";
      }
      for (const child of this.children.values()) if (child.live && child.background && !activeIds.has(child.value.identity.childId) && !ended(child.value.state)) {
        child.live = false; child.value.state = "outcome_unknown";
      }
      this.emit(); return false;
    }
    const frame = message as unknown as { task_id?: string; run_id?: string; tool_use_id?: string; parent_task_id?: string; is_backgrounded?: boolean; patch?: { is_backgrounded?: boolean }; summary?: string; subtype?: string; status?: string; parent_tool_use_id?: string | null };
    const existing = frame.task_id ? this.children.get(frame.task_id) : null;
    // SDK run_id is lexicographically sortable; a late terminal frame cannot finish its new run.
    if (existing?.runId && frame.run_id && frame.run_id < existing.runId) return Boolean(frame.parent_tool_use_id);
    const observations = this.source.observe(message);
    if (frame.task_id && this.source.isDeclaredTask(frame.task_id)) {
      const canonical = frame.tool_use_id ? this.source.resolveSubagentId(frame.tool_use_id) : existing?.canonicalId;
      if (canonical) {
        const child = existing ?? this.create(frame.task_id, canonical, requestId);
        child.canonicalId = canonical;
        if (message.type === "system" && message.subtype === "task_started") {
          const newRun = frame.run_id ?? frame.tool_use_id ?? message.uuid;
          if (child.value.identity.nativeRunId !== newRun) { child.value.parentRequestId = requestId; child.value.approvalIds = []; }
          child.runId = frame.run_id ?? null; child.live = true;
          child.value.identity = { provider: "claude", parentNativeSessionId: this.parentNativeSessionId ?? message.session_id, childId: frame.task_id, generation: this.generation, nativeRunId: newRun };
          child.toolUseId = frame.tool_use_id ?? child.toolUseId;
          child.value.sourceItemId = child.toolUseId;
          child.background = frame.is_backgrounded ?? false;
          child.value.parentChildId = frame.parent_task_id ?? null;
        }
        if (typeof frame.patch?.is_backgrounded === "boolean") child.background = frame.patch.is_backgrounded;
        if (frame.summary) child.value.preview = frame.summary;
      }
    }
    // Level snapshots may precede task_started. Their actual task_id still owns a later terminal edge.
    const announced = frame.task_id ? this.children.get(frame.task_id) : null;
    if (announced && frame.subtype === "task_notification") {
      announced.value.state = frame.status === "stopped" ? "cancelled" : frame.status === "failed" ? "failed" : frame.status === "completed" ? "completed" : announced.value.state;
      if (ended(announced.value.state)) announced.value.approvalIds = [];
      if (frame.summary) announced.value.preview = frame.summary;
      announced.value.updatedAt = Date.now();
    }
    for (const observation of observations) {
      const child = [...this.children.values()].find(entry => entry.canonicalId === observation.id);
      if (!child) continue;
      if (observation.kind === "declared") {
        child.value.title = observation.description || observation.title || child.value.title;
        child.value.state = "running";
        if (observation.parentSubagentId) child.value.parentChildId = [...this.children.values()].find(entry => entry.canonicalId === observation.parentSubagentId)?.value.identity.childId ?? child.value.parentChildId;
      } else if (observation.kind === "status") {
        child.value.state = observation.status === "canceled" ? "cancelled" : observation.status;
        if (ended(child.value.state)) child.value.approvalIds = [];
      } else if (observation.kind === "subtitle") child.value.activity = observation.subtitle;
      else if (observation.kind === "timeline" && (observation.item.type === "assistant_message" || observation.item.type === "user_message")) {
        const text = observation.item.text;
        if (observation.item.type === "assistant_message") child.value.preview = text;
        // Stable IDs make duplicate lifecycle completion messages one child result.
        this.put(child, observation.item.type === "assistant_message" ? { kind: "assistant", id: `task-result:${child.value.identity.nativeRunId}`, text, streaming: false, at: Date.now() } : { kind: "user", id: `task-prompt:${child.value.identity.nativeRunId}`, text, at: Date.now() });
      }
      child.value.updatedAt = Date.now();
    }
    if (frame.parent_tool_use_id) {
      const canonical = this.source.resolveSubagentId(frame.parent_tool_use_id);
      const child = [...this.children.values()].find(entry => entry.canonicalId === canonical);
      if (child) {
        this.source.observeSidechainFrame(message, child.canonicalId);
        // Existing mapper deliberately ignores sidechains; locally re-root only this verified child.
        const local = { ...message, parent_tool_use_id: null } as SDKMessage;
        for (const output of child.mapper.handle(local, child.value.identity.nativeRunId ?? child.canonicalId)) {
          if (output.type === "upsert") { this.put(child, output.item); if (output.item.kind === "assistant") child.value.preview = output.item.text; }
          else if (output.type === "delta") { const item = child.items.get(output.itemId); if (item?.kind === "assistant" || item?.kind === "reasoning") { this.put(child, { ...item, text: item.text + output.text }); if (item.kind === "assistant") child.value.preview = item.text + output.text; } }
        }
        child.value.updatedAt = Date.now();
      }
      this.emit(); return true;
    }
    if (observations.length || frame.task_id) this.emit();
    return false;
  }
  approval(agentId: string | undefined, item: TranscriptItem, pending: boolean) {
    // SDK canUseTool.agentID is the native agent/task id, never inferred from the parent turn.
    const child = agentId ? (this.children.get(agentId) ?? (pending ? this.create(agentId, agentId, null) : undefined)) : [...this.children.values()].find(entry => entry.value.approvalIds.includes(item.id));
    if (!child) return false;
    if (agentId && pending) child.live = true;
    child.value.approvalIds = pending ? [...new Set([...child.value.approvalIds, item.id])] : child.value.approvalIds.filter(id => id !== item.id);
    child.value.state = child.value.approvalIds.length ? "waiting_input" : child.value.state === "waiting_input" ? "running" : child.value.state;
    this.put(child, item); this.emit(); return true;
  }
  disconnected() {
    this.generation = randomUUID();
    for (const child of this.children.values()) { child.live = false; child.value.approvalIds = []; if (!ended(child.value.state)) child.value.state = "outcome_unknown"; }
    this.emit();
  }
  require(target: NativeTaskIdentity) {
    const child = this.children.get(target.childId), actual = child?.value.identity;
    if (!child || !actual || target.provider !== "claude" || target.parentNativeSessionId !== this.parentNativeSessionId || target.generation !== actual.generation || target.nativeRunId !== actual.nativeRunId) throw new HttpError(409, "native_task_stale", "Claude 하위 작업 실행이 바뀌었습니다. 상태를 새로 확인하세요.");
    return child;
  }
  async refresh(cwd: string) {
    if (!this.parentNativeSessionId) return this.list();
    const ids = await listSubagents(this.parentNativeSessionId, { dir: cwd });
    for (const id of ids) if (!this.children.has(id)) this.create(id, id, null);
    this.emit("refresh"); return this.list();
  }
  async history(target: NativeTaskIdentity, cwd: string) {
    const child = this.require(target);
    if (child.live && child.items.size) return { items: [...child.items.values()], detail: child.items.size >= 500 ? "현재 실행에서 관측한 최근 500개 항목입니다." : null };
    const ids = await listSubagents(target.parentNativeSessionId, { dir: cwd });
    if (ids.includes(target.childId)) {
      const records = await getSubagentMessages(target.parentNativeSessionId, target.childId, { dir: cwd, limit: 500 });
      // The SDK has already selected this agent's file; parent_tool_use_id names the outer owner.
      const history = claudeHistory(records.map(record => ({ ...record, parent_tool_use_id: null })), child.value.updatedAt, Date.now());
      return { items: [...new Map([...history, ...child.items.values()].map(item => [item.id, item])).values()], detail: records.length >= 500 ? "원본 하위 대화의 500개 항목입니다." : null };
    }
    return { items: [...child.items.values()], detail: "이 하위 작업의 로컬 SDK transcript는 아직 없습니다. 현재 실행에서 관측한 항목을 표시합니다." };
  }
  async control(target: NativeTaskIdentity, command: NativeTaskControl) {
    const child = this.require(target), query = this.ports.query();
    this.capabilities(child);
    if (!query || command.kind === "steer" || command.kind === "send" || !child.value.capabilities[command.kind === "background" ? "background" : "stop"]) throw new HttpError(409, "native_action_unavailable", "현재 Claude SDK 하위 작업에서 지원하지 않는 제어입니다.");
    if (command.kind === "background") {
      const moved = await query.backgroundTasks(child.toolUseId!);
      if (!moved) throw new HttpError(409, "native_task_finished", "해당 foreground 도구가 끝나 백그라운드로 전환하지 못했습니다.");
      child.background = true; this.emit(); return;
    }
    // Paseo's original stopBackgroundWork uses both SDK ack and task_notification, not ack alone.
    let timer: NodeJS.Timeout | undefined, wake: (() => void) | undefined;
    const settled = new Promise<void>((resolveWait, reject) => {
      wake = () => { if (!this.ports.query() || this.generation !== target.generation) reject(new Error("Claude 실행 연결이 종료되어 중단 결과를 확인하지 못했습니다.")); else if (child.value.identity.nativeRunId !== target.nativeRunId) reject(new Error("하위 작업이 새 실행으로 바뀌어 이전 중단 결과를 확인하지 못했습니다.")); else if (ended(child.value.state)) resolveWait(); };
      this.waiters.add(wake); timer = setTimeout(() => reject(new Error("하위 task 중단 결과가 아직 도착하지 않았습니다. 상태를 확인하세요.")), 15_000); timer.unref();
    });
    void settled.catch(() => undefined);
    try { await query.stopTask(target.childId); await settled; }
    finally { if (timer) clearTimeout(timer); if (wake) this.waiters.delete(wake); }
  }
}
