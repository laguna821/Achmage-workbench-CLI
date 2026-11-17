import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ScopeProbe } from "./ladder.ts";

// 0.5.4: each engine in its own place on Linux. Where the user's systemd can make a scope (`systemd-run --user
// --scope`, cgroup v2 with the memory controller), every engine process is started in a scope of its own:
// - the kernel's OOM killer, or systemd-oomd, then ends THAT scope only — never the app's scope with the
//   window and the gateway in it (the app's own scope stops as a whole when one process in it is killed);
// - with 대화당 메모리 상한 on, a Claude conversation's scope has MemoryHigh (90 %: slowed and pushed to swap
//   first) and MemoryMax (the cap: past it that conversation's engine ends, and only it);
// - under memory pressure the least urgent engine can give memory back to swap (`memory.reclaim`).
// `systemd-run --scope` registers the scope and then becomes the command itself (same process id, same parent:
// the gateway, same environment but systemd's INVOCATION_ID, same cwd and pipes; `--quiet` keeps its own
// "Running as unit" line off stderr), so pipes, signals, exit codes and the memory readout work as before.
// Each scope is bound to the gateway's own unit (BindsTo/After): stopping that unit — the login service, the
// app's scope — stops the engines with it. A RESTART of a service does not reach scopes (measured, systemd 261),
// so a gateway sweeps the scopes its unit left behind when it starts (sweepEngineScopes).
// FAIL-SAFE: an engine started through the wrapper that does not come up — spawn error, the wrapper ends before
// the engine said anything in its first seconds, or systemd-run still has not become the engine after 3 s — is
// started ONCE more without it, with what was already written to it; one line "WB_ENGINE_SCOPE_OFF <reason>" goes
// to the log and wrapping is off for the rest of this gateway run. A turn never fails because of the wrapper.
// Elsewhere (no systemd, Windows, macOS) engines start exactly as before. Engine processes on Linux also get a
// higher oom_score_adj than the gateway, so a kernel that must kill something takes an engine before the gateway.

export const SCOPE_PREFIX = "workbench-engine-";
/** Engines are taken before the gateway (0) by the kernel's OOM killer. Raising it needs no privilege. */
export const ENGINE_OOM_SCORE = 300;
/** An engine that ends this soon after a wrapped start, having said nothing, is taken as a wrapper failure. */
export const FIRST_MS = 5_000;
/** systemd-run that has not become the engine by then is stuck (on the bus): it is ended and the engine started plainly. */
export const STUCK_MS = 3_000;
/** The start check never takes longer than this. */
export const PROBE_MS = 5_000;
/** One write to /proc or /sys never holds anything up longer than this. */
export const WRITE_MS = 2_000;

const scopeArgs = (unit: string, capBytes: number | null, owner: string | null) => [
  "--user", "--scope", "--quiet", "--collect", "--expand-environment=no", `--unit=${unit}`,
  ...(owner ? ["-p", `BindsTo=${owner}`, "-p", `After=${owner}`] : []),
  ...(capBytes ? ["-p", `MemoryHigh=${Math.floor(capBytes * 0.9)}`, "-p", `MemoryMax=${capBytes}`] : []),
  "--",
];

/** The unit this gateway runs in (a service or a scope of the user's systemd), or null. */
export function ownUnit(cgroupFile = "/proc/self/cgroup"): string | null {
  let line = "";
  try { line = readFileSync(cgroupFile, "utf8"); } catch { return null; }
  const last = /^0::(\/.*)$/m.exec(line)?.[1]?.split("/").at(-1) ?? "";
  if (!/^[A-Za-z0-9:_.@\\-]+\.(service|scope)$/.test(last) || /^user@\d+\.service$/.test(last) || last === "init.scope") return null;
  return last;
}
/** The part of an engine scope's name that says which gateway unit started it. */
const ownerTag = (owner: string | null) => (owner ?? "none").replace(/\.(service|scope)$/, "").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40);

function findSystemdRun(env: NodeJS.ProcessEnv): string | null {
  for (const dir of [...(env.PATH ?? "").split(delimiter), "/usr/bin", "/bin"]) {
    if (!dir) continue;
    const file = join(dir, "systemd-run");
    try { accessSync(file, fsConstants.X_OK); return file; } catch { /* next */ }
  }
  return null;
}

