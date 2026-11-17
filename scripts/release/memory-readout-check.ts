// The memory readout on the system this runs on (0.5.4), for the release workflow's first-run job on
// Windows and macOS (it also runs on Linux): the process table is read the way the gateway reads it
// (Windows: one PowerShell Get-CimInstance call; macOS: one ps call; Linux: /proc) and summed into the
// readout's parts. This process stands in for the gateway; a node child started here for an engine (by
// its pid, as Codex's app-server is told) with a grandchild under it; the shell that runs this script for
// the window, recorded as `workbench-service --desktop` records the real window (its parent).
// Only numbers are written: no process name, path or command line.
// Usage: node scripts/release/memory-readout-check.ts [result.json]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AppMemoryReader, type EngineSource } from "../../apps/host/src/app-memory.ts";

const output = process.argv[2];
const fail = (message: string): never => { console.error(`memory readout: ${message}`); process.exit(1); };

const engine = spawn(process.execPath, ["-e", "const{spawn}=require('node:child_process');spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{stdio:'ignore'});setTimeout(()=>{},120000)"], { stdio: "ignore", windowsHide: true });
const engines = (): EngineSource[] => [
  { provider: "codex", sessions: [{ id: "check", title: "확인" }], pid: engine.pid ?? null, marker: null, idle: true },
  // Claude Code is told by its session variable, which only Linux can read: off Linux its bytes are null.
  { provider: "claude", sessions: [{ id: "other", title: "다른 대화" }], pid: null, marker: "no-such-session", idle: true },
];
try {
  await new Promise((done) => setTimeout(done, 1500));
  const started = Date.now();
  const memory = await new AppMemoryReader({
    // No process runs this path: the window is the recorded one alone.
    appBin: join(tmpdir(), "no-such-app", process.platform === "win32" ? "achmage-workbench.exe" : "achmage-workbench"),
    image: false, appDir: null, engines,
    windows: async () => [{ pid: process.ppid, started: null }],
  }).read();
  const tookMs = Date.now() - started;
  if (!memory.known) fail(`not known on ${process.platform} (the table could not be read, or the gateway or the recorded window is not in it)`);
  if (!memory.known) throw new Error("unreachable");
  const result = {
    platform: process.platform, tookMs, measure: memory.measure, pagesLeftOut: memory.pagesLeftOut ?? false,
    totalBytes: memory.totalBytes, windowBytes: memory.windowBytes, toolsBytes: memory.toolsBytes, gatewayBytes: memory.gatewayBytes,
    engines: (memory.engines ?? []).map((entry) => ({ provider: entry.provider, sessions: entry.sessions.length, bytes: entry.bytes, idle: entry.idle })),
  };
  console.log(JSON.stringify(result, null, 2));
  if (output) { mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2) + "\n"); }
  if (!(memory.gatewayBytes > 0)) fail("the gateway's own memory is not above 0");
  // A node process alone is tens of MB; RSS counts every process's shared pages in full.
  if (!(memory.toolsBytes > 5 * 1024 * 1024)) fail("the engine stand-in and its child were not counted");
  if (!(memory.windowBytes > 0)) fail("the recorded window was not counted");
  if (memory.totalBytes !== memory.windowBytes + memory.toolsBytes + memory.gatewayBytes) fail("the parts do not add up to the total");
  const expected = process.platform === "linux" ? ["pss", "mixed", "rss"] : ["rss"];
  if (!expected.includes(memory.measure)) fail(`measure ${memory.measure} on ${process.platform}`);
  if ((process.platform === "darwin") !== (memory.pagesLeftOut === true)) fail("pagesLeftOut is said exactly on macOS");
  const [codex, claude] = result.engines;
  if (result.engines.length !== 2 || codex?.provider !== "codex" || claude?.provider !== "claude") fail("the engine list does not parse");
  if (!(typeof codex!.bytes === "number" && codex!.bytes > 5 * 1024 * 1024)) fail("the engine told by its pid has no memory");
  if (claude!.bytes !== null) fail("an engine whose process is not there has a number");
  console.log("memory readout: ok");
} finally {
  engine.kill();
}
