import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppMemoryReader, appParts, parseLinuxPss, parseLinuxRss, parseLinuxStat, parsePsTable, parseWindowsTable, sumParts, type ProcessRow } from "./app-memory.ts";
import { EventBus } from "./bus.ts";
import { createHttpServer } from "./http.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

// 0.5.1 "memline": what the app uses now — the window, what the gateway started, the gateway.
// Fixture process tables only (made-up programs and folders).

const KB = 1024;
afterEach(() => vi.useRealTimers());

describe("Linux: /proc", () => {
  it("reads a process's parent from its stat line, whatever its name holds", () => {
    expect(parseLinuxStat("4321 (node) S 4000 4321 4321 0 -1 4194304 137 0 0 0")).toEqual({ pid: 4321, ppid: 4000 });
    expect(parseLinuxStat("77 (a (b) c) 9) R 1 77 77 0 -1 0")).toEqual({ pid: 77, ppid: 1 });
    expect(parseLinuxStat("")).toBeNull();
    expect(parseLinuxStat("garbage")).toBeNull();
  });

  it("reads the proportional share from smaps_rollup and the resident set from status, in bytes", () => {
    const rollup = "5613b855f000-7fff305f6000 ---p 00000000 00:00 0                          [rollup]\nRss:                2276 kB\nPss:                 197 kB\nPss_Dirty:           104 kB\nPss_Anon:            104 kB\n";
    expect(parseLinuxPss(rollup)).toBe(197 * KB);
    expect(parseLinuxPss("Rss: 5 kB\n")).toBeNull();
    expect(parseLinuxRss("Name:\tnode\nVmPeak:\t  900 kB\nVmRSS:\t   81234 kB\nRssAnon:\t 100 kB\n")).toBe(81234 * KB);
    expect(parseLinuxRss("Name:\tkthreadd\n")).toBeNull();
  });
});

describe("macOS: ps -axo pid,ppid,rss,comm", () => {
  it("reads each row; the program's path may hold spaces; rss is in KiB", () => {
    const table = [
      "  PID  PPID    RSS COMM",
      "    1     0  12345 /sbin/launchd",
      "  500     1 204800 /Applications/Fixture Bench.app/Contents/MacOS/fixture-bench",
      "  610   500  90000 /Applications/Fixture Bench.app/Contents/Resources/node",
      "  700   610 300000 /usr/local/bin/engine",
      "not a row",
      "",
    ].join("\n");
    expect(parsePsTable(table)).toEqual([
      { pid: 1, ppid: 0, bytes: 12345 * KB, exe: "/sbin/launchd" },
      { pid: 500, ppid: 1, bytes: 204800 * KB, exe: "/Applications/Fixture Bench.app/Contents/MacOS/fixture-bench" },
      { pid: 610, ppid: 500, bytes: 90000 * KB, exe: "/Applications/Fixture Bench.app/Contents/Resources/node" },
      { pid: 700, ppid: 610, bytes: 300000 * KB, exe: "/usr/local/bin/engine" },
    ]);
  });

  it("the app's process is the window; the gateway under it and what the gateway started are their own parts", () => {
    const rows = parsePsTable("PID PPID RSS COMM\n1 0 10 /sbin/launchd\n500 1 2000 /Applications/Fixture Bench.app/Contents/MacOS/fixture-bench\n610 500 900 /opt/node\n700 610 3000 /usr/local/bin/engine\n800 1 7000 /Applications/Other.app/Contents/MacOS/other\n");
    const parts = appParts(rows, 610, "/Applications/Fixture Bench.app/Contents/MacOS/fixture-bench")!;
    expect(parts).toEqual({ window: [500], tools: [700], gateway: [610] });
    expect(sumParts(rows, parts, "rss", 5)).toEqual({ known: true, totalBytes: 5900 * KB, windowBytes: 2000 * KB, toolsBytes: 3000 * KB, gatewayBytes: 900 * KB, measure: "rss", at: 5 });
  });
});

