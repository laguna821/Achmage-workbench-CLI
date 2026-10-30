// The isolated stage the real desktop app runs on for app-e2e: a private GTK Broadway display (no
// window ever reaches the user's Wayland desktop), a private D-Bus session without service
// activation (the app's single-instance check never finds a running Workbench, notifications and
// portals go nowhere), temporary data folders (the gateway's WORKBENCH_DATA_DIR, the shell's WebKit
// storage under XDG_DATA_HOME), and stand-ins for the desktop's openers first on PATH. The user's
// HOME stays, so the installed engines are found and signed in as usual. Only processes started
// here are stopped, and the temporary folders are removed at the end.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, closeSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebDriver, sleep } from "./webdriver.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

export type Engines = "real" | "stand-in";

export type Tools = { tauriDriver: string; webkitDriver: string };

/** Where the harness finds its drivers (overridable for other machines). */
export function findTools(): Tools {
  const tauriDriver = process.env.APP_E2E_TAURI_DRIVER ?? join(homedir(), ".cargo/bin/tauri-driver");
  const webkitDriver = process.env.APP_E2E_WEBKIT_DRIVER ?? join(homedir(), ".local/opt/webkit-webdriver/WebKitWebDriver");
  for (const [name, path] of [
    ["tauri-driver (cargo install tauri-driver --locked)", tauriDriver],
    ["WebKitWebDriver (see docs/app-e2e.md)", webkitDriver],
  ] as const) {
    if (!existsSync(path)) throw new Error(`${name} not found at ${path}`);
  }
  for (const command of ["broadwayd", "dbus-run-session", "cc", "pkg-config"]) {
    if (spawnSync("sh", ["-c", `command -v ${command}`]).status !== 0) throw new Error(`${command} not found on PATH`);
  }
  return { tauriDriver, webkitDriver };
}

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

