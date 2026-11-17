import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, readFileSync, rmSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { TailscaleView } from "@workbench/contracts";
import { writePrivateFileAtomicSync } from "@workbench/paseo-server-transport/private-files";

/**
 * Tailscale as the road from a phone to this PC (설정 › 휴대폰과 다른 기기 › 테일스케일로 연결).
 *
 * What this module may do: read `tailscale status --json` and `tailscale serve status --json`, and —
 * only while the person's 켜기 stands (until 끄기) — keep ONE foreground child
 * `tailscale serve --https=443 http://127.0.0.1:<device port>` running for as long as the gateway runs.
 * A foreground Serve session lives only as long as that process (tailscaled drops it when the CLI's
 * IPN-bus watcher ends), so nothing persistent is ever written into Tailscale's own configuration.
 * Never Funnel, never `--bg`, never any other Tailscale setting. argv only (no shell); the only
 * variable part is the gateway's own port. The program is looked up only at absolute places (M1).
 *
 * The CLI's JSON shapes and argument forms are written from Tailscale's documentation and source; each
 * is marked "to confirm with the real CLI" in ux/reports/tailscale-report.md.
 */

export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";
/** MagicDNS and HTTPS certificates are both switched on from the admin console's DNS page (kb/1153 names this address). */
export const TAILSCALE_DNS_ADMIN_URL = "https://console.tailscale.com/admin/dns";
/** The HTTPS port Serve listens on in the tailnet: 443 gives an address without a port number. */
export const SERVE_HTTPS_PORT = 443;

export type TailscaleResult = { code: number; stdout: string; stderr: string };
/** Runs the CLI with these arguments; null = there is no `tailscale` program on this PC. Throws TailscaleNotRunnable. */
export type TailscaleRun = (argv: readonly string[]) => Promise<TailscaleResult | null>;
/** Starts the long-running foreground serve; null = there is no `tailscale` program. Throws TailscaleNotRunnable. */
export type TailscaleSpawn = (argv: readonly string[]) => { child: ChildProcess; program: string } | null;

/** The program is there but this user may not run it (EACCES / EPERM): an error, not "not installed". */
export class TailscaleNotRunnable extends Error {
  readonly code = "tailscale_not_runnable";
  readonly file: string;
  constructor(file: string) {
    super(`이 PC의 테일스케일 프로그램(${file.slice(0, 200)})을 실행할 권한이 없습니다. 테일스케일을 다시 설치하거나 그 파일의 권한을 확인한 뒤 다시 확인을 누르세요.`);
    this.file = file;
  }
}

/**
 * Where the CLI is looked for. Windows: only the installer's absolute places under %ProgramFiles% /
 * %ProgramFiles(x86)% from the environment — never a bare name (Windows would look in the current
 * folder first). macOS and Linux: the known absolute places first, the bare name through PATH last.
 * WORKBENCH_TAILSCALE_BIN (the rig's stand-in) is honoured only as an absolute path.
 */
export function tailscaleCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const explicit = env.WORKBENCH_TAILSCALE_BIN?.trim();
  if (explicit) return (platform === "win32" ? win32 : posix).isAbsolute(explicit) ? [explicit] : [];
  if (platform === "win32") {
    const places: string[] = [];
    for (const base of [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"]]) {
      const root = base?.trim();
      // Only a drive-rooted folder (C:\…): a relative or UNC value from the environment is not trusted.
      if (!root || !/^[A-Za-z]:\\/.test(root)) continue;
      const file = win32.join(root, "Tailscale", "tailscale.exe");
      if (!places.some((known) => known.toLowerCase() === file.toLowerCase())) places.push(file);
    }
    return places;
  }
  if (platform === "darwin") return ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/usr/bin/tailscale", "tailscale"];
  return ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale", "/run/current-system/sw/bin/tailscale", "/snap/bin/tailscale", "tailscale"];
}

/**
 * The absolute path of the program to run, or null when there is none. A bare name is resolved only on
 * POSIX and only through PATH entries that are themselves absolute (never the current folder).
 */
