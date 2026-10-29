import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type { CreateTerminalRequest, TerminalList, TerminalOutput, TerminalSession } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { physicalPath, withinDirectory } from "./directory-operations.ts";
import type { Store } from "./store.ts";
import type { Workspaces } from "./workspaces.ts";

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const active = (status: TerminalSession["status"]) => status === "starting" || status === "running" || status === "stopping";
type Running = { child: ChildProcessWithoutNullStreams; done: Promise<void>; closeTimer?: ReturnType<typeof setTimeout> };

/** The gateway owns workers; a saved PID is diagnostic data, never authority to signal a process. */
export class Terminals {
  private readonly records = new Map<string, TerminalSession>();
  private readonly live = new Map<string, Running>();
  private stopping = false;
  private readonly store: Store;
  private readonly spaces: Workspaces;
  private readonly binary: string;
  constructor(store: Store, spaces: Workspaces, binary = process.env.WORKBENCH_PTY_BIN ?? "") {
    this.store = store; this.spaces = spaces; this.binary = binary;
    for (const entry of store.terminals()) {
      this.records.set(entry.id, entry);
      if (active(entry.status)) this.save({ ...entry, status: "interrupted", pid: null, error: "앱이 종료되어 이전 실행은 이어지지 않습니다. 출력 기록을 확인하고 새 터미널을 열어 주세요." });
    }
  }
  private save(entry: TerminalSession) { const next = { ...entry, updatedAt: Date.now() }; this.records.set(next.id, next); this.store.saveTerminal(next); return next; }
  get(id: string) { const entry = this.records.get(id); if (!entry) throw new HttpError(404, "terminal_missing", "터미널 기록을 찾지 못했습니다."); return entry; }
  list(workspaceId: string): TerminalList {
    this.spaces.get(workspaceId);
    return { available: !!this.binary && existsSync(this.binary), terminals: [...this.records.values()].filter((entry) => entry.workspaceId === workspaceId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 256) };
  }
  busy(cwd: string) {
    const root = physicalPath(cwd);
    return [...this.live.keys()].some((id) => withinDirectory(root, physicalPath(this.get(id).cwd)));
  }
  has(id: string) { return this.records.has(id); }
  create(workspaceId: string, request: CreateTerminalRequest, internal: { cwd?: string; environment?: Record<string, string>; color?: string } = {}) {
    if (!request || typeof request.requestId !== "string" || !/^[\w-]{1,100}$/.test(request.requestId)) throw new HttpError(400, "terminal_request", "터미널 요청 ID가 필요합니다.");
    if (request.shell !== undefined && (typeof request.shell !== "string" || !request.shell || request.shell.length > 4096 || request.shell.includes("\0"))) throw new HttpError(400, "terminal_shell", "실행할 셸 경로를 확인해 주세요.");
    if (request.args !== undefined && (!Array.isArray(request.args) || request.args.length > 64 || request.args.some((arg) => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0")) || !request.shell)) throw new HttpError(400, "terminal_args", "사용자 셸의 인자를 확인해 주세요.");
    const shell = request.shell ?? null, args = request.args ?? [], existing = this.records.get(request.requestId);
    if (Buffer.byteLength(JSON.stringify({ shell, args })) > 65_536) throw new HttpError(400, "terminal_args", "셸과 인자의 전체 크기는 64 KiB 이하여야 합니다.");
    if (existing) {
      if (existing.workspaceId !== workspaceId || existing.shell !== shell || JSON.stringify(existing.args) !== JSON.stringify(args) || JSON.stringify(existing.environment ?? {}) !== JSON.stringify(internal.environment ?? {}) || (internal.cwd && existing.cwd !== internal.cwd)) throw new HttpError(409, "terminal_request_reused", "다른 터미널에 사용한 요청 ID입니다.");
      return existing;
    }
    if (this.stopping) throw new HttpError(409, "host_stopping", "앱이 종료 중입니다.");
    const selected = this.spaces.get(workspaceId), space = this.spaces.requireActive(selected.id, selected.workId);
    if (!this.binary || !existsSync(this.binary)) throw new HttpError(503, "terminal_unavailable", "이 실행 환경에는 Rust 터미널 실행기가 없습니다. 데스크톱 앱에서 열어 주세요.");
    if (this.live.size >= 16) throw new HttpError(429, "terminal_limit", "동시에 실행하는 터미널은 최대 16개입니다. 사용하지 않는 터미널을 종료해 주세요.");
    const now = Date.now();
    const entry = this.save({ id: request.requestId, workspaceId, workId: space.workId, hostId: space.hostId, cwd: internal.cwd ?? space.cwd, label: typeof request.label === "string" && request.label.trim() ? request.label.trim().slice(0, 80) : "터미널", shell, args, ...(internal.environment ? { environment: internal.environment } : {}), ...(internal.color ? { color: internal.color } : {}), status: "starting", pid: null, exitCode: null, error: null, cols: 80, rows: 24, outputStart: 0, outputEnd: 0, createdAt: now, updatedAt: now });
    const child = spawn(this.binary, ["--pty-worker"], { stdio: "pipe", windowsHide: true, cwd: entry.cwd });
    let finish!: () => void;
    const running: Running = { child, done: new Promise<void>((resolve) => { finish = resolve; }) };
    this.live.set(entry.id, running);
    let buffer = "", stderr = "";
    const failure = (message: string) => { this.save({ ...this.get(entry.id), error: message.slice(0, 2000), status: "error" }); child.stdin.end(); };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      buffer += data;
      if (buffer.length > 1024 * 1024) { failure("터미널 실행기의 응답이 너무 큽니다."); buffer = ""; return; }
      for (;;) {
        const index = buffer.indexOf("\n"); if (index < 0) break;
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try { this.event(entry.id, JSON.parse(line)); } catch (error) { failure(`터미널 응답을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`); }
      }
    });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (text: string) => { stderr = (stderr + text).slice(-4000); });
    child.on("error", (error) => failure(error.message));
    child.stdin.on("error", () => {}); // Exit/close records the actual worker result.
    child.on("close", (code) => {
      clearTimeout(running.closeTimer);
      const last = this.get(entry.id);
      if (active(last.status)) this.save({ ...last, pid: null, status: "error", error: stderr || `터미널 실행기가 종료되었습니다 (${code ?? "signal"}).` });
      else if (last.pid !== null) this.save({ ...last, pid: null });
      this.live.delete(entry.id); finish();
    });
    child.stdin.write(JSON.stringify({ cwd: entry.cwd, cols: entry.cols, rows: entry.rows, shell, args, env: internal.environment }) + "\n");
    return entry;
  }
  private event(id: string, message: Record<string, unknown>) {
    let entry = this.get(id);
    if (message.type === "ready") {
      this.save({ ...entry, status: entry.status === "stopping" ? "stopping" : "running", pid: typeof message.pid === "number" ? message.pid : null });
    } else if (message.type === "data" && typeof message.data === "string") {
      const bytes = Buffer.from(message.data, "base64");
      if (bytes.length > 65_536) throw new Error("Output chunk exceeds limit");
      if (!bytes.length) return;
      const next = this.store.transaction(() => {
        const start = this.store.appendTerminalOutput(id, entry.outputEnd, bytes, OUTPUT_LIMIT);
        const next = { ...entry, outputStart: start, outputEnd: entry.outputEnd + bytes.length, updatedAt: Date.now() };
        this.store.saveTerminal(next);
        return next;
      });
      this.records.set(id, next);
    } else if (message.type === "resized" && typeof message.cols === "number" && typeof message.rows === "number") {
      this.save({ ...entry, cols: message.cols, rows: message.rows });
    } else if (message.type === "error") {
      this.save({ ...entry, status: message.fatal ? "error" : entry.status, error: String(message.message ?? "터미널 오류").slice(0, 2000) });
    } else if (message.type === "exit") {
      this.save({ ...entry, status: entry.status === "error" ? "error" : "exited", pid: null, exitCode: typeof message.code === "number" ? message.code : null });
    }
  }
  private write(id: string, message: unknown) {
    const entry = this.get(id), running = this.live.get(id);
    this.spaces.requireActive(entry.workspaceId, entry.workId);
    if (!running || entry.status !== "running") throw new HttpError(409, "terminal_not_running", "실행 중인 터미널이 아닙니다. 이전 출력은 그대로 보존합니다.");
    if (running.child.stdin.writableLength > 1024 * 1024) throw new HttpError(429, "terminal_input_busy", "터미널이 입력을 처리 중입니다. 잠시 뒤 다시 시도해 주세요.");
    running.child.stdin.write(JSON.stringify(message) + "\n");
    return { ok: true };
  }
  input(id: string, data: unknown) {
    if (typeof data !== "string" || Buffer.byteLength(data) > 65_536) throw new HttpError(400, "terminal_input", "한 번의 터미널 입력은 64 KiB 이하여야 합니다.");
    return this.write(id, { type: "input", data: Buffer.from(data).toString("base64") });
  }
  resize(id: string, cols: unknown, rows: unknown) {
    if (typeof cols !== "number" || typeof rows !== "number" || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 1000 || rows < 2 || rows > 1000) throw new HttpError(400, "terminal_size", "터미널 크기가 올바르지 않습니다.");
    return this.write(id, { type: "resize", cols, rows });
  }
  output(id: string, cursor = 0): TerminalOutput {
    const terminal = this.get(id);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HttpError(400, "terminal_cursor", "출력 위치가 올바르지 않습니다.");
    const start = Math.min(Math.max(cursor, terminal.outputStart), terminal.outputEnd);
    const chunks = this.store.readTerminalOutput(id, start).map((chunk) => Buffer.from(chunk.data).subarray(Math.max(0, start - chunk.start)));
    const bytes = Buffer.concat(chunks);
    return { terminal, start, end: start + bytes.length, data: bytes.toString("base64"), truncated: cursor < terminal.outputStart };
  }
  async close(id: string) {
    const entry = this.get(id), running = this.live.get(id);
    if (!running) return entry;
    if (entry.status !== "stopping") {
      this.save({ ...entry, status: "stopping" });
      running.child.stdin.end(JSON.stringify({ type: "close" }) + "\n");
      // Only this freshly spawned worker is owned. Its EOF closes its PTY; never signal a saved PID.
      running.closeTimer = setTimeout(() => { running.child.kill(); }, 4000);
    }
    await running.done;
    return this.get(id);
  }
  async waitForExit(id: string) { await this.live.get(id)?.done; return this.get(id); }
  async shutdown() { this.stopping = true; await Promise.all([...this.live.keys()].map((id) => this.close(id))); }
}
