import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * A window that said where it is (0.5.4): the shell runs `workbench-service start|attach --desktop` to
 * reach the gateway, and that command's parent is the window's process. Its id is kept in the data folder
 * (`windows.json`), with when it started where the system tells it (Linux), so a process id used again
 * later is not taken for the window. This is how the window is found when its program's path cannot tell
 * it — an AppImage: each start of the image runs from a mount of its own (/tmp/.mount_*), and the gateway
 * of the login service names the image file, not the program the window runs.
 */
export type WindowRecord = { pid: number; started: number | null };
export const WINDOW_RECORDS = "windows.json";
const MAX_WINDOW_RECORDS = 8;

const validRecords = (value: unknown): WindowRecord[] => (Array.isArray(value) ? value : [])
  .filter((entry): entry is WindowRecord => !!entry && Number.isSafeInteger(entry.pid) && entry.pid > 1 && (entry.started === null || Number.isSafeInteger(entry.started)))
  .map((entry) => ({ pid: entry.pid, started: entry.started }));

export async function readWindowRecords(dataDir: string | null): Promise<WindowRecord[]> {
  if (!dataDir) return [];
  try { return validRecords(JSON.parse(await readFile(join(dataDir, WINDOW_RECORDS), "utf8"))); } catch { return []; }
}

/** When a process started, where the system tells it (Linux /proc); null elsewhere. */
export function processStarted(pid: number, platform: string = process.platform): number | null {
  if (platform !== "linux") return null;
  try { return parseLinuxStat(readFileSync(`/proc/${pid}/stat`, "utf8"))?.started ?? null; } catch { return null; }
}

const aliveNow = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/**
 * The service command run by the window (`--desktop`) records its parent: the window. Records of
 * processes that have gone (or whose id now names another process) are dropped; at most a few are kept.
 * Never fails the command: a record that cannot be written only leaves the readout without a number.
 */
