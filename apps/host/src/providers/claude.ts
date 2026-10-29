import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
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
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { AccessMode, ApprovalDecision, EngineCommand, ModelOption, ProviderStatus, Session, UsageWindow, Work } from "@workbench/contracts";
import { ClaudeTranscriptMapper, describeTool, type MapperOutput } from "@workbench/provider-claude";
import { launchEnv, resolveClaude, type ResolvedBinary } from "../binaries.ts";
import { billingVarsIn } from "../engine-env.ts";
import { parseClaudeAuthStatus } from "../engine-login.ts";
import { isWebAddress } from "../open-url.ts";
import { emptyStatus, type AdapterSink, type AttachedFile, type ClaudeLaunch, type EngineCli, type LoginStart, type NativeConversation, type ProviderAdapter } from "./types.ts";
import { claudeHistory, isRequest } from "../imports.ts";
import { isImage, mentionFiles } from "../attachments.ts";
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
  /** Model Claude Code last reported answering with, and the effort when it names one (its init frame). */
  engineModel: string | null;
  engineEffort: string | null;
  /** Started with the agent browser's instructions in its system prompt. */
  browser: boolean;
  input: InputQueue;
  query: Query;
  mapper: ClaudeTranscriptMapper;
  turnKey: string;
  /** The request the running turn answers (null for a turn nobody here sent, or a compaction). */
  requestId: string | null;
  /** Requests steered into the running turn, in order (each may become the next turn). */
  steered: { turnKey: string; uuid: string }[];
  turnActive: boolean;
  interrupting: boolean;
  approvals: Map<string, PendingApproval>;
  idleTimer: NodeJS.Timeout | null;
  /** In Claude Code's plan mode ("계획 먼저") until the plan is approved. */
  planning: boolean;
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
  /** The app is closing: processes it closes do not end their turns here (the next start does). */
  private closing = false;

  private readonly modelCache: string | null;
  private readonly browser: BrowserEngineHooks | null;

  private readonly attachmentsDir: string | null;

  private readonly launch: ClaudeLaunch | null;

  constructor(
    sink: AdapterSink,
    options?: { idleMs?: number; modelCacheFile?: string; attachmentsDir?: string; browser?: BrowserEngineHooks | null; launch?: ClaudeLaunch },
  ) {
    this.sink = sink;
    this.idleMs = options?.idleMs ?? 10 * 60_000;
    this.modelCache = options?.modelCacheFile ?? null;
    this.attachmentsDir = options?.attachmentsDir ?? null;
    this.browser = options?.browser ?? null;
    this.launch = options?.launch ?? null;
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
    const probe = query({ prompt: input, options: { ...this.sdkLaunch(), settingSources: [] } });
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
    await this.resolve();
    if (!this.binary) return;
    await this.refreshStatus();
    void this.loadModels();
  }

  /** Find the engine (again) and say where it is. */
  private async resolve() {
    this.binary = await resolveClaude(sdkBundledBinary());
    if (!this.binary) {
      this.publish({ installed: false, binary: null, binarySource: null, origin: null, version: null, error: "claude를 찾지 못했습니다." });
      return;
    }
    this.publish({ installed: true, binary: this.binary.path, binarySource: this.binary.source, origin: this.binary.origin, version: this.binary.version, billingVars: billingVarsIn(), error: null });
  }

  /** Look again (after an install, or the user installed it meanwhile); running sessions keep theirs. */
  async locate() {
    const before = this.binary;
    await this.resolve();
    if (this.binary && (this.binary.command !== before?.command || !this.current.loggedIn)) {
      await this.refreshStatus();
      void this.loadModels();
    }
  }

  /** How the Agent SDK starts this engine: a native binary, or a JavaScript entry on the gateway's Node. */
  private sdkLaunch(options: { paths?: string[]; extra?: Record<string, string> } = {}) {
    const binary = this.binary!;
    const env = launchEnv(binary, { paths: options.paths, extra: { CLAUDE_AGENT_SDK_CLIENT_APP: "achmage-workbench/0.1", ...options.extra } });
    const strings = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    if (binary.kind === "node") {
      const script = binary.args[0]!;
      // The SDK runs a .js/.mjs script with `executable`; a GUI app may have no `node` on PATH, so name ours.
      if (/\.(m?js|jsx?|tsx?)$/i.test(script)) return { pathToClaudeCodeExecutable: script, executable: process.execPath as "node", executableArgs: binary.args.slice(1), env: strings };
      // Any other script the SDK would start as a program: start it on our Node instead.
      return {
        pathToClaudeCodeExecutable: script,
        env: strings,
        spawnClaudeCodeProcess: (options: SpawnOptions) =>
          spawn(process.execPath, [...binary.args, ...options.args], { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as unknown as SpawnedProcess,
      };
    }
    return { pathToClaudeCodeExecutable: binary.command, env: strings };
  }

  cli(): EngineCli | null {
    const binary = this.binary;
    return binary ? { command: binary.command, args: binary.args, env: launchEnv(binary) } : null;
  }

  async refreshStatus(): Promise<ProviderStatus> {
    if (!this.binary) await this.resolve();
    if (!this.binary) {
      return this.current;
    }
    // The same environment the sessions get, so the status names the login they will use.
    const env = launchEnv(this.binary);
    let stdout = "";
    let failure: unknown = null;
    try {
      stdout = (await run(this.binary.command, [...this.binary.args, "auth", "status", "--json"], { timeout: 20_000, env, windowsHide: true })).stdout;
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
        probe = { input, query: query({ prompt: input, options: { ...this.sdkLaunch(), settingSources: [] } }) };
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

  /** The engine's own login (`claude auth login`) while it waits for the browser. */
  private loginProcess: ChildProcessWithoutNullStreams | null = null;

  /**
   * Claude Code's own login: it opens the browser itself and listens on this computer for the
   * page to hand the login back. It also prints an address for when the browser did not open; that
   * page shows a code, which Claude Code takes on its input ("로그인 코드"). Done when it exits.
   */
  async login(): Promise<LoginStart> {
    if (!this.binary) await this.resolve();
    const binary = this.binary;
    if (!binary) {
      throw new Error("claude를 찾지 못했습니다.");
    }
    await this.cancelLogin();
    const child = spawn(binary.command, [...binary.args, "auth", "login", "--claudeai"], { stdio: ["pipe", "pipe", "pipe"], env: launchEnv(binary), windowsHide: true });
    this.loginProcess = child;
    child.stdin.on("error", () => undefined);
    let output = "";
    let url: string | null = null;
    const waiting = (message: string) => this.publish({ login: { state: "waiting", url, userCode: null, acceptsCode: true, opened: true, message, at: Date.now() } });
    const found = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 15_000);
      const onData = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-8000);
        const address = loginAddress(output);
        if (address && !url) {
          url = address;
          clearTimeout(timer);
          resolve(address);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    // Ten minutes for the browser; then the login stops and can be started again.
    const limit = setTimeout(() => {
      if (this.loginProcess !== child) return;
      child.kill();
      this.publish({ login: { state: "failed", url: null, userCode: null, acceptsCode: false, opened: true, message: "로그인을 기다리다 멈췄습니다. 다시 눌러 주세요.", at: Date.now() } });
    }, 10 * 60_000);
    child.on("error", () => undefined);
    child.on("exit", (code) => {
      clearTimeout(limit);
      if (this.loginProcess !== child) return;
      this.loginProcess = null;
      const reason = loginFailure(output);
      this.publish({
        login:
          code === 0
            ? { state: "done", url: null, userCode: null, acceptsCode: false, opened: true, message: "로그인했습니다.", at: Date.now() }
            : { state: "failed", url: null, userCode: null, acceptsCode: false, opened: true, message: `로그인하지 못했습니다${reason ? `: ${reason}` : "."}`, at: Date.now() },
      });
      void this.refreshStatus().then(() => {
        if (this.current.loggedIn) void this.loadModels();
      });
    });
    waiting("브라우저에서 Claude 로그인을 마치면 자동으로 연결됩니다.");
    // The address arrives a moment later; the screen then offers it ("브라우저가 열리지 않았다면").
    await found;
    if (this.loginProcess === child) waiting("브라우저에서 Claude 로그인을 마치면 자동으로 연결됩니다.");
    return { url, message: "브라우저에서 Claude 로그인을 마치면 자동으로 연결됩니다." };
  }

  /** The code the login page showed (`코드#상태`), handed to the waiting login. Never logged. */
  async loginCode(code: string) {
    const child = this.loginProcess;
    const value = code.trim();
    if (!child || child.exitCode !== null) throw new Error("기다리는 로그인이 없습니다. 로그인을 다시 눌러 주세요.");
    if (!/^[A-Za-z0-9._~+/=-]{4,4096}#[A-Za-z0-9._~+/=-]{4,4096}$/.test(value)) throw new Error("코드 전체를 붙여 넣어 주세요(# 앞뒤 모두).");
    child.stdin.write(`${value}\n`);
  }

  async cancelLogin() {
    const child = this.loginProcess;
    if (!child) return;
    this.loginProcess = null;
    child.kill();
    if (this.current.login?.state === "waiting") this.publish({ login: null });
  }

  private startRuntime(session: Session & { access: AccessMode; plan?: boolean }, work: Work): Runtime {
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
      engineEffort: null,
      browser: Boolean(browser),
      input,
      query: undefined as unknown as Query,
      mapper: new ClaudeTranscriptMapper(),
      turnKey: "",
      requestId: null,
      steered: [],
      turnActive: false,
      interrupting: false,
      approvals: new Map(),
      idleTimer: null,
      planning: Boolean(session.plan),
    };
    const canUseTool: CanUseTool = (toolName, toolInput, options) =>
      new Promise<PermissionResult>((resolve) => {
        // The end of plan mode: the plan waits for the user's go-ahead, whatever the access.
        if (toolName === "ExitPlanMode") {
          const itemId = `approval:${options.toolUseID}`;
          const item = {
            kind: "approval" as const,
            id: itemId,
            title: "이 계획대로 진행할까요?",
            detail: typeof toolInput.plan === "string" ? toolInput.plan : null,
            reason: null,
            decision: null,
            plan: true,
            at: Date.now(),
          };
          runtime.approvals.set(itemId, { toolUseId: options.toolUseID, toolName, input: toolInput, resolve, item });
          this.sink.upsertItem(session.id, item);
          this.sink.updateSession(session.id, { status: "awaitingApproval", activity: "계획 확인 필요" });
          return;
        }
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
    // The context card and the vault guard (pkm.ts), for every process this session starts.
    const extras = this.launch?.(session, work) ?? null;
    runtime.query = query({
      prompt: input,
      options: {
        ...(extras?.hooks ? { hooks: extras.hooks } : {}),
        cwd: work.cwd,
        // Files attached to requests are read from here without asking.
        ...(this.attachmentsDir ? { additionalDirectories: [this.attachmentsDir] } : {}),
        resume: session.nativeSessionId ?? undefined,
        model: session.model ?? undefined,
        effort: (session.effort as EffortLevel | null) ?? undefined,
        permissionMode: session.plan ? "plan" : PERMISSION_MODE[session.access],
        // Lets "전체 접근" be switched on later in the same process (it is not on by itself).
        allowDangerouslySkipPermissions: true,
        canUseTool,
        includePartialMessages: true,
        settingSources: ["user", "project", "local"],
        // The context card (pkm.ts) and the agent browser's instructions, after Claude Code's own.
        systemPrompt: { type: "preset", preset: "claude_code", ...(extras?.append || browser ? { append: [extras?.append, browser].filter(Boolean).join("\n\n") } : {}) },
        // Never an API key or cloud route left in the gateway's environment: the user's login.
        // The agent browser's playwright-cli is on PATH, and names this session's browser while on.
        ...this.sdkLaunch({ paths: this.browser?.pathDirs(), extra: this.browser?.sessionEnv(session) }),
      },
    });
    this.runtimes.set(session.id, runtime);
    void this.consume(runtime);
    return runtime;
  }

  /** Record the model that actually answers, so a picker change can be checked against the engine. */
  private noteModel(runtime: Runtime, message: SDKMessage) {
    // Newer Claude Code also names the effort it sends on its init frame.
    if (message.type === "system" && message.subtype === "init" && message.effort !== undefined && (message.effort ?? null) !== runtime.engineEffort) {
      runtime.engineEffort = message.effort ?? null;
      this.sink.updateSession(runtime.sessionId, { engineEffort: runtime.engineEffort });
    }
    const model =
      message.type === "assistant" ? message.message.model : message.type === "system" && message.subtype === "init" ? message.model : null;
    if (!model || model === runtime.engineModel) return;
    runtime.engineModel = model;
    this.sink.updateSession(runtime.sessionId, { engineModel: model });
  }

  private async consume(runtime: Runtime) {
    const sessionId = runtime.sessionId;
    let failure: string | null = null;
    try {
      for await (const message of runtime.query) {
        this.noteModel(runtime, message);
        for (const output of runtime.mapper.handle(message, runtime.turnKey)) {
          this.apply(runtime, output);
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.runtimes.get(sessionId) === runtime) {
        this.runtimes.delete(sessionId);
      }
      if (runtime.idleTimer) {
        clearTimeout(runtime.idleTimer);
      }
      if (runtime.turnActive && !this.closing) this.lost(runtime, failure);
    }
  }

  /**
   * Claude Code ended in the middle of a turn (its process died): the turn still ends, with its cause,
   * so the gateway settles what it left — the waiting requests stay, a changed working copy becomes a
   * proposal — and the session shows the error under '오류·멈춤'.
   */
  private lost(runtime: Runtime, failure: string | null) {
    const sessionId = runtime.sessionId;
    const stopping = runtime.interrupting;
    runtime.turnActive = false;
    runtime.interrupting = false;
    // Nobody waits for these answers any more (the process is gone): the cards only expire.
    for (const [itemId, pending] of runtime.approvals) {
      runtime.approvals.delete(itemId);
      this.sink.upsertItem(sessionId, { ...pending.item, decision: "expired" });
    }
    // Requests steered in may or may not have reached it: they wait again above the input.
    if (runtime.steered.length) this.sink.steerDropped(sessionId, runtime.steered.map((entry) => entry.turnKey), true);
    runtime.steered = [];
    const error = failure ? `Claude 실행이 중단되었습니다: ${failure}` : "Claude Code가 응답을 마치지 못하고 끝났습니다.";
    if (!stopping) this.sink.upsertItem(sessionId, { kind: "notice", id: `error:${Date.now()}`, level: "error", text: error, at: Date.now() });
    // A compaction asked for by the user is not a reply: no end line under the last request.
    if (!runtime.compacting) {
      this.sink.upsertItem(sessionId, {
        kind: "turnEnd",
        id: `end:${runtime.turnKey}`,
        status: stopping ? "interrupted" : "failed",
        cause: stopping ? "stop" : "crash",
        durationMs: null,
        at: Date.now(),
        requestId: runtime.requestId,
      });
    }
    runtime.compacting = false;
    this.sink.updateSession(sessionId, { status: "idle", activity: null, lastError: stopping ? null : error });
  }

  /**
   * A turn nobody here sent (a message from another session, also one folded in after a turn):
   * the session is busy with it like with any other, and it gets an end line of its own.
   */
  private beginOwnTurn(runtime: Runtime, turnKey: string, activity: string) {
    runtime.turnKey = turnKey;
    runtime.requestId = null;
    runtime.turnActive = true;
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
      runtime.idleTimer = null;
    }
    this.sink.updateSession(runtime.sessionId, { status: "running", activity, lastError: null });
  }

  private apply(runtime: Runtime, output: MapperOutput) {
    const sessionId = runtime.sessionId;
    // Output while no turn is open: Claude Code is answering something that did not come from here.
    if (!runtime.turnActive && (output.type === "delta" || (output.type === "upsert" && (output.item.kind === "assistant" || output.item.kind === "tool")))) {
      this.beginOwnTurn(runtime, `own:${Date.now()}`, "응답 중");
    }
    switch (output.type) {
      case "init":
        this.sink.updateSession(sessionId, { nativeSessionId: output.nativeSessionId });
        break;
      case "upsert":
        this.sink.upsertItem(sessionId, output.item);
        break;
      case "images":
        this.sink.toolImages(sessionId, output.itemId, output.images);
        break;
      case "peer":
        // Another Claude Code session wrote here and Claude Code answers it on its own.
        if (output.starts && !runtime.turnActive) this.beginOwnTurn(runtime, output.item.id, "다른 세션의 메시지에 답하는 중");
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
          this.sink.upsertItem(sessionId, { kind: "turnEnd", id: `end:${runtime.turnKey}`, status, ...(status === "interrupted" ? { cause: "stop" as const } : {}), durationMs: output.durationMs, at: Date.now(), requestId: runtime.requestId });
          runtime.turnKey = runtime.steered.shift()!.turnKey;
          runtime.requestId = runtime.turnKey;
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
            ...(status === "interrupted" ? { cause: "stop" as const } : {}),
            durationMs: output.durationMs,
            at: Date.now(),
            requestId: runtime.requestId,
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

  async send(session: Session & { access: AccessMode; plan?: boolean }, work: Work, text: string, turnKey: string, files: AttachedFile[] = []) {
    await this.init();
    let current = this.runtimes.get(session.id);
    // The browser was switched since this process started. Its instructions are part of the system
    // prompt, so a new process resumes the same session with the new ones.
    if (current && !current.turnActive && current.browser !== Boolean(this.browser?.instructions(session))) {
      this.closeRuntime(current);
      current = undefined;
    }
    const runtime = current ?? this.startRuntime(session, work);
    // "계획 먼저" is Claude Code's own plan mode for this request; otherwise the session's access.
    const planning = Boolean(session.plan);
    if (runtime.access !== session.access || runtime.planning !== planning) {
      await runtime.query.setPermissionMode(planning ? "plan" : PERMISSION_MODE[session.access]);
      runtime.access = session.access;
      runtime.planning = planning;
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
    runtime.requestId = turnKey;
    runtime.turnActive = true;
    runtime.input.push({
      type: "user",
      message: { role: "user", content: claudeContent(text, files) },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    });
  }

  /**
   * Put a request into the running turn: Claude Code folds it in between tool steps ("next"), or
   * runs it right after the turn when the turn has no further step.
   */
  async steer(session: Session, _work: Work, text: string, turnKey: string, files: AttachedFile[] = []) {
    const runtime = this.runtimes.get(session.id);
    if (!runtime || !runtime.turnActive || runtime.interrupting) return false;
    // The uuid lets a stop name exactly which of these Claude Code dropped.
    const uuid = randomUUID();
    runtime.steered.push({ turnKey, uuid });
    runtime.input.push({
      type: "user",
      message: { role: "user", content: claudeContent(text, files) },
      parent_tool_use_id: null,
      origin: { kind: "human" },
      priority: "next",
      uuid,
    });
    return true;
  }

  /**
   * "/" in the input: Claude Code's commands and the user's, project's and plugins' commands and
   * skills, from this session's own process (started now when it is not running; the next
   * request uses it, and it closes when idle like any other).
   */
  async commands(session: Session & { access: AccessMode }, work: Work): Promise<EngineCommand[]> {
    await this.init();
    let runtime = this.runtimes.get(session.id);
    if (!runtime) {
      runtime = this.startRuntime(session, work);
      this.scheduleIdle(runtime);
    }
    const list = await runtime.query.supportedCommands();
    return list.map((command) => ({ name: command.name, description: command.description, hint: command.argumentHint || null, kind: command.builtin ? "command" : "skill" }));
  }

  /** "이 요청 전으로": Claude Code's own fork of the session file, cut just before that request. */
  async forkNative(session: Session, work: Work, keep: { turns: number; requests: number }) {
    const records = await getSessionMessages(session.nativeSessionId!, { dir: work.cwd });
    const requests = records.flatMap((record, index) => (isRequest(record) ? [index] : []));
    const at = requests[keep.requests];
    if (at === undefined || at === 0) throw new Error("Claude Code 기록에서 이 요청을 찾지 못했습니다.");
    const { sessionId } = await forkSession(session.nativeSessionId!, { dir: work.cwd, upToMessageId: records[at - 1]!.uuid, title: `${session.purpose} · 갈래` });
    return sessionId;
  }

  /**
   * "가져오기": Claude Code's conversations on this computer (its own session files). Those run
   * through the SDK count too: desktop hosts and Workbench itself start Claude Code that way.
   */
  async listNative(query: string): Promise<NativeConversation[]> {
    const q = query.trim().toLowerCase();
    return (await listSessions({ limit: 1000, includeProgrammatic: true }))
      .map((info) => ({ nativeSessionId: info.sessionId, title: titleOf(info), cwd: info.cwd ?? null, updatedAt: info.lastModified }))
      .filter((entry) => !q || entry.title.toLowerCase().includes(q) || (entry.cwd ?? "").toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async nativeHistory(nativeSessionId: string) {
    const info = await getSessionInfo(nativeSessionId);
    if (!info) throw new Error("Claude Code 대화를 찾지 못했습니다.");
    const records = await getSessionMessages(nativeSessionId, info.cwd ? { dir: info.cwd } : {});
    return {
      nativeSessionId,
      title: titleOf(info),
      cwd: info.cwd ?? null,
      updatedAt: info.lastModified,
      items: claudeHistory(records, info.createdAt ?? info.lastModified, info.lastModified),
    };
  }

  /** A new access reaches Claude Code at once; approvals the new mode would not ask for are given. */
  async setAccess(session: Session & { access: AccessMode }) {
    const runtime = this.runtimes.get(session.id);
    if (!runtime) return;
    // While planning, plan mode stays; the new access applies once the plan is approved.
    if (!runtime.planning) await runtime.query.setPermissionMode(PERMISSION_MODE[session.access]);
    runtime.access = session.access;
    for (const [itemId, pending] of runtime.approvals) {
      if (pending.toolName !== "ExitPlanMode" && allows(session.access, pending.toolName)) await this.answerApproval(session, itemId, "accept");
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
    runtime.requestId = null;
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
    if (pending.toolName === "ExitPlanMode") {
      // Going ahead leaves plan mode for the session's access; otherwise Claude keeps planning.
      if (decision === "accept") {
        runtime.planning = false;
        const mode = PERMISSION_MODE[runtime.access];
        pending.resolve({ behavior: "allow", updatedInput: pending.input, updatedPermissions: [{ type: "setMode", mode, destination: "session" }] });
        void runtime.query.setPermissionMode(mode).catch(() => undefined);
      } else {
        pending.resolve({ behavior: "deny", message: "The user wants to refine the plan before going ahead. Stop here and wait for their next message." });
      }
    } else if (decision === "accept") {
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
    this.closing = true;
    this.loginProcess?.kill();
    this.loginProcess = null;
    for (const runtime of this.runtimes.values()) {
      runtime.input.close();
      runtime.query.close();
    }
    this.runtimes.clear();
  }
}

/** Base64 limits of the Messages API: larger files go by path, and Claude Code reads them itself. */
const IMAGE_INLINE = 3_750_000;
const PDF_INLINE = 20_000_000;

/** A request with its files: pictures and PDFs as content blocks, anything else named by path. */
export function claudeContent(text: string, files: AttachedFile[]): SDKUserMessage["message"]["content"] {
  if (!files.length) return text;
  const blocks: Exclude<SDKUserMessage["message"]["content"], string> = [];
  const named: AttachedFile[] = [];
  for (const file of files) {
    const size = statSync(file.path).size;
    if (isImage(file.mime) && size <= IMAGE_INLINE) {
      const media = file.mime as "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      blocks.push({ type: "image", source: { type: "base64", media_type: media, data: readFileSync(file.path).toString("base64") } });
    } else if (file.mime === "application/pdf" && size <= PDF_INLINE) {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: readFileSync(file.path).toString("base64") }, title: file.name });
    } else {
      named.push(file);
    }
  }
  return [...blocks, { type: "text", text: mentionFiles(text, named) }];
}

/** What a conversation is called: the user's title, else Claude Code's summary or first request. */
function titleOf(info: { customTitle?: string; summary: string; firstPrompt?: string }) {
  return (info.customTitle ?? info.summary ?? info.firstPrompt ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "제목 없음";
}

/** Terminal escapes (colours, OSC 8 links) out of an engine's output. */
export function plainText(text: string) {
  return text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "");
}

/** The address `claude auth login` prints for when the browser did not open. */
export function loginAddress(output: string): string | null {
  const text = plainText(output);
  const line = text.split(/\r?\n/).find((entry) => /https?:\/\//.test(entry));
  const url = line ? /https?:\/\/\S+/.exec(line)?.[0] ?? null : null;
  return url && isWebAddress(url) ? url : null;
}

/** Why the login failed, as the engine said it (one short line). */
export function loginFailure(output: string): string | null {
  const lines = plainText(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = [...lines].reverse().find((entry) => /fail|error|invalid|denied|expired/i.test(entry));
  return line ? line.slice(0, 200) : null;
}