export function locateTailscale(candidates: readonly string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const paths = platform === "win32" ? win32 : posix;
  for (const candidate of candidates) {
    let places: string[];
    if (paths.isAbsolute(candidate)) places = [candidate];
    else if (platform === "win32") continue;
    else places = (env.PATH ?? "").split(":").filter((dir) => posix.isAbsolute(dir)).map((dir) => posix.join(dir, candidate));
    for (const place of places) {
      let file;
      try { file = statSync(place); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") throw new TailscaleNotRunnable(place);
        continue;
      }
      if (!file.isFile()) continue;
      if (platform !== "win32") { try { accessSync(place, constants.X_OK); } catch { throw new TailscaleNotRunnable(place); } }
      return place;
    }
  }
  return null;
}

/**
 * The CLI as the gateway runs it: located at absolute places only, started with an explicit working
 * folder (the app's data folder) so nothing is looked up relative to wherever the app was started.
 */
export function tailscaleProgram(cwd: string, candidates: string[] = tailscaleCandidates()): { run: TailscaleRun; spawn: TailscaleSpawn } {
  const run: TailscaleRun = async (argv) => {
    const file = locateTailscale(candidates);
    if (!file) return null;
    return new Promise<TailscaleResult | null>((resolve, reject) => {
      execFile(file, [...argv], { cwd, shell: false, timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === "ENOENT") return resolve(null);
        if (code === "EACCES" || code === "EPERM") return reject(new TailscaleNotRunnable(file));
        const exit = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
        resolve({ code: exit, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
    });
  };
  const start: TailscaleSpawn = (argv) => {
    const file = locateTailscale(candidates);
    if (!file) return null;
    return { child: spawn(file, [...argv], { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }), program: file };
  };
  return { run, spawn: start };
}

/** The exact argv of the one foreground serve this app keeps running (no `--bg`: it ends with the process). */
export function serveOnArgv(port: number): string[] {
  if (!Number.isInteger(port) || port <= 1024 || port > 65535) throw new Error("bad device port");
  return ["serve", `--https=${SERVE_HTTPS_PORT}`, `http://127.0.0.1:${port}`];
}
/** Shown as text only (a background entry left by something else): the app never runs it. */
export function serveOffArgv(): string[] { return ["serve", `--https=${SERVE_HTTPS_PORT}`, "off"]; }
/** How a command is shown to the person: the program name and the arguments, as typed in a terminal. */
export const commandLine = (argv: readonly string[]) => ["tailscale", ...argv].join(" ");

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A DNS name the CLI gave, made into an https origin only when it is a plain host name. */
export function machineName(dnsName: unknown): string | null {
  if (typeof dnsName !== "string") return null;
  const name = dnsName.trim().replace(/\.$/, "").toLowerCase();
  if (!name || name.length > 253) return null;
  const labels = name.split(".");
  return labels.length >= 3 && labels.every((label) => LABEL.test(label)) ? name : null;
}

type StatusJson = {
  BackendState?: unknown; AuthURL?: unknown;
  Self?: { DNSName?: unknown; HostName?: unknown; Online?: unknown } | null;
  CurrentTailnet?: { Name?: unknown; MagicDNSSuffix?: unknown; MagicDNSEnabled?: unknown } | null;
  MagicDNSSuffix?: unknown; CertDomains?: unknown;
};
type ServeLayer = {
  TCP?: Record<string, { HTTPS?: unknown; HTTP?: unknown; TCPForward?: unknown } | null> | null;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown; Path?: unknown; Text?: unknown } | null> | null } | null> | null;
  AllowFunnel?: Record<string, unknown> | null;
};
/** ipn.ServeConfig: the background layer, the foreground sessions (`tailscale serve` without --bg) and VIP services. */
export type ServeJson = ServeLayer & { Foreground?: Record<string, ServeLayer | null> | null; Services?: Record<string, ServeLayer | null> | null };

const parse = <T>(text: string): T | null => { try { const value = JSON.parse(text) as unknown; return value && typeof value === "object" && !Array.isArray(value) ? value as T : null; } catch { return null; } };
export const parseServe = (result: TailscaleResult | null): ServeJson | null => result && result.code === 0 ? (result.stdout.trim() ? parse<ServeJson>(result.stdout) : {}) : null;

/**
 * What Serve does with HTTPS port 443 on this machine, across the background config, every foreground
 * session and every service (tailscaled prefers a foreground handler over a background one).
 * - ours: exactly one holder, a FOREGROUND session, `/` → http://127.0.0.1:<port> and nothing else;
 * - background: exactly one holder, the background layer, pointing at this app's port (left by a `--bg` run);
 * - other: anything else on 443; funnel: Funnel allowed on 443 in any layer.
 */
export function readServe(serve: ServeJson, port: number): { use: "free" | "ours" | "background" | "other"; by: string; funnel: boolean } {
  const key = String(SERVE_HTTPS_PORT);
  const foreground = Object.values(serve.Foreground ?? {}).filter((layer): layer is ServeLayer => !!layer && typeof layer === "object");
  const funnel = [serve, ...foreground].some((layer) => Object.entries(layer.AllowFunnel ?? {}).some(([host, on]) => on === true && host.endsWith(":" + key)));
  type Holder = { where: "background" | "foreground" | "service"; name: string; layer: ServeLayer };
  const holds = (layer: ServeLayer) => !!layer.TCP?.[key] || Object.keys(layer.Web ?? {}).some((host) => host.endsWith(":" + key));
  const holders: Holder[] = [];
  if (holds(serve)) holders.push({ where: "background", name: "", layer: serve });
  for (const layer of foreground) if (holds(layer)) holders.push({ where: "foreground", name: "", layer });
  for (const [name, layer] of Object.entries(serve.Services ?? {})) if (layer && typeof layer === "object" && holds(layer)) holders.push({ where: "service", name, layer });
  if (!holders.length) return { use: "free", by: "", funnel };
  const ours = new Set([`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}/`]);
  const describe = (holder: Holder) => {
    if (holder.where === "service") return "테일스케일 서비스 " + holder.name;
    const tcp = holder.layer.TCP?.[key];
    if (tcp && typeof tcp.TCPForward === "string" && tcp.TCPForward) return `TCP ${tcp.TCPForward}`;
    const handlers = Object.entries(holder.layer.Web ?? {}).filter(([host]) => host.endsWith(":" + key)).flatMap(([, web]) => Object.entries(web?.Handlers ?? {}));
    if (handlers.length === 1 && handlers[0]![0] === "/" && typeof handlers[0]![1]?.Proxy === "string" && ours.has(handlers[0]![1]!.Proxy as string)) return "";
    const first = handlers[0]?.[1];
    return typeof first?.Proxy === "string" ? first.Proxy : typeof first?.Path === "string" ? "파일 " + first.Path : handlers.length ? "다른 설정" : "HTTPS 443";
  };
  if (holders.length === 1) {
    const by = describe(holders[0]!);
    if (!by) return { use: holders[0]!.where === "foreground" ? "ours" : "background", by: "", funnel };
    return { use: "other", by: by.slice(0, 120), funnel };
  }
  const named = holders.map(describe).find(Boolean);
  return { use: "other", by: (named ?? `http://127.0.0.1:${port}`).slice(0, 120) + " 외", funnel };
}

export type TailscaleRecord = {
  /** What the person had before 켜기; 끄기 puts it back. The record's presence is the person's standing choice "on". */
  previous: { enabled: boolean; publicUrl: string; listenHost: string; port: number };
  address: string; port: number; at: number;
};

/** What the gateway's own serve child is doing now. */
export type ServeChildState = "off" | "opening" | "running";

/**
 * One state of the panel, from the CLI's answers only. `port` is the gateway's device port that Serve
 * would reach (known before 켜기), `record` the person's standing 켜기, `serving` the gateway's own
 * child, `why` the last reason the road closed, `seenAt` when a device last signed in through the address.
 */
export async function detectTailscale(run: TailscaleRun, context: { port: number; record: TailscaleRecord | null; seenAt: number | null; listening: boolean; publicUrl: string;
  serving?: ServeChildState; why?: string; retrying?: boolean }): Promise<TailscaleView> {
  const base = { ours: !!context.record } as const;
  const serving = context.serving ?? "off";
  const lost = (view: TailscaleView): TailscaleView => context.record
    ? { ...view, lost: true, ...(context.why ? { why: context.why } : {}), ...(context.retrying ? { retrying: true } : {}) } : view;
  let status: TailscaleResult | null;
  try { status = await run(["status", "--json"]); }
  catch (error) {
    if (error instanceof TailscaleNotRunnable) return lost({ ...base, state: "error", message: error.message });
    return lost({ ...base, state: "error", message: "테일스케일 상태를 읽지 못했습니다. 잠시 뒤 다시 확인을 누르세요." });
  }
  if (!status) return lost({ ...base, state: "missing", downloadUrl: TAILSCALE_DOWNLOAD_URL });
  const json = parse<StatusJson>(status.stdout);
  if (!json) {
    // The CLI is there but its background service is not: it answers on stderr with a non-zero exit.
    if (/tailscaled|doesn't appear to be running|failed to connect|connection refused|not running/i.test(status.stderr + status.stdout)) return lost({ ...base, state: "stopped", backend: "NoDaemon" });
    return lost({ ...base, state: "error", message: "테일스케일이 알 수 없는 답을 했습니다. 테일스케일을 최신판으로 올린 뒤 다시 확인을 누르세요." });
  }
  const backend = typeof json.BackendState === "string" ? json.BackendState : "";
  if (backend === "NeedsLogin" || backend === "NeedsMachineAuth") return lost({ ...base, state: "needs-login", backend });
  if (backend !== "Running") return lost({ ...base, state: "stopped", backend: backend || "Unknown" });
  const name = machineName(json.Self?.DNSName);
  const shown = typeof json.Self?.HostName === "string" ? json.Self.HostName.slice(0, 80) : "";
  if (!name) return lost({ ...base, state: "no-https", reason: "name", machine: shown, adminUrl: TAILSCALE_DNS_ADMIN_URL });
  const magic = json.CurrentTailnet?.MagicDNSEnabled;
  if (magic === false) return lost({ ...base, state: "no-https", reason: "magicdns", machine: name, adminUrl: TAILSCALE_DNS_ADMIN_URL });
  // HTTPS certificates exist for the names the CLI lists in CertDomains; the address is only ever one of those.
  const certs = Array.isArray(json.CertDomains) ? json.CertDomains.filter((value): value is string => typeof value === "string").map((value) => value.trim().toLowerCase()) : [];
  if (!certs.includes(name)) return lost({ ...base, state: "no-https", reason: "https", machine: name, adminUrl: TAILSCALE_DNS_ADMIN_URL });
  const address = "https://" + name;
  let serveText: TailscaleResult | null;
  try { serveText = await run(["serve", "status", "--json"]); } catch { serveText = null; }
  const serve = parseServe(serveText);
  if (!serve) return lost({ ...base, state: "error", message: "테일스케일의 Serve 설정을 읽지 못했습니다. 테일스케일을 최신판으로 올린 뒤 다시 확인을 누르세요." });
  const use = readServe(serve, context.port);
  if (use.funnel) return lost({ ...base, state: "funnel", address });
  if (use.use === "other") return lost({ ...base, state: "taken", address, by: use.by });
  // A background (`--bg`) entry to this app's port: said, with the command to remove it as text; nothing is run.
  if (use.use === "background") return lost({ ...base, state: "background", address, command: serveOffArgv() });
  if (use.use === "ours") {
    // A foreground session to this port that is not this gateway's own child is someone else's (a terminal).
    if (serving === "off") return lost({ ...base, state: "taken", address, by: `http://127.0.0.1:${context.port} (이 앱이 아닌 다른 실행)` });
    if (serving === "opening") return { ...base, state: "opening", address, command: serveOnArgv(context.port) };
    // Serve reaches the listener; the panel says "on" only when this app's listener is on that address too.
    if (context.listening && context.publicUrl === address) return { ...base, state: "on", address, command: serveOnArgv(context.port), seenAt: context.seenAt };
    return { ...base, state: "on", address, command: serveOnArgv(context.port), seenAt: null, listenerOff: true };
  }
  if (serving !== "off") return { ...base, state: "opening", address, command: serveOnArgv(context.port) };
  return lost({ ...base, state: "ready", address, command: serveOnArgv(context.port) });
}

// ── the serve child's PID file: a hard-killed gateway's leftover is ended at the next start ─────────

export type ServeChildFile = { pid: number; started: string; command: string[] | string; argv: string[] };

/** A running process's start time and command line, as the OS reports them; null when there is none. */
export function processInfo(pid: number, platform: NodeJS.Platform = process.platform, cwd?: string): { started: string; command: string[] | string } | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (command.at(-1) === "") command.pop();
      return started && command.length ? { started, command } : null;
    }
    const options = { encoding: "utf8" as const, timeout: 5_000, windowsHide: true, ...(cwd ? { cwd } : {}), stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
    if (platform === "win32") {
      const root = process.env.SystemRoot?.trim();
      if (!root || !/^[A-Za-z]:\\/.test(root)) return null;
      const shell = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const out = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o'); $p.CommandLine }`], options).split(/\r?\n/);
      const started = out[0]?.trim() ?? "", command = out.slice(1).join(" ").trim();
      return started && command ? { started, command } : null;
    }
    const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], options).trim();
    const command = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], options).trim();
    return started && command ? { started, command } : null;
  } catch { return null; }
}

