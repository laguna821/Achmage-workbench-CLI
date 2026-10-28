import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  query,
  type CanUseTool,
  type EffortLevel,
  type ModelInfo,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKControlInterruptResponse,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AccessMode, ApprovalDecision, ModelOption, ProviderStatus, Session, UsageWindow, Work } from "@workbench/contracts";
import { ClaudeTranscriptMapper, describeTool, type MapperOutput } from "@workbench/provider-claude";
import { resolveClaude, type ResolvedBinary } from "../binaries.ts";
import { billingVarsIn, claudeSdkEnv, engineEnv } from "../engine-env.ts";
import { parseClaudeAuthStatus } from "../engine-login.ts";
import { emptyStatus, type AdapterSink, type LoginStart, type ProviderAdapter } from "./types.ts";
import type { BrowserEngineHooks } from "../browse.ts";

const run = promisify(execFile);

/** Async iterable fed by `send`; keeps one Claude Code process per active session. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage) {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: message, done: false });
    } else {
      this.items.push(message);
    }
  }

  close() {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

type PendingApproval = {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  item: { kind: "approval"; id: string; title: string; detail: string | null; reason: string | null; decision: null; at: number };
};

type Runtime = {
  sessionId: string;
  /** The access Claude Code was last told to use (its permission mode). */
  access: AccessMode;
  /** The running turn compacts the conversation on request (not a reply). */
  compacting: boolean;
  /** Model and effort the running Claude Code process was last told to use. */
  model: string | null;
  effort: string | null;
  /** Model Claude Code last reported answering with. */
  engineModel: string | null;
  /** Started with the agent browser's instructions in its system prompt. */
  browser: boolean;
  input: InputQueue;
  query: Query;
  mapper: ClaudeTranscriptMapper;
  turnKey: string;
  /** Requests steered into the running turn, in order (each may become the next turn). */
  steered: { turnKey: string; uuid: string }[];
  turnActive: boolean;
  interrupting: boolean;
  approvals: Map<string, PendingApproval>;
  idleTimer: NodeJS.Timeout | null;
};

