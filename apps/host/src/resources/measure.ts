import { constants, freemem, getPriority, setPriority, totalmem, availableParallelism, cpus } from "node:os";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { parseLinuxRss, parseLinuxStat, type EngineSource } from "../app-memory.ts";
import { availableMemory } from "../terminals.ts";
import type { MachineFacts } from "./core.ts";

// What the resource manager reads from the system. All of it is the bundled Node's own (no native module,
// no shell-out): total memory and cores from `os`; memory available now — Linux: MemAvailable, or the
// cgroup's room when the app runs under a memory limit (the same reading terminals use); Windows: the
// physical memory the system reports available (GlobalMemoryStatusEx, close to Task Manager's
// "사용 가능"); macOS: libuv's free-page figure, which leaves out memory macOS would hand back from its
// caches — it reads LOW, so the 자동 limit is cautious there. The engines' process trees are read on Linux
// only (/proc, asynchronous file reads); elsewhere the learned cost stays at its default.

export type Reading = "exact" | "close" | "rough";
export const readingFor = (platform: string): Reading => (platform === "linux" ? "exact" : platform === "win32" ? "close" : "rough");

export function machineFacts(): MachineFacts {
  // A stand-in machine for test gateways and rigs (never set by the app). "@<file>": read from that file at each
  // reading, so a rig can change what memory is free while the gateway runs (the pressure ladder, 0.5.4).
  const standIn = process.env.WORKBENCH_MACHINE;
  if (standIn) {
    try {
      const facts = JSON.parse(standIn.startsWith("@") ? readFileSync(standIn.slice(1), "utf8") : standIn) as MachineFacts;
      if ([facts.totalBytes, facts.availableBytes, facts.cores].every((value) => typeof value === "number" && value > 0)) return facts;
    } catch { /* not a stand-in: the real readings */ }
  }
  const constrained = (process as { constrainedMemory?: () => number }).constrainedMemory?.();
  const total = typeof constrained === "number" && constrained > 0 && constrained < totalmem() ? constrained : totalmem();
  const cores = typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
  return { totalBytes: total, availableBytes: process.platform === "linux" ? availableMemory() : freemem(), cores };
}

/** One engine process with everything under it (Linux). */
export type EngineTree = { source: EngineSource; pid: number; pids: number[]; bytes: number };

const text = (path: string) => readFile(path, "utf8").catch(() => null);

/**
 * Linux: the gateway's engine processes and their trees. A Claude Code process is told by the
 * WORKBENCH_SESSION it was started with (its environment is this user's own); Codex's app-server by its pid.
 */
export async function linuxEngineTrees(gatewayPid: number, engines: readonly EngineSource[]): Promise<EngineTree[]> {
  if (!engines.length) return [];
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const children = new Map<number, number[]>();
  for (const pid of pids) {
    const stat = parseLinuxStat((await text(`/proc/${pid}/stat`)) ?? "");
    if (stat && stat.pid !== stat.ppid) children.set(stat.ppid, [...(children.get(stat.ppid) ?? []), stat.pid]);
  }
  const byMarker = new Map<string, number>();
  if (engines.some((engine) => engine.marker)) {
    for (const pid of children.get(gatewayPid) ?? []) {
      const marker = ((await text(`/proc/${pid}/environ`)) ?? "").split("\0").find((entry) => entry.startsWith("WORKBENCH_SESSION="))?.slice(18);
      if (marker) byMarker.set(marker, pid);
    }
  }
  const trees: EngineTree[] = [];
  for (const source of engines) {
    const root = source.pid ?? (source.marker ? byMarker.get(source.marker) ?? null : null);
    if (root === null) continue;
    const seen: number[] = [], queue = [root];
    while (queue.length) { const pid = queue.pop()!; if (seen.includes(pid)) continue; seen.push(pid); queue.push(...(children.get(pid) ?? [])); }
    let bytes = 0;
    for (const pid of seen) bytes += parseLinuxRss((await text(`/proc/${pid}/status`)) ?? "") ?? 0;
    if (bytes > 0) trees.push({ source, pid: root, pids: seen, bytes });
  }
  return trees;
}

/** The processor priority "뒤에서 도는 작업은 천천히" gives an engine not on screen. */
export const BACKGROUND_PRIORITY = constants.priority.PRIORITY_BELOW_NORMAL;
export const NORMAL_PRIORITY = constants.priority.PRIORITY_NORMAL;

/**
 * Set an engine's priority. Linux: the nice value belongs to each thread, so every thread of every process
 * of the tree is set (processes started later inherit it from their parent's thread). macOS: the process
 * (all its threads); its existing children are not reached, later ones inherit. Windows: the process's
 * priority class; a child started later inherits "below normal", existing children are not reached.
 * Raising a priority back can be refused by the system (Linux without RLIMIT_NICE); the count of refusals
 * is returned and the engine keeps the lower priority until it closes.
 */
export async function applyPriority(platform: string, pids: readonly number[], priority: number): Promise<{ set: number; refused: number }> {
  let set = 0, refused = 0;
  const one = (id: number) => {
    try { if (getPriority(id) !== priority) { setPriority(id, priority); set++; } }
    catch { refused++; }
  };
  for (const pid of pids) {
    if (platform === "linux") {
      const tasks = await readdir(`/proc/${pid}/task`).catch(() => [] as string[]);
      for (const tid of tasks) if (/^\d+$/.test(tid)) one(Number(tid));
    } else one(pid);
  }
  return { set, refused };
}
