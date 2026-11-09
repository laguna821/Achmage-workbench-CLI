import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { HubRelationshipExecution, HubRelationshipSelection, RunSettings, Session } from "@workbench/contracts";
import type { AgentSnapshotPayload, HubExecutionAgentValidateRequest, HubExecutionAgentValidationIssue } from "@getpaseo/protocol/messages";
import type { HubExecutionAgents, HubExecutionAgentCreateInput, HubExecutionControlInput, OwnedAgentEvent, OwnedAgentSnapshot } from "@workbench/paseo-server-transport/hub/execution-ports";
import type { SessionManager } from "../sessions.ts";
import type { Store } from "../store.ts";
import type { EventBus } from "../bus.ts";

export type HubExecutionGrant = { generation: number; selection: HubRelationshipSelection; settings: RunSettings };
type ExecutionRecord = HubRelationshipExecution & { daemonId: string; payloadHash: string; workspaceId: string; generation: number };
const PREFIX = "hub-outbound-execution:";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const records = (store: Store) => store.metaEntries(PREFIX).map(row => JSON.parse(row.value) as ExecutionRecord);

/** The upstream controller owns RPC behavior. This port translates only Hub-owned
 * executions into existing SessionManager sessions and durable TaskService receipts. */
export class WorkbenchHubExecutions implements HubExecutionAgents {
  private active = true;
  private readonly pending = new Map<string, Promise<OwnedAgentSnapshot>>();
  private readonly listeners = new Set<() => void>();
  private readonly options: { daemonId: string; generation: number; manager: SessionManager; store: Store; bus: EventBus; grant: () => HubExecutionGrant | null };
  constructor(options: WorkbenchHubExecutions["options"]) { this.options = options; }
  private grant() {
    const grant = this.options.grant();
    if (!this.active || !grant || grant.generation !== this.options.generation || (grant.selection.expiresAt !== null && grant.selection.expiresAt <= Date.now()))
      throw new Error("Hub execution permission is disabled, expired or changed. Review it in Workbench.");
    const template = this.options.manager.view.sessions.get(grant.selection.sessionId);
    if (!template || template.archivedAt || template.workspaceId !== grant.selection.workspaceId || template.hostId !== this.options.manager.snapshot().hostId)
      throw new Error("The approved local target is no longer available.");
    this.options.manager.workspaces.requireActive(grant.selection.workspaceId, template.workId);
    if (grant.settings.profileId && this.options.manager.profiles.get(grant.settings.profileId, grant.settings.provider).revision !== grant.settings.profileRevision)
      throw new Error("The approved profile changed. Reconnect after reviewing its settings.");
    return { ...grant, template };
  }
  async validate(input: Omit<HubExecutionAgentValidateRequest, "type" | "requestId">): Promise<HubExecutionAgentValidationIssue[]> {
    try { this.validateOptions(input); return []; }
    catch (error) { return [{ path: [], message: error instanceof Error ? error.message : String(error) }]; }
  }
  private validateOptions(input: Omit<HubExecutionAgentValidateRequest, "type" | "requestId">) {
    const grant = this.grant(), settings = grant.settings;
    if (input.provider !== settings.provider || (input.model !== undefined && input.model !== settings.model)
      || (input.thinkingOptionId !== undefined && input.thinkingOptionId !== settings.effort)
      || input.modeId !== undefined || (input.providerOptions && Object.keys(input.providerOptions).length))
      throw new Error("Use the exact provider/model approved in Workbench. Remote mode and provider-option overrides are not supported.");
    return grant;
  }
  private key(executionId: string) { return PREFIX + hash([this.options.daemonId, executionId]); }
  private read(executionId: string): ExecutionRecord | null { const text = this.options.store.getMeta(this.key(executionId)); return text ? JSON.parse(text) as ExecutionRecord : null; }
  private save(record: ExecutionRecord) { this.options.store.setMeta(this.key(record.executionId), JSON.stringify(record)); }
  create(input: HubExecutionAgentCreateInput): Promise<OwnedAgentSnapshot> {
    const pending = this.pending.get(input.executionId);
    if (pending) return pending.then(() => this.create(input));
    const result = this.createOnce(input).finally(() => { if (this.pending.get(input.executionId) === result) this.pending.delete(input.executionId); });
    this.pending.set(input.executionId, result); return result;
  }
  private async createOnce(input: HubExecutionAgentCreateInput): Promise<OwnedAgentSnapshot> {
    const grant = this.validateOptions(input);
    if (!input.executionId.trim() || input.executionId.length > 256 || !input.prompt.trim() || input.prompt.length > 100_000) throw new Error("Hub execution identity or prompt length is invalid.");
    const workspace = this.options.manager.workspaces.requireActive(grant.selection.workspaceId, grant.template.workId);
    if (realpathSync(input.cwd) !== realpathSync(workspace.cwd)) throw new Error("Hub cwd is outside the explicitly approved workspace.");
    if (input.worktree || input.toolPolicy || Object.keys(input.env ?? {}).length || Object.keys(input.mcpServers ?? {}).length)
      throw new Error("Remote worktree, tool-policy, environment and MCP server injection are not supported. Configure tools locally.");
    const payloadHash = hash(input), previous = this.read(input.executionId);
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw new Error("This execution ID was already used with different input.");
      if (previous.generation !== grant.generation) throw new Error("This execution belongs to an earlier permission grant.");
      const receipt = this.options.manager.tasks.receipt(previous.commandId);
      if (!previous.sessionId || !receipt || receipt.status === "outcome_unknown") throw new Error("Execution outcome is unknown. Inspect its existing Workbench receipt; it was not resubmitted.");
      if (receipt.status === "rejected") throw new Error(receipt.detail ?? "Execution was rejected.");
      return { executionId: input.executionId, agent: this.snapshot(previous) };
    }
    const latest = records(this.options.store).filter(row => row.daemonId === this.options.daemonId).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest && Date.now() - latest.createdAt < grant.selection.minIntervalSeconds * 1000) throw new Error("Hub execution rate limit reached.");
    const record: ExecutionRecord = { executionId: input.executionId, daemonId: this.options.daemonId, payloadHash,
      generation: grant.generation, workspaceId: workspace.id, sessionId: null, commandId: "hub-out." + hash([this.options.daemonId, input.executionId]),
      createdAt: Date.now(), state: "received", detail: null };
    // Persist admission before creating or dispatching work. A crash never silently retries an uncertain command.
    this.save(record);
    const session = this.options.manager.createSession(workspace.workId, { provider: grant.settings.provider, workspaceId: workspace.id,
      purpose: "Hub · " + input.prompt.slice(0, 54), model: grant.settings.model, effort: grant.settings.effort,
      access: grant.settings.access, profileId: grant.settings.profileId }, false);
    record.sessionId = session.id; record.state = "outcome_unknown"; this.save(record);
    this.grant();
    const receipt = await this.options.manager.tasks.submit({ commandId: record.commandId, hostId: session.hostId,
      workspaceId: workspace.id, sessionId: session.id, text: input.prompt, mode: "queue", profileId: grant.settings.profileId });
    record.state = receipt.status === "rejected" ? "failed" : receipt.status === "outcome_unknown" ? "outcome_unknown" : "accepted";
    record.detail = receipt.detail; this.save(record);
    if (record.state === "failed" || record.state === "outcome_unknown") throw new Error(receipt.detail ?? "Hub command outcome could not be confirmed.");
    return { executionId: input.executionId, agent: this.snapshot(record) };
  }
  private owned(executionId: string) {
    const grant = this.grant(), record = this.read(executionId);
    if (!record?.sessionId || record.generation !== grant.generation || record.workspaceId !== grant.selection.workspaceId) throw new Error("This execution is outside the current relationship grant.");
    const session = this.options.manager.view.sessions.get(record.sessionId);
    if (!session || session.workspaceId !== record.workspaceId) throw new Error("The execution session is unavailable.");
    return { record, session };
  }
  async control(input: HubExecutionControlInput): Promise<void> {
    const { record, session } = this.owned(input.executionId);
    const tasks = this.options.manager.tasks.list({ workspaceId: record.workspaceId }).tasks.filter(task => task.sessionId === session.id);
    const task = tasks.find(value => value.requestId === record.commandId);
    if (tasks.some(value => value.requestId !== record.commandId && (value.state === "running" || value.state === "waiting_input" || value.state === "queued")))
      throw new Error("A different local request now owns this session.");
    if (task?.state === "queued") {
      const receipt = await this.options.manager.tasks.command({ commandId: "hub-ctl." + hash([this.options.daemonId, input]), target: task, kind: "cancel_queue", queuedId: record.commandId });
      if (receipt.status !== "completed") throw new Error(receipt.detail ?? "Cancellation outcome is unknown.");
    } else if (task?.capabilities.stop) {
      const receipt = await this.options.manager.tasks.command({ commandId: "hub-ctl." + hash([this.options.daemonId, input]), target: task, kind: "stop" });
      if (receipt.status !== "completed") throw new Error(receipt.detail ?? "Interruption outcome is unknown.");
    }
    this.grant();
    if (input.action === "archive") this.options.manager.updateSession(session.id, { archived: true });
  }
  private snapshot(record: ExecutionRecord): AgentSnapshotPayload {
    const session = record.sessionId && this.options.manager.view.sessions.get(record.sessionId);
    if (!session) throw new Error("The recorded Hub session is unavailable.");
    return projectSession(session, this.options.manager.workspaces.get(record.workspaceId).cwd);
  }
  subscribe(listener: (event: OwnedAgentEvent) => void): () => void {
    const seen = new Map<string, string>();
    const publish = (record: ExecutionRecord, includeReply: boolean) => {
      try { this.owned(record.executionId); } catch { return; }
      const agent = this.snapshot(record); listener({ type: "update", executionId: record.executionId, agent });
      if (!includeReply || !record.sessionId) return;
      for (const item of this.options.manager.items(record.sessionId).items) {
        if (item.kind !== "assistant" || item.streaming || !item.text || seen.get(item.id) === item.text) continue;
        seen.set(item.id, item.text);
        listener({ type: "stream", executionId: record.executionId, agentId: agent.id, event: { type: "timeline", provider: agent.provider,
          item: { type: "assistant_message", text: item.text, messageId: item.id } } });
      }
    };
    const owned = () => records(this.options.store).filter(record => record.daemonId === this.options.daemonId && record.generation === this.options.generation);
    const release = this.options.bus.subscribe(event => {
      const sessionId = event.type === "session.upserted" ? event.session.id : event.type === "item.upserted" ? event.sessionId : null;
      if (sessionId) for (const record of owned()) if (record.sessionId === sessionId) publish(record, event.type === "item.upserted");
    });
    this.listeners.add(release);
    for (const record of owned()) publish(record, true);
    return () => { release(); this.listeners.delete(release); };
  }
  async invalidateAuthority() { this.active = false; for (const release of this.listeners) release(); this.listeners.clear(); await Promise.allSettled(this.pending.values()); }
}

