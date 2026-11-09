import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { NativeTaskControl, NativeTaskIdentity, NativeTaskSnapshot, Session, TranscriptItem, Work } from "@workbench/contracts";
import { mapThreadItem, type CodexRpc, type RpcNotification } from "@workbench/provider-codex";
import type { Thread } from "@workbench/provider-codex/src/generated/v2/Thread.ts";
import type { ThreadReadResponse } from "@workbench/provider-codex/src/generated/v2/ThreadReadResponse.ts";
import type { ThreadResumeResponse } from "@workbench/provider-codex/src/generated/v2/ThreadResumeResponse.ts";
import type { TurnStartResponse } from "@workbench/provider-codex/src/generated/v2/TurnStartResponse.ts";
import type { AskForApproval } from "@workbench/provider-codex/src/generated/v2/AskForApproval.ts";
import type { SandboxPolicy } from "@workbench/provider-codex/src/generated/v2/SandboxPolicy.ts";
import type { SandboxMode } from "@workbench/provider-codex/src/generated/v2/SandboxMode.ts";
import type { ThreadItem } from "@workbench/provider-codex/src/generated/v2/ThreadItem.ts";
import { codexHistory, type CodexTurn } from "../imports.ts";
import { HttpError } from "../errors.ts";

type Child = { sessionId: string; value: NativeTaskSnapshot; items: Map<string, TranscriptItem>; parentThreadId: string; cwd: string | null; verified: boolean };
type Ports = {
  rpc(): CodexRpc | null; root(threadId: string): string | undefined; request(threadId: string): string | null;
  publish(sessionId: string, tasks: NativeTaskSnapshot[], source: "live" | "refresh"): void;
};
const ended = (state: NativeTaskSnapshot["state"]) => ["completed", "failed", "cancelled", "interrupted"].includes(state);
const same = (a: NativeTaskIdentity, b: NativeTaskIdentity) => a.provider === b.provider && a.parentNativeSessionId === b.parentNativeSessionId && a.childId === b.childId && a.generation === b.generation && a.nativeRunId === b.nativeRunId;

/** Workbench scope/lifetime adapter over the official app-server thread/turn API and mapper.
 * Only children linked by provider parentThreadId or an actual collaboration item enter this table. */