/**
 * Whether this computer can give engines their own scope. Read once at start, in the background (never on a
 * request's path), bounded by PROBE_MS: cgroup v2, its memory controller, and a real `systemd-run --user --scope`
 * of `true` with the very options engines get, in the environment engines get (a login service may have no
 * DBUS_SESSION_BUS_ADDRESS; without XDG_RUNTIME_DIR either, systemd-run cannot find the bus and says so at once).
 * WORKBENCH_ENGINE_SCOPE=off (test gateways) answers "no" without trying.
 */
export async function probeScope(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<ScopeProbe | null> {
  if (platform !== "linux" || env.WORKBENCH_ENGINE_SCOPE === "off") return null;
  const own = await readFile("/proc/self/cgroup", "utf8").catch(() => "");
  const cgroup2 = /^0::\//m.test(own);
  const controllers = await readFile("/sys/fs/cgroup/cgroup.controllers", "utf8").catch(() => "");
  const memory = controllers.split(/\s+/).includes("memory");
  const binary = findSystemdRun(env);
  if (!cgroup2 || !memory || !binary) return { cgroup2, memory, systemdRun: false };
  const owner = ownUnit();
  const systemdRun = await new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(false), PROBE_MS + 500);
    execFile(binary, [...scopeArgs(`${SCOPE_PREFIX}${ownerTag(owner)}-probe-${randomUUID().slice(0, 8)}.scope`, 64 * 1024 * 1024, owner), "true"], { timeout: PROBE_MS, killSignal: "SIGKILL", windowsHide: true, env },
      (error) => { clearTimeout(timer); done(!error); });
  });
  if (systemdRun) { engineScope.binary = binary; engineScope.owner = owner; }
  return { cgroup2, memory, systemdRun };
}

/** How engines are started now (set by the resource manager from the probe and the settings). */
export const engineScope = {
  enabled: false,
  /** 대화당 메모리 상한 in bytes, or null (off). Applies to Claude conversations started after it is set. */
  capBytes: null as number | null,
  /** systemd-run, by its full path (found by the probe). */
  binary: "systemd-run",
  /** The gateway's own unit: engine scopes are bound to it and named after it. */
  owner: null as string | null,
  /** Why wrapping was turned off during this run (the fail-safe), or null. */
  disabledReason: null as string | null,
  /** Told once when the fail-safe turns wrapping off (the resource manager says it in the settings). */
  onDisable: null as ((reason: string) => void) | null,
  /**
   * The command that starts an engine: as given, or inside its own scope. `cap`: this engine serves one
   * conversation (Claude), so the per-conversation cap applies; Codex's one app-server serves them all.
   */
  wrap(command: string, args: readonly string[], label: string, cap: boolean): { command: string; args: string[] } {
    if (!this.enabled) return { command, args: [...args] };
    const unit = `${SCOPE_PREFIX}${ownerTag(this.owner)}-${label.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}-${randomUUID().slice(0, 8)}.scope`;
    return { command: this.binary, args: [...scopeArgs(unit, cap ? this.capBytes : null, this.owner), command, ...args] };
  },
  /** The fail-safe: wrapping off for the rest of this run, said once in the log with a fixed code. */
  disable(reason: string) {
    if (!this.enabled) return;
    this.enabled = false;
    this.disabledReason = reason;
    console.error(`WB_ENGINE_SCOPE_OFF ${reason.replace(/\s+/g, " ").slice(0, 300)}`);
    try { this.onDisable?.(reason); } catch { /* only a notice */ }
  },
};

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type EngineSpawnOptions = { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal };

/**
 * Start an engine: plainly when wrapping is off; otherwise in its own scope behind the fail-safe (GuardedEngine).
 * The result has the streams and events of a ChildProcess (what the Agent SDK and CodexRpc use).
 */
export function spawnEngine(command: string, args: readonly string[], options: EngineSpawnOptions, label: string, cap: boolean, spawnFn: Spawn = spawn): ChildProcessWithoutNullStreams {
  const spawnOptions: SpawnOptions = { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true };
  if (!engineScope.enabled) return spawnFn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams;
  const wrapped = engineScope.wrap(command, args, label, cap);
  return new GuardedEngine(wrapped, { command, args: [...args] }, spawnOptions, options.signal, spawnFn) as unknown as ChildProcessWithoutNullStreams;
}

