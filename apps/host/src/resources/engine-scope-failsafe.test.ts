import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FIRST_MS, STUCK_MS, engineCgroup, engineScope, ownUnit, probeScope, raiseOomScore, reclaimEngine, spawnEngine, sweepEngineScopes } from "./engine-scope.ts";

// The coordinator's safety pass (0.5.4): the scope wrapper must never take an engine down, nor change what it sees.
// Wrapper stand-ins (a file named systemd-run) for the failures; the real systemd-run where this computer has it.

let dir = "";
const engine = () => join(dir, "engine.mjs");
// An engine stand-in: says "ready" at once, echoes every line it is given, reports SIGINT and ends with 7 on it.
const ENGINE = `import tty from "node:tty"; import fs from "node:fs";
process.stdout.write("ready\\n");
let buffer = "";
process.stdin.on("data", (data) => { buffer += data; let at; while ((at = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
  if (line === "inspect") process.stdout.write(JSON.stringify({ env: process.env, cwd: process.cwd(), tty: [0, 1, 2].map((fd) => tty.isatty(fd)), pid: process.pid, ppid: process.ppid, comm: fs.readFileSync("/proc/self/comm", "utf8").trim() }) + "\\n");
  else process.stdout.write("echo:" + line + "\\n"); } });
process.stdin.on("end", () => process.exit(0));
process.on("SIGINT", () => { process.stderr.write("got SIGINT\\n"); process.exit(7); });
`;
const wrapper = (name: string, body: string) => {
  const folder = join(dir, name); mkdirSync(folder, { recursive: true });
  const file = join(folder, "systemd-run");
  writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755);
  return file;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wb-scope-failsafe-"));
  writeFileSync(engine(), ENGINE);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => { engineScope.enabled = false; engineScope.binary = "systemd-run"; engineScope.owner = null; engineScope.disabledReason = null; engineScope.onDisable = null; engineScope.capBytes = null; vi.restoreAllMocks(); });

type Run = { child: ChildProcessWithoutNullStreams; out: () => string; err: () => string; exits: [number | null, NodeJS.Signals | null][]; errors: Error[] };
function run(env: NodeJS.ProcessEnv = process.env, cwd?: string): Run {
  const child = spawnEngine(process.execPath, [engine()], { env, cwd }, "t", true);
  let out = "", err = "";
  const exits: Run["exits"] = [], errors: Error[] = [];
  child.stdout.on("data", (data: Buffer) => { out += data; });
  child.stderr.on("data", (data: Buffer) => { err += data; });
  child.on("exit", (code, signal) => exits.push([code, signal]));
  child.on("error", (error) => errors.push(error));
  return { child, out: () => out, err: () => err, exits, errors };
}
const settle = async (test: () => boolean, ms = 15_000) => { await vi.waitFor(() => expect(test()).toBe(true), { timeout: ms, interval: 20 }); };

