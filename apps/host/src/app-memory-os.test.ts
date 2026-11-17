import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppMemoryReader, appParts, MAC_PS_ARGS, memoryFromTable, parseLinuxStat, parsePsTable, parseWindowsTable, readWindowRecords, recordWindow, WINDOW_RECORDS, type ProcessRow } from "./app-memory.ts";

// 0.5.4: the memory readout where the app's program path cannot tell the window (an AppImage), on macOS
// (one `ps` table; the web view's page processes are not the app's children), and the window found by the
// record the shell's service command leaves (`workbench-service … --desktop`: its parent is the window).
// Fixture process tables only (made-up folders); the Linux runs use copied system programs under a temp
// folder made to look like an AppImage's mount.

const KB = 1024;
const row = (pid: number, ppid: number, exe: string | null, bytes = 1000, started?: number): ProcessRow => ({ pid, ppid, exe, bytes, ...(started !== undefined ? { started } : {}) });

describe("Linux /proc/<pid>/stat: when the process started", () => {
  it("field 22 (clock ticks since boot) when the line has it; absent from short lines", () => {
    // A whole line as the kernel writes it (proc(5)), for a process whose name holds a space and a bracket.
    const line = "1255110 (web (x) 2) R 1255109 1255109 1255109 0 -1 4194304 127 0 0 0 0 0 0 0 16 -4 1 0 8880648 7954432 527 18446744073709551615 94380702810112 94380702836785 140726978884784 0 0 0 0 0 0 0 0 0 17 7 0 0 0 0 0 94380702853616 94380702855396 94381599588352 140726978887720 140726978887740 140726978887740 140726978891755 0\n";
    expect(parseLinuxStat(line)).toEqual({ pid: 1255110, ppid: 1255109, started: 8880648 });
    expect(parseLinuxStat("4321 (node) S 4000 4321 4321 0 -1 4194304 137 0 0 0")).toEqual({ pid: 4321, ppid: 4000 });
  });
});

describe("AppImage: the window by its record and the gateway's launcher by its mount, not by a program path", () => {
  // The login service's gateway: started by the launcher (`--host-runtime`) of the image's persistent copy,
  // running from that copy's mount; the copy's own mount helper (its program IS the image file) is the
  // launcher's child. The window: another start of the image the person opened, from a mount of its own.
  const IMAGE = "/home/u/.local/share/achmage-workbench/runtimes/appimage/0f0f/AchmageWorkbench.AppImage";
  const MOUNT_GW = "/tmp/.mount_AchmagAbC123", MOUNT_WIN = "/tmp/.mount_AchmagXyZ789";
  const table = [
    row(1, 0, "/usr/lib/systemd/systemd"), row(900, 1, "/usr/lib/systemd/systemd"),
    row(1000, 900, `${MOUNT_GW}/usr/bin/achmage-workbench`, 9000, 100), // the launcher
    row(1001, 1000, IMAGE, 1500, 101), // the image's mount helper
    row(1010, 1000, `${MOUNT_GW}/usr/lib/achmage-workbench/node/node`, 300000, 102), // the gateway
    row(1020, 1010, "/home/u/.local/bin/claude", 250000, 200), row(1021, 1020, "/usr/bin/python3", 40000, 201),
    row(2000, 900, `${MOUNT_WIN}/usr/bin/achmage-workbench`, 200000, 500), // the window
    row(2001, 2000, "/home/u/Downloads/Achmage.Workbench.AppImage", 1500, 501), // its mount helper (the runtime forks it, then execs the program)
    row(2010, 2000, `${MOUNT_WIN}/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess`, 350000, 510),
    row(2011, 2000, `${MOUNT_WIN}/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess`, 60000, 511),
    row(3000, 900, "/usr/bin/firefox", 900000, 50),
  ];
  const hints = { appDir: MOUNT_GW, image: true };

  it("with the window's record: the window and its web processes, the launcher and the mount helper; the gateway's tree apart", () => {
    const parts = appParts(table, 1010, IMAGE, { ...hints, windows: [{ pid: 2000, started: 500 }] });
    expect(parts).toEqual({ window: [1000, 1001, 2000, 2001, 2010, 2011], tools: [1020, 1021], gateway: [1010] });
  });

  it("without a record (the login service's gateway before any window opened): not known — the launcher and the image's helper are no window", () => {
    expect(appParts(table, 1010, IMAGE, hints)).toBeNull();
    // Before 0.5.4's rule the image path itself would have matched the mount helper and called it the window.
    expect(appParts(table, 1010, IMAGE, { appDir: MOUNT_GW, image: false })).toEqual({ window: [1000, 1001], tools: [1020, 1021], gateway: [1010] });
  });

  it("a record whose process id now names another process (it started at another time) is not the window", () => {
    expect(appParts(table, 1010, IMAGE, { ...hints, windows: [{ pid: 2000, started: 7 }] })).toBeNull();
    expect(appParts(table, 1010, IMAGE, { ...hints, windows: [{ pid: 4242, started: 1 }] })).toBeNull();
  });

  it("the window's own mode: the gateway's parent IS the window, found by its program in the gateway's mount", () => {
    const shell = [row(1, 0, "/sbin/init"), row(2000, 1, `${MOUNT_WIN}/usr/bin/achmage-workbench`), row(2001, 2000, "/home/u/Achmage.AppImage"),
      row(2010, 2000, `${MOUNT_WIN}/usr/lib/webkit/WebKitWebProcess`), row(2020, 2000, `${MOUNT_WIN}/usr/lib/achmage-workbench/node/node`), row(2030, 2020, "/usr/bin/codex")];
    // The window's gateway names the program in the mount (lib.rs: current_exe): found by path, as before.
    expect(appParts(shell, 2020, `${MOUNT_WIN}/usr/bin/achmage-workbench`, { appDir: MOUNT_WIN })).toEqual({ window: [2000, 2001, 2010], tools: [2030], gateway: [2020] });
  });
});

