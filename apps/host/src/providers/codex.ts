import { spawn } from "node:child_process";
import type { ApprovalDecision, ModelOption, ProviderStatus, Session, UsageWindow, Work } from "@workbench/contracts";
import { CodexRpc, mapPlanSteps, mapThreadItem, type RpcNotification, type RpcServerRequest } from "@workbench/provider-codex";
import type { AgentMessageDeltaNotification } from "@workbench/provider-codex/src/generated/v2/AgentMessageDeltaNotification.ts";
import type { CommandExecutionRequestApprovalParams } from "@workbench/provider-codex/src/generated/v2/CommandExecutionRequestApprovalParams.ts";
import type { ErrorNotification } from "@workbench/provider-codex/src/generated/v2/ErrorNotification.ts";
import type { FileChangeRequestApprovalParams } from "@workbench/provider-codex/src/generated/v2/FileChangeRequestApprovalParams.ts";
import type { GetAccountRateLimitsResponse } from "@workbench/provider-codex/src/generated/v2/GetAccountRateLimitsResponse.ts";
import type { GetAccountResponse } from "@workbench/provider-codex/src/generated/v2/GetAccountResponse.ts";
import type { ItemCompletedNotification } from "@workbench/provider-codex/src/generated/v2/ItemCompletedNotification.ts";
import type { ItemStartedNotification } from "@workbench/provider-codex/src/generated/v2/ItemStartedNotification.ts";
import type { ReasoningEffort } from "@workbench/provider-codex/src/generated/ReasoningEffort.ts";
import type { ConfigReadResponse } from "@workbench/provider-codex/src/generated/v2/ConfigReadResponse.ts";
import type { ModelListResponse } from "@workbench/provider-codex/src/generated/v2/ModelListResponse.ts";
import type { ThreadReadResponse } from "@workbench/provider-codex/src/generated/v2/ThreadReadResponse.ts";
import type { ThreadSettingsUpdatedNotification } from "@workbench/provider-codex/src/generated/v2/ThreadSettingsUpdatedNotification.ts";
import type { LoginAccountResponse } from "@workbench/provider-codex/src/generated/v2/LoginAccountResponse.ts";
import type { PermissionsRequestApprovalParams } from "@workbench/provider-codex/src/generated/v2/PermissionsRequestApprovalParams.ts";
import type { RateLimitSnapshot } from "@workbench/provider-codex/src/generated/v2/RateLimitSnapshot.ts";
import type { ReasoningSummaryTextDeltaNotification } from "@workbench/provider-codex/src/generated/v2/ReasoningSummaryTextDeltaNotification.ts";
import type { ThreadStartResponse } from "@workbench/provider-codex/src/generated/v2/ThreadStartResponse.ts";
import type { TurnCompletedNotification } from "@workbench/provider-codex/src/generated/v2/TurnCompletedNotification.ts";
import type { TurnPlanUpdatedNotification } from "@workbench/provider-codex/src/generated/v2/TurnPlanUpdatedNotification.ts";
import type { TurnStartResponse } from "@workbench/provider-codex/src/generated/v2/TurnStartResponse.ts";
import type { TurnStartedNotification } from "@workbench/provider-codex/src/generated/v2/TurnStartedNotification.ts";
import { resolveCodex } from "../binaries.ts";
import { billingVarsIn, engineEnv } from "../engine-env.ts";
import { codexAccountInfo } from "../engine-login.ts";
import { emptyStatus, type AdapterSink, type LoginStart, type ProviderAdapter } from "./types.ts";

const CLIENT_VERSION = "0.1.0";

type PendingApproval = { rpcId: number | string; method: string; params: unknown; sessionId: string };

const ACTIVITY: Record<string, string> = {
  agentMessage: "응답 작성 중",
  reasoning: "생각하는 중",
  commandExecution: "명령 실행 중",
  fileChange: "파일 수정 중",
  mcpToolCall: "도구 사용 중",
  webSearch: "웹 검색 중",
};

function windowLabel(minutes: number | null): string {
  if (minutes === 300) return "5시간";
  if (minutes === 10080) return "주간";
  if (!minutes) return "한도";
  return minutes % 1440 === 0 ? `${minutes / 1440}일` : `${Math.round(minutes / 60)}시간`;
}

