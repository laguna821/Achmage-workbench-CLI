import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { freemem } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { applyTerminalSize } from "@workbench/paseo-terminal/size-ownership";
import type { TerminalSizePort } from "@workbench/paseo-terminal/ports";
import type { TerminalReplay, TerminalResizeOwner, TerminalSearchRequest, TerminalSearchResult } from "../../../packages/contracts/src/terminal-runtime.ts";
import { GATEWAY_SCROLLBACK, TerminalEmulator } from "./terminal-emulator.ts";
import type { CreateTerminalRequest, TerminalList, TerminalOutput, TerminalSession } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { physicalPath, withinDirectory } from "./directory-operations.ts";
import type { Store } from "./store.ts";
import type { Workspaces } from "./workspaces.ts";
import { gatewayOnly } from "./gateway-env.ts";
import { withEngineTools } from "./engine-env.ts";

const MiB = 1024 * 1024;
/**
 * Scrollback, one bounded copy per place (0.5.3, A6). The gateway's screen model keeps `gateway` lines: what a
 * reload or a tab shown again restores (screen plus that tail). The window keeps `window` lines only while the
 * terminal is shown (TerminalView.tsx; a hidden one releases its view). The database journal keeps the last
 * `journalLive` bytes of a running terminal (search, restore after a restart) and the last `journalEnded` bytes
 * once it has ended ("이전 출력 기록").
 */
export const TERMINAL_SCROLLBACK = { gateway: GATEWAY_SCROLLBACK, window: 5000, journalLive: 1 * MiB, journalEnded: 256 * 1024 } as const;
const OUTPUT_LIMIT = TERMINAL_SCROLLBACK.journalLive;

/**
 * Who may open one more live terminal (0.5.3, A5). A terminal is a worker process plus the shell (10 to 25 MB
 * together) and its bounded screen: the machine decides, not a fixed count. A new one opens while the
 * memory the system says is available (Linux: MemAvailable) is at least `reserveBytes`; `maxLive` stays as a
 * safety net against a runaway script opening terminals in a loop.
 */
export const TERMINAL_LIMITS = { maxLive: 64, reserveBytes: 1024 * MiB } as const;
const number = (value: number) => Math.floor(value).toLocaleString("en-US");
/** null: admitted. Otherwise the Korean reason shown to the person. */
export function terminalAdmission(live: number, availableBytes: number): string | null {
  if (live >= TERMINAL_LIMITS.maxLive) return `동시에 실행하는 터미널은 최대 ${TERMINAL_LIMITS.maxLive}개입니다. 사용하지 않는 터미널을 종료해 주세요.`;
  if (Number.isFinite(availableBytes) && availableBytes < TERMINAL_LIMITS.reserveBytes)
    return `이 컴퓨터의 남은 메모리가 ${number(availableBytes / MiB)} MB라 새 터미널을 열지 않았습니다(최소 ${number(TERMINAL_LIMITS.reserveBytes / MiB)} MB 필요). 쓰지 않는 터미널이나 프로그램을 종료한 뒤 다시 열어 주세요.`;
  return null;
}
/** Memory the system can give without swapping: the cgroup-aware figure where Node has it, else MemAvailable. */
export function availableMemory() {
  const constrained = (process as { availableMemory?: () => number }).availableMemory?.();
  return typeof constrained === "number" && constrained > 0 ? Math.min(constrained, freemem()) : freemem();
}
/**
 * How many terminals a workspace's list shows (0.5.3, A7). Past it, the oldest ended ones leave with their output
 * (they could not be reached from the list). Nothing is ever deleted for its age: an ended terminal and the end of
 * its output stay for as long as the person keeps them.
 */
export const TERMINAL_RETENTION = { perWorkspace: 256 } as const;
/**
 * Output is written to the journal in batches (0.5.3, A8): at most every `outputFlushMs`, or at once when a
 * terminal has `outputFlushBytes` waiting; and always before its record is saved (exit, close, resize, error),
 * in the same transaction, so the record and its rows agree after any crash. Readers see waiting bytes at once.
 */
export const TERMINAL_OUTPUT_BATCH = { flushMs: 200, flushBytes: 64 * 1024 } as const;
export type TerminalsOptions = { availableMemory?: () => number; outputFlushMs?: number };
const active = (status: TerminalSession["status"]) => status === "starting" || status === "running" || status === "stopping";
type Running = { child: ChildProcessWithoutNullStreams; done: Promise<void>; closeTimer?: ReturnType<typeof setTimeout> };