function projectSession(session: Session, cwd: string): AgentSnapshotPayload {
  return { id: session.id, provider: session.provider, cwd, workspaceId: session.workspaceId, model: session.engineModel ?? session.model,
    createdAt: new Date(session.createdAt).toISOString(), updatedAt: new Date(session.updatedAt).toISOString(), lastUserMessageAt: null,
    status: session.archivedAt ? "closed" : session.status === "error" ? "error" : session.status === "idle" ? "idle" : "running",
    capabilities: { supportsStreaming: true, supportsSessionPersistence: true, supportsDynamicModes: false,
      supportsMcpServers: false, supportsReasoningStream: false, supportsToolInvocations: true },
    currentModeId: null, availableModes: [], pendingPermissions: [], persistence: session.nativeSessionId ? { provider: session.provider, sessionId: session.nativeSessionId } : null,
    title: session.purpose, labels: { "workbench.origin": "paseo-hub" }, requiresAttention: session.status === "awaitingApproval" || session.status === "error",
    attentionReason: session.status === "awaitingApproval" ? "permission" : session.status === "error" ? "error" : null,
    ...(session.lastError ? { lastError: session.lastError } : {}), archivedAt: session.archivedAt ? new Date(session.archivedAt).toISOString() : null };
}

export function hubExecutionHistory(store: Store, manager: SessionManager): HubRelationshipExecution[] {
  const tasks = manager.tasks.list().tasks;
  return records(store).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(record => {
    const task = tasks.find(task => task.sessionId === record.sessionId && task.requestId === record.commandId);
    const state = task ? task.state === "cancelled" || task.state === "interrupted" ? "failed" : task.state === "queued" ? "accepted" : task.state : record.state;
    return { executionId: record.executionId, sessionId: record.sessionId, commandId: record.commandId,
      createdAt: record.createdAt, state, detail: record.detail };
  });
}
