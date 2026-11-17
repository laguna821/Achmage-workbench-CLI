import { spawn } from "node:child_process";
import { getPriority } from "node:os";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BACKGROUND_PRIORITY, NORMAL_PRIORITY, applyPriority, linuxEngineTrees, machineFacts } from "./measure.ts";

// The readings and the lower priority, on this computer (Linux runs the tree parts; elsewhere they are skipped).
const linux = process.platform === "linux";

describe("machine facts", () => {
  it("total, available and cores from the bundled Node (or the stand-in machine)", () => {
    const facts = machineFacts();
    expect(facts.totalBytes).toBeGreaterThan(0);
    expect(facts.availableBytes).toBeGreaterThan(0);
    expect(facts.cores).toBeGreaterThanOrEqual(1);
  });
});

describe.runIf(linux)("an engine's tree (Linux)", () => {
  it("is found by WORKBENCH_SESSION under the gateway, measured with its children, and lowered thread by thread", async () => {
    // A stand-in engine: a node process with a child, started with the marker the Claude adapter gives.
    let pids: number[] = [];
    const engine = spawn(process.execPath, ["-e", "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)"], { env: { ...process.env, WORKBENCH_SESSION: "s-engine" }, stdio: "ignore" });
    try {
      await new Promise((done) => setTimeout(done, 400));
      const [tree] = await linuxEngineTrees(process.pid, [{ provider: "claude", sessions: [{ id: "s-engine", title: "대화" }], pid: null, marker: "s-engine", idle: false }]);
      pids = tree?.pids ?? [];
      expect(tree?.pid).toBe(engine.pid);
      expect(tree!.pids.length).toBe(2);
      expect(tree!.bytes).toBeGreaterThan(10 * 1024 * 1024);
      const lowered = await applyPriority("linux", tree!.pids, BACKGROUND_PRIORITY);
      expect(lowered.refused).toBe(0);
      for (const pid of tree!.pids) for (const tid of readdirSync(`/proc/${pid}/task`)) expect(getPriority(Number(tid))).toBe(BACKGROUND_PRIORITY);
      // Back to normal: allowed only where the system lets this user raise a priority (RLIMIT_NICE); said, never thrown.
      const back = await applyPriority("linux", tree!.pids, NORMAL_PRIORITY);
      expect(back.set + back.refused).toBeGreaterThan(0);
    } finally {
      // Every process this test started, by PID (the child too).
      for (const pid of [engine.pid!, ...pids]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  });
});