/** The gateway owns workers; a saved PID is diagnostic data, never authority to signal a process. */
export class Terminals {
  private readonly records = new Map<string, TerminalSession>();
  private readonly live = new Map<string, Running>();
  private readonly emulators = new Map<string, TerminalEmulator>();
  private readonly sizePorts = new Map<string, TerminalSizePort>();
  private readonly sizeOwners = new Map<string, Map<string, object>>();
  private stopping = false;
  /** Output read from the worker and not yet in the journal; it ends at the record's `outputEnd`. */
  private readonly pending = new Map<string, { chunks: Buffer[]; size: number }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushMs: number;
  private readonly store: Store;
  private readonly spaces: Workspaces;
  private readonly binary: string;
  private readonly memory: () => number;
  constructor(store: Store, spaces: Workspaces, binary = gatewayOnly("WORKBENCH_PTY_BIN") ?? "", options: TerminalsOptions = {}) {
    this.store = store; this.spaces = spaces; this.binary = binary; this.memory = options.availableMemory ?? availableMemory; this.flushMs = options.outputFlushMs ?? TERMINAL_OUTPUT_BATCH.flushMs;
    for (const entry of store.terminals()) {
      this.records.set(entry.id, entry);
      if (active(entry.status)) this.save({ ...entry, status: "interrupted", pid: null, error: "호스트가 재시작되어 이전 터미널 실행은 이어지지 않습니다. 출력 기록을 확인하고 새 터미널을 열어 주세요." });
    }
  }
  private save(entry: TerminalSession) {
    const next = { ...entry, updatedAt: Date.now() };
    this.records.set(next.id, next);
    if (!this.pending.has(next.id)) { this.store.saveTerminal(next); return next; }
    this.store.transaction(() => { this.writePending(next.id); this.store.saveTerminal(this.records.get(next.id)!); });
    return this.records.get(next.id)!;
  }
  /** Waiting output into the journal (the caller saves the record in the same transaction). */
  private writePending(id: string) {
    const waiting = this.pending.get(id), entry = this.records.get(id);
    if (!waiting || !entry) return;
    this.pending.delete(id);
    const start = this.store.appendTerminalOutput(id, entry.outputEnd - waiting.size, Buffer.concat(waiting.chunks, waiting.size), OUTPUT_LIMIT);
    this.records.set(id, { ...entry, outputStart: start });
  }
  /** Write one terminal's waiting output and its record now. */
  private flushOutput(id: string) {
    if (!this.pending.has(id)) return;
    this.store.transaction(() => { this.writePending(id); this.store.saveTerminal(this.records.get(id)!); });
  }
  /** Every terminal's waiting output (the batch timer; shutdown). */
  flushAll() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.pending.size) return;
    this.store.transaction(() => { for (const id of [...this.pending.keys()]) { this.writePending(id); this.store.saveTerminal(this.records.get(id)!); } });
  }
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
  forgetWork(workId: string) {
    for (const [id, entry] of this.records) if (entry.workId === workId && !this.live.has(id)) this.records.delete(id);
  }
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
    const refused = terminalAdmission(this.live.size, this.memory());
    if (refused) throw new HttpError(429, "terminal_limit", refused);
    const now = Date.now();
    const entry = this.save({ id: request.requestId, workspaceId, workId: space.workId, hostId: space.hostId, cwd: internal.cwd ?? space.cwd, label: typeof request.label === "string" && request.label.trim() ? request.label.trim().slice(0, 80) : "터미널", shell, args, ...(internal.environment ? { environment: internal.environment } : {}), ...(internal.color ? { color: internal.color } : {}), status: "starting", pid: null, exitCode: null, error: null, cols: 80, rows: 24, outputStart: 0, outputEnd: 0, createdAt: now, updatedAt: now });
    // The person's terminal keeps the app's tool wrappers on its PATH (they left the gateway's own PATH).
    const child = spawn(this.binary, ["--pty-worker"], { stdio: "pipe", windowsHide: true, cwd: entry.cwd, env: withEngineTools() });
    let finish!: () => void;
    const running: Running = { child, done: new Promise<void>((resolve) => { finish = resolve; }) };
    this.live.set(entry.id, running);
    const model = new TerminalEmulator(entry.rows, entry.cols, data => {
      // Only the owned live worker receives emulator replies; replay never writes to a shell.
      if (this.live.get(entry.id) === running && this.get(entry.id).status === "running" && child.stdin.writableLength < 1024 * 1024) {
        child.stdin.write(JSON.stringify({ type: "input", data: Buffer.from(data).toString("base64") }) + "\n");
      }
    });
    this.emulators.set(entry.id, model);
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
      this.flushOutput(entry.id); this.keepTail(entry.id);
      this.live.delete(entry.id); this.emulators.delete(entry.id); model.dispose();
      this.sizeOwners.delete(entry.id); this.sizePorts.delete(entry.id); finish();
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
      const next = { ...entry, outputEnd: entry.outputEnd + bytes.length, updatedAt: Date.now() };
      this.records.set(id, next);
      const waiting = this.pending.get(id) ?? { chunks: [], size: 0 };
      waiting.chunks.push(Buffer.from(bytes)); waiting.size += bytes.length; this.pending.set(id, waiting);
      this.emulators.get(id)?.feed(bytes, next.outputEnd);
      if (waiting.size >= TERMINAL_OUTPUT_BATCH.flushBytes) this.flushOutput(id);
      else if (!this.flushTimer) { this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flushAll(); }, this.flushMs); this.flushTimer.unref?.(); }
    } else if (message.type === "resized" && typeof message.cols === "number" && typeof message.rows === "number") {
      this.save({ ...entry, cols: message.cols, rows: message.rows });
      this.emulators.get(id)?.resize(message.rows, message.cols);
    } else if (message.type === "error") {
      this.save({ ...entry, status: message.fatal ? "error" : entry.status, error: String(message.message ?? "터미널 오류").slice(0, 2000) });
    } else if (message.type === "exit") {
      this.save({ ...entry, status: entry.status === "error" ? "error" : "exited", pid: null, exitCode: typeof message.code === "number" ? message.code : null });
      this.keepTail(id);
    }
  }
  /**
   * Ended terminals past the 256 a workspace's list shows leave with their stored output, oldest first (0.5.3, A7).
   * Running ones never; age never. Ended journals are cut to their tail (older databases kept 2 MiB). Runs from the
   * idle maintenance (store-maintenance.ts), never on output. `now` is kept for callers; age plays no part.
   */
  prune(_now = Date.now()) {
    const gone: string[] = [], perSpace = new Map<string, TerminalSession[]>();
    for (const entry of this.records.values()) {
      if (active(entry.status) || this.live.has(entry.id)) continue;
      perSpace.set(entry.workspaceId, [...perSpace.get(entry.workspaceId) ?? [], entry]);
    }
    for (const [workspaceId, ended] of perSpace) {
      const shown = new Set([...this.records.values()].filter((entry) => entry.workspaceId === workspaceId).sort((a, b) => b.createdAt - a.createdAt).slice(0, TERMINAL_RETENTION.perWorkspace).map((entry) => entry.id));
      for (const entry of ended) if (!shown.has(entry.id)) gone.push(entry.id);
    }
    if (gone.length) this.store.transaction(() => { for (const id of gone) this.store.deleteTerminal(id); });
    for (const id of gone) this.records.delete(id);
    for (const entry of [...this.records.values()]) if (!active(entry.status) && !this.live.has(entry.id)) this.keepTail(entry.id);
    return gone.length;
  }
  /** An ended terminal keeps only the tail of its journal (TERMINAL_SCROLLBACK.journalEnded). */
  private keepTail(id: string) {
    this.flushOutput(id);
    const entry = this.records.get(id);
    if (!entry || active(entry.status) || entry.outputEnd - entry.outputStart <= TERMINAL_SCROLLBACK.journalEnded) return;
    const start = entry.outputEnd - TERMINAL_SCROLLBACK.journalEnded;
    const next = { ...entry, outputStart: start, updatedAt: Date.now() };
    this.store.transaction(() => { this.store.trimTerminalOutput(id, start); this.store.saveTerminal(next); });
    this.records.set(id, next);
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
  resize(id: string, cols: unknown, rows: unknown, owner?: TerminalResizeOwner) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || Number(cols) < 2 || Number(cols) > 1000 || Number(rows) < 2 || Number(rows) > 1000) throw new HttpError(400, "terminal_size", "터미널 크기를 확인해 주세요.");
    if (!owner) { this.write(id, { type: "resize", cols, rows }); return { ok: true }; }
    if (!/^[\w:-]{1,160}$/.test(owner.ownerId) || !["claim", "update"].includes(owner.intent)) throw new HttpError(400, "terminal_size_owner", "터미널 화면 식별자를 확인해 주세요.");
    const entry = this.get(id); this.spaces.requireActive(entry.workspaceId, entry.workId);
    if (!this.live.has(id) || entry.status !== "running") throw new HttpError(409, "terminal_not_running", "실행 중인 터미널이 아닙니다.");
    let port = this.sizePorts.get(id);
    if (!port) { port = { getSize: () => this.get(id), send: message => this.write(id, message) }; this.sizePorts.set(id, port); }
    let owners = this.sizeOwners.get(id);
    if (!owners) { owners = new Map(); this.sizeOwners.set(id, owners); }
    let identity = owners.get(owner.ownerId);
    if (!identity) { if (owners.size >= 64) owners.delete(owners.keys().next().value!); identity = {}; owners.set(owner.ownerId, identity); }
    return { ok: true, applied: applyTerminalSize(port, identity, { cols: Number(cols), rows: Number(rows), intent: owner.intent }) };
  }
  ownsRunning(id: string) { return this.live.has(id) && this.get(id).status === "running"; }
  async replay(id: string): Promise<TerminalReplay> {
    const terminal = this.get(id), live = this.emulators.get(id);
    if (live) return { terminal, ...await live.capture(), truncated: terminal.outputStart > 0 };
    // Historical sessions are rebuilt from their retained journal, never adopted by PID.
    const model = new TerminalEmulator(terminal.rows, terminal.cols, () => {});
    try {
      const output = this.history(id);
      model.feed(Buffer.from(output.data, "base64"), output.end);
      return { terminal, ...await model.capture(), truncated: terminal.outputStart > 0 };
    } finally { model.dispose(); }
  }
  search(id: string, request: TerminalSearchRequest): TerminalSearchResult {
    if (typeof request.query !== "string" || !request.query.trim() || request.query.length > 256) throw new HttpError(400, "terminal_query", "찾을 글자를 1~256자로 입력해 주세요.");
    const limit = request.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, "terminal_query", "검색 결과는 최대 200개입니다.");
    const entry = this.get(id), output = this.history(id);
    const lines = stripVTControlCharacters(Buffer.from(output.data, "base64").toString("utf8")).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const needle = request.caseSensitive ? request.query : request.query.toLocaleLowerCase();
    const matches: TerminalSearchResult["matches"] = [];
    let limited = false;
    for (let line = 0; line < lines.length; line++) {
      const text = lines[line]!, searchable = request.caseSensitive ? text : text.toLocaleLowerCase();
      const at = searchable.indexOf(needle); if (at < 0) continue;
      if (matches.length === limit) { limited = true; break; }
      const from = Math.max(0, at - 160), cropped = text.slice(from, Math.max(from + 800, at + request.query.length));
      matches.push({ line: line + 1, text: cropped, from: at - from, to: at - from + request.query.length });
    }
    return { terminalId: id, query: request.query, start: output.start, end: output.end, truncated: entry.outputStart > 0, limited, matches };
  }

  private history(id: string) {
    const entry = this.get(id), chunks: Buffer[] = [];
    let cursor = entry.outputStart;
    while (cursor < entry.outputEnd) {
      const page = this.output(id, cursor);
      if (page.end <= cursor) break;
      chunks.push(Buffer.from(page.data, "base64")); cursor = page.end;
    }
    return { start: entry.outputStart, end: cursor, data: Buffer.concat(chunks).toString("base64") };
  }
  output(id: string, cursor = 0): TerminalOutput {
    const terminal = this.get(id);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HttpError(400, "terminal_cursor", "출력 위치가 올바르지 않습니다.");
    const start = Math.min(Math.max(cursor, terminal.outputStart), terminal.outputEnd);
    const rows = this.store.readTerminalOutput(id, start);
    const chunks = rows.map((chunk) => Buffer.from(chunk.data).subarray(Math.max(0, start - chunk.start)));
    // Output still waiting for its batch is served from memory: a reader never waits for the journal.
    const waiting = this.pending.get(id), waitingStart = terminal.outputEnd - (waiting?.size ?? 0);
    const read = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (waiting && rows.length < 16 && start + read >= waitingStart) chunks.push(Buffer.concat(waiting.chunks, waiting.size).subarray(start + read - waitingStart));
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
  async shutdown() { this.stopping = true; await Promise.all([...this.live.keys()].map((id) => this.close(id))); this.flushAll(); }
}