export class CodexChildren {
  private generation = randomUUID();
  private readonly children = new Map<string, Child>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly ports: Ports;
  constructor(ports: Ports) { this.ports = ports; }
  owner(threadId: string) { const child = this.children.get(threadId); return child?.verified ? child.sessionId : undefined; }
  hasActive() { return [...this.children.values()].some(child => !ended(child.value.state) && child.value.identity.generation === this.generation); }
  list(sessionId: string) { return [...this.children.values()].filter(child => child.sessionId === sessionId).map(child => structuredClone(child.value)); }
  private emit(child: Child, source: "live" | "refresh" = "live") { this.capabilities(child); this.ports.publish(child.sessionId, this.list(child.sessionId), source); this.waiters.get(child.value.identity.childId)?.forEach(wake => wake()); }
  private capabilities(child: Child) {
    const live = child.verified && Boolean(this.ports.rpc()) && child.value.identity.generation === this.generation;
    const active = live && !ended(child.value.state) && child.value.identity.nativeRunId !== null;
    child.value.capabilities = { observe: true, send: live && ended(child.value.state), queue: false, steer: active, stop: active, approve: live && child.value.approvalIds.length > 0, background: false };
    child.value.controlDetail = live ? "Codex 원본 thread/resume · turn/start · turn/interrupt · turn/steer. 진행 중 메시지는 현재 turn ID를 확인합니다." : "원본 thread 기록을 다시 확인하면 현재 실행에서 지원하는 제어가 표시됩니다.";
  }
  private declare(id: string, parentThreadId: string, sourceItemId: string | null, title?: string): Child | null {
    const existing = this.children.get(id);
    if (existing) return existing;
    const parent = this.children.get(parentThreadId);
    const sessionId = this.ports.root(parentThreadId) ?? parent?.sessionId;
    if (!sessionId) return null;
    const rootId = parent?.value.identity.parentNativeSessionId ?? parentThreadId;
    const child: Child = { sessionId, parentThreadId, cwd: null, verified: false, items: new Map(), value: {
      identity: { provider: "codex", parentNativeSessionId: rootId, childId: id, generation: this.generation, nativeRunId: null },
      parentRequestId: parent?.value.parentRequestId ?? this.ports.request(rootId), parentChildId: parent ? parentThreadId : null,
      title: title || "Codex 하위 작업", state: "outcome_unknown", preview: null, activity: null, updatedAt: Date.now(), sourceItemId,
      approvalIds: [], capabilities: { observe: true, send: false, queue: false, steer: false, stop: false, approve: false }, controlDetail: "하위 thread 확인 중",
    } };
    this.children.set(id, child); return child;
  }
  private thread(thread: Thread, sourceItemId: string | null = null, source: "live" | "refresh" = "live") {
    if (!thread.parentThreadId) return null;
    const child = this.declare(thread.id, thread.parentThreadId, sourceItemId, thread.agentNickname ?? thread.name ?? undefined);
    if (!child) return null;
    child.parentThreadId = thread.parentThreadId; child.cwd = thread.cwd; child.verified = true;
    child.value.identity.generation = this.generation;
    const turn = thread.turns.findLast(entry => entry.status === "inProgress") ?? thread.turns.at(-1);
    child.value.identity.nativeRunId = turn?.id ?? null;
    child.value.state = thread.status.type === "active" || turn?.status === "inProgress" ? "running" : turn?.status === "interrupted" ? "interrupted" : turn?.status === "failed" || thread.status.type === "systemError" ? "failed" : turn ? "completed" : "outcome_unknown";
    child.value.preview = thread.preview || child.value.preview;
    child.value.updatedAt = Math.max(child.value.updatedAt, thread.updatedAt * 1000);
    for (const item of codexHistory(thread.turns as CodexTurn[])) this.put(child, item);
    this.emit(child, source); return child;
  }
  private put(child: Child, item: TranscriptItem) { child.items.set(item.id, item); while (child.items.size > 500) child.items.delete(child.items.keys().next().value!); }
  private collaboration(parentThreadId: string, item: ThreadItem, source: "live" | "refresh" = "live") {
    if (item.type === "collabAgentToolCall") {
      for (const id of item.receiverThreadIds) {
        if (id === parentThreadId) continue;
        const child = this.declare(id, item.senderThreadId, item.id, item.prompt ?? undefined);
        if (!child) continue;
        const state = item.agentsStates[id];
        if (state) {
          child.value.state = state.status === "running" ? "running" : state.status === "pendingInit" ? "queued" : state.status === "completed" ? "completed" : state.status === "errored" ? "failed" : state.status === "shutdown" ? "cancelled" : state.status === "interrupted" ? "interrupted" : "outcome_unknown";
          child.value.preview = state.message ?? child.value.preview;
        }
        child.value.sourceItemId ??= item.id;
        this.emit(child, source);
      }
    } else if (item.type === "subAgentActivity") {
      const child = this.declare(item.agentThreadId, parentThreadId, item.id, item.agentPath);
      if (child) this.emit(child, source);
    }
  }
  /** Called before the parent router, so child outputs never become parent transcript items. */
  observe({ method, params }: RpcNotification) {
    const data = (params ?? {}) as { thread?: Thread; threadId?: string; item?: ThreadItem; turn?: Thread["turns"][number]; itemId?: string; delta?: string };
    if (method === "thread/started" && data.thread) this.thread(data.thread);
    const threadId = data.threadId;
    if (!threadId) return;
    if (data.item && (method === "item/started" || method === "item/completed")) this.collaboration(threadId, data.item);
    const child = this.children.get(threadId);
    if (!child) return;
    if (method === "turn/started" && data.turn) { child.value.identity.generation = this.generation; child.value.identity.nativeRunId = data.turn.id; child.value.state = "running"; }
    if (method === "turn/completed" && data.turn) {
      if (child.value.identity.nativeRunId && child.value.identity.nativeRunId !== data.turn.id) return;
      child.value.identity.nativeRunId = data.turn.id;
      child.value.state = data.turn.status === "interrupted" ? "interrupted" : data.turn.status === "failed" ? "failed" : "completed";
      child.value.approvalIds = [];
    }
    if (data.item && (method === "item/started" || method === "item/completed")) {
      const mapped = mapThreadItem(data.item, Date.now(), method === "item/started");
      if (mapped) this.put(child, mapped);
      if (mapped?.kind === "assistant") child.value.preview = mapped.text;
    }
    if (method === "item/agentMessage/delta" && data.itemId && typeof data.delta === "string") {
      const item = child.items.get(data.itemId);
      if (item?.kind === "assistant") { this.put(child, { ...item, text: item.text + data.delta }); child.value.preview = item.text + data.delta; }
    }
    child.value.updatedAt = Date.now(); this.emit(child);
  }
  approval(threadId: string, item: TranscriptItem, pending: boolean) {
    const child = this.children.get(threadId); if (!child) return false;
    child.value.approvalIds = pending ? [...new Set([...child.value.approvalIds, item.id])] : child.value.approvalIds.filter(id => id !== item.id);
    this.put(child, item); child.value.state = child.value.approvalIds.length ? "waiting_input" : child.value.state === "waiting_input" ? "running" : child.value.state;
    child.value.updatedAt = Date.now(); this.emit(child); return true;
  }
  disconnected() {
    this.generation = randomUUID();
    for (const child of this.children.values()) { child.verified = false; if (!ended(child.value.state)) child.value.state = "outcome_unknown"; child.value.approvalIds = []; this.emit(child); }
  }
  private async read(id: string) { const rpc = this.ports.rpc(); if (!rpc) throw new HttpError(409, "native_runtime_closed", "Codex 실행 연결이 종료되었습니다."); return (await rpc.request<ThreadReadResponse>("thread/read", { threadId: id, includeTurns: true })).thread; }
  async refresh(session: Session, work: Work) {
    if (!session.nativeSessionId) return this.list(session.id);
    const root = await this.read(session.nativeSessionId);
    if (root.id !== session.nativeSessionId || resolve(root.cwd) !== resolve(work.cwd)) throw new HttpError(409, "native_workspace_mismatch", "공급자 부모 thread의 작업공간이 다릅니다.");
    for (const turn of root.turns) for (const item of turn.items) this.collaboration(root.id, item, "refresh");
    // Reads only descendants already observed from provider-owned parent records.
    const pending = [...this.children.values()].filter(child => child.sessionId === session.id).map(child => child.value.identity.childId);
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.shift()!; if (visited.has(id)) continue; visited.add(id);
      const thread = await this.read(id);
      if (!thread.parentThreadId || (thread.parentThreadId !== root.id && this.children.get(thread.parentThreadId)?.sessionId !== session.id)) throw new HttpError(409, "native_parent_mismatch", "하위 thread의 부모 연결을 확인하지 못했습니다.");
      this.thread(thread, null, "refresh");
      for (const turn of thread.turns) for (const item of turn.items) this.collaboration(thread.id, item, "refresh");
      for (const entry of this.children.values()) if (entry.sessionId === session.id && !visited.has(entry.value.identity.childId)) pending.push(entry.value.identity.childId);
    }
    return this.list(session.id);
  }
  require(session: Session, target: NativeTaskIdentity) {
    const child = this.children.get(target.childId);
    if (!child || child.sessionId !== session.id || session.nativeSessionId !== target.parentNativeSessionId || !same(child.value.identity, target)) throw new HttpError(409, "native_task_stale", "하위 작업 실행이 바뀌었습니다. 원본 상태를 새로 확인하세요.");
    return child;
  }
  async control(session: Session, work: Work, target: NativeTaskIdentity, command: NativeTaskControl, policy?: (cwd: string) => { approvalPolicy: AskForApproval; sandbox: SandboxMode; sandboxPolicy: SandboxPolicy }) {
    this.require(session, target);
    await this.refresh(session, work);
    const child = this.require(session, target), rpc = this.ports.rpc();
    if (!rpc || !child.value.identity.nativeRunId || !child.value.capabilities[command.kind === "background" ? "background" : command.kind] || command.kind === "background") throw new HttpError(409, "native_action_unavailable", "이 Codex 하위 작업은 현재 해당 제어를 지원하지 않습니다.");
    if (command.kind === "send") {
      if (!policy || !child.cwd) throw new HttpError(409, "native_policy_unavailable", "하위 작업의 현재 쓰기 정책을 확인하지 못했습니다.");
      const guard = policy(child.cwd);
      // Resume the same provider-owned descendant; never fork an unrelated thread or choose a model.
      const resumed = await rpc.request<ThreadResumeResponse>("thread/resume", { threadId: target.childId, approvalPolicy: guard.approvalPolicy, sandbox: guard.sandbox });
      if (resumed.thread.id !== target.childId || resumed.thread.parentThreadId !== child.parentThreadId) throw new HttpError(409, "native_parent_mismatch", "재개한 하위 thread의 소유 관계가 달라졌습니다.");
      const live = resumed.thread.turns.findLast(turn => turn.status === "inProgress");
      if (live) throw new HttpError(409, "native_task_running", "하위 작업이 이미 다시 실행 중입니다. 현재 작업의 메시지 전달을 사용하세요.");
      const started = await rpc.request<TurnStartResponse>("turn/start", { threadId: target.childId, clientUserMessageId: command.commandId,
        input: [{ type: "text", text: command.text!, text_elements: [] }], approvalPolicy: guard.approvalPolicy, sandboxPolicy: guard.sandboxPolicy });
      child.value.identity.nativeRunId = started.turn.id;
      child.value.state = started.turn.status === "inProgress" ? "running" : started.turn.status === "interrupted" ? "interrupted" : started.turn.status === "failed" ? "failed" : "completed";
      child.value.updatedAt = Date.now(); this.emit(child); return;
    }
    if (command.kind === "steer") {
      await rpc.request("turn/steer", { threadId: target.childId, expectedTurnId: target.nativeRunId, clientUserMessageId: command.commandId, input: [{ type: "text", text: command.text!, text_elements: [] }] });
      return;
    }
    // Same original API as parent interrupt, but the exact child thread and turn are the target.
    let timer: NodeJS.Timeout | undefined, wake: (() => void) | undefined;
    const settled = new Promise<void>((resolveWait, reject) => {
      wake = () => { if (child.value.identity.generation !== target.generation) reject(new Error("Codex 연결이 바뀌어 중단 결과를 확인하지 못했습니다.")); else if (ended(child.value.state)) resolveWait(); };
      const set = this.waiters.get(target.childId) ?? new Set(); set.add(wake); this.waiters.set(target.childId, set);
      timer = setTimeout(() => reject(new Error("하위 작업 중단 결과를 아직 확인하지 못했습니다. 같은 명령을 다시 보내지 말고 상태를 확인하세요.")), 15_000); timer.unref();
    });
    // Attach a handler immediately; an engine exit can settle the notification before RPC does.
    void settled.catch(() => undefined);
    try { await rpc.request("turn/interrupt", { threadId: target.childId, turnId: target.nativeRunId }); await settled; }
    finally { if (timer) clearTimeout(timer); if (wake) this.waiters.get(target.childId)?.delete(wake); }
  }
  async history(session: Session, work: Work, target: NativeTaskIdentity) {
    const child = this.require(session, target);
    if (!child.items.size && this.ports.rpc()) await this.refresh(session, work);
    return { items: [...child.items.values()], detail: child.items.size >= 500 ? "최근 500개 항목입니다. 원본 thread 기록은 Codex에 보존됩니다." : null };
  }
}