/** GTK uses abstract UNIX sockets on Linux: they have no filesystem entry. */
async function acceptsConnection(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

/** Every process below `root` (children, grandchildren…), read from /proc. */
export function descendants(root: number): number[] {
  const parents = new Map<number, number[]>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const list = parents.get(ppid) ?? [];
      list.push(Number(entry));
      parents.set(ppid, list);
    } catch {
      // Gone meanwhile.
    }
  }
  const out: number[] = [];
  const walk = (pid: number) => {
    for (const child of parents.get(pid) ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

const processStamp = (pid: number) => {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
    return fields[0] === "Z" ? null : fields[19] ?? null;
  } catch {
    return null;
  }
};

/** Normal shutdown of this harness's children only; preserve data and report if one lingers. */
async function stopTree(child: ChildProcess, graceMs = 6000) {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  const tree = new Map([pid, ...descendants(pid)].map((target) => [target, processStamp(target)]));
  const stillOwned = (target: number, stamp: string | null) => stamp !== null && processStamp(target) === stamp;
  for (const [target, stamp] of tree) {
    if (!stillOwned(target, stamp)) continue;
    try {
      process.kill(target, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  const end = Date.now() + graceMs;
  while (Date.now() < end && [...tree].some(([target, stamp]) => stillOwned(target, stamp))) await sleep(100);
  const lingering = [...tree].filter(([target, stamp]) => stillOwned(target, stamp)).map(([target]) => target);
  if (lingering.length) throw new Error(`Harness children did not stop normally: ${lingering.join(", ")}. Temporary files retained.`);
}

const BUS_CONFIG = `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <!-- A private session bus without any service directories: nothing is activated on it. -->
  <type>session</type>
  <keep_umask/>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`;

const OPENERS = ["xdg-open", "gio", "gnome-open", "kde-open", "kde-open5", "wslview"];

export type Stage = {
  root: string;
  runtimeDir: string;
  outDir: string;
  display: string;
  broadwayPort: number;
  /** Temporary X11 server only for the legacy Electron document renderer. */
  x11?: { display: string; authority: string };
  printDialog?: boolean;
  privateKeyring?: boolean;
  tools: Tools;
  /** JSON lines written by the opener stand-ins. */
  openLog: string;
  launch: (options: LaunchOptions) => Promise<AppRun>;
  close: () => Promise<void>;
};

export type LaunchOptions = {
  name: string;
  binary: string;
  engines: Engines;
  /** Named temporary profile shared across app restarts within this stage only. */
  profile?: string;
  freshPort?: boolean;
  /** A vault to offer (a temporary fixture); otherwise none is suggested, never the user's. */
  vault?: string | null;
  window?: { width: number; height: number };
};

export type AppRun = {
  name: string;
  wd: WebDriver;
  dataDir: string;
  gateway: { url: string; token: string };
  capabilities: Record<string, unknown>;
  driverLog: string;
  api: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  close: () => Promise<void>;
};

/** Build the stage: temp root, DPI module, bus config, opener stand-ins, a Broadway display. */
export async function openStage(outDir: string, options: { legacyOffice?: boolean; printDialog?: boolean; privateKeyring?: boolean } = {}): Promise<Stage> {
  const tools = findTools();
  const root = mkdtempSync("/tmp/wb-app-e2e-");
  const started: ChildProcess[] = [];
  const keyringPassword = options.privateKeyring ? randomBytes(32).toString("base64") : undefined;
  const runtimeDir = join(root, "runtime");
  mkdirSync(runtimeDir, { mode: 0o700 });
  try {

  // GTK module that gives the Broadway screen a resolution (see dpi.c).
  const dpiModule = join(root, "libwb-dpi.so");
  const cflags = spawnSync("pkg-config", ["--cflags", "--libs", "gtk+-3.0"], { encoding: "utf8" }).stdout.trim().split(/\s+/);
  const built = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", dpiModule, join(here, "dpi.c"), ...cflags], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(`building the DPI module failed: ${built.stderr}`);

  const busConfig = join(root, "bus.conf");
  writeFileSync(busConfig, BUS_CONFIG);

  const shimDir = join(root, "openers");
  mkdirSync(shimDir);
  for (const name of OPENERS) {
    const path = join(shimDir, name);
    writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(here, "opener-shim.cjs"))} ${name} "$@"\n`);
    chmodSync(path, 0o755);
  }
  const openLog = join(root, "openers.jsonl");
  writeFileSync(openLog, "");

  // A display number nobody uses (other checks pick :100–:1099), and its HTTP port on loopback.
  let number = 0;
  for (let attempt = 0; attempt < 200 && !number; attempt += 1) {
    const candidate = 1200 + Math.floor(Math.random() * 800);
    if (!existsSync(join(runtimeDir, `broadway${candidate + 1}.socket`))) number = candidate;
  }
  if (!number) throw new Error("no free Broadway display number");
  const display = `:${number}`;
  const broadwayPort = await freePort();
  const broadwayLog = openSync(join(outDir, "broadwayd.log"), "w");
  const broadway = spawn("broadwayd", ["--address", "127.0.0.1", "--port", String(broadwayPort), display], { env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir }, stdio: ["ignore", broadwayLog, broadwayLog] });
  broadway.on("error", () => undefined);
  closeSync(broadwayLog);
  started.push(broadway);
  const socket = join(runtimeDir, `broadway${number + 1}.socket`);
  for (let waited = 0; !(await acceptsConnection(socket)) && !(await acceptsConnection(`\0${socket}`)); waited += 50) {
    if (waited > 8000 || broadway.exitCode !== null) throw new Error(`broadwayd ${display} did not start (see broadwayd.log)`);
    await sleep(50);
  }

  const runs: AppRun[] = [];
  let x11: Stage["x11"];
  if (options.legacyOffice) {
    const xvfb = process.env.APP_E2E_XVFB ?? "Xvfb";
    let xNumber = 0;
    for (let attempt = 0; attempt < 200 && !xNumber; attempt += 1) {
      const candidate = 2200 + Math.floor(Math.random() * 800);
      if (!existsSync(`/tmp/.X11-unix/X${candidate}`) && !existsSync(`/tmp/.X${candidate}-lock`)) xNumber = candidate;
    }
    if (!xNumber) throw new Error("no free private X11 display number");
    const authority = join(runtimeDir, "Xauthority"), display = `:${xNumber}`;
    writeFileSync(authority, "", { mode: 0o600 });
    const auth = spawnSync("xauth", ["-f", authority, "add", display, ".", randomBytes(16).toString("hex")], { encoding: "utf8" });
    if (auth.status !== 0) throw new Error(`private Xauthority setup failed: ${auth.stderr}`);
    const log = openSync(join(outDir, "xvfb.log"), "w");
    const server = spawn(xvfb, [display, "-screen", "0", "1920x1200x24", "-nolisten", "tcp", "-noreset", "-auth", authority], { stdio: ["ignore", log, log] });
    let launchError: Error | null = null;
    server.on("error", (error) => { launchError = error; });
    closeSync(log); started.push(server);
    for (let waited = 0; !await acceptsConnection(`/tmp/.X11-unix/X${xNumber}`); waited += 50) {
      if (launchError || waited > 8000 || server.exitCode !== null) throw new Error(`Private Xvfb did not start (set APP_E2E_XVFB; see xvfb.log): ${launchError ?? ""}`);
      await sleep(50);
    }
    x11 = { display, authority };
  }
  const stage: Stage = {
    root,
    runtimeDir,
    outDir,
    display,
    broadwayPort,
    x11,
    printDialog: options.printDialog,
    privateKeyring: options.privateKeyring,
    tools,
    openLog,
    async launch(options) {
      const run = await launchApp({ stage, options, dpiModule, busConfig, shimDir, started, keyringPassword });
      runs.push(run);
      return run;
    },
    async close() {
      const results = await Promise.allSettled(runs.splice(0).map((run) => run.close()));
      for (const child of started.splice(0).reverse()) results.push(await stopTree(child).then(() => ({ status: "fulfilled" as const, value: undefined }), (reason: unknown) => ({ status: "rejected" as const, reason })));
      const errors = results.filter((result) => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map((error) => error.reason), `Stage did not stop; retained ${root}`);
      rmSync(root, { recursive: true, force: true });
    },
  };
  return stage;
  } catch (error) {
    const stopped = await Promise.allSettled(started.map((child) => stopTree(child)));
    if (stopped.every((result) => result.status === "fulfilled")) rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function launchApp(input: { stage: Stage; options: LaunchOptions; dpiModule: string; busConfig: string; shimDir: string; started: ChildProcess[]; keyringPassword?: string | undefined }): Promise<AppRun> {
  const { stage, options, dpiModule, busConfig, shimDir, started } = input;
  if (options.profile && !/^[a-z0-9-]{1,40}$/.test(options.profile)) throw new Error("Invalid temporary profile name");
  const dir = options.profile ? join(stage.root, `profile-${options.profile}`) : mkdtempSync(join(stage.root, `${options.name}-`));
  mkdirSync(dir, { recursive: true });
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(18).toString("base64url");
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Nothing started under the harness can reach the user's compositor or session bus.
  for (const key of ["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE", "GNOME_KEYRING_CONTROL", "GNOME_KEYRING_PID"]) delete env[key];
  Object.assign(env, {
    GDK_BACKEND: "broadway",
    XDG_RUNTIME_DIR: stage.runtimeDir,
    BROADWAY_DISPLAY: stage.display,
    GTK_MODULES: [dpiModule, process.env.GTK_MODULES].filter(Boolean).join(":"),
    NO_AT_BRIDGE: "1",
    // The shell's WebKit storage ($XDG_DATA_HOME/kr.achmage.workbench) and caches: temporary.
    XDG_DATA_HOME: join(dir, "xdg-data"),
    XDG_CONFIG_HOME: join(dir, "xdg-config"),
    XDG_CACHE_HOME: join(dir, "xdg-cache"),
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_TOKEN: token,
    // Offer only the fixture vault, never the user's own.
    WORKBENCH_VAULT_SUGGEST: options.vault ?? "",
    // Claude Code must not update itself into the temporary data folder.
    DISABLE_AUTOUPDATER: "1",
    PATH: [shimDir, process.env.PATH].filter(Boolean).join(delimiter),
    APP_E2E_OPEN_LOG: stage.openLog,
    APP_E2E_REAL_PATH: process.env.PATH ?? "",
    APP_E2E_REAL_XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? "",
  });
  if (stage.x11) Object.assign(env, { DISPLAY: stage.x11.display, XAUTHORITY: stage.x11.authority, XDG_SESSION_TYPE: "x11", ELECTRON_OZONE_PLATFORM_HINT: "x11" });
  if (stage.printDialog) env.APP_E2E_PRINT_PROBE_DIR = stage.outDir;
  if (options.engines === "stand-in") {
    env.WORKBENCH_CODEX_BIN = join(repo, "scripts/fixtures/fake-codex.mjs");
    env.WORKBENCH_CLAUDE_BIN = join(repo, "scripts/fixtures/fake-claude.mjs");
  }
  if (options.freshPort) env.WORKBENCH_PORT = "0";

  const driverPort = await freePort();
  const nativePort = await freePort();
  const driverLog = join(stage.outDir, `${options.name}-driver.log`);
  const log = openSync(driverLog, "w");
  const driverArgs = [stage.tools.tauriDriver, "--port", String(driverPort), "--native-port", String(nativePort), "--native-driver", stage.tools.webkitDriver];
  if (stage.privateKeyring) {
    // GNOME falls back to a real HOME keyring unless this directory already exists.
    mkdirSync(join(env.XDG_DATA_HOME!, "keyrings"), { recursive: true, mode: 0o700 });
    mkdirSync(env.XDG_CONFIG_HOME!, { recursive: true, mode: 0o700 });
    driverArgs.unshift(process.execPath, join(here, "keyring-driver.ts"));
  }
  const driver = spawn(
    "dbus-run-session",
    ["--config-file", busConfig, "--", ...driverArgs],
    { env, stdio: [stage.privateKeyring ? "pipe" : "ignore", log, log] },
  );
  if (stage.privateKeyring) driver.stdin!.end(input.keyringPassword);
  closeSync(log);
  started.push(driver);
  const wd = new WebDriver(`http://127.0.0.1:${driverPort}`);
  for (let waited = 0; ; waited += 100) {
    const ok = await wd.status().then(
      () => true,
      () => false,
    );
    if (ok) break;
    if (waited > 15_000 || driver.exitCode !== null) throw new Error(`tauri-driver did not start (see ${driverLog})`);
    await sleep(100);
  }
  const capabilities = await wd.start({ "tauri:options": { application: options.binary } });
  // The window opens on the gateway's address (its token is taken off the address by the page).
  let origin = "";
  for (let waited = 0; !origin; waited += 200) {
    const url = await wd.url().catch(() => "");
    if (url.startsWith("http://127.0.0.1:")) origin = new URL(url).origin;
    else if (waited > 30_000) throw new Error(`the app window did not open the gateway (url: ${url || "none"})`);
    else await sleep(200);
  }
  if (options.window) await wd.setWindowRect(options.window);
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  let closed = false;
  return {
    name: options.name,
    wd,
    dataDir,
    gateway: { url: origin, token },
    capabilities,
    driverLog,
    api,
    async close() {
      if (closed) return;
      closed = true;
      // The page's own error reports, kept next to the driver log before the data folder goes.
      const clientLog = join(dataDir, "client.log");
      if (existsSync(clientLog)) writeFileSync(join(stage.outDir, `${options.name}-client.log`), readFileSync(clientLog));
      await wd.quit().catch(() => undefined);
      await stopTree(driver);
      const index = started.indexOf(driver);
      if (index >= 0) started.splice(index, 1);
      if (!options.profile) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The opener stand-ins' records so far. */
export function openRecords(stage: Stage): { at: number; opener: string; args: string[]; target: string | null; exists: boolean; mime: string | null; application: string | null; parent: string | null }[] {
  return readFileSync(stage.openLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
