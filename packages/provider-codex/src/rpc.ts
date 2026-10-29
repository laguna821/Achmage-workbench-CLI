import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

// Minimal client for `codex app-server` (newline-delimited JSON-RPC over stdio).
// Server-initiated requests (approvals) are surfaced to the caller, who must answer them.

export type RpcNotification = { method: string; params: unknown };
export type RpcServerRequest = { id: number | string; method: string; params: unknown };

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class RpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export type CodexRpcOptions = {
  binary: string;
  /** Arguments before `app-server` (a JavaScript launcher run on Node names its script here). */
  prefixArgs?: string[];
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  requestTimeoutMs?: number;
  onNotification: (notification: RpcNotification) => void;
  onServerRequest: (request: RpcServerRequest) => void;
  onExit: (code: number | null, stderrTail: string) => void;
};

export class CodexRpc {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderrTail = "";
  private readonly options: CodexRpcOptions;

  constructor(options: CodexRpcOptions) {
    this.options = options;
  }

  get running() {
    return this.child !== null;
  }

  start() {
    const child = spawn(this.options.binary, [...(this.options.prefixArgs ?? []), "app-server", ...(this.options.args ?? [])], {
      env: this.options.env ?? process.env,
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
    });
    let ended = false;
    const end = (code: number | null) => {
      if (ended) return;
      ended = true;
      if (this.child === child) this.child = null;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new RpcError("codex app-server exited"));
      }
      this.pending.clear();
      this.options.onExit(code, this.stderrTail);
    };
    child.on("exit", (code) => end(code));
    // A program that cannot be started reports an error instead of exiting.
    child.on("error", (error) => {
      this.stderrTail = `${this.stderrTail}\n${error.message}`.slice(-4000);
      end(null);
    });
    child.stdin.on("error", () => undefined);
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const child = this.child;
    if (!child) {
      return Promise.reject(new RpcError("codex app-server is not running"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`${method} timed out`));
      }, timeoutMs ?? this.options.requestTimeoutMs ?? 60_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown) {
    this.child?.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
  }

  respond(id: number | string, result: unknown) {
    this.child?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  respondError(id: number | string, message: string) {
    this.child?.stdin.write(`${JSON.stringify({ id, error: { code: -32000, message } })}\n`);
  }

  stop() {
    this.child?.kill("SIGTERM");
  }

  private handleLine(line: string) {
    if (!line.trim()) {
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && typeof message.method === "string") {
      this.options.onServerRequest({
        id: message.id as number | string,
        method: message.method,
        params: message.params,
      });
      return;
    }
    if (hasId) {
      const pending = this.pending.get(message.id as number);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id as number);
      clearTimeout(pending.timer);
      const error = message.error as { message?: string; code?: number; data?: unknown } | undefined;
      if (error) {
        pending.reject(new RpcError(error.message ?? "codex request failed", error.code, error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      this.options.onNotification({ method: message.method, params: message.params });
    }
  }
}