describe("fail-safe start (the wrapper never fails a turn)", () => {
  const cases: [string, () => string][] = [
    ["(a) the wrapper cannot be started at all", () => join(dir, "missing", "systemd-run")],
    ["(b) the wrapper exits 1 at once, complaining on stderr", () => wrapper("b", `echo "Failed to connect to user scope bus" >&2\nexit 1`)],
    ["(c) the wrapper starts, then ends in 200 ms", () => wrapper("c", "sleep 0.2\nexit 0")],
    ["(d) systemd-run hangs (never becomes the engine)", () => wrapper("d", "sleep 30")],
  ];
  for (const [name, make] of cases) {
    it(`${name}: started once more without it, what was written arrives, one log line, wrapping off for the run`, async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const told = vi.fn();
      engineScope.enabled = true; engineScope.binary = make(); engineScope.onDisable = told;
      const started = Date.now();
      const engine = run();
      // Written before anything came back (as the SDK writes its first request at once).
      engine.child.stdin.write("first\n");
      await settle(() => engine.out().includes("echo:first"), STUCK_MS + 10_000);
      expect(engine.out().startsWith("ready\n")).toBe(true);
      // The wrapper's own complaint never reaches the engine's stderr reader; no error, no exit seen by the caller.
      expect(engine.err()).toBe("");
      expect(engine.errors).toEqual([]);
      expect(engine.exits).toEqual([]);
      expect(log.mock.calls.filter(([line]) => String(line).startsWith("WB_ENGINE_SCOPE_OFF "))).toHaveLength(1);
      expect(engineScope.enabled).toBe(false);
      expect(told).toHaveBeenCalledTimes(1);
      engine.child.stdin.write("second\n");
      await settle(() => engine.out().includes("echo:second"));
      engine.child.stdin.end();
      await settle(() => engine.exits.length === 1);
      expect(engine.exits).toEqual([[0, null]]);
      // The next engine starts plainly, with no wrapper and no second log line.
      const next = run();
      next.child.stdin.end("x\n");
      await settle(() => next.exits.length === 1);
      expect(next.out()).toBe("ready\necho:x\n");
      expect(log.mock.calls.filter(([line]) => String(line).startsWith("WB_ENGINE_SCOPE_OFF "))).toHaveLength(1);
      if (name.startsWith("(d)")) expect(Date.now() - started).toBeGreaterThanOrEqual(STUCK_MS);
    }, 30_000);
  }
  it("a working wrapper (it becomes the engine): no fall-back, nothing logged, wrapping stays on", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    engineScope.enabled = true;
    engineScope.binary = wrapper("ok", `while [ "$1" != "--" ]; do shift; done; shift; exec "$@"`);
    const engine = run();
    engine.child.stdin.end("hello\n");
    await settle(() => engine.exits.length === 1);
    expect(engine.out()).toBe("ready\necho:hello\n");
    expect(engine.exits).toEqual([[0, null]]);
    expect(log).not.toHaveBeenCalled();
    expect(engineScope.enabled).toBe(true);
  });
  it("an engine stopped by the caller during its first seconds is not started again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    engineScope.enabled = true;
    engineScope.binary = wrapper("slow", "sleep 1\nexit 0");
    const engine = run();
    engine.child.kill("SIGTERM");
    await settle(() => engine.exits.length === 1);
    expect(engineScope.enabled).toBe(true);
    expect(engine.out()).toBe("");
  });
  it("the first seconds are short (a slow engine that later ends is not taken for a wrapper failure)", () => {
    expect(FIRST_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("bounded writes to /proc and /sys never throw into a turn", () => {
  it("oom_score_adj: a process that is gone, or not ours (pid 1): skipped quietly", async () => {
    await expect(raiseOomScore([2 ** 22 + 12345, 1])).resolves.toBe(0);
  });
  it("memory.reclaim: not an engine scope, or gone: null, quietly", async () => {
    await expect(reclaimEngine(1, 1024)).resolves.toBeNull();
    await expect(reclaimEngine(2 ** 22 + 12345, 1024)).resolves.toBeNull();
  });
});

describe.runIf(process.platform === "linux")("under the real conditions of this computer", () => {
  const moduleFile = fileURLToPath(new URL("./engine-scope.ts", import.meta.url));
  // A user unit's environment: no DBUS_SESSION_BUS_ADDRESS, no display, HOME USER LOGNAME PATH (+ XDG_RUNTIME_DIR).
  const bare = (withRuntime: boolean): NodeJS.ProcessEnv => ({
    HOME: process.env.HOME, USER: process.env.USER ?? "user", LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "user", PATH: "/usr/local/bin:/usr/bin:/bin",
    ...(withRuntime && process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
  });
  const inBare = (withRuntime: boolean) => new Promise<{ probe: unknown; probeMs: number; out?: string; code?: number | null; offLines: number }>((done, fail) => {
    const code = `
      const m = await import(${JSON.stringify(moduleFile)});
      let offLines = 0; const write = console.error; console.error = (line) => { if (String(line).startsWith("WB_ENGINE_SCOPE_OFF")) offLines++; };
      const t0 = Date.now(); const probe = await m.probeScope("linux", process.env); const probeMs = Date.now() - t0;
      if (!probe?.systemdRun) { process.stdout.write(JSON.stringify({ probe, probeMs, offLines })); process.exit(0); }
      m.engineScope.enabled = true;
      const child = m.spawnEngine("/bin/sh", ["-c", "echo started in $(basename $(sed -n 's/^0:://p' /proc/self/cgroup))"], { env: process.env }, "bare", true);
      let out = ""; child.stdout.on("data", (d) => { out += d; });
      child.on("close", (exit) => { process.stdout.write(JSON.stringify({ probe, probeMs, out, code: exit, offLines })); });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: bare(withRuntime), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
    child.on("close", () => { try { done(JSON.parse(out)); } catch { fail(new Error(`no answer: ${out} ${err}`)); } });
  });
  it("a user unit's bare environment WITH XDG_RUNTIME_DIR: detected, and a wrapped start runs in its own scope", async () => {
    const result = await inBare(true);
    if (!(result.probe as { systemdRun?: boolean } | null)?.systemdRun) { console.log("no user scopes here:", JSON.stringify(result)); return; }
    expect(result.out).toMatch(/^started in workbench-engine-[A-Za-z0-9_]+-bare-[0-9a-f]{8}\.scope\n$/);
    expect(result.code).toBe(0);
    expect(result.offLines).toBe(0);
  }, 20_000);
  it("WITHOUT XDG_RUNTIME_DIR: \"cannot\", quickly, no hang", async () => {
    const result = await inBare(false);
    expect((result.probe as { systemdRun: boolean }).systemdRun).toBe(false);
    expect(result.probeMs).toBeLessThan(2_000);
  }, 20_000);

  it("the real wrapper changes nothing the engine sees: environment (but systemd's INVOCATION_ID), cwd, pipes not a tty, no added output; signals reach the engine itself; exit code passed through", async () => {
    const saved = process.env.WORKBENCH_ENGINE_SCOPE;
    delete process.env.WORKBENCH_ENGINE_SCOPE;
    const probe = await probeScope("linux").finally(() => { process.env.WORKBENCH_ENGINE_SCOPE = saved; });
    if (!probe?.systemdRun) { console.log("no user scopes here:", JSON.stringify(probe)); return; }
    engineScope.enabled = true;
    const log = vi.spyOn(console, "error");
    const env = { ...process.env, WB_MARK: "같은 환경 $HOME %h" };
    const cwd = mkdtempSync(join(dir, "cwd-"));
    const plain = spawn(process.execPath, [engine()], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let plainOut = ""; plain.stdout.on("data", (d) => { plainOut += d; });
    plain.stdin.end("inspect\n");
    await settle(() => plainOut.split("\n").length >= 3);
    const wrapped = run(env, cwd);
    wrapped.child.stdin.write("inspect\n");
    await settle(() => wrapped.out().split("\n").length >= 3);
    const seen = JSON.parse(wrapped.out().split("\n")[1]!), before = JSON.parse(plainOut.split("\n")[1]!);
    // systemd gives each unit its own INVOCATION_ID (set, or replaced when the gateway already had one).
    const { INVOCATION_ID: _added, ...seenEnv } = seen.env as Record<string, string>;
    const { INVOCATION_ID: _had, ...beforeEnv } = before.env as Record<string, string>;
    expect(seenEnv).toEqual(beforeEnv);
    expect(seen.env.WB_MARK).toBe("같은 환경 $HOME %h");
    expect(seen.cwd).toBe(cwd);
    expect(seen.tty).toEqual([false, false, false]);
    // The scope's main process IS the engine: same pid as the caller holds, child of this process, named node.
    expect(seen.pid).toBe(wrapped.child.pid);
    expect(seen.ppid).toBe(process.pid);
    expect(seen.comm).toBe(before.comm);
    expect(await engineCgroup(seen.pid)).toMatch(/\/workbench-engine-[^/]+\.scope$/);
    // Nothing of systemd-run's on stderr ("Running as unit: …" is kept off by --quiet).
    expect(wrapped.err()).toBe("");
    wrapped.child.kill("SIGINT");
    await settle(() => wrapped.exits.length === 1);
    expect(wrapped.exits).toEqual([[7, null]]);
    expect(wrapped.err()).toBe("got SIGINT\n");
    expect(log.mock.calls.filter(([line]) => String(line).startsWith("WB_ENGINE_SCOPE_OFF"))).toHaveLength(0);
  }, 30_000);

  it("a gateway starting again in the same unit ends the engine scopes its previous run left", async () => {
    const saved = process.env.WORKBENCH_ENGINE_SCOPE;
    delete process.env.WORKBENCH_ENGINE_SCOPE;
    const probe = await probeScope("linux").finally(() => { process.env.WORKBENCH_ENGINE_SCOPE = saved; });
    if (!probe?.systemdRun || !engineScope.owner) { console.log("no user scopes / own unit here"); return; }
    expect(engineScope.owner).toBe(ownUnit());
    // A unit name of its own for this test (other tests of this run start engines under the same unit at the same time).
    engineScope.owner = "app.slice";
    engineScope.enabled = true;
    // The worst case: an engine that ignores the end of its input and SIGHUP.
    const stubborn = spawnEngine(process.execPath, ["-e", "process.on('SIGHUP',()=>{}); process.stdout.write('up'); process.stdin.resume(); setInterval(()=>{},1000)"], { env: process.env }, "left", false);
    await new Promise((done) => stubborn.stdout.once("data", done));
    const pid = stubborn.pid!;
    expect(await engineCgroup(pid)).not.toBeNull();
    stubborn.unref();
    expect(await sweepEngineScopes(engineScope.owner, 500)).toBe(1);
    await settle(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    // Another unit's scopes are never touched.
    expect(await sweepEngineScopes("someone-else.service", 10)).toBe(0);
  }, 30_000);
});
