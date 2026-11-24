import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

// A minimal Agent Client Protocol (agentclientprotocol.com, protocol version 1) client connection:
// newline-delimited JSON-RPC 2.0 over the agent's stdin/stdout. Written for Workbench; the shape of the
// plumbing (one process per conversation, requests the agent sends back for permissions) follows the ACP
// spec and Paseo's ACP client (github.com/getpaseo/paseo, Apache-2.0), from which no code is copied.

export type AcpNotification = { method: string; params: unknown };
export type AcpServerRequest = { id: number | string; method: string; params: unknown };

export class AcpError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** ACP's "Authentication required" (Google's ACP guide: -32000 without credentials). */
export const isAuthRequired = (error: unknown) => error instanceof AcpError && (error.code === -32000 || /auth(entication)? required/i.test(error.message));

export type AcpSpawn = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;

export type AcpConnectionOptions = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Default timeout of a request; `session/prompt` waits for its turn instead (no timeout). */
  requestTimeoutMs?: number;
  onNotification(notification: AcpNotification): void;
  onRequest(request: AcpServerRequest): void;
  onExit(code: number | null, stderrTail: string): void;
  spawn?: AcpSpawn;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout | null; method: string };

export class AcpConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderrTail = "";
  private readonly options: AcpConnectionOptions;

  constructor(options: AcpConnectionOptions) {
    this.options = options;
  }

  get running() { return this.child !== null; }
  get pid(): number | null { return this.child?.pid ?? null; }

  start() {
    const { command, args, env, cwd } = this.options;
    const child = this.options.spawn
      ? this.options.spawn(command, args, { env, cwd })
      : spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => { this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000); });
    let ended = false;
    const end = (code: number | null) => {
      if (ended) return;
      ended = true;
      if (this.child === child) this.child = null;
      for (const [, pending] of this.pending) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new AcpError("Gemini 엔진(agy acp)이 종료되었습니다."));
      }
      this.pending.clear();
      this.options.onExit(code, this.stderrTail);
    };
    child.on("exit", (code) => end(code));
    child.on("error", (error) => { this.stderrTail = `${this.stderrTail}\n${error.message}`.slice(-4000); end(null); });
    child.stdin.on("error", () => undefined);
  }

  /** `timeoutMs` 0: wait as long as it takes (a prompt turn). */
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new AcpError("Gemini 엔진(agy acp)이 실행 중이 아닙니다."));
    const id = this.nextId++;
    const limit = timeoutMs ?? this.options.requestTimeoutMs ?? 60_000;
    return new Promise<T>((resolve, reject) => {
      const timer = limit > 0 ? setTimeout(() => { this.pending.delete(id); reject(new AcpError(`${method}: 응답이 없습니다.`)); }, limit) : null;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown) {
    this.child?.stdin.write(`${JSON.stringify(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params })}\n`);
  }

  respond(id: number | string, result: unknown) {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  respondError(id: number | string, code: number, message: string) {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
  }

  /** Close stdin (agy saves its conversation and exits), then end the process if it lingers. */
  stop() {
    const child = this.child;
    if (!child) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    const timer = setTimeout(() => { if (this.child === child) child.kill("SIGTERM"); }, 3_000);
    timer.unref?.();
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && typeof message.method === "string") {
      this.options.onRequest({ id: message.id as number | string, method: message.method, params: message.params });
      return;
    }
    if (hasId) {
      const pending = this.pending.get(message.id as number);
      if (!pending) return;
      this.pending.delete(message.id as number);
      if (pending.timer) clearTimeout(pending.timer);
      const error = message.error as { message?: string; code?: number; data?: unknown } | undefined;
      if (error) pending.reject(new AcpError(error.message ?? `${pending.method} failed`, error.code, error.data));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") this.options.onNotification({ method: message.method, params: message.params });
  }
}