export function usageFromSnapshot(snapshot: RateLimitSnapshot | null | undefined): UsageWindow[] {
  if (!snapshot) {
    return [];
  }
  return [snapshot.primary, snapshot.secondary]
    .filter((window): window is NonNullable<typeof window> => window !== null)
    .map((window) => ({
      label: windowLabel(window.windowDurationMins),
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt ? window.resetsAt * 1000 : null,
    }));
}

/**
 * Picker options from `model/list`. The user's config.toml (`model`, `model_reasoning_effort`)
 * decides what "default" means, so it overrides the built-in default marks when it names a listed model.
 */
export function modelsFromList(list: ModelListResponse, configured?: { model: string | null; effort: string | null }): ModelOption[] {
  const options = list.data
    .filter((model) => !model.hidden)
    .map((model) => ({
      id: model.model || model.id,
      label: model.displayName || model.model,
      description: model.description || null,
      efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
      defaultEffort: model.defaultReasoningEffort ?? null,
      isDefault: model.isDefault,
    }));
  const base = options.find((option) => option.id === configured?.model) ?? options.find((option) => option.isDefault);
  if (!base) return options;
  const effort = configured?.effort && base.efforts.includes(configured.effort) ? configured.effort : base.defaultEffort;
  return options.map((option) => (option.id === base.id ? { ...option, isDefault: true, defaultEffort: effort } : { ...option, isDefault: false }));
}

/**
 * Codex keeps a turn's model and effort for later turns, so every turn names them explicitly;
 * otherwise going back to "default" in the picker would silently keep the last override.
 */
export function turnSettings(session: Pick<Session, "model" | "effort">, models: ModelOption[]) {
  const chosen = (session.model && models.find((model) => model.id === session.model)) || (!session.model && models.find((model) => model.isDefault)) || null;
  return { model: session.model ?? chosen?.id ?? null, effort: session.effort ?? chosen?.defaultEffort ?? null };
}