/**
 * A wrapped engine with its fail-safe. Until the engine's first output it keeps what was written to its stdin and
 * holds back what appears on stderr (systemd-run's own complaint must never reach the engine's stderr reader);
 * on a failed start it starts the engine plainly, writes the kept input to it, and from then on is a plain pipe.
 */
class GuardedEngine extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private child: ChildProcess;
  private wrappedNow = true;
  private spoke = false;
  private stopped = false;
  private stdinEnded = false;
  private kept: Buffer[] = [];
  private heldErr: Buffer[] = [];
  private readonly startedAt = Date.now();
  private stuckTimer: NodeJS.Timeout | null = null;
  private readonly plain: { command: string; args: string[] };
  private readonly options: SpawnOptions;
  private readonly signal: AbortSignal | undefined;
  private readonly spawnFn: Spawn;

  constructor(wrapped: { command: string; args: string[] }, plain: { command: string; args: string[] }, options: SpawnOptions, signal: AbortSignal | undefined, spawnFn: Spawn) {
    super();
    this.plain = plain; this.options = options; this.signal = signal; this.spawnFn = spawnFn;
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        if (this.wrappedNow && !this.spoke) this.kept.push(Buffer.from(chunk));
        const target = this.child.stdin;
        if (!target || target.destroyed) { done(); return; }
        // An engine that went away mid-write is the fail-safe's or the exit's business, never a write error.
        target.write(chunk, () => done());
      },
      final: (done) => { this.stdinEnded = true; this.child.stdin?.end(); done(); },
    });
    this.child = this.attach(spawnFn(wrapped.command, wrapped.args, options));
    // systemd-run becomes the engine (same process) once its scope exists; still systemd-run after STUCK_MS: stuck.
    this.stuckTimer = setTimeout(() => {
      this.stuckTimer = null;
      const pid = this.child.pid;
      if (!this.wrappedNow || this.spoke || !pid) return;
      let comm = "";
      try { comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return; }
      if (comm === "systemd-run") this.fallBack(`systemd-run did not start the engine within ${STUCK_MS} ms`, true);
    }, STUCK_MS);
    this.stuckTimer.unref?.();
  }

  get pid() { return this.child.pid; }
  get killed() { return this.stopped || this.child.killed; }
  kill(signal: NodeJS.Signals | number = "SIGTERM") { this.stopped = true; return this.child.kill(signal); }
  ref() { this.child.ref?.(); }
  unref() { this.child.unref?.(); }

  private canFallBack() {
    return this.wrappedNow && !this.spoke && !this.stopped && !this.signal?.aborted && Date.now() - this.startedAt < FIRST_MS;
  }

  private attach(child: ChildProcess) {
    child.stdin?.on("error", () => undefined);
    child.stdout?.on("data", (data: Buffer) => {
      if (child !== this.child) return;
      if (!this.spoke) {
        this.spoke = true;
        this.kept = [];
        for (const piece of this.heldErr.splice(0)) this.stderr.write(piece);
      }
      this.stdout.write(data);
    });
    child.stderr?.on("data", (data: Buffer) => {
      if (child !== this.child) return;
      if (this.wrappedNow && !this.spoke) this.heldErr.push(data);
      else this.stderr.write(data);
    });
    child.on("spawn", () => { if (child === this.child) this.emit("spawn"); });
    child.on("error", (error: Error) => {
      if (child !== this.child) return;
      if (this.canFallBack() || (this.wrappedNow && !this.spoke && !this.stopped && !this.signal?.aborted)) { this.fallBack(`could not start systemd-run: ${error.message}`); return; }
      this.emit("error", error);
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (child !== this.child) return;
      if (this.canFallBack()) { this.fallBack(`the wrapped engine ended (${code ?? signal}) before it said anything${this.heldErr.length ? `: ${Buffer.concat(this.heldErr).toString("utf8").trim().slice(0, 160)}` : ""}`); return; }
      // Said nothing and ended later: what it wrote to stderr is the engine's own (shown as it would be).
      for (const piece of this.heldErr.splice(0)) this.stderr.write(piece);
      this.exitCode = code; this.signalCode = signal;
      this.emit("exit", code, signal);
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (child !== this.child) return;
      if (this.stuckTimer) { clearTimeout(this.stuckTimer); this.stuckTimer = null; }
      this.stdout.end(); this.stderr.end();
      this.emit("close", code, signal);
    });
    return child;
  }

  private fallBack(reason: string, killStuck = false) {
    const failed = this.child;
    this.wrappedNow = false;
    if (this.stuckTimer) { clearTimeout(this.stuckTimer); this.stuckTimer = null; }
    engineScope.disable(reason);
    this.heldErr = [];
    const kept = this.kept.splice(0);
    this.child = this.attach(this.spawnFn(this.plain.command, this.plain.args, this.options));
    if (killStuck) try { failed.kill("SIGKILL"); } catch { /* gone */ }
    for (const piece of kept) this.child.stdin?.write(piece);
    if (this.stdinEnded) this.child.stdin?.end();
  }
}