export function recordWindow(dataDir: string, pid: number, platform: string = process.platform): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    let kept: WindowRecord[] = [];
    try { kept = validRecords(JSON.parse(readFileSync(join(dataDir, WINDOW_RECORDS), "utf8"))); } catch { /* none yet */ }
    const started = processStarted(pid, platform);
    const seen = new Set<number>([pid]);
    kept = kept.filter((entry) => !seen.has(entry.pid) && seen.add(entry.pid) && aliveNow(entry.pid) && (entry.started === null || processStarted(entry.pid, platform) === entry.started));
    kept = [...kept, { pid, started }].slice(-MAX_WINDOW_RECORDS);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // Written beside and renamed over (node built-ins only: the release check runs this file as it is).
    const file = join(dataDir, WINDOW_RECORDS), temporary = `${file}.${process.pid}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(kept), { mode: 0o600 }); renameSync(temporary, file); }
    catch (error) { rmSync(temporary, { force: true }); throw error; }
  } catch { /* the readout says "not known" instead */ }
}

/**
 * `/proc/<pid>/stat`: "pid (name) state ppid …" — the name may hold spaces and brackets, so read after its
 * last ")". Field 22, when the line has it: when the process started (clock ticks since boot), which tells
 * a process id used again apart from the one that was recorded.
 */
export function parseLinuxStat(text: string): { pid: number; ppid: number; started?: number } | null {
  const close = text.lastIndexOf(")");
  const pid = Number.parseInt(text, 10);
  const fields = close < 0 ? [] : text.slice(close + 1).trim().split(/\s+/);
  const ppid = close < 0 ? NaN : Number(fields[1]);
  const started = /^\d+$/.test(fields[19] ?? "") ? Number(fields[19]) : null;
  return Number.isInteger(pid) && Number.isInteger(ppid) ? { pid, ppid, ...(started !== null ? { started } : {}) } : null;
}
const kbLine = (text: string, name: string) => {
  const found = new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text);
  return found ? Number(found[1]) * 1024 : null;
};
/** `/proc/<pid>/smaps_rollup`: the proportional share (shared pages divided among the processes that map them), in bytes. */
export const parseLinuxPss = (text: string) => kbLine(text, "Pss");
/** `/proc/<pid>/status`: the resident set, in bytes (a kernel thread has none). */
export const parseLinuxRss = (text: string) => kbLine(text, "VmRSS");

/**
 * macOS `ps -axww -o pid=,ppid=,rss=,comm=` (ps(1): `=` leaves the header out, `-ww` any width — without it
 * ps cuts lines at 79 columns when its output is not a terminal): rss in KiB (1024-byte units); the
 * program's path is the rest of the line (it may hold spaces). A header line, if any, is not a row.
 */
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
 * - the window: every other process whose program is the app's (`appBin`), and every recorded window
 *   (`windows`, 0.5.4) still alive under the same start, with everything under those; with them, the
 *   gateway's own parent when it is the app's program (its launcher: `--host-runtime`, or the window that
 *   started it) — told by `appBin`, or, from an AppImage, by its program inside the gateway's own mount
 *   (`appDir`, the APPDIR the launcher handed on).
 * `image`: `appBin` is an AppImage file (the gateway of the login service there): no process runs THE
 * window from that path — only the image's own mount helpers do — so the window is found by the records
 * alone.
 * Null when the gateway is not in the table, no app program is named, or no window is found (the launcher
 * alone is not a window): a sum without the window is not the app's memory.
 */
export function appParts(rows: readonly ProcessRow[], gatewayPid: number, appBin: string | null | undefined, options: { ignoreCase?: boolean; windows?: readonly WindowRecord[]; appDir?: string | null; image?: boolean } = {}): AppParts | null {
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
  const byPath = options.image ? [] : rows.filter((row) => isApp(row.exe) && !gatewayTree.has(row.pid)).map((row) => row.pid);
  const recorded = (options.windows ?? []).filter((entry) => {
    const row = byPid.get(entry.pid);
    return row && !gatewayTree.has(entry.pid) && (entry.started === null || row.started === undefined || row.started === entry.started);
  }).map((entry) => entry.pid);
  if (!byPath.length && !recorded.length) return null;
  const mount = options.appDir ? fold(options.appDir.replace(/[\\/]+$/, "")) : null;
  const launcher = byPid.get(byPid.get(gatewayPid)!.ppid);
  const ofApp = launcher && launcher.pid !== gatewayPid && !gatewayTree.has(launcher.pid) && launcher.exe !== null
    && (isApp(launcher.exe) || (mount !== null && fold(launcher.exe).startsWith(`${mount}/`)));
  const window = under([...byPath, ...recorded, ...(ofApp ? [launcher.pid] : [])], gatewayTree);
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

/** Where the window is looked for besides the app's program path (0.5.4). */
export type WindowHints = { windows: readonly WindowRecord[]; appDir: string | null; image: boolean };

/**
 * Linux: the table from /proc (parent, program, start), then the memory of the app's processes only.
 * From an AppImage (0.5.4) the program runs from inside a mount of each start's own, and the gateway of the
 * login service names the image file: the window is then the recorded one (`windows.json`) with its tree,
 * and the gateway's launcher is told by its program inside the gateway's own mount (APPDIR).
 */
async function readLinux(gatewayPid: number, appBin: string | null, engines: () => EngineSource[], hints: WindowHints): Promise<AppMemory> {
  if (!appBin) return { known: false };
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const table = (await each(pids, async (pid): Promise<ProcessRow | null> => {
    const stat = parseLinuxStat((await text(`/proc/${pid}/stat`)) ?? "");
    return stat ? { ...stat, exe: await readlink(`/proc/${pid}/exe`).catch(() => null), bytes: null } : null;
  })).filter((row): row is ProcessRow => row !== null);
  const parts = appParts(table, gatewayPid, appBin, hints);
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

const run = (file: string, args: string[], limits: { maxBuffer: number; timeout: number } = { maxBuffer: 16 * 1024 * 1024, timeout: 20_000 }) => new Promise<string>((done, fail) => {
  execFile(file, args, { encoding: "utf8", ...limits, windowsHide: true }, (error, stdout) => (error ? fail(error) : done(stdout)));
});

/** macOS: the one `ps` call (argv only, no shell): a few seconds at most, a few MB of output at most. */
export const MAC_PS_ARGS = ["-axww", "-o", "pid=,ppid=,rss=,comm="];

/** The system's process table as rows with their memory (macOS: ps RSS; Windows: the working set). Linux reads /proc in readLinux. */
export async function readProcessTable(platform: string): Promise<ProcessRow[]> {
  if (platform === "darwin") return parsePsTable(await run("/bin/ps", MAC_PS_ARGS, { maxBuffer: 4 * 1024 * 1024, timeout: 5_000 }));
  if (platform === "win32") return parseWindowsTable(await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_TABLE_SCRIPT, "utf16le").toString("base64")]));
  throw new Error(`no process table reader for ${platform}`);
}

/**
 * macOS and Windows: the answer from one process table with its memory (ps RSS / the working set).
 * macOS (0.5.4): the app (its window process), the gateway's launcher, the gateway and everything it started,
 * by parent chains, as on Linux. The web view's page processes (WKWebView's WebContent) are started by
 * launchd for the system, not by the app, and `ps` cannot tell whose they are: they are left out, and the
 * answer says so (`pagesLeftOut`) rather than pretending a total. `ps` gives the resident set (RSS), not
 * the "memory footprint" Activity Monitor shows: measure "rss".
 * Windows: WebView2's processes are the app's children; the working set is measure "rss". Paths without case.
 * Neither system hands out another process's environment here: a Claude Code process cannot be told apart
 * (its bytes null); Codex's app-server by its pid.
 */
export function memoryFromTable(platform: "darwin" | "win32", rows: readonly ProcessRow[], gatewayPid: number, appBin: string | null, engines: () => EngineSource[], hints: WindowHints, at = Date.now()): AppMemory {
  const parts = appParts(rows, gatewayPid, appBin, { ignoreCase: platform === "win32", windows: hints.windows });
  if (!parts) return { known: false };
  const memory = { ...sumParts(rows, parts, "rss", at), ...(platform === "darwin" ? { pagesLeftOut: true as const } : {}) };
  const alive = engines();
  return alive.length ? { ...memory, engines: engineMemory(rows, gatewayPid, alive, () => null) } : memory;
}

async function readTable(platform: string, gatewayPid: number, appBin: string | null, engines: () => EngineSource[] = () => [], hints: WindowHints = { windows: [], appDir: null, image: false }): Promise<AppMemory> {
  if (platform === "linux") return readLinux(gatewayPid, appBin, engines, hints);
  if ((platform === "darwin" || platform === "win32") && appBin) return memoryFromTable(platform, await readProcessTable(platform), gatewayPid, appBin, engines, hints);
  return { known: false };
}

/** A read is kept this long on every system (the Windows one is slow). */
export const MEMORY_CACHE_MS = 30_000;

export class AppMemoryReader {
  private readonly source: () => Promise<AppMemory>;
  private last: { at: number; value: AppMemory } | null = null;
  private pending: Promise<AppMemory> | null = null;

  /**
   * `dataDir`: where the window records itself (default WORKBENCH_DATA_DIR); `windows` instead reads the
   * records from elsewhere (the release check). `appDir`: the gateway's AppImage mount (default APPDIR);
   * `image`: the app's program named is an AppImage file (default: it is $APPIMAGE or ends in .AppImage).
   */
  constructor(options: { platform?: string; appBin?: string | null; gatewayPid?: number; read?: () => Promise<AppMemory>; engines?: () => EngineSource[]; dataDir?: string | null; windows?: () => Promise<WindowRecord[]>; appDir?: string | null; image?: boolean } = {}) {
    const appBin = options.appBin === undefined ? process.env.WORKBENCH_APP_BIN || null : options.appBin;
    const dataDir = options.dataDir === undefined ? process.env.WORKBENCH_DATA_DIR || null : options.dataDir;
    const appDir = options.appDir === undefined ? process.env.APPDIR || null : options.appDir;
    const image = options.image ?? (!!appBin && ((!!process.env.APPIMAGE && process.env.APPIMAGE === appBin) || /\.appimage$/i.test(appBin)));
    const windows = options.windows ?? (() => readWindowRecords(dataDir));
    this.source = options.read ?? (async () => readTable(options.platform ?? process.platform, options.gatewayPid ?? process.pid, appBin, options.engines, { windows: await windows(), appDir, image }));
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
