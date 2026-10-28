import { spawn } from "node:child_process";
import type { AccessMode, ApprovalDecision, ModelOption, ProviderStatus, Session, UsageWindow, Work } from "@workbench/contracts";
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
import type { McpServerElicitationRequestParams } from "@workbench/provider-codex/src/generated/v2/McpServerElicitationRequestParams.ts";
import type { AskForApproval } from "@workbench/provider-codex/src/generated/v2/AskForApproval.ts";
import type { Config } from "@workbench/provider-codex/src/generated/v2/Config.ts";
import type { SandboxMode } from "@workbench/provider-codex/src/generated/v2/SandboxMode.ts";
import type { SandboxPolicy } from "@workbench/provider-codex/src/generated/v2/SandboxPolicy.ts";
import type { ThreadTokenUsageUpdatedNotification } from "@workbench/provider-codex/src/generated/v2/ThreadTokenUsageUpdatedNotification.ts";
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
  contextCompaction: "대화를 압축하는 중",
};

/** What each access means to Codex: when to ask, and the sandbox around commands. */
const ACCESS: Record<AccessMode, { approvalPolicy: AskForApproval; sandbox: SandboxMode }> = {
  ask: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  full: { approvalPolicy: "never", sandbox: "danger-full-access" },
};

function sandboxPolicy(mode: SandboxMode): SandboxPolicy {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  return { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

/** The access the user's own Codex settings give (config.toml approval_policy / sandbox_mode). */
export function configuredAccess(config: Pick<Config, "approval_policy" | "sandbox_mode"> | null | undefined): AccessMode | null {
  const approval = config?.approval_policy ?? null;
  const sandbox = config?.sandbox_mode ?? null;
  if (approval === "never" && sandbox === "danger-full-access") return "full";
  if (approval === "untrusted" || sandbox === "read-only") return "ask";
  return approval || sandbox ? "auto" : null;
}

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

/** An MCP elicitation that is a tool-call approval: Codex marks it, or it asks for nothing but yes/no. */
export function isToolApproval(params: McpServerElicitationRequestParams) {
  const meta = params._meta as { codex_approval_kind?: unknown } | null;
  if (meta && typeof meta === "object" && meta.codex_approval_kind === "mcp_tool_call") return true;
  if (params.mode !== "form") return false;
  const schema = params.requestedSchema as { properties?: Record<string, unknown> } | null;
  return !schema?.properties || Object.keys(schema.properties).length === 0;
}

export class CodexAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  private rpc: CodexRpc | null = null;
  private ready: Promise<void> | null = null;
  private current: ProviderStatus = emptyStatus("codex");
  private readonly sink: AdapterSink;
  /** Fixed by the environment for tests (WORKBENCH_CODEX_APPROVAL / _SANDBOX); otherwise per session. */
  private readonly forced: { approvalPolicy?: string; sandbox?: string };
  /** threadId -> the access its turns run with now */
  private readonly threadAccess = new Map<string, AccessMode>();
  /** sessionId -> the access the user last set (approvals arriving meanwhile follow it) */
  private readonly sessionAccess = new Map<string, AccessMode>();
  /** threads compacting on request (their turn is not a reply) */
  private readonly compacting = new Set<string>();
  /** model_auto_compact_token_limit from the user's settings, when set */
  private compactLimit: number | null = null;
  /** threadId -> sessionId */
  private readonly threads = new Map<string, string>();
  /** threadIds resumed or started in this app-server process */
  private readonly loaded = new Set<string>();
  /** threadId -> active turn id */
  private readonly activeTurns = new Map<string, string>();
  private readonly interrupting = new Set<string>();
  /** threadId -> steered requests (turn keys) Codex has not yet taken into the conversation */
  private readonly steers = new Map<string, string[]>();
  /** threadId -> user messages Codex recorded in the running turn (the first is the request itself) */
  private readonly userMessages = new Map<string, number>();
  /** approval item id -> pending server request */
  private readonly approvals = new Map<string, PendingApproval>();
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly idleMs: number;

  constructor(sink: AdapterSink, options?: { approvalPolicy?: string; sandbox?: string; idleMs?: number }) {
    this.sink = sink;
    this.forced = { approvalPolicy: options?.approvalPolicy, sandbox: options?.sandbox };
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
      // The user's own settings decide what a session's default access is, and when Codex compacts.
      const config = await rpc.request<ConfigReadResponse>("config/read", {}).catch(() => null);
      this.compactLimit = config?.config.model_auto_compact_token_limit ? Number(config.config.model_auto_compact_token_limit) : null;
      this.publish({ configuredAccess: configuredAccess(config?.config) });
      if (loggedIn) {
        const limits = await rpc.request<GetAccountRateLimitsResponse>("account/rateLimits/read", undefined);
        this.publish({ usage: usageFromSnapshot(limits.rateLimits), usageObservedAt: Date.now() });
        if (!this.current.models.length) {
          const models = await rpc.request<ModelListResponse>("model/list", { limit: 100 });
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

  /** Approval and sandbox for an access, unless the environment fixes them (tests). */
  private policyFor(access: AccessMode) {
    return {
      approvalPolicy: (this.forced.approvalPolicy ?? ACCESS[access].approvalPolicy) as AskForApproval,
      sandbox: (this.forced.sandbox ?? ACCESS[access].sandbox) as SandboxMode,
    };
  }

  /** The session's thread, started or resumed in this app-server with the session's access. */
  private async threadFor(session: Session & { access: AccessMode }, work: Work) {
    const rpc = this.rpc!;
    let threadId = session.nativeSessionId;
    if (!threadId) {
      const started = await rpc.request<ThreadStartResponse>("thread/start", {
        cwd: work.cwd,
        model: session.model,
        ...this.policyFor(session.access),
        serviceName: "achmage_workbench",
      });
      threadId = started.thread.id;
      this.sink.updateSession(session.id, { nativeSessionId: threadId, engineModel: started.model, engineEffort: started.reasoningEffort });
      this.loaded.add(threadId);
      this.threadAccess.set(threadId, session.access);
    } else if (!this.loaded.has(threadId)) {
      await rpc.request<ThreadStartResponse>("thread/resume", { threadId, cwd: work.cwd, ...this.policyFor(session.access), excludeTurns: true });
      this.loaded.add(threadId);
      this.threadAccess.set(threadId, session.access);
    }
    this.threads.set(threadId, session.id);
    this.sessionAccess.set(session.id, session.access);
    return threadId;
  }

  async send(session: Session & { access: AccessMode }, work: Work, text: string) {
    await this.ensureRunning();
    const rpc = this.rpc!;
    const threadId = await this.threadFor(session, work);
    // Model and effort are per turn, so a change in the picker applies to the next message.
    const { model, effort } = turnSettings(session, this.current.models);
    // So is access: a change since the thread started is passed with the turn (and kept by Codex).
    const policy = this.policyFor(session.access);
    const changed = this.threadAccess.get(threadId) !== session.access;
    this.threadAccess.set(threadId, session.access);
    const response = await rpc.request<TurnStartResponse>("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...(model ? { model } : {}),
      ...(effort ? { effort: effort as ReasoningEffort } : {}),
      ...(changed ? { approvalPolicy: policy.approvalPolicy, sandboxPolicy: sandboxPolicy(policy.sandbox) } : {}),
    });
    this.activeTurns.set(threadId, response.turn.id);
    // Codex 0.160 sends no settings notification for per-turn overrides; read what the thread now uses.
    const sessionId = session.id;
    void rpc
      .request<ThreadReadResponse>("thread/read", { threadId })
      .then(({ thread }) => this.sink.updateSession(sessionId, { engineModel: thread.model, engineEffort: thread.reasoningEffort }))
      .catch(() => undefined);
  }

  /** Put a request into the running turn (`turn/steer`); false when that turn is already over. */
  async steer(session: Session, _work: Work, text: string, turnKey: string) {
    const threadId = session.nativeSessionId;
    const turnId = threadId ? this.activeTurns.get(threadId) : undefined;
    if (!threadId || !turnId || !this.rpc || this.interrupting.has(threadId)) return false;
    // Noted before sending: Codex may record the message before its answer to the request arrives.
    this.steers.set(threadId, [...(this.steers.get(threadId) ?? []), turnKey]);
    try {
      await this.rpc.request("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text, text_elements: [] }],
        clientUserMessageId: turnKey,
      });
      return true;
    } catch {
      // The turn ended between the check and the request (expectedTurnId no longer matches).
      this.steers.set(threadId, (this.steers.get(threadId) ?? []).filter((key) => key !== turnKey));
      return false;
    }
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

  /** Answer Codex; `shown`: the card is on screen and records the answer. */
  private respond(itemId: string, pending: PendingApproval, decision: ApprovalDecision, shown = true) {
    this.approvals.delete(itemId);
    if (pending.method === "item/permissions/requestApproval") {
      const params = pending.params as PermissionsRequestApprovalParams;
      const granted = decision === "accept" ? { ...(params.permissions.network ? { network: params.permissions.network } : {}), ...(params.permissions.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}) } : {};
      this.rpc?.respond(pending.rpcId, { permissions: granted, scope: "turn" });
    } else if (pending.method === "mcpServer/elicitation/request") {
      this.rpc?.respond(pending.rpcId, decision === "accept" ? { action: "accept", content: {}, _meta: null } : { action: "decline", content: null, _meta: null });
    } else {
      this.rpc?.respond(pending.rpcId, { decision });
    }
    if (shown) this.sink.upsertItem(pending.sessionId, { ...this.approvalItem(itemId, pending), decision });
  }

  async answerApproval(session: Session, itemId: string, decision: ApprovalDecision) {
    const pending = this.approvals.get(itemId);
    if (!pending || pending.sessionId !== session.id || !this.rpc) {
      return false;
    }
    this.respond(itemId, pending, decision);
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
    if (pending.method === "mcpServer/elicitation/request") {
      const params = pending.params as McpServerElicitationRequestParams;
      return {
        kind: "approval" as const,
        id: itemId,
        title: `${params.serverName} MCP 도구를 쓸까요?`,
        detail: params.message || null,
        reason: null,
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

  /**
   * Codex recorded a user message in the running turn. A steered request carries the id it was
   * sent with; when Codex leaves that out, every message after the turn's own request is the
   * oldest steered one.
   */
  private tookSteer(threadId: string, clientId: string | null) {
    const seen = (this.userMessages.get(threadId) ?? 0) + 1;
    this.userMessages.set(threadId, seen);
    const pending = this.steers.get(threadId);
    if (!pending?.length) return;
    const index = clientId ? pending.indexOf(clientId) : seen > 1 ? 0 : -1;
    if (index >= 0) pending.splice(index, 1);
  }

  private onServerRequest(request: RpcServerRequest) {
    const params = (request.params ?? {}) as { threadId?: string };
    const sessionId = params.threadId ? this.threads.get(params.threadId) : undefined;
    const supported = [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "mcpServer/elicitation/request",
    ];
    if (!sessionId || !supported.includes(request.method)) {
      this.rpc?.respondError(request.id, `Achmage Workbench does not handle ${request.method}`);
      return;
    }
    // An MCP server may ask for a tool approval (an empty form Codex marks as such) or for real
    // input: a form with fields or a link to open. Only approvals can be answered here so far;
    // the rest is declined with a word on why, instead of failing silently.
    if (request.method === "mcpServer/elicitation/request" && !isToolApproval(request.params as McpServerElicitationRequestParams)) {
      const params = request.params as McpServerElicitationRequestParams;
      this.rpc?.respond(request.id, { action: "decline", content: null, _meta: null });
      this.sink.upsertItem(sessionId, {
        kind: "notice",
        id: `elicitation:${String(request.id)}`,
        level: "info",
        text: `${params.serverName} MCP 서버가 입력${params.mode === "url" ? "(링크 열기)" : ""}을 요청했지만 Workbench에서는 아직 받을 수 없어 거절했습니다: ${params.message}`,
        at: Date.now(),
      });
      return;
    }
    const itemId = `approval:${String(request.id)}`;
    const pending = { rpcId: request.id, method: request.method, params: request.params, sessionId };
    this.approvals.set(itemId, pending);
    // Switched to full access while this turn ran: the turn keeps its policy, so its remaining
    // approvals are answered here.
    if (this.sessionAccess.get(sessionId) === "full") {
      this.respond(itemId, pending, "accept", false);
      return;
    }
    this.sink.upsertItem(sessionId, this.approvalItem(itemId, pending));
    this.sink.updateSession(sessionId, { status: "awaitingApproval", activity: "승인 필요" });
  }

  /** Full access answers what was waiting; the next turns run with the new policy (see send). */
  async setAccess(session: Session & { access: AccessMode }) {
    this.sessionAccess.set(session.id, session.access);
    if (session.access !== "full") return;
    for (const [itemId, pending] of this.approvals) {
      if (pending.sessionId === session.id) this.respond(itemId, pending, "accept");
    }
    const stillWaiting = [...this.approvals.values()].some((other) => other.sessionId === session.id);
    if (!stillWaiting && session.status === "awaitingApproval") this.sink.updateSession(session.id, { status: "running", activity: "응답 준비 중" });
  }

  /** Compact the thread now (`thread/compact/start`); Codex also does so on its own when full. */
  async compact(session: Session & { access: AccessMode }, work: Work) {
    if (!session.nativeSessionId) return false;
    await this.ensureRunning();
    const threadId = await this.threadFor(session, work);
    this.compacting.add(threadId);
    this.sink.updateSession(session.id, { status: "running", activity: "대화를 압축하는 중", lastError: null });
    try {
      await this.rpc!.request("thread/compact/start", { threadId });
      return true;
    } catch (error) {
      this.compacting.delete(threadId);
      this.sink.updateSession(session.id, { status: "idle", activity: null });
      throw error;
    }
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
        this.userMessages.set(threadId, 0);
        this.sink.updateSession(sessionId, { status: "running", activity: this.compacting.has(threadId) ? "대화를 압축하는 중" : "응답 준비 중", lastError: null });
        break;
      }
      case "thread/tokenUsage/updated": {
        // `last` is the latest request to the model: what the conversation takes up now.
        const { tokenUsage } = params as ThreadTokenUsageUpdatedNotification;
        this.sink.updateSession(sessionId, {
          context: { used: tokenUsage.last.totalTokens, window: tokenUsage.modelContextWindow, compactAt: this.compactLimit, at: Date.now() },
        });
        break;
      }
      case "item/started": {
        const { item } = params as ItemStartedNotification;
        if (item.type === "userMessage") this.tookSteer(threadId, item.clientId);
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
        // Steered requests Codex never took into the conversation were dropped with the turn.
        const dropped = this.steers.get(threadId) ?? [];
        this.steers.delete(threadId);
        this.userMessages.delete(threadId);
        if (dropped.length) this.sink.steerDropped(sessionId, dropped);
        const status = interrupted ? "interrupted" : turn.status === "failed" ? "failed" : "completed";
        for (const [itemId, pending] of this.approvals) {
          if (pending.sessionId === sessionId) {
            this.approvals.delete(itemId);
            this.sink.upsertItem(sessionId, { ...this.approvalItem(itemId, pending), decision: "expired" });
          }
        }
        // A compaction asked for by the user is not a reply: no end line under the last request.
        if (!this.compacting.delete(threadId)) {
          this.sink.upsertItem(sessionId, {
            kind: "turnEnd",
            id: `end:${turn.id}`,
            status,
            durationMs: turn.durationMs,
            at: Date.now(),
          });
        }
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