/** What each access means to Claude Code. */
const PERMISSION_MODE: Record<AccessMode, PermissionMode> = { ask: "default", auto: "acceptEdits", full: "bypassPermissions" };

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Whether an access lets a tool through without asking (as Claude Code's mode would). */
function allows(access: AccessMode, toolName: string) {
  return access === "full" || (access === "auto" && EDIT_TOOLS.has(toolName));
}

/** The access the user's own Claude Code settings give (permissions.defaultMode). */
export function configuredAccess(settingsJson: string | null): AccessMode | null {
  try {
    const mode = (JSON.parse(settingsJson ?? "") as { permissions?: { defaultMode?: unknown } }).permissions?.defaultMode;
    if (mode === "bypassPermissions") return "full";
    if (mode === "acceptEdits" || mode === "auto") return "auto";
    if (mode === "default" || mode === "plan" || mode === "dontAsk") return "ask";
  } catch {
    // No settings file, or not JSON.
  }
  return null;
}

function readSettings(): string | null {
  try {
    return readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json"), "utf8");
  } catch {
    return null;
  }
}

/** Plan limits as `usage` (get_usage) reports them: utilization 0–100, reset as an ISO time. */
export function usageFromPlan(limits: unknown): UsageWindow[] {
  const windows = (limits && typeof limits === "object" ? limits : {}) as Record<string, { utilization?: unknown; resets_at?: unknown } | null | undefined>;
  const labels: [string, string][] = [
    ["five_hour", "5시간"],
    ["seven_day", "주간"],
    ["seven_day_opus", "주간 · Opus"],
    ["seven_day_sonnet", "주간 · Sonnet"],
  ];
  return labels.flatMap(([key, label]) => {
    const window = windows[key];
    if (!window || typeof window.utilization !== "number") return [];
    const resets = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : NaN;
    return [{ label, usedPercent: Math.round(window.utilization * 10) / 10, resetsAt: Number.isFinite(resets) ? resets : null }];
  });
}

export function modelsFromInfo(models: ModelInfo[]): ModelOption[] {
  return models.map((model, index) => ({
    id: model.value,
    label: model.displayName || model.value,
    description: model.description || null,
    efforts: model.supportedEffortLevels ?? [],
    defaultEffort: null,
    isDefault: model.value === "default" || index === 0,
  }));
}

const MODEL_CACHE_TTL = 24 * 60 * 60_000;

function sdkBundledBinary(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    return join(dirname(pkg), process.platform === "win32" ? "claude.exe" : "claude");
  } catch {
    return null;
  }
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;
  private current: ProviderStatus = emptyStatus("claude");
  private binary: ResolvedBinary | null = null;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly sink: AdapterSink;
  private readonly idleMs: number;
  private readonly usage = new Map<string, UsageWindow>();
  private initializing: Promise<void> | null = null;

  private readonly modelCache: string | null;
  private readonly browser: BrowserEngineHooks | null;

  constructor(
    sink: AdapterSink,
    options?: { idleMs?: number; modelCacheFile?: string; browser?: BrowserEngineHooks | null },
  ) {
    this.sink = sink;
    this.idleMs = options?.idleMs ?? 10 * 60_000;
    this.modelCache = options?.modelCacheFile ?? null;
    this.browser = options?.browser ?? null;
  }

  /**
   * The model list comes from Claude Code itself (initialize response). It is cached so the picker
   * works before the first message, and refreshed in the background at most once a day.
   */
  private async loadModels() {
    let cachedAt = 0;
    if (this.modelCache) {
      try {
        const cached = JSON.parse(readFileSync(this.modelCache, "utf8")) as { at: number; models: ModelOption[] };
        cachedAt = cached.at;
        this.publish({ models: cached.models });
      } catch {
        // No cache yet.
      }
    }
    if (Date.now() - cachedAt < MODEL_CACHE_TTL || !this.binary || !this.current.loggedIn) {
      return;
    }
    const input = new InputQueue();
    const probe = query({ prompt: input, options: { pathToClaudeCodeExecutable: this.binary.path, settingSources: [], env: claudeSdkEnv(this.binary.path) } });
    try {
      const init = await probe.initializationResult();
      const models = modelsFromInfo(init.models);
      if (models.length) {
        this.publish({ models });
        if (this.modelCache) writeFileSync(this.modelCache, JSON.stringify({ at: Date.now(), models }));
      }
    } catch {
      // Keep whatever list we had; the picker falls back to the engine default.
    } finally {
      input.close();
      probe.close();
    }
  }

  status() {
    return this.current;
  }

  private publish(patch: Partial<ProviderStatus>) {
    this.current = { ...this.current, ...patch };
    this.sink.providerStatus(this.current);
  }

  init() {
    this.initializing ??= this.initOnce();
    return this.initializing;
  }

  private async initOnce() {
    this.binary = await resolveClaude(sdkBundledBinary());
    if (!this.binary) {
      this.publish({ installed: false, error: "claude를 찾지 못했습니다." });
      return;
    }
    this.publish({ installed: true, binary: this.binary.path, binarySource: this.binary.source, version: this.binary.version, billingVars: billingVarsIn(), error: null });
    await this.refreshStatus();
    void this.loadModels();
  }

  async refreshStatus(): Promise<ProviderStatus> {
    if (!this.binary) {
      return this.current;
    }
    // The same environment the sessions get, so the status names the login they will use.
    const env = engineEnv({ command: this.binary.path });
    let stdout = "";
    let failure: unknown = null;
    try {
      stdout = (await run(this.binary.path, ["auth", "status", "--json"], { timeout: 20_000, env })).stdout;
    } catch (error) {
      // `auth status` exits non-zero when logged out, with the JSON still on stdout.
      stdout = (error as { stdout?: string }).stdout ?? "";
      failure = error;
    }
    this.publish({ configuredAccess: configuredAccess(readSettings()) });
    const login = parseClaudeAuthStatus(stdout);
    if (!login) {
      this.publish({ error: failure instanceof Error ? failure.message : "로그인 상태를 읽지 못했습니다." });
    } else if (!login.signedIn) {
      this.publish({ loggedIn: false, loginMethod: null, account: null, plan: null, error: null });
    } else {
      this.publish({ loggedIn: true, loginMethod: login.method, account: login.account, plan: login.plan, error: null });
      void this.readPlanUsage();
    }
    return this.current;
  }

  /**
   * Plan limits (5시간 · 주간) without waiting for a reply to carry them: asked of a running
   * session's Claude Code, or of a short-lived one when none runs. No model is called.
   */
  private async readPlanUsage(from?: Runtime) {
    if (!this.binary) return;
    const runtime = from ?? [...this.runtimes.values()][0];
    type UsageQuery = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<{ rate_limits?: unknown }> };
    let probe: { input: InputQueue; query: Query } | null = null;
    try {
      let target = runtime?.query as (Query & UsageQuery) | undefined;
      if (!target) {
        const input = new InputQueue();
        probe = { input, query: query({ prompt: input, options: { pathToClaudeCodeExecutable: this.binary.path, settingSources: [], env: claudeSdkEnv(this.binary.path) } }) };
        target = probe.query as Query & UsageQuery;
      }
      const usage = await target.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.();
      const windows = usageFromPlan(usage?.rate_limits);
      if (windows.length) {
        for (const window of windows) this.usage.set(window.label, window);
        this.publish({ usage: [...this.usage.values()], usageObservedAt: Date.now() });
      }
    } catch {
      // Older Claude Code, or no plan limits (API key): the limits arrive with replies instead.
    } finally {
      probe?.input.close();
      probe?.query.close();
    }
  }

  /** After a turn: how full the context is (exactly, as /context counts it) and the plan limits. */
  private async afterTurn(runtime: Runtime) {
    try {
      const usage = await runtime.query.getContextUsage();
      this.sink.updateSession(runtime.sessionId, {
        context: {
          used: usage.totalTokens,
          window: usage.maxTokens || null,
          compactAt: usage.isAutoCompactEnabled ? (usage.autoCompactThreshold ?? null) : null,
          at: Date.now(),
        },
      });
    } catch {
      // Older Claude Code: the figure from the turn's own usage stays.
    }
    await this.readPlanUsage(runtime);
  }

  async login(): Promise<LoginStart> {
    if (!this.binary) {
      throw new Error("claude를 찾지 못했습니다.");
    }
    const child = spawn(this.binary.path, ["auth", "login", "--claudeai"], { stdio: ["ignore", "pipe", "pipe"], env: engineEnv({ command: this.binary.path }) });
    const url = await new Promise<string | null>((resolve) => {
      let buffer = "";
      const timer = setTimeout(() => resolve(null), 15_000);
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const match = buffer.match(/https:\/\/\S+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    child.on("exit", () => void this.refreshStatus());
    return { url, message: "브라우저에서 Claude 로그인을 마치면 자동으로 연결됩니다." };
  }

  private startRuntime(session: Session & { access: AccessMode }, work: Work): Runtime {
    if (!this.binary) {
      throw new Error("claude를 찾지 못했습니다.");
    }
    const input = new InputQueue();
    const browser = this.browser?.instructions(session) ?? null;
    const runtime: Runtime = {
      sessionId: session.id,
      access: session.access,
      compacting: false,
      model: session.model,
      effort: session.effort,
      engineModel: null,
      browser: Boolean(browser),
      input,
      query: undefined as unknown as Query,
      mapper: new ClaudeTranscriptMapper(),
      turnKey: "",
      steered: [],
      turnActive: false,
      interrupting: false,
      approvals: new Map(),
      idleTimer: null,
    };
    const canUseTool: CanUseTool = (toolName, toolInput, options) =>
      new Promise<PermissionResult>((resolve) => {
        // The access was raised while Claude Code was deciding: let it through as the new mode would.
        // A bare playwright-cli command is the agent browser's to judge (it asks by the same access).
        if (allows(runtime.access, toolName) || (toolName === "Bash" && typeof toolInput.command === "string" && this.browser?.allowsCommand(session.id, toolInput.command))) {
          resolve({ behavior: "allow", updatedInput: toolInput });
          return;
        }
        const view = describeTool(toolName, toolInput);
        const itemId = `approval:${options.toolUseID}`;
        const item = {
          kind: "approval" as const,
          id: itemId,
          title: options.title ?? `${toolName} 사용을 허용할까요?`,
          detail: view.title,
          reason: options.decisionReason ?? options.description ?? null,
          decision: null,
          at: Date.now(),
        };
        runtime.approvals.set(itemId, { toolUseId: options.toolUseID, toolName, input: toolInput, resolve, item });
        this.sink.upsertItem(session.id, item);
        this.sink.updateSession(session.id, { status: "awaitingApproval", activity: "승인 필요" });
        options.signal.addEventListener("abort", () => {
          if (runtime.approvals.delete(itemId)) {
            this.sink.upsertItem(session.id, { ...item, decision: "expired" });
            resolve({ behavior: "deny", message: "Request aborted" });
          }
        });
      });
    runtime.query = query({
      prompt: input,
      options: {
        cwd: work.cwd,
        resume: session.nativeSessionId ?? undefined,
        model: session.model ?? undefined,
        effort: (session.effort as EffortLevel | null) ?? undefined,
        permissionMode: PERMISSION_MODE[session.access],
        // Lets "전체 접근" be switched on later in the same process (it is not on by itself).
        allowDangerouslySkipPermissions: true,
        canUseTool,
        includePartialMessages: true,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code", ...(browser ? { append: browser } : {}) },
        pathToClaudeCodeExecutable: this.binary.path,
        // Never an API key or cloud route left in the gateway's environment: the user's login.
        // The agent browser's playwright-cli is on PATH, and names this session's browser while on.
        env: claudeSdkEnv(this.binary.path, { paths: this.browser?.pathDirs(), extra: this.browser?.sessionEnv(session) }),
      },
    });
    this.runtimes.set(session.id, runtime);
    void this.consume(runtime);
    return runtime;
  }

  /** Record the model that actually answers, so a picker change can be checked against the engine. */
  private noteModel(runtime: Runtime, message: SDKMessage) {
    const model =
      message.type === "assistant" ? message.message.model : message.type === "system" && message.subtype === "init" ? message.model : null;
    if (!model || model === runtime.engineModel) return;
    runtime.engineModel = model;
    this.sink.updateSession(runtime.sessionId, { engineModel: model });
  }

  private async consume(runtime: Runtime) {
    const sessionId = runtime.sessionId;
    try {
      for await (const message of runtime.query) {
        this.noteModel(runtime, message);
        for (const output of runtime.mapper.handle(message, runtime.turnKey)) {
          this.apply(runtime, output);
        }
      }
    } catch (error) {
      if (runtime.turnActive) {
        this.sink.upsertItem(sessionId, {
          kind: "notice",
          id: `error:${Date.now()}`,
          level: "error",
          text: `Claude 실행이 중단되었습니다: ${error instanceof Error ? error.message : String(error)}`,
          at: Date.now(),
        });
      }
    } finally {
      if (this.runtimes.get(sessionId) === runtime) {
        this.runtimes.delete(sessionId);
      }
      if (runtime.idleTimer) {
        clearTimeout(runtime.idleTimer);
      }
      if (runtime.turnActive) {
        this.sink.updateSession(sessionId, { status: "idle", activity: null });
      }
    }
  }

  private apply(runtime: Runtime, output: MapperOutput) {
    const sessionId = runtime.sessionId;
    switch (output.type) {
      case "init":
        this.sink.updateSession(sessionId, { nativeSessionId: output.nativeSessionId });
        break;
      case "upsert":
        this.sink.upsertItem(sessionId, output.item);
        break;
      case "delta":
        this.sink.delta(sessionId, output.itemId, output.text);
        break;
      case "activity":
        if (runtime.turnActive && runtime.approvals.size === 0) {
          this.sink.updateSession(sessionId, { activity: output.text, status: output.text ? "running" : "idle" });
        }
        break;
      case "usage":
        this.usage.set(output.window.label, output.window);
        this.publish({ usage: [...this.usage.values()], usageObservedAt: Date.now() });
        break;
      case "context":
        this.sink.updateSession(sessionId, { context: { used: output.used, window: output.window, compactAt: null, at: Date.now() } });
        break;
      case "authError":
        this.publish({ loggedIn: false, error: output.message });
        break;
      case "turnEnd": {
        const status = runtime.interrupting ? "interrupted" : output.status;
        // A request steered in after the last tool step was not folded into this turn: Claude Code
        // runs it as the next turn right away, so the session keeps working under that request
        // (also after a stop, when this Claude Code could not cancel it).
        const follows = output.queued > 0 && runtime.steered.length > 0;
        if (follows) {
          if (status === "failed" && output.error) {
            this.sink.upsertItem(sessionId, { kind: "notice", id: `error:${runtime.turnKey}`, level: "error", text: output.error, at: Date.now() });
          }
          this.sink.upsertItem(sessionId, { kind: "turnEnd", id: `end:${runtime.turnKey}`, status, durationMs: output.durationMs, at: Date.now() });
          runtime.turnKey = runtime.steered.shift()!.turnKey;
          runtime.interrupting = false;
          this.sink.updateSession(sessionId, { status: "running", activity: "이어서 보낸 요청에 답하는 중" });
          break;
        }
        runtime.steered = [];
        runtime.turnActive = false;
        runtime.interrupting = false;
        if (status === "failed" && output.error) {
          this.sink.upsertItem(sessionId, { kind: "notice", id: `error:${runtime.turnKey}`, level: "error", text: output.error, at: Date.now() });
        }
        // A compaction asked for by the user is not a reply: no end line under the last request.
        if (!runtime.compacting) {
          this.sink.upsertItem(sessionId, {
            kind: "turnEnd",
            id: `end:${runtime.turnKey}`,
            status,
            durationMs: output.durationMs,
            at: Date.now(),
          });
        }
        runtime.compacting = false;
        this.sink.updateSession(sessionId, { status: "idle", activity: null, lastError: status === "failed" ? output.error : null });
        this.scheduleIdle(runtime);
        void this.afterTurn(runtime);
        break;
      }
    }
  }

  private closeRuntime(runtime: Runtime) {
    if (this.runtimes.get(runtime.sessionId) === runtime) this.runtimes.delete(runtime.sessionId);
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    runtime.input.close();
    runtime.query.close();
  }

  /** Close the Claude Code process after inactivity; the next message resumes the session. */
  private scheduleIdle(runtime: Runtime) {
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
    }
    runtime.idleTimer = setTimeout(() => {
      if (!runtime.turnActive && this.runtimes.get(runtime.sessionId) === runtime) {
        this.runtimes.delete(runtime.sessionId);
        runtime.input.close();
        runtime.query.close();
      }
    }, this.idleMs);
  }

  async send(session: Session & { access: AccessMode }, work: Work, text: string, turnKey: string) {
    await this.init();
    let current = this.runtimes.get(session.id);
    // The browser was switched since this process started. Its instructions are part of the system
    // prompt, so a new process resumes the same session with the new ones.
    if (current && !current.turnActive && current.browser !== Boolean(this.browser?.instructions(session))) {
      this.closeRuntime(current);
      current = undefined;
    }
    const runtime = current ?? this.startRuntime(session, work);
    if (runtime.access !== session.access) {
      await runtime.query.setPermissionMode(PERMISSION_MODE[session.access]);
      runtime.access = session.access;
    }
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
      runtime.idleTimer = null;
    }
    // A model or effort picked since the process started applies from this message on.
    if (runtime.model !== session.model) {
      await runtime.query.setModel(session.model ?? undefined);
      runtime.model = session.model;
    }
    if (runtime.effort !== session.effort) {
      await runtime.query.applyFlagSettings({ effortLevel: (session.effort as EffortLevel | null) ?? null });
      runtime.effort = session.effort;
    }
    runtime.turnKey = turnKey;
    runtime.turnActive = true;
    runtime.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    });
  }

  /**
   * Put a request into the running turn: Claude Code folds it in between tool steps ("next"), or
   * runs it right after the turn when the turn has no further step.
   */
  async steer(session: Session, _work: Work, text: string, turnKey: string) {
    const runtime = this.runtimes.get(session.id);
    if (!runtime || !runtime.turnActive || runtime.interrupting) return false;
    // The uuid lets a stop name exactly which of these Claude Code dropped.
    const uuid = randomUUID();
    runtime.steered.push({ turnKey, uuid });
    runtime.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      origin: { kind: "human" },
      priority: "next",
      uuid,
    });
    return true;
  }

  /** A new access reaches Claude Code at once; approvals the new mode would not ask for are given. */
  async setAccess(session: Session & { access: AccessMode }) {
    const runtime = this.runtimes.get(session.id);
    if (!runtime) return;
    await runtime.query.setPermissionMode(PERMISSION_MODE[session.access]);
    runtime.access = session.access;
    for (const [itemId, pending] of runtime.approvals) {
      if (allows(session.access, pending.toolName)) await this.answerApproval(session, itemId, "accept");
    }
  }

  /** Compact now: Claude Code's own /compact, as a turn that is not a reply. */
  async compact(session: Session & { access: AccessMode }, work: Work) {
    await this.init();
    const runtime = this.runtimes.get(session.id) ?? this.startRuntime(session, work);
    if (runtime.turnActive) return false;
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
      runtime.idleTimer = null;
    }
    runtime.turnKey = `compact:${Date.now()}`;
    runtime.turnActive = true;
    runtime.compacting = true;
    this.sink.updateSession(session.id, { status: "running", activity: "대화를 압축하는 중", lastError: null });
    runtime.input.push({ type: "user", message: { role: "user", content: "/compact" }, parent_tool_use_id: null, origin: { kind: "human" } });
    return true;
  }

  async interrupt(session: Session) {
    const runtime = this.runtimes.get(session.id);
    if (!runtime || !runtime.turnActive) {
      this.sink.updateSession(session.id, { status: "idle", activity: null });
      return;
    }
    runtime.interrupting = true;
    this.sink.updateSession(session.id, { status: "interrupting", activity: "중단하는 중" });
    for (const [itemId, pending] of runtime.approvals) {
      runtime.approvals.delete(itemId);
      pending.resolve({ behavior: "deny", message: "User interrupted", interrupt: true });
      this.sink.upsertItem(session.id, { ...pending.item, decision: "decline" });
    }
    // Stop means stop: requests steered in but not yet taken would otherwise run right after the
    // stop as turns of their own. Newer Claude Code cancels them with the interrupt; older ones list
    // them as still queued and are asked to drop each.
    const control = runtime.query as unknown as {
      interrupt(options?: { cancelQueued?: boolean }): Promise<SDKControlInterruptResponse | undefined>;
      cancelAsyncMessage?(uuid: string): Promise<boolean>;
    };
    const receipt = await control.interrupt({ cancelQueued: true });
    const dropped = new Set(receipt?.cancelled ?? []);
    for (const uuid of receipt?.still_queued ?? []) {
      if (await control.cancelAsyncMessage?.(uuid).catch(() => false)) dropped.add(uuid);
    }
    const lost = runtime.steered.filter((entry) => dropped.has(entry.uuid));
    if (lost.length) {
      runtime.steered = runtime.steered.filter((entry) => !dropped.has(entry.uuid));
      this.sink.steerDropped(session.id, lost.map((entry) => entry.turnKey));
    }
  }

  async answerApproval(session: Session, itemId: string, decision: ApprovalDecision) {
    const runtime = this.runtimes.get(session.id);
    const pending = runtime?.approvals.get(itemId);
    if (!runtime || !pending) {
      return false;
    }
    runtime.approvals.delete(itemId);
    if (decision === "accept") {
      pending.resolve({ behavior: "allow", updatedInput: pending.input });
    } else {
      pending.resolve({ behavior: "deny", message: "The user declined this action." });
      const declined = runtime.mapper.markDeclined(pending.toolUseId);
      if (declined) {
        this.sink.upsertItem(session.id, declined);
      }
    }
    this.sink.upsertItem(session.id, { ...pending.item, decision });
    if (runtime.approvals.size === 0) {
      this.sink.updateSession(session.id, { status: "running", activity: "응답 준비 중" });
    }
    return true;
  }

  async shutdown() {
    for (const runtime of this.runtimes.values()) {
      runtime.input.close();
      runtime.query.close();
    }
    this.runtimes.clear();
  }
}
