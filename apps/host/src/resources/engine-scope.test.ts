import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_OOM_SCORE, SCOPE_PREFIX, engineCgroup, engineScope, probeScope, raiseOomScore, reclaimEngine } from "./engine-scope.ts";

// 0.5.4: engines in scopes of their own (Linux with user scopes). The real thing where this computer has it: a small
// stand-in process started the way an engine is, checked in /proc and /sys/fs/cgroup, then ended by its pid.

afterEach(() => { engineScope.enabled = false; engineScope.capBytes = null; engineScope.owner = null; engineScope.binary = "systemd-run"; engineScope.onDisable = null; });

describe("engine scopes", () => {
  it("off for test gateways and on other systems: engines start exactly as before", async () => {
    expect(process.env.WORKBENCH_ENGINE_SCOPE).toBe("off");
    expect(await probeScope("linux")).toBeNull();
    expect(await probeScope("win32")).toBeNull();
    expect(engineScope.wrap("/bin/engine", ["a", "b"], "s1", true)).toEqual({ command: "/bin/engine", args: ["a", "b"] });
  });
  it("wrapped: systemd-run as a scope of its own, the cap only for a one-conversation engine, the arguments untouched", () => {
    engineScope.enabled = true;
    engineScope.capBytes = 2 * 2 ** 30;
    const claude = engineScope.wrap("/bin/claude", ["--x", "$HOME"], "abc-123", true);
    expect(claude.command).toBe("systemd-run");
    expect(claude.args).toContain("--quiet");
    expect(claude.args).toContain("--expand-environment=no");
    expect(claude.args.find((arg) => arg.startsWith("--unit="))).toMatch(new RegExp(`^--unit=${SCOPE_PREFIX}none-abc-123-[0-9a-f]{8}\\.scope$`));
    engineScope.owner = "achmage-workbench.service";
    const bound = engineScope.wrap("/bin/claude", [], "s", true);
    expect(bound.args).toEqual(expect.arrayContaining(["BindsTo=achmage-workbench.service", "After=achmage-workbench.service"]));
    expect(bound.args.find((arg) => arg.startsWith("--unit="))).toMatch(new RegExp(`^--unit=${SCOPE_PREFIX}achmage_workbench-s-`));
    expect(claude.args).toContain(`MemoryMax=${2 * 2 ** 30}`);
    expect(claude.args).toContain(`MemoryHigh=${Math.floor(2 * 2 ** 30 * 0.9)}`);
    expect(claude.args.slice(claude.args.indexOf("--") + 1)).toEqual(["/bin/claude", "--x", "$HOME"]);
    const codex = engineScope.wrap("/bin/codex", [], "codex", false);
    expect(codex.args.some((arg) => arg.startsWith("MemoryMax="))).toBe(false);
  });
});

describe.runIf(process.platform === "linux")("a real scope on this computer", () => {
  it("same process id and parent, its own scope with the cap, taken before the gateway, gives memory back", async () => {
    const saved = process.env.WORKBENCH_ENGINE_SCOPE;
    delete process.env.WORKBENCH_ENGINE_SCOPE;
    const probe = await probeScope("linux").finally(() => { process.env.WORKBENCH_ENGINE_SCOPE = saved; });
    if (!probe?.systemdRun) { console.log("no user scopes here:", JSON.stringify(probe)); return; }
    engineScope.enabled = true;
    engineScope.capBytes = 256 * 2 ** 20;
    const launch = engineScope.wrap(process.execPath, ["-e", "const b=Buffer.alloc(64*1024*1024,1);process.stdout.write('ready');setInterval(()=>b[0]++,1000)"], "test", true);
    const child = spawn(launch.command, launch.args, { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise((done, fail) => { child.stdout!.once("data", done); child.once("exit", fail); });
      const pid = child.pid!;
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      expect(Number(/^PPid:\s+(\d+)/m.exec(status)![1])).toBe(process.pid);
      const cgroup = await engineCgroup(pid);
      expect(cgroup).toMatch(new RegExp(`/${SCOPE_PREFIX}[A-Za-z0-9_]+-test-[0-9a-f]{8}\\.scope$`));
      expect(Number(readFileSync(`${cgroup}/memory.max`, "utf8"))).toBe(256 * 2 ** 20);
      // Raised to ENGINE_OOM_SCORE when lower (a process started under `choom -n 800`, as test runs are here, keeps its higher score).
      const before = Number(readFileSync(`/proc/${pid}/oom_score_adj`, "utf8"));
      expect(await raiseOomScore([pid])).toBe(before < ENGINE_OOM_SCORE ? 1 : 0);
      expect(Number(readFileSync(`/proc/${pid}/oom_score_adj`, "utf8"))).toBe(Math.max(before, ENGINE_OOM_SCORE));
      expect(await raiseOomScore([pid])).toBe(0);
      const given = await reclaimEngine(pid, 32 * 2 ** 20);
      expect(given).not.toBeNull();
      // The gateway itself is never in an engine scope: nothing to reclaim from it.
      expect(await reclaimEngine(process.pid, 1)).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});