const sameCommand = (a: string[] | string, b: string[] | string) => typeof a === "string" || typeof b === "string" ? String(a) === String(b) : a.length === b.length && a.every((part, index) => part === b[index]);
/** The recorded command is the app's own serve: it ends with exactly `serve --https=443 http://127.0.0.1:<port>`. */
const isServeCommand = (file: ServeChildFile) => {
  const port = Number(/^http:\/\/127\.0\.0\.1:(\d+)$/.exec(file.argv[2] ?? "")?.[1]);
  let argv: string[]; try { argv = serveOnArgv(port); } catch { return false; }
  if (file.argv.length !== argv.length || file.argv.some((part, index) => part !== argv[index])) return false;
  return typeof file.command === "string" ? file.command.endsWith(" " + argv.join(" ")) : file.command.slice(-argv.length).every((part, index) => part === argv[index]);
};

export function writeServeChildFile(path: string, pid: number, argv: string[], platform: NodeJS.Platform = process.platform, cwd?: string, program?: string) {
  const info = processInfo(pid, platform, cwd);
  const file: ServeChildFile = { pid, started: info?.started ?? "", command: info?.command ?? [program ?? "tailscale", ...argv], argv };
  writePrivateFileAtomicSync(path, JSON.stringify(file, null, 2));
}

/**
 * At gateway start, before anything else: a serve child left running by a hard-killed gateway (same PID,
 * same start time, that exact serve command line) is ended. Anything else with that PID is left alone.
 */
export async function endLeftoverServe(path: string, platform: NodeJS.Platform = process.platform, cwd?: string): Promise<"none" | "ended" | "other"> {
  let file: ServeChildFile | null = null;
  try { file = JSON.parse(readFileSync(path, "utf8")) as ServeChildFile; } catch { file = null; }
  rmSync(path, { force: true });
  if (!file || !Number.isSafeInteger(file.pid) || typeof file.started !== "string" || !file.started || !Array.isArray(file.argv) || !isServeCommand(file)) return "none";
  const info = processInfo(file.pid, platform, cwd);
  if (!info) return "none";
  if (info.started !== file.started || !sameCommand(info.command, file.command)) return "other";
  try { process.kill(file.pid, "SIGTERM"); } catch { return "none"; }
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const now = processInfo(file.pid, platform, cwd);
    if (!now || now.started !== file.started) return "ended";
  }
  try { process.kill(file.pid, "SIGKILL"); } catch { /* gone */ }
  return "ended";
}
