import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import type { AppMemory, EngineMemory } from "@workbench/contracts";

// What the app uses now (0.5.1): the resident memory of the gateway, of every process it started that
// is still alive, and of the app's window with the web view's processes. Read only when the window asks
// (`GET /api/memory`), at most once in 30 s, with asynchronous file reads or one child process — never
// on the event loop's own time. Only sums leave this file: no process name, path or command line. The
// engines (0.5.3 B1) are named by their conversations' titles, which the window shows anyway.

/** An engine as its adapter knows it: its conversations (with titles), its process id or the WORKBENCH_SESSION it was started with. */
export type EngineSource = { provider: "claude" | "codex"; sessions: { id: string; title: string }[]; pid: number | null; marker: string | null; idle: boolean };

/**
 * Each engine's memory: its process with everything under it (MCP servers, hooks). A Claude Code process
 * is told by the WORKBENCH_SESSION it was started with (`markerOf`, read for the gateway's own children);
 * Codex's app-server by its pid. Null bytes when its process is not in the table.
 */
export function engineMemory(rows: readonly ProcessRow[], gatewayPid: number, engines: readonly EngineSource[], markerOf: (pid: number) => string | null): EngineMemory[] {
  const children = new Map<number, number[]>();
  for (const row of rows) if (row.pid !== row.ppid) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const bytes = new Map(rows.map((row) => [row.pid, row.bytes ?? 0]));
  const byMarker = new Map<string, number>();
  for (const pid of children.get(gatewayPid) ?? []) { const marker = markerOf(pid); if (marker) byMarker.set(marker, pid); }
  const tree = (root: number) => {
    let total = 0;
    const queue = [root], seen = new Set<number>();
    while (queue.length) { const pid = queue.pop()!; if (seen.has(pid)) continue; seen.add(pid); total += bytes.get(pid) ?? 0; queue.push(...(children.get(pid) ?? [])); }
    return total;
  };
  return engines.map((engine) => {
    const pid = engine.pid ?? (engine.marker ? byMarker.get(engine.marker) ?? null : null);
    return { provider: engine.provider, sessions: engine.sessions, bytes: pid !== null && bytes.has(pid) ? tree(pid) : null, idle: engine.idle };
  });
}

/** One process of the system's table. `exe` is its program's path where the system tells it. */
export type ProcessRow = { pid: number; ppid: number; exe: string | null; bytes: number | null; started?: number };
export type AppParts = { window: number[]; tools: number[]; gateway: number[] };

/** `/proc/<pid>/stat`: "pid (name) state ppid …" — the name may hold spaces and brackets, so read after its last ")". */
export function parseLinuxStat(text: string): { pid: number; ppid: number } | null {
  const close = text.lastIndexOf(")");
  const pid = Number.parseInt(text, 10);
  const ppid = close < 0 ? NaN : Number(text.slice(close + 1).trim().split(/\s+/)[1]);
  return Number.isInteger(pid) && Number.isInteger(ppid) ? { pid, ppid } : null;
}
const kbLine = (text: string, name: string) => {
  const found = new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text);
  return found ? Number(found[1]) * 1024 : null;
};
/** `/proc/<pid>/smaps_rollup`: the proportional share (shared pages divided among the processes that map them), in bytes. */
export const parseLinuxPss = (text: string) => kbLine(text, "Pss");
/** `/proc/<pid>/status`: the resident set, in bytes (a kernel thread has none). */
export const parseLinuxRss = (text: string) => kbLine(text, "VmRSS");

/** macOS `ps -axo pid,ppid,rss,comm`: rss in KiB; the program's path is the rest of the line (it may hold spaces). */
export function parsePsTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const found = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (found) rows.push({ pid: Number(found[1]), ppid: Number(found[2]), bytes: Number(found[3]) * 1024, exe: found[4]! });
  }
  return rows;
}