/** Writes to /proc and /sys: bounded, never thrown — false where not allowed (read-only, gone, another user's). */
async function boundedWrite(file: string, value: string): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<boolean>((done) => { timer = setTimeout(() => done(false), WRITE_MS); timer.unref?.(); });
  const write = writeFile(file, value).then(() => true, () => false);
  const result = await Promise.race([write, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

/**
 * A gateway starting in the same unit as before ends the engine scopes that unit's previous run left (a service
 * RESTART does not stop scopes bound to it): SIGTERM, then SIGKILL after `graceMs`. Only scopes named after this
 * very unit; nothing when the gateway has no unit of its own.
 */
export async function sweepEngineScopes(owner: string | null = engineScope.owner, graceMs = 3_000, base?: string): Promise<number> {
  if (!owner) return 0;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const root = base ?? (uid === null ? null : `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`);
  if (!root) return 0;
  const prefix = `${SCOPE_PREFIX}${ownerTag(owner)}-`;
  const scopes = (await readdir(root).catch(() => [] as string[])).filter((name) => name.startsWith(prefix) && name.endsWith(".scope"));
  const pids: number[] = [];
  for (const scope of scopes) for (const pid of (await readFile(join(root, scope, "cgroup.procs"), "utf8").catch(() => "")).split(/\s+/).filter(Boolean).map(Number)) pids.push(pid);
  const signal = (name: NodeJS.Signals) => { for (const pid of pids) { try { process.kill(pid, name); } catch { /* gone */ } } };
  signal("SIGTERM");
  if (pids.length) {
    await new Promise((done) => setTimeout(done, graceMs));
    signal("SIGKILL");
  }
  return pids.length;
}

/** The cgroup folder of a process, when it is one of our engine scopes (else null). */
export async function engineCgroup(pid: number): Promise<string | null> {
  const line = await readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => "");
  const path = /^0::(\/.*)$/m.exec(line)?.[1];
  if (!path || !path.split("/").at(-1)!.startsWith(SCOPE_PREFIX)) return null;
  return `/sys/fs/cgroup${path}`;
}

/** Linux: an engine process is taken before the gateway when the kernel must kill something. */
export async function raiseOomScore(pids: readonly number[]): Promise<number> {
  let raised = 0;
  for (const pid of pids) {
    const now = Number((await readFile(`/proc/${pid}/oom_score_adj`, "utf8").catch(() => "")).trim());
    if (!Number.isFinite(now) || now >= ENGINE_OOM_SCORE) continue;
    if (await boundedWrite(`/proc/${pid}/oom_score_adj`, String(ENGINE_OOM_SCORE))) raised++;
  }
  return raised;
}

/**
 * Under pressure (rung 4): ask the kernel to move up to `bytes` of this engine's memory to swap. The engine keeps
 * running (slower when it touches what moved). Returns how much its scope's memory went down, or null when the
 * engine is not in a scope of ours or the system refused.
 */
export async function reclaimEngine(pid: number, bytes: number): Promise<number | null> {
  const cgroup = await engineCgroup(pid);
  if (!cgroup) return null;
  const current = async () => Number((await readFile(`${cgroup}/memory.current`, "utf8").catch(() => "")).trim());
  const before = await current();
  if (!Number.isFinite(before) || before <= 0) return null;
  // Bounded: at most half of what it holds, at most 1 GiB per ask.
  const ask = Math.max(0, Math.min(Math.floor(bytes), Math.floor(before / 2), 1024 ** 3));
  if (!ask) return 0;
  // The kernel answers EAGAIN when it could not reclaim all of it; what it did reclaim stays reclaimed.
  await boundedWrite(`${cgroup}/memory.reclaim`, String(ask));
  const after = await current();
  return Number.isFinite(after) ? Math.max(0, before - after) : null;
}