describe("Windows: Get-CimInstance Win32_Process", () => {
  // One line per process: id, parent, working set (bytes), start (file time), program.
  const table = [
    "4\t0\t151552\t134000000000000000\t",
    "1200\t800\t95000000\t134000000100000000\tC:\\Program Files\\Fixture Bench\\fixture-bench.exe",
    "1300\t1200\t210000000\t134000000200000000\tC:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\msedgewebview2.exe",
    "1310\t1300\t150000000\t134000000210000000\tC:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\msedgewebview2.exe",
    "1400\t1200\t70000000\t134000000300000000\tC:\\Program Files\\Fixture Bench\\node.exe",
    "1500\t1400\t260000000\t134000000400000000\tC:\\Users\\선생님\\AppData\\Local\\engine\\engine.exe",
    // A process id used again: its "parent" 1500 started after it, so it is not the gateway's.
    "1600\t1500\t999000000\t133000000000000000\tC:\\Windows\\System32\\other.exe",
    "",
  ].join("\r\n");

  it("reads each row, with programs the system does not name and Korean folders", () => {
    const rows = parseWindowsTable(table);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({ pid: 4, ppid: 0, bytes: 151552, started: 134000000000000000, exe: null });
    expect(rows[5]).toEqual({ pid: 1500, ppid: 1400, bytes: 260000000, started: 134000000400000000, exe: "C:\\Users\\선생님\\AppData\\Local\\engine\\engine.exe" });
  });

  it("the window with its web view, the tools, the gateway; the app's path in any letter case; a reused id is nobody's child", () => {
    const rows = parseWindowsTable(table);
    const parts = appParts(rows, 1400, "c:\\program files\\fixture bench\\FIXTURE-BENCH.EXE", { ignoreCase: true })!;
    expect(parts).toEqual({ window: [1200, 1300, 1310], tools: [1500], gateway: [1400] });
    expect(sumParts(rows, parts, "rss", 9)).toMatchObject({ known: true, windowBytes: 455000000, toolsBytes: 260000000, gatewayBytes: 70000000, totalBytes: 785000000 });
  });
});

describe("the three parts", () => {
  const row = (pid: number, ppid: number, exe: string | null, bytes = 1000): ProcessRow => ({ pid, ppid, exe, bytes });
  const APP = "/opt/fixture/bench";

  it("a gateway of the login service: the window is found by the app's program, not by the gateway's parents", () => {
    const rows = [row(1, 0, "/sbin/init"), row(50, 1, APP), row(60, 50, "/opt/fixture/node"), row(61, 60, "/usr/bin/engine"), row(62, 61, "/bin/tool"),
      row(900, 1, APP), row(910, 900, "/usr/lib/webkit/WebProcess"), row(911, 900, "/usr/lib/webkit/NetworkProcess"), row(999, 1, "/usr/bin/unrelated")];
    // 50 is the gateway's launcher (the app's program without a window): it counts with the window's part.
    expect(appParts(rows, 60, APP)).toEqual({ window: [50, 900, 910, 911], tools: [61, 62], gateway: [60] });
  });

  it("the app's program run BY the gateway (a terminal, a font list) is a tool, not a window", () => {
    const rows = [row(1, 0, "/sbin/init"), row(900, 1, APP), row(60, 900, "/opt/fixture/node"), row(70, 60, APP), row(71, 70, "/bin/sh")];
    expect(appParts(rows, 60, APP)).toEqual({ window: [900], tools: [70, 71], gateway: [60] });
  });

  it("a program replaced by an update while it runs is still the app's", () => {
    const rows = [row(1, 0, "/sbin/init"), row(900, 1, `${APP} (deleted)`), row(60, 1, "/opt/fixture/node")];
    expect(appParts(rows, 60, APP)).toEqual({ window: [900], tools: [], gateway: [60] });
  });

  it("no window in the table, no app program named, or no gateway in the table: not known", () => {
    const rows = [row(1, 0, "/sbin/init"), row(60, 1, "/opt/fixture/node"), row(61, 60, "/usr/bin/engine")];
    expect(appParts(rows, 60, APP)).toBeNull();
    expect(appParts([...rows, row(900, 1, APP)], 60, null)).toBeNull();
    expect(appParts([row(900, 1, APP)], 60, APP)).toBeNull();
  });

  it("a parent loop in a broken table ends", () => {
    const rows = [row(60, 61, "/opt/fixture/node"), row(61, 60, "/usr/bin/engine"), row(900, 900, APP)];
    expect(appParts(rows, 60, APP)).toEqual({ window: [900], tools: [61], gateway: [60] });
  });
});