/** The one PowerShell call on Windows: a line per process — id, parent, working set (bytes), start (file time), program. */
export const WINDOWS_TABLE_SCRIPT = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,CreationDate,ExecutablePath | ForEach-Object {
  $started = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }
  "$($_.ProcessId)\`t$($_.ParentProcessId)\`t$($_.WorkingSetSize)\`t$started\`t$($_.ExecutablePath)"
}`;
export function parseWindowsTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, bytes, started, exe] = line.split("\t");
    if (!/^\d+$/.test(pid ?? "") || !/^\d+$/.test(ppid ?? "") || !/^\d+$/.test(bytes ?? "")) continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), bytes: Number(bytes), ...(Number(started) > 0 ? { started: Number(started) } : {}), exe: exe?.trim() || null });
  }
  return rows;
}

/**
 * The three parts of a process table:
 * - the gateway: the process `gatewayPid`;
 * - the tools: everything under it by parent chain (engine CLIs, document tools, the search worker, exports —
 *   and the app's own program when the gateway runs it as a terminal or a font list);
 * - the window: every other process whose program is the app's (`appBin`), with everything under those.
 * Null when the gateway is not in the table, no app program is named, or no window is found: a sum without
 * the window is not the app's memory.
 */
export function appParts(rows: readonly ProcessRow[], gatewayPid: number, appBin: string | null | undefined, options: { ignoreCase?: boolean } = {}): AppParts | null {
  if (!appBin) return null;
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  if (!byPid.has(gatewayPid)) return null;
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const parent = byPid.get(row.ppid);
    // A process id is used again on Windows: a "parent" that started after its child is someone else.
    if (!parent || row.pid === row.ppid || (parent.started !== undefined && row.started !== undefined && parent.started > row.started)) continue;
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  }
  const under = (roots: number[], stop: ReadonlySet<number>) => {
    const seen = new Set<number>();
    const queue = [...roots];
    while (queue.length) {
      const pid = queue.pop()!;
      if (seen.has(pid) || stop.has(pid)) continue;
      seen.add(pid);
      queue.push(...(children.get(pid) ?? []));
    }
    return seen;
  };
  const gatewayTree = under([gatewayPid], new Set());
  const fold = (path: string) => (options.ignoreCase ? path.toLowerCase() : path);
  const wanted = fold(appBin);
  // Linux names a program that an update replaced while it runs "<path> (deleted)".
  const isApp = (exe: string | null) => exe !== null && fold(exe.replace(/ \(deleted\)$/, "")) === wanted;
  const window = under(rows.filter((row) => isApp(row.exe) && !gatewayTree.has(row.pid)).map((row) => row.pid), gatewayTree);
  if (!window.size) return null;
  const sorted = (pids: Iterable<number>) => [...pids].sort((a, b) => a - b);
  gatewayTree.delete(gatewayPid);
  return { window: sorted(window), tools: sorted(gatewayTree), gateway: [gatewayPid] };
}

export function sumParts(rows: readonly ProcessRow[], parts: AppParts, measure: "pss" | "rss" | "mixed", at: number): Extract<AppMemory, { known: true }> {
  const bytes = new Map(rows.map((row) => [row.pid, row.bytes ?? 0]));
  const sum = (pids: number[]) => pids.reduce((total, pid) => total + (bytes.get(pid) ?? 0), 0);
  const windowBytes = sum(parts.window), toolsBytes = sum(parts.tools), gatewayBytes = sum(parts.gateway);
  return { known: true, totalBytes: windowBytes + toolsBytes + gatewayBytes, windowBytes, toolsBytes, gatewayBytes, measure, at };
}

const text = (path: string) => readFile(path, "utf8").catch(() => null);
/** In small batches: the reads go to the thread pool, a handful at a time. */
async function each<T, R>(items: readonly T[], work: (item: T) => Promise<R>, batch = 16): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += batch) results.push(...await Promise.all(items.slice(start, start + batch).map(work)));
  return results;
}

/** Linux: the table from /proc (parent, program), then the memory of the app's processes only. */
async function readLinux(gatewayPid: number, appBin: string | null, engines: () => EngineSource[]): Promise<AppMemory> {
  // An AppImage's program runs from inside its mount, and the path named here is the image: its window
  // cannot be told by that path, so no number is given.
  if (!appBin || (process.env.APPIMAGE && process.env.APPIMAGE === appBin)) return { known: false };
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const table = (await each(pids, async (pid): Promise<ProcessRow | null> => {
    const stat = parseLinuxStat((await text(`/proc/${pid}/stat`)) ?? "");
    return stat ? { ...stat, exe: await readlink(`/proc/${pid}/exe`).catch(() => null), bytes: null } : null;
  })).filter((row): row is ProcessRow => row !== null);
  const parts = appParts(table, gatewayPid, appBin);
  if (!parts) return { known: false };
  let pss = 0, rss = 0;
  const measured = await each([...parts.window, ...parts.tools, ...parts.gateway], async (pid): Promise<ProcessRow> => {
    const share = parseLinuxPss((await text(`/proc/${pid}/smaps_rollup`)) ?? "");
    if (share !== null) { pss++; return { pid, ppid: 0, exe: null, bytes: share }; }
    const resident = parseLinuxRss((await text(`/proc/${pid}/status`)) ?? "");
    if (resident !== null) rss++;
    return { pid, ppid: 0, exe: null, bytes: resident };
  });
  const memory = sumParts(measured, parts, rss === 0 ? "pss" : pss === 0 ? "rss" : "mixed", Date.now());
  const alive = engines();
  if (!alive.length) return memory;
  // The session variable of the gateway's own children (an engine's environment is this user's own).
  const markers = new Map<number, string | null>();
  await each(table.filter((row) => row.ppid === gatewayPid), async (row) => {
    const environ = (await text(`/proc/${row.pid}/environ`)) ?? "";
    markers.set(row.pid, environ.split("\0").find((entry) => entry.startsWith("WORKBENCH_SESSION="))?.slice(18) ?? null);
  });
  const sized = new Map(measured.map((row) => [row.pid, row.bytes]));
  return { ...memory, engines: engineMemory(table.map((row) => ({ ...row, bytes: sized.get(row.pid) ?? null })), gatewayPid, alive, (pid) => markers.get(pid) ?? null) };
}

const run = (file: string, args: string[]) => new Promise<string>((done, fail) => {
  execFile(file, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 20_000, windowsHide: true }, (error, stdout) => (error ? fail(error) : done(stdout)));
});

async function readTable(platform: string, gatewayPid: number, appBin: string | null, engines: () => EngineSource[] = () => []): Promise<AppMemory> {
  if (platform === "linux") return readLinux(gatewayPid, appBin, engines);
  if (platform === "darwin") {
    // On macOS the web view's processes are started by launchd, not by the app: parent chains do not
    // reach them, so the window's part would be far too low. A number that is known to be wrong is
    // not shown (the readout stays away) until those processes can be told apart. The table reader
    // and its parser are kept for that day (parsePsTable, appParts).
    void parsePsTable; void run;
    return { known: false };
  }
  if (platform === "win32") {
    const rows = parseWindowsTable(await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_TABLE_SCRIPT, "utf16le").toString("base64")]));
    const parts = appParts(rows, gatewayPid, appBin, { ignoreCase: true });
    if (!parts) return { known: false };
    const memory = sumParts(rows, parts, "rss", Date.now());
    const alive = engines();
    // No process environment here: a Claude Code process cannot be told apart (bytes null); Codex's by its pid.
    return alive.length ? { ...memory, engines: engineMemory(rows, gatewayPid, alive, () => null) } : memory;
  }
  return { known: false };
}

/** A read is kept this long on every system (the Windows one is slow). */
export const MEMORY_CACHE_MS = 30_000;

export class AppMemoryReader {
  private readonly source: () => Promise<AppMemory>;
  private last: { at: number; value: AppMemory } | null = null;
  private pending: Promise<AppMemory> | null = null;

  constructor(options: { platform?: string; appBin?: string | null; gatewayPid?: number; read?: () => Promise<AppMemory>; engines?: () => EngineSource[] } = {}) {
    const appBin = options.appBin === undefined ? process.env.WORKBENCH_APP_BIN || null : options.appBin;
    this.source = options.read ?? (() => readTable(options.platform ?? process.platform, options.gatewayPid ?? process.pid, appBin, options.engines));
  }

  /** The next read is a new one (engines were just closed). */
  forget() { this.last = null; }

  /** The last read when it is younger than 30 s; else one new read, shared by everyone who asks meanwhile. A read that fails is "not known". */
  read(): Promise<AppMemory> {
    if (this.last && Date.now() - this.last.at < MEMORY_CACHE_MS) return Promise.resolve(this.last.value);
    this.pending ??= this.source().catch((): AppMemory => ({ known: false })).then((value) => {
      this.last = { at: Date.now(), value };
      this.pending = null;
      return value;
    });
    return this.pending;
  }
}