export class CodexAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  private rpc: CodexRpc | null = null;
  private ready: Promise<void> | null = null;
  private current: ProviderStatus = emptyStatus("codex");
  private readonly sink: AdapterSink;
  private readonly approvalPolicy: string;
  private readonly sandbox: string;
  /** threadId -> sessionId */
  private readonly threads = new Map<string, string>();
  /** threadIds resumed or started in this app-server process */
  private readonly loaded = new Set<string>();
  /** threadId -> active turn id */
  private readonly activeTurns = new Map<string, string>();
  private readonly interrupting = new Set<string>();
  /** approval item id -> pending server request */
  private readonly approvals = new Map<string, PendingApproval>();
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly idleMs: number;

  constructor(sink: AdapterSink, options?: { approvalPolicy?: string; sandbox?: string; idleMs?: number }) {
    this.sink = sink;
    this.approvalPolicy = options?.approvalPolicy ?? "on-request";
    this.sandbox = options?.sandbox ?? "workspace-write";
    this.idleMs = options?.idleMs ?? 10 * 60_000;
  }

  /**
   * The app-server is only kept while Codex is in use. When nothing runs and no approval is
   * pending it is stopped; the next request starts it again and resumes the same threads.
   */
  private scheduleIdleStop(ms: number) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activeTurns.size === 0 && this.approvals.size === 0) {
        this.rpc?.stop();
      }
    }, ms);
  }

  private cancelIdleStop() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  status() {
    return this.current;
  }

  async init() {
    // Read login and usage once, then let the engine go idle until Codex is actually used.
    await this.ensureRunning().catch(() => undefined);
    this.scheduleIdleStop(60_000);
  }

  private publish(patch: Partial<ProviderStatus>) {
    this.current = { ...this.current, ...patch };
    this.sink.providerStatus(this.current);
  }

  private ensureRunning(): Promise<void> {
    this.cancelIdleStop();
    if (this.rpc?.running && this.ready) {
      return this.ready;
    }
    this.ready = (async () => {
      const binary = await resolveCodex();
      if (!binary) {
        this.publish({ installed: false, error: "codex를 찾지 못했습니다." });
        throw new Error("codex를 찾지 못했습니다.");
      }
      this.publish({ installed: true, binary: binary.path, binarySource: binary.source, version: binary.version, billingVars: billingVarsIn(), error: null });
      const rpc = new CodexRpc({
        binary: binary.path,
        env: engineEnv({ command: binary.path }),
        onNotification: (notification) => this.onNotification(notification),
        onServerRequest: (request) => this.onServerRequest(request),
        onExit: (code, stderr) => this.onExit(code, stderr),
      });
      this.rpc = rpc;
      this.loaded.clear();
      rpc.start();
      await rpc.request("initialize", {
        clientInfo: { name: "achmage_workbench", title: "Achmage Workbench", version: CLIENT_VERSION },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      rpc.notify("initialized");
      await this.refreshStatus();
    })();
    this.ready.catch(() => {
      this.ready = null;
    });
    return this.ready;
  }

  private onExit(code: number | null, stderr: string) {
    this.rpc = null;
    this.ready = null;
    for (const [threadId, sessionId] of this.threads) {
      if (this.activeTurns.has(threadId)) {
        this.sink.upsertItem(sessionId, {
          kind: "notice",
          id: `exit:${Date.now()}`,
          level: "error",
          text: "Codex 엔진이 종료되어 응답이 끊겼습니다. 다시 보내면 이어서 진행합니다.",
          at: Date.now(),
        });
        this.sink.updateSession(sessionId, { status: "idle", activity: null, lastError: stderr.slice(-500) || `exit ${code}` });
      }
    }
    this.activeTurns.clear();
    this.approvals.clear();
  }

  async refreshStatus(): Promise<ProviderStatus> {
    if (!this.rpc?.running) {
      // Explicit refresh: start briefly to read account and usage.
      await this.ensureRunning().catch(() => undefined);
      this.scheduleIdleStop(60_000);
    }
    const rpc = this.rpc;
    if (!rpc?.running) {
      return this.current;
    }
    try {
      const account = await rpc.request<GetAccountResponse>("account/read", { refreshToken: false });
      const login = codexAccountInfo(account);
      const loggedIn = Boolean(login?.signedIn);
      this.publish(
        login?.signedIn
          ? { loggedIn, loginMethod: login.method, account: login.account ?? (login.method === "metered" ? "API 키" : null), plan: login.plan }
          : { loggedIn, loginMethod: null, account: null, plan: null },
      );
      if (loggedIn) {
        const limits = await rpc.request<GetAccountRateLimitsResponse>("account/rateLimits/read", undefined);
        this.publish({ usage: usageFromSnapshot(limits.rateLimits), usageObservedAt: Date.now() });
        if (!this.current.models.length) {
          const [models, config] = await Promise.all([
            rpc.request<ModelListResponse>("model/list", { limit: 100 }),
            rpc.request<ConfigReadResponse>("config/read", {}).catch(() => null),
          ]);
          this.publish({
            models: modelsFromList(models, { model: config?.config.model ?? null, effort: config?.config.model_reasoning_effort ?? null }),
          });
        }
      }
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : String(error) });
    }
    return this.current;
  }

  async login(): Promise<LoginStart> {
    await this.ensureRunning();
    const response = await this.rpc!.request<LoginAccountResponse>("account/login/start", { type: "chatgpt" });
    if (response.type === "chatgpt") {
      spawn("xdg-open", [response.authUrl], { detached: true, stdio: "ignore" }).unref();
      return { url: response.authUrl, message: "브라우저에서 ChatGPT 로그인을 마치면 자동으로 연결됩니다." };
    }
    return { url: null, message: "로그인을 시작했습니다." };
  }

  async send(session: Session, work: Work, text: string) {
    await this.ensureRunning();
    const rpc = this.rpc!;
    let threadId = session.nativeSessionId;
    if (!threadId) {
      const started = await rpc.request<ThreadStartResponse>("thread/start", {
        cwd: work.cwd,
        model: session.model,
        approvalPolicy: this.approvalPolicy,
        sandbox: this.sandbox,
        serviceName: "achmage_workbench",
      });
      threadId = started.thread.id;
      this.sink.updateSession(session.id, { nativeSessionId: threadId, engineModel: started.model, engineEffort: started.reasoningEffort });
      this.loaded.add(threadId);
    } else if (!this.loaded.has(threadId)) {
      await rpc.request<ThreadStartResponse>("thread/resume", {
        threadId,
        cwd: work.cwd,
        approvalPolicy: this.approvalPolicy,
        sandbox: this.sandbox,
        excludeTurns: true,
      });
      this.loaded.add(threadId);
    }
    this.threads.set(threadId, session.id);
    // Model and effort are per turn, so a change in the picker applies to the next message.
    const { model, effort } = turnSettings(session, this.current.models);
    const response = await rpc.request<TurnStartResponse>("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...(model ? { model } : {}),
      ...(effort ? { effort: effort as ReasoningEffort } : {}),
    });
    this.activeTurns.set(threadId, response.turn.id);
    // Codex 0.160 sends no settings notification for per-turn overrides; read what the thread now uses.
    const sessionId = session.id;
    void rpc
      .request<ThreadReadResponse>("thread/read", { threadId })
      .then(({ thread }) => this.sink.updateSession(sessionId, { engineModel: thread.model, engineEffort: thread.reasoningEffort }))
      .catch(() => undefined);
  }

  async interrupt(session: Session) {
    const threadId = session.nativeSessionId;
    const turnId = threadId ? this.activeTurns.get(threadId) : undefined;
    if (!threadId || !turnId || !this.rpc) {
      this.sink.updateSession(session.id, { status: "idle", activity: null });
      return;
    }
    this.interrupting.add(threadId);
    this.sink.updateSession(session.id, { status: "interrupting", activity: "중단하는 중" });
    for (const [itemId, pending] of this.approvals) {
      if (pending.sessionId === session.id) {
        await this.answerApproval(session, itemId, "decline");
      }
    }
    await this.rpc.request("turn/interrupt", { threadId, turnId });
  }

  async answerApproval(session: Session, itemId: string, decision: ApprovalDecision) {
    const pending = this.approvals.get(itemId);
    if (!pending || pending.sessionId !== session.id || !this.rpc) {
      return false;
    }
    this.approvals.delete(itemId);
    if (pending.method === "item/permissions/requestApproval") {
      const params = pending.params as PermissionsRequestApprovalParams;
      const granted = decision === "accept" ? { ...(params.permissions.network ? { network: params.permissions.network } : {}), ...(params.permissions.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}) } : {};
      this.rpc.respond(pending.rpcId, { permissions: granted, scope: "turn" });
    } else {
      this.rpc.respond(pending.rpcId, { decision });
    }
    this.sink.upsertItem(session.id, { ...this.approvalItem(itemId, pending), decision });
    const stillWaiting = [...this.approvals.values()].some((other) => other.sessionId === session.id);
    this.sink.updateSession(session.id, stillWaiting ? {} : { status: "running", activity: "응답 준비 중" });
    return true;
  }

  async shutdown() {
    this.cancelIdleStop();
    this.rpc?.stop();
  }

  private approvalItem(itemId: string, pending: PendingApproval) {
    const at = Date.now();
    if (pending.method === "item/commandExecution/requestApproval") {
      const params = pending.params as CommandExecutionRequestApprovalParams;
      return {
        kind: "approval" as const,
        id: itemId,
        title: "이 명령을 실행할까요?",
        detail: params.command ?? null,
        reason: params.reason ?? null,
        decision: null,
        at,
      };
    }
    if (pending.method === "item/fileChange/requestApproval") {
      const params = pending.params as FileChangeRequestApprovalParams;
      return {
        kind: "approval" as const,
        id: itemId,
        title: "파일을 변경할까요?",
        detail: params.grantRoot ?? null,
        reason: params.reason ?? null,
        decision: null,
        at,
      };
    }
    const params = pending.params as PermissionsRequestApprovalParams;
    return {
      kind: "approval" as const,
      id: itemId,
      title: "추가 권한을 허용할까요?",
      detail: JSON.stringify(params.permissions),
      reason: params.reason,
      decision: null,
      at,
    };
  }

  private onServerRequest(request: RpcServerRequest) {
    const params = (request.params ?? {}) as { threadId?: string };
    const sessionId = params.threadId ? this.threads.get(params.threadId) : undefined;
    const supported = [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ];
    if (!sessionId || !supported.includes(request.method)) {
      this.rpc?.respondError(request.id, `Achmage Workbench does not handle ${request.method}`);
      return;
    }
    const itemId = `approval:${String(request.id)}`;
    const pending = { rpcId: request.id, method: request.method, params: request.params, sessionId };
    this.approvals.set(itemId, pending);
    this.sink.upsertItem(sessionId, this.approvalItem(itemId, pending));
    this.sink.updateSession(sessionId, { status: "awaitingApproval", activity: "승인 필요" });
  }

  private onNotification({ method, params }: RpcNotification) {
    const threadId = (params as { threadId?: string } | undefined)?.threadId;
    const sessionId = threadId ? this.threads.get(threadId) : undefined;
    switch (method) {
      case "account/rateLimits/updated": {
        const usage = usageFromSnapshot((params as { rateLimits: RateLimitSnapshot }).rateLimits);
        if (usage.length) {
          this.publish({ usage, usageObservedAt: Date.now() });
        }
        return;
      }
      case "account/login/completed":
      case "account/updated":
        void this.refreshStatus();
        return;
    }
    if (!sessionId || !threadId) {
      return;
    }
    switch (method) {
      case "thread/settings/updated": {
        // Reported after a turn applies the picked model / effort.
        const { threadSettings } = params as ThreadSettingsUpdatedNotification;
        this.sink.updateSession(sessionId, { engineModel: threadSettings.model, engineEffort: threadSettings.effort });
        break;
      }
      case "turn/started": {
        const { turn } = params as TurnStartedNotification;
        this.activeTurns.set(threadId, turn.id);
        this.sink.updateSession(sessionId, { status: "running", activity: "응답 준비 중", lastError: null });
        break;
      }
      case "item/started": {
        const { item } = params as ItemStartedNotification;
        const mapped = mapThreadItem(item, Date.now(), true);
        if (mapped) {
          this.sink.upsertItem(sessionId, mapped);
        }
        if (ACTIVITY[item.type]) {
          this.sink.updateSession(sessionId, { activity: ACTIVITY[item.type] });
        }
        break;
      }
      case "item/completed": {
        const { item } = params as ItemCompletedNotification;
        const mapped = mapThreadItem(item, Date.now(), false);
        if (mapped) {
          this.sink.upsertItem(sessionId, mapped);
        }
        break;
      }
      case "item/agentMessage/delta": {
        const delta = params as AgentMessageDeltaNotification;
        this.sink.delta(sessionId, delta.itemId, delta.delta);
        break;
      }
      case "item/reasoning/summaryTextDelta": {
        const delta = params as ReasoningSummaryTextDeltaNotification;
        this.sink.delta(sessionId, delta.itemId, delta.delta);
        break;
      }
      case "turn/plan/updated": {
        const plan = params as TurnPlanUpdatedNotification;
        this.sink.upsertItem(sessionId, {
          kind: "plan",
          id: `plan:${plan.turnId}`,
          steps: mapPlanSteps(plan.plan),
          at: Date.now(),
        });
        break;
      }
      case "error": {
        const notification = params as ErrorNotification;
        if (!notification.willRetry) {
          this.sink.upsertItem(sessionId, {
            kind: "notice",
            id: `error:${notification.turnId}`,
            level: "error",
            text: notification.error.message,
            at: Date.now(),
          });
        }
        break;
      }
      case "turn/completed": {
        const { turn } = params as TurnCompletedNotification;
        this.activeTurns.delete(threadId);
        const interrupted = this.interrupting.delete(threadId) || turn.status === "interrupted";
        const status = interrupted ? "interrupted" : turn.status === "failed" ? "failed" : "completed";
        for (const [itemId, pending] of this.approvals) {
          if (pending.sessionId === sessionId) {
            this.approvals.delete(itemId);
            this.sink.upsertItem(sessionId, { ...this.approvalItem(itemId, pending), decision: "expired" });
          }
        }
        this.sink.upsertItem(sessionId, {
          kind: "turnEnd",
          id: `end:${turn.id}`,
          status,
          durationMs: turn.durationMs,
          at: Date.now(),
        });
        this.sink.updateSession(sessionId, {
          status: "idle",
          activity: null,
          lastError: status === "failed" ? turn.error?.message ?? "실패" : null,
        });
        void this.refreshStatus();
        if (this.activeTurns.size === 0) this.scheduleIdleStop(this.idleMs);
        break;
      }
    }
  }
}