describe("the reader", () => {
  const known = (at: number) => ({ known: true as const, totalBytes: 3, windowBytes: 1, toolsBytes: 1, gatewayBytes: 1, measure: "rss" as const, at });

  it("reads at most once in 30 s, and once for callers that ask together", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    let reads = 0;
    const reader = new AppMemoryReader({ read: async () => known(++reads) });
    const [a, b] = await Promise.all([reader.read(), reader.read()]);
    expect([reads, a, b]).toEqual([1, known(1), known(1)]);
    vi.setSystemTime(1_000_000 + 29_000);
    expect(await reader.read()).toEqual(known(1));
    vi.setSystemTime(1_000_000 + 30_000);
    expect(await reader.read()).toEqual(known(2));
    expect(reads).toBe(2);
  });

  it("a read that fails, and a system it has no reader for, answer not known (and that is cached too)", async () => {
    let reads = 0;
    const failing = new AppMemoryReader({ read: async () => { reads++; throw new Error("no process table"); } });
    expect(await failing.read()).toEqual({ known: false });
    expect(await failing.read()).toEqual({ known: false });
    expect(reads).toBe(1);
    expect(await new AppMemoryReader({ platform: "sunos", appBin: "/opt/fixture/bench" }).read()).toEqual({ known: false });
    expect(await new AppMemoryReader({ platform: "linux", appBin: null }).read()).toEqual({ known: false });
  });

  it.skipIf(process.platform !== "linux")("Linux, against this test process: itself as the gateway, its children as tools, a program outside its tree as the window", async () => {
    // The "app": a copy of sleep under a folder of its own, so no other process on this machine runs that path.
    const dir = mkdtempSync(join(tmpdir(), "wb-memory-app-")), app = join(dir, "sleep");
    copyFileSync(realpathSync("/bin/sleep"), app);
    chmodSync(app, 0o755);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    // The app's program started by this process: a tool. Started by a shell that has gone: outside this tree, the window.
    const inside = spawn(app, ["30"], { stdio: "ignore" });
    const outside = Number(execFileSync("/bin/sh", ["-c", '"$0" 30 >/dev/null 2>&1 & echo $!', app], { encoding: "utf8" }).trim());
    try {
      await new Promise((done) => setTimeout(done, 300));
      const memory = await new AppMemoryReader({ platform: "linux", appBin: app, gatewayPid: process.pid }).read();
      if (!memory.known) throw new Error("not known");
      // This process: its share is not more than its resident set, and not nothing.
      expect(memory.gatewayBytes).toBeGreaterThan(8 * 1024 * 1024);
      expect(memory.gatewayBytes).toBeLessThanOrEqual(process.memoryUsage().rss * 1.2);
      // The node child (tens of MB) with the sleep started here; the one sleep outside this tree alone is the window.
      expect(memory.toolsBytes).toBeGreaterThan(5 * 1024 * 1024);
      expect(memory.windowBytes).toBeGreaterThan(0);
      expect(memory.windowBytes).toBeLessThan(5 * 1024 * 1024);
      expect(memory.totalBytes).toBe(memory.windowBytes + memory.toolsBytes + memory.gatewayBytes);
      expect(["pss", "mixed", "rss"]).toContain(memory.measure);
      // Only numbers (and which measure) leave the reader.
      expect(Object.keys(memory).sort()).toEqual(["at", "gatewayBytes", "known", "measure", "toolsBytes", "totalBytes", "windowBytes"]);
      // Without the window in the table the answer is not a number.
      process.kill(outside, "SIGKILL");
      await new Promise((done) => setTimeout(done, 200));
      expect(await new AppMemoryReader({ platform: "linux", appBin: app, gatewayPid: process.pid }).read()).toEqual({ known: false });
    } finally {
      child.kill("SIGKILL"); inside.kill("SIGKILL");
      try { process.kill(outside, "SIGKILL"); } catch { /* already stopped above */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /api/memory", () => {
  it("answers the reader's numbers to the app's token only, and pushes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-memory-")), store = new Store(join(dir, "state.sqlite")), bus = new EventBus();
    const manager = new SessionManager(store, bus, { hostId: "host", hostLabel: "시험", dataDir: dir, managedWorksDir: join(dir, "works") });
    const seq = bus.currentSeq;
    let reads = 0;
    const answer = { known: true as const, totalBytes: 600, windowBytes: 300, toolsBytes: 200, gatewayBytes: 100, measure: "pss" as const, at: 1 };
    const server = createHttpServer(manager, bus, { token: "fixture-only", webDir: null, memory: new AppMemoryReader({ read: async () => { reads++; return answer; } }) });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("no address");
    try {
      expect(reads).toBe(0); // nothing is read until someone asks
      const url = `http://127.0.0.1:${address.port}/api/memory`;
      expect((await fetch(url)).status).toBe(401);
      const response = await fetch(url, { headers: { authorization: "Bearer fixture-only" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(answer);
      expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer fixture-only" } })).status).not.toBe(200);
      expect(reads).toBe(1);
      expect(bus.currentSeq).toBe(seq);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
});