describe("the window's record (workbench-service --desktop)", () => {
  it.skipIf(process.platform !== "linux")("records the parent with its start, drops records of processes that have gone or changed, keeps at most 8", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-windows-"));
    try {
      const gone = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
      const goneId = gone.pid!;
      gone.kill("SIGKILL");
      await new Promise((done) => gone.once("exit", done));
      writeFileSync(join(dir, WINDOW_RECORDS), JSON.stringify([
        { pid: goneId, started: 5 }, { pid: process.pid, started: 1 }, { pid: "x", started: null }, ...Array.from({ length: 12 }, () => ({ pid: process.ppid, started: null })),
      ]));
      recordWindow(dir, process.pid);
      const own = parseLinuxStat(readFileSync(`/proc/${process.pid}/stat`, "utf8"))!.started!;
      const records = await readWindowRecords(dir);
      // The gone one and the stale one (same id, other start) are dropped; this process recorded last with its start.
      expect(records.at(-1)).toEqual({ pid: process.pid, started: own });
      expect(records.some((entry) => entry.pid === goneId)).toBe(false);
      expect(records.length).toBeLessThanOrEqual(8);
      expect(records.filter((entry) => entry.pid === process.pid)).toHaveLength(1);
      // Nothing to read, or garbage: no records.
      writeFileSync(join(dir, WINDOW_RECORDS), "{not json");
      expect(await readWindowRecords(dir)).toEqual([]);
      expect(await readWindowRecords(null)).toEqual([]);
      // A folder that cannot be written does not fail the service command.
      expect(() => recordWindow(join(dir, WINDOW_RECORDS, "below-a-file"), process.pid)).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("Linux, a real process tree laid out as an AppImage's (copied programs under a temp \"mount\")", () => {
  it.skipIf(process.platform !== "linux")("the login service's gateway names the image: not known until the window is recorded, then the parts; gone again when the window goes", async () => {
    // Not a real AppImage (the release build makes one with linuxdeploy, which needs the network): the
    // mounts are folders named as the runtime names them, the programs copies of system ones.
    const root = mkdtempSync(join(tmpdir(), "wb-appimage-"));
    const mountGw = join(root, ".mount_AchmagAbC123"), mountWin = join(root, ".mount_AchmagXyZ789"), data = join(root, "data");
    const image = join(root, "runtimes", "appimage", "0f0f", "AchmageWorkbench.AppImage");
    for (const dir of [join(mountGw, "usr/bin"), join(mountWin, "usr/bin"), join(root, "runtimes/appimage/0f0f"), data]) mkdirSync(dir, { recursive: true });
    const copy = (from: string, to: string) => { copyFileSync(realpathSync(from), to); chmodSync(to, 0o755); };
    copy("/bin/sh", join(mountGw, "usr/bin/achmage-workbench")); // the launcher (a shell, so it can start children)
    copy("/bin/sleep", image); // the image's mount helper
    copy("/bin/sleep", join(mountWin, "usr/bin/achmage-workbench")); // the window
    const gatewayScript = "const {spawn}=require('node:child_process');spawn('/bin/sleep',['60'],{stdio:'ignore'});setInterval(()=>{},1000)";
    const launcher = spawn(join(mountGw, "usr/bin/achmage-workbench"), ["-c", '"$1" 60 & "$2" -e "$3" & echo $!; wait', "launcher", image, process.execPath, gatewayScript], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    let window = 0;
    try {
      const gateway = await new Promise<number>((done, fail) => {
        let text = "";
        launcher.stdout!.on("data", (chunk) => { text += chunk; if (text.includes("\n")) done(Number(text.trim())); });
        launcher.once("exit", () => fail(new Error("the launcher stopped")));
      });
      const reader = () => new AppMemoryReader({ platform: "linux", appBin: image, gatewayPid: gateway, dataDir: data, appDir: mountGw });
      // Wait for the gateway's child and the helper to be there (bounded generously: a busy machine).
      const children = () => readFileSync(`/proc/${gateway}/task/${gateway}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
      for (let tries = 0; tries < 200 && !children().length; tries++) await new Promise((done) => setTimeout(done, 50));
      expect(await reader().read()).toEqual({ known: false });
      window = Number(execFileSync("/bin/sh", ["-c", '"$0" 60 >/dev/null 2>&1 & echo $!', join(mountWin, "usr/bin/achmage-workbench")], { encoding: "utf8" }).trim());
      recordWindow(data, window);
      const memory = await reader().read();
      if (!memory.known) throw new Error("not known with the window recorded");
      // The gateway (node, tens of MB), its child (sleep), the window (sleep) with the launcher (sh) and the helper (sleep).
      expect(memory.gatewayBytes).toBeGreaterThan(5 * 1024 * 1024);
      expect(memory.toolsBytes).toBeGreaterThan(0);
      expect(memory.toolsBytes).toBeLessThan(5 * 1024 * 1024);
      expect(memory.windowBytes).toBeGreaterThan(0);
      expect(memory.windowBytes).toBeLessThan(15 * 1024 * 1024);
      expect(memory.totalBytes).toBe(memory.windowBytes + memory.toolsBytes + memory.gatewayBytes);
      process.kill(window, "SIGKILL");
      for (let tries = 0; tries < 200; tries++) { try { process.kill(window, 0); await new Promise((done) => setTimeout(done, 25)); } catch { break; } }
      expect(await reader().read()).toEqual({ known: false });
    } finally {
      try { process.kill(-launcher.pid!, "SIGKILL"); } catch { /* gone */ }
      try { if (window) process.kill(window, "SIGKILL"); } catch { /* gone */ }
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("macOS: one ps table", () => {
  // ps(1) on macOS: `-o pid=,ppid=,rss=,comm=` — `=` leaves the headers out, numbers right-aligned, rss in
  // 1024-byte units, comm the program as it was started (here full paths, as launchd starts apps). The web
  // view's WebContent and Networking processes are XPC services started by launchd (parent 1).
  const APP = "/Applications/Achmage Workbench.app/Contents/MacOS/achmage-workbench";
  const ps = [
    "    1     0  14896 /sbin/launchd",
    "  512     1 186240 /Applications/Achmage Workbench.app/Contents/MacOS/achmage-workbench",
    "  530     1 241312 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent",
    "  531     1  31200 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking",
    "  640     1  12016 /Applications/Achmage Workbench.app/Contents/MacOS/achmage-workbench",
    "  641   640 301456 /Applications/Achmage Workbench.app/Contents/Resources/node/node",
    "  700   641 262144 /Users/teacher/.local/bin/claude",
    "  701   700  40960 /opt/homebrew/bin/python3",
    "  720   641  92160 /Users/teacher/.local/bin/codex",
    "  800     1 512000 /Applications/Safari.app/Contents/MacOS/Safari",
    "",
  ].join("\n");

  it("the call is argv only, any width, no headers", () => {
    expect(MAC_PS_ARGS).toEqual(["-axww", "-o", "pid=,ppid=,rss=,comm="]);
    expect(parsePsTable(ps)).toHaveLength(10);
    expect(parsePsTable(ps)[1]).toEqual({ pid: 512, ppid: 1, bytes: 186240 * KB, exe: APP });
  });

  it("the app, the launcher, the gateway and what it started — RSS, and saying the page processes are left out", () => {
    const engines = () => [
      { provider: "claude" as const, sessions: [{ id: "a", title: "강의안" }], pid: null, marker: "a", idle: false },
      { provider: "codex" as const, sessions: [{ id: "x", title: "채점" }], pid: 720, marker: null, idle: true },
    ];
    expect(memoryFromTable("darwin", parsePsTable(ps), 641, APP, engines, { windows: [], appDir: null, image: false }, 7)).toEqual({
      known: true, measure: "rss", pagesLeftOut: true, at: 7,
      windowBytes: (186240 + 12016) * KB, toolsBytes: (262144 + 40960 + 92160) * KB, gatewayBytes: 301456 * KB,
      totalBytes: (186240 + 12016 + 262144 + 40960 + 92160 + 301456) * KB,
      // Claude Code's process cannot be told apart from ps alone; Codex's app-server by its pid.
      engines: [
        { provider: "claude", sessions: [{ id: "a", title: "강의안" }], bytes: null, idle: false },
        { provider: "codex", sessions: [{ id: "x", title: "채점" }], bytes: 92160 * KB, idle: true },
      ],
    });
  });

  it("no window in the table: not known", () => {
    const rows = parsePsTable(ps).filter((entry) => entry.pid !== 512 && entry.pid !== 640);
    expect(memoryFromTable("darwin", rows, 641, APP, () => [], { windows: [], appDir: null, image: false })).toEqual({ known: false });
  });
});

describe("Windows: the same table function", () => {
  it("a recorded window counts as on the other systems; nothing is said about page processes (WebView2's are the app's children)", () => {
    const rows = parseWindowsTable([
      "4\t0\t151552\t134000000000000000\t",
      "1200\t800\t95000000\t134000000100000000\tC:\\Users\\선생님\\AppData\\Local\\Achmage Workbench\\achmage-workbench.exe",
      "1300\t1200\t210000000\t134000000200000000\tC:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\msedgewebview2.exe",
      "1400\t1200\t70000000\t134000000300000000\tC:\\Users\\선생님\\AppData\\Local\\Achmage Workbench\\node\\node.exe",
      "",
    ].join("\r\n"));
    const memory = memoryFromTable("win32", rows, 1400, "c:\\users\\선생님\\appdata\\local\\achmage workbench\\ACHMAGE-WORKBENCH.EXE", () => [], { windows: [], appDir: null, image: false }, 3);
    expect(memory).toEqual({ known: true, measure: "rss", at: 3, windowBytes: 305000000, toolsBytes: 0, gatewayBytes: 70000000, totalBytes: 375000000 });
  });
});
