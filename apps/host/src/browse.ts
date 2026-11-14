import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { copyFile, link, lstat, open as openFile, rename, rm, writeFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { connect } from "node:net";
import { homedir, hostname } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  LOGIN_SITES,
  SHARED_BROWSER_HELP,
  browserSessionName,
  type AccessMode,
  type AgentBrowserStatus,
  type AgentBrowserWindow,
  type ApprovalDecision,
  type Session,
  type TranscriptItem,
  type Work,
  type BrowserControl,
  type BrowserJobResult,
} from "@workbench/contracts";
import { BrowserInstaller, browserPaths, installSteps, installedOnDisk, type BrowserPaths, type InstallStep } from "./browse-install.ts";
import {
  absoluteLinks,
  browserCommandKind,
  browserDecision,
  browserInstructions,
  browserOffNote,
  describeBrowserCommand,
  describeRef,
  isPlainBrowserCommand,
  parseCliArgs,
  targetUrl,
} from "./browse-policy.ts";
import { cmdLauncherSource, launcherSource, wrapperSource } from "./browse-wrapper.ts";
import { daemonRun, daemonSocket, hideDecoded, hideTyped, hostPageOf, SHOWN, type HostPage } from "./browse-host.ts";
import { HttpError } from "./errors.ts";
import { contentReason, needlesOf, turn, type Needles } from "./channels/file-scan.ts";
import { LightpandaBrowser, LightpandaInstall, LIGHTPANDA_HELP } from "./browse-lightpanda.ts";

const run = promisify(execFile);

// The agent browser: one Chromium window on one persistent profile in the app data folder, so a
// sign-in done once stays across app restarts. The gateway owns that window. Engines send
// `playwright-cli` commands through the wrapper on their PATH; the gateway checks each against
// the session's access (approval cards like an engine's), then runs the real Playwright CLI
// outside any engine sandbox. Signing in happens in a plain launch of the same Chromium on the
// same profile (no automation, which Google refuses), never at the same time as the agent.

/** Both launches must agree on how Chromium encrypts cookies, or saved sign-ins read as logged out. */
const PASSWORD_STORE = "--password-store=basic";
/** How long values the gateway typed into a window stay hidden in its answers (unit 9). */
const TYPED_MS = 30 * 60_000;
/** After its step ended, how long a typed value is still hidden (round 4, ruling P4). */
const FORGET_MS = 2 * 60_000;
/** The typed values of a window still hidden now (a forgotten one for FORGET_MS more). */
const stillTyped = <T extends { goneAt?: number }>(entries: T[]) => entries.filter((entry) => entry.goneAt === undefined || entry.goneAt > Date.now());
/** A browser output file up to this size is text that can be rewritten hidden; a larger one is judged by the byte scanner only. */
const TEXT_MAX = 8 * 1024 * 1024;
/** Text hidden this many characters at a time, with the event loop given a turn between pieces (ruling B). */
const TEXT_PIECE = 128 * 1024;

/** How long another session's recent browser use counts as "in use" while that session works. */
const IN_USE_MS = 120_000;

/** Sites shown as signed in, recognised by the name and domain of their sign-in cookie (values are never read). */
const SIGN_IN_MARKS: { label: string; host: RegExp; names: string[] }[] = [
  { label: "Google", host: /(^|\.)google\.com$/, names: ["SID", "__Secure-1PSID", "__Secure-3PSID"] },
  { label: "네이버", host: /(^|\.)naver\.com$/, names: ["NID_AUT"] },
  { label: "GitHub", host: /(^|\.)github\.com$/, names: ["user_session"] },
];

/**
 * The environment of the browser's launches: without a desktop identity inherited from whatever
 * started the gateway (an Electron app's CHROME_DESKTOP would file the window under that app).
 */
function browserEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.CHROME_DESKTOP;
  return env;
}

/**
 * Unit 9: Chromium's password manager, its "save password?" prompt and autofill are off in the agent
 * profile (the 비밀 보관함 is where values live; a click on that prompt would write a typed password
 * into the profile's Login Data). Written into the profile's preferences before each launch; the
 * other keys of the file are kept.
 */
export function noPasswordManager(profile: string) {
  const file = join(profile, "Default", "Preferences");
  let prefs: Record<string, unknown> = {};
  let text: string | null = null;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    // A file that cannot be read is left to Chromium; none yet is written new.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  if (text !== null) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* Set aside below. */ }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) prefs = parsed as Record<string, unknown>;
    else {
      // A file that does not parse would leave the password manager on: set aside (kept once), then written new.
      try { renameSync(file, `${file}.corrupt`); } catch { return; }
    }
  }
  const section = (key: string) => (prefs[key] && typeof prefs[key] === "object" && !Array.isArray(prefs[key]) ? prefs[key] : {}) as Record<string, unknown>;
  const next = {
    ...prefs,
    credentials_enable_service: false,
    credentials_enable_autosignin: false,
    profile: { ...section("profile"), password_manager_enabled: false, password_manager_leak_detection: false },
    autofill: { ...section("autofill"), enabled: false, profile_enabled: false, credit_card_enabled: false },
  };
  if (JSON.stringify(next) === JSON.stringify(prefs)) return;
  mkdirSync(join(profile, "Default"), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(next));
}

/** Signed-in sites from cookie (domain, name) pairs. */
export function signedInSites(cookies: { host_key: string; name: string }[]): string[] {
  return SIGN_IN_MARKS.filter((mark) => cookies.some((cookie) => mark.host.test(cookie.host_key) && mark.names.includes(cookie.name))).map((mark) => mark.label);
}

/** Read which sites a Chromium profile is signed in to: cookie domains and names only. */
export function readSignedIn(profile: string): string[] | null {
  const file = join(profile, "Default", "Cookies");
  if (!existsSync(file)) return [];
  let db: DatabaseSync | null = null;
  try {
    // immutable: no locks, so a running Chromium is neither blocked nor disturbed.
    db = new DatabaseSync(`file:${encodeURI(file)}?immutable=1`, { readOnly: true });
    return signedInSites(db.prepare("SELECT DISTINCT host_key, name FROM cookies").all() as { host_key: string; name: string }[]);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** A refusal the engine reads as the command's error output. */
class Refusal extends Error {}

export type BrowseHost = {
  /** The session, its work and the access it runs with now; null when unknown. */
  lookup(sessionId: string): { session: Session; work: Work; access: AccessMode } | null;
  sessions(): Session[];
  upsertItem(sessionId: string, item: TranscriptItem): void;
  updateSession(sessionId: string, patch: Partial<Session>): void;
  publish(status: AgentBrowserStatus): void;
  pageControl?(sessionId: string): BrowserControl;
  hasPage?(sessionId: string): boolean;
  openPage?(sessionId: string, url: string): Promise<unknown>;
  pageCommand?(sessionId: string, requestId: string, command: string, args: string[], control: BrowserControl): Promise<BrowserJobResult>;
};

/** What engine adapters ask of the agent browser (both engines the same way). */
export type BrowserEngineHooks = {
  /** Other local tools are available independently of the browser toggle. */
  extraInstructions?(session: Session): string | null;
  /** Folders put in front of every engine process's PATH (the wrapper). */
  pathDirs(): string[];
  /** Variables for one session's own process (Claude): its browser session name while on. */
  sessionEnv(session: Session): Record<string, string>;
  /** The instructions while the session's browser is on, else null. */
  instructions(session: Session): string | null;
  /** The note an engine gets when the browser is switched off mid-session. */
  offNote(session: Session): string;
  /** A command line that only runs playwright-cli in a session with the browser on: the gateway decides about it. */
  allowsCommand(sessionId: string, command: string): boolean;
  /** Folders a sandboxed session must be able to write (its spool), while on. */
  writableRoots(session: Session): string[];
  /** What the engine's conversation was last told about the browser (Codex keeps it in the thread). */
  told(sessionId: string): boolean | null;
  setTold(sessionId: string, on: boolean): void;
};

export type AgentBrowserOptions = {
  dataDir: string;
  engine?: "lightpanda" | "chromium";
  /** Explicit test executable; production uses the verified app-local release. */
  lightpanda?: string;
  /** No window (checks and tests): the same Chromium, headless. */
  headless?: boolean;
  /** A stand-in for the Playwright CLI script (checks): used as if installed. */
  cli?: string | null;
  /** A stand-in for Chromium in the sign-in launch (checks). */
  chrome?: string | null;
  /** Close the agent's window after this long without a command (and with its session idle). */
  idleCloseMs?: number;
  /** How stale a waiting command's heartbeat may be before its approval runs nothing (tests shorten it). */
  waitGraceMs?: number;
  /** How long the gateway's own command waits for the daemon (tests shorten it). */
  hostTimeoutMs?: number;
  steps?: (paths: BrowserPaths, finish: () => void) => InstallStep[];
};

type Agent = { name: string; sessionId: string; cwd: string; daemonPid: number | null; lastAt: number; snapshot: string | null; snapshotFile: string | null };
type Pending = { sessionId: string; item: Extract<TranscriptItem, { kind: "approval" }>; resolve: (accepted: boolean) => void };
type Request = { id: string; args: string[]; cwd: string };
type CliResult = { code: number; stdout: string; stderr: string };

const isBusy = (session: Session) => session.status !== "idle" && session.status !== "error";

const lastLine = (result: CliResult) => (result.stderr.trim() || result.stdout.trim()).split("\n").filter((line) => line.trim() && !/^\s+at /.test(line)).slice(-2).join(" ").slice(0, 300);

function alive(pid: number | null | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Child processes of a process (Linux /proc). */
function childrenOf(pid: number): number[] {
  const found: number[] = [];
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        if (ppid === pid) found.push(Number(entry));
      } catch {
        // Gone meanwhile.
      }
    }
  } catch {
    // No /proc.
  }
  return found;
}

type Move = { from: string; to: string; base: string };
type Placed = Omit<Move, "to"> & { to: string | null; asked: string; renamed?: boolean; why?: string };
/** Whether `path` is inside `root` (or is it). */
const within = (root: string, path: string) => {
  const inside = relative(resolve(root), resolve(path));
  return !inside.startsWith("..") && !isAbsolute(inside);
};
const realOr = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
/** No folder from `base` (not included) down to `folder` is a link (one not there yet is fine: it is made). */
function noLinkBelow(base: string, folder: string): boolean {
  let at = resolve(base);
  for (const part of relative(at, resolve(folder)).split(sep).filter(Boolean)) {
    at = join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) return false;
    } catch { return true; }
  }
  return true;
}
/** What the engine hears about the files it asked for in its work folder. */
function placedNote(placed: Placed[]): string {
  const lines = placed.map((entry) => entry.to
    ? `Workbench: 파일을 ${entry.to}에 두었습니다.${entry.renamed ? ` (${entry.asked}에는 사용자의 다른 파일이 있어 이름을 바꿨습니다)` : ""}`
    : entry.why === "removed" ? "" : `Workbench: 요청한 자리(${entry.asked})에 파일을 두지 못했습니다(${entry.why}).`).filter(Boolean);
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

/** The line an answer gets for files removed because they could not be hidden. */
function removedNote(removed: string[]): string {
  return removed.length ? `\nWorkbench: 비밀 값이 들어 있을 수 있는데 숨길 수 없는 파일이라 지웠습니다: ${[...new Set(removed)].join(", ")}\n` : "";
}

/**
 * A help or version request exactly as the CLI reads one: no `--` anywhere, nothing but an optional
 * command and `--help` / `-h` / `--version` (session flags aside). Returns the argv the gateway runs
 * for it (`[command?, "--help"]` or `["--version"]`), or null when the line is anything else.
 */
export function helpArgv(argv: string[]): string[] | null {
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (/^(?:-s|--session)=/.test(arg)) continue;
    if ((arg === "-s" || arg === "--session") && index + 1 < argv.length) {
      index += 1;
      continue;
    }
    rest.push(arg);
  }
  if (rest.includes("--")) return null;
  const words = rest.filter((arg) => !arg.startsWith("-"));
  const flags = rest.filter((arg) => arg.startsWith("-"));
  if (words.length > 1 || !flags.every((flag) => flag === "--help" || flag === "-h" || flag === "--version")) return null;
  if (!flags.length) return words.length ? null : ["--help"];
  if (flags.includes("--version")) return ["--version"];
  return [...words, "--help"];
}

export class AgentBrowser {
  readonly paths: BrowserPaths;
  private readonly options: AgentBrowserOptions;
  private readonly chromiumInstaller: BrowserInstaller;
  private readonly pandaInstaller: BrowserInstaller;
  private readonly panda: LightpandaBrowser;
  private engine: "lightpanda" | "chromium";
  private get installer() { return this.engine === "lightpanda" ? this.pandaInstaller : this.chromiumInstaller; }
  private host: BrowseHost | null = null;
  private window: AgentBrowserWindow = { kind: "closed" };
  private agent: Agent | null = null;
  private login: { pid: number; child: ChildProcess | null } | null = null;
  private readonly paused = new Set<string>();
  private signedIn: string[] = [];
  /** sessionId -> what the spool and thread map last reflected */
  private readonly known = new Map<string, { on: boolean; thread: string | null; name: string }>();
  private readonly byName = new Map<string, string>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly inFlight = new Set<string>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly approvals = new Map<string, Pending>();
  /** Sites each session's browser went to with the user's leave (자동 asks for a new one). */
  private readonly sites = new Map<string, Set<string>>();
  private told: Record<string, boolean> = {};
  private poll: NodeJS.Timeout | null = null;
  private idle: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Unit 9: what every answer to an engine passes first (the credential scrubber; a page shows a typed password in its snapshot). */
  scrubOutput: ((text: string) => string) | null = null;
  /** Every form of every stored value (8+ characters), for the byte scanner (channels/file-scan.ts). */
  storedNeedles: (() => string[]) | null = null;
  /** The label of a stored value that is exactly this text, whatever its length (ruling E: a decoded JSON string), or null. */
  storedExact: ((text: string) => string | null) | null = null;
  /** Unit 9: values the gateway typed into the open window (by its session name), hidden in all it answers until the window closes or 30 minutes pass. */
  private typedIn = new Map<string, { entries: { label: string; value: string; key?: string; goneAt?: number }[]; until: number }>();

  constructor(options: AgentBrowserOptions) {
    this.options = options;
    this.paths = browserPaths(options.dataDir);
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(join(this.paths.root, "engine.json"), "utf8")).engine; } catch { /* first launch */ }
    this.engine = options.engine ?? (options.cli ? "chromium" : saved === "chromium" ? "chromium" : "lightpanda");
    const pandaInstall = new LightpandaInstall(this.paths.root);
    this.panda = new LightpandaBrowser(options.lightpanda ?? pandaInstall.binary, options.idleCloseMs);
    this.pandaInstaller = new BrowserInstaller({ ready: () => Boolean(options.lightpanda) || pandaInstall.ready(), steps: () => pandaInstall.steps(), onChange: () => this.publish(), versions: { cli: "MCP", browser: pandaInstall.version } });
    for (const dir of [this.paths.root, this.paths.bin, this.paths.spool, this.paths.output]) mkdirSync(dir, { recursive: true });
    mkdirSync(this.paths.profile, { recursive: true, mode: 0o700 });
    // Sign-ins, page snapshots and screenshots (mail, for one) are this user's alone.
    chmodSync(this.paths.root, 0o700);
    chmodSync(this.paths.profile, 0o700);
    this.writeWrapper();
    try {
      this.told = JSON.parse(readFileSync(this.paths.told, "utf8")) as Record<string, boolean>;
    } catch {
      this.told = {};
    }
    if (saved !== this.engine) {
      this.told = {}; writeFileSync(this.paths.told, "{}");
      writeFileSync(join(this.paths.root, "engine.json"), JSON.stringify({ engine: this.engine }), { mode: 0o600 });
    }
    this.chromiumInstaller = new BrowserInstaller({
      ready: () => Boolean(options.cli) || installedOnDisk(this.paths),
      steps: () => (options.steps ?? installSteps)(this.paths, () => this.writeConfig()),
      onChange: () => this.publish(),
    });
    if (this.installer.state.state === "ready") this.writeConfig();
  }

  private get cliJs() {
    return this.options.cli ?? this.paths.cliJs;
  }

  /** The wrapper engines run as `playwright-cli` (rewritten each start: it names this gateway's Node). */
  private writeWrapper() {
    const script = join(this.paths.bin, "playwright-cli.mjs");
    writeFileSync(script, wrapperSource(this.paths.root));
    writeFileSync(join(this.paths.bin, "playwright-cli"), launcherSource(process.execPath, script), { mode: 0o755 });
    chmodSync(join(this.paths.bin, "playwright-cli"), 0o755);
    // Windows shells (PowerShell, cmd) run the .cmd; Git Bash runs the sh one.
    if (process.platform === "win32") writeFileSync(join(this.paths.bin, "playwright-cli.cmd"), cmdLauncherSource(process.execPath, script));
    writeFileSync(join(this.paths.bin, "workbench-browser"), launcherSource(process.execPath, script), { mode: 0o755 });
    chmodSync(join(this.paths.bin, "workbench-browser"), 0o755);
    if (process.platform === "win32") writeFileSync(join(this.paths.bin, "workbench-browser.cmd"), cmdLauncherSource(process.execPath, script));
  }

  /** The CLI's config: Chromium (the downloaded build), this profile, a window, output kept here. */
  private writeConfig() {
    // Unit 9: a service without a graphical session has no screen for a window; it runs headless there.
    const headless = Boolean(this.options.headless) || (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
    const config = {
      browser: {
        browserName: "chromium",
        userDataDir: this.paths.profile,
        // A window the user sees; headless only in checks. Chromium's own sandbox stays on.
        launchOptions: { headless, chromiumSandbox: true, ...(headless ? { channel: "chromium" } : {}) },
        contextOptions: { viewport: null },
      },
      outputDir: this.paths.output,
      // Unit 9: the daemon keeps no log of the commands it runs (a gateway fill carries a value).
      saveSession: false,
      codegen: "none",
    };
    writeFileSync(this.paths.config, JSON.stringify(config, null, 2));
    noPasswordManager(this.paths.profile);
  }

  bind(host: BrowseHost) {
    this.host = host;
    for (const session of host.sessions()) this.sessionChanged(session);
    // Watchers can miss a file (or a folder made before them): a slow look as well.
    this.poll = setInterval(() => this.tick(), 1000);
    this.poll.unref();
    if (this.engine === "chromium") void this.adoptRunning().finally(() => this.refreshSignedIn());
  }

  status(): AgentBrowserStatus {
    return { engine: this.engine, install: this.installer.state, window: this.window, paused: [...this.paused], signedIn: this.engine === "chromium" ? this.signedIn : [] };
  }

  async selectEngine(engine: string) {
    if (engine !== "lightpanda" && engine !== "chromium") throw new HttpError(400, "browser_engine", "알 수 없는 브라우저입니다.");
    if (engine === this.engine) return this.status();
    if (this.panda.busy || (this.window.kind === "agent" && this.window.busy)) throw new HttpError(409, "browser_busy", "진행 중인 탐색이 끝나거나 중지된 뒤 전환하세요.");
    if (this.window.kind === "login") throw new HttpError(409, "browser_login", "열린 로그인 창을 닫은 뒤 전환하세요.");
    for (const sessionId of this.known.keys()) if (!this.host?.lookup(sessionId)?.session.pageAgent) this.expire(sessionId);
    await this.closeAgent(); await this.panda.closeAll();
    this.engine = engine;
    writeFileSync(join(this.paths.root, "engine.json"), JSON.stringify({ engine }), { mode: 0o600 });
    this.told = {}; writeFileSync(this.paths.told, "{}");
    this.setWindow({ kind: "closed" });
    return this.status();
  }

  private publish() {
    this.host?.publish(this.status());
  }

  private setWindow(next: AgentBrowserWindow) {
    this.window = next;
    this.publish();
  }

  install() {
    void this.installer.install();
    return this.status();
  }

  // ---- sessions, spool folders and the Codex thread map --------------------------------------

  /** A session changed (its browser switch, thread id, archive): keep its spool folder and the thread map right. */
  sessionChanged(session: Session) {
    const name = browserSessionName(session.id);
    const on = Boolean(session.browser) && !session.archivedAt;
    const thread = session.provider === "codex" ? session.nativeSessionId : null;
    const before = this.known.get(session.id);
    if (before && before.on === on && before.thread === thread) return;
    this.known.set(session.id, { on, thread, name });
    this.byName.set(name, session.id);
    const dir = join(this.paths.spool, name);
    if (on) {
      mkdirSync(dir, { recursive: true });
      this.watchSpool(name);
    } else if (before?.on) {
      this.watchers.get(name)?.close();
      this.watchers.delete(name);
      // Waiting wrappers see the folder gone and stop at once.
      rmSync(dir, { recursive: true, force: true });
      this.expire(session.id);
      this.paused.delete(session.id);
      if (this.agent?.sessionId === session.id) void this.closeAgent();
      this.panda.stop(name);
      this.publish();
    }
    if (before?.thread !== thread || before?.on !== on) this.writeThreads();
  }

  private writeThreads() {
    const map: Record<string, string> = {};
    for (const entry of this.known.values()) if (entry.on && entry.thread) map[entry.thread] = entry.name;
    writeFileSync(`${this.paths.threads}.tmp`, JSON.stringify(map));
    renameSync(`${this.paths.threads}.tmp`, this.paths.threads);
  }

  private watchSpool(name: string) {
    if (this.watchers.has(name)) return;
    try {
      const watcher = watch(join(this.paths.spool, name), (_event, file) => {
        if (file && String(file).endsWith(".req.json")) this.take(name, String(file));
      });
      watcher.on("error", () => this.watchers.delete(name));
      this.watchers.set(name, watcher);
    } catch {
      // The slow look still finds requests.
    }
  }

  private tick() {
    const now = Date.now();
    for (const entry of this.known.values()) {
      if (!entry.on) continue;
      const dir = join(this.paths.spool, entry.name);
      try {
        for (const file of readdirSync(dir)) {
          if (file.endsWith(".req.json")) this.take(entry.name, file);
          // Answers and heartbeats of commands nobody waits for any more.
          else if (/\.(res\.json|wait)$/.test(file) && now - statSync(join(dir, file)).mtimeMs > 15 * 60_000) rmSync(join(dir, file), { force: true });
        }
      } catch {
        // Folder not there (yet), or a file gone meanwhile.
      }
    }
    // The agent's window closed by the user, or its process ended.
    if (this.agent && this.agent.daemonPid && !alive(this.agent.daemonPid)) this.dropAgent();
    if (this.login && !alive(this.login.pid)) this.loginClosed();
  }

  private take(name: string, file: string) {
    const key = `${name}/${file}`;
    if (this.inFlight.has(key)) return;
    const path = join(this.paths.spool, name, file);
    let request: Request;
    try {
      request = JSON.parse(readFileSync(path, "utf8")) as Request;
      rmSync(path, { force: true });
    } catch {
      return;
    }
    this.inFlight.add(key);
    const reply = async (raw: CliResult) => {
      this.inFlight.delete(key);
      const result = await this.hidden(raw, request.cwd, name);
      const out = join(this.paths.spool, name, `${request.id}.res.json`);
      try {
        writeFileSync(`${out}.tmp`, JSON.stringify(result));
        renameSync(`${out}.tmp`, out);
      } catch {
        // The session's browser was switched off meanwhile: its folder is gone.
      }
    };
    // One command at a time per session, in the order they came.
    const previous = this.chains.get(name) ?? Promise.resolve();
    const next = previous
      .then(() => this.handle(name, request))
      .then(reply, (error: unknown) =>
        reply({ code: 1, stdout: "", stderr: `playwright-cli: ${error instanceof Refusal ? error.message : `Workbench 브라우저 오류: ${error instanceof Error ? error.message : String(error)}`}\n` }),
      );
    this.chains.set(name, next);
  }

  // ---- one command ------------------------------------------------------------------------------

  private async handle(name: string, request: Request): Promise<CliResult> {
    const sessionId = this.byName.get(name);
    const entry = sessionId ? this.host?.lookup(sessionId) : null;
    if (!sessionId || !entry || !entry.session.browser) throw new Refusal(`세션 ${name}의 Workbench 브라우저가 꺼져 있습니다. 사용자에게 입력창 아래 '브라우저'를 켜 달라고 하세요.`);
    const parsed = parseCliArgs(request.args);
    const tabOpen = parsed.command === "tab-open";
    let shared = Boolean(entry.session.pageAgent || this.host?.hasPage?.(sessionId));
    // Help and the version change nothing. Only the exact help form counts, and the CLI gets the
    // argv written here, never the engine's own (`state-save -- --help` would run state-save).
    const help = helpArgv(request.args);
    if (help) return shared ? { code: 0, stdout: SHARED_BROWSER_HELP, stderr: "" } : this.engine === "lightpanda" ? { code: 0, stdout: LIGHTPANDA_HELP, stderr: "" } : this.cli(name, help, this.paths.root);
    if (!parsed.command) throw new Refusal("명령이 없습니다. 도움말은 'playwright-cli --help' 또는 'playwright-cli <명령> --help'로만 볼 수 있습니다.");
    const kind = browserCommandKind(tabOpen ? "open" : parsed.command);
    if (kind === "blocked") throw new Refusal(`'${parsed.command}' 명령은 Workbench 브라우저에서 쓸 수 없습니다(쿠키·저장소·네트워크 기록·창 관리는 막혀 있습니다).`);
    if (!shared && !tabOpen && this.installer.state.state !== "ready") throw new Refusal("에이전트 브라우저가 아직 설치되지 않았습니다. 사용자에게 '브라우저 › 설치'를 부탁하세요.");
    if (!shared && !tabOpen) this.blocker(sessionId);
    if (!shared && parsed.command === "close") return this.closeOwn(sessionId);
    // Capture authority before the approval card. A later human takeover cannot authorize this old request.
    let pageControl = shared && !tabOpen ? this.host?.pageControl?.(sessionId) : null;
    const url = kind === "navigate" && parsed.command !== "search" ? targetUrl(parsed.args) : null;
    const sites = this.sites.get(sessionId) ?? new Set<string>();
    const newSite = parsed.command === "search" || Boolean(url && !sites.has(url.host));
    if (browserDecision(entry.access, kind, newSite) === "ask") {
      const ref = parsed.args.find((arg) => /^e\d+$/.test(arg));
      const element = ref ? describeRef(this.lastSnapshot(name), ref) : null;
      const view = describeBrowserCommand(parsed.command, parsed.args, element);
      const reason = entry.access === "ask" ? "권한 '묻기'에서는 브라우저 동작마다 확인합니다." : "권한 '자동'에서는 누르기·입력·새 사이트 이동을 확인합니다.";
      const accepted = await this.ask(sessionId, view.title, `${view.detail}\nplaywright-cli -s=${name} ${[parsed.command, ...parsed.args].join(" ")}`, reason);
      if (!accepted) throw new Refusal("사용자가 이 브라우저 동작을 허용하지 않았습니다. 다른 방법을 찾거나 사용자에게 물어보세요.");
      // The window may have changed hands while the card waited, or the engine stopped waiting.
      if (!shared && !tabOpen) this.blocker(sessionId);
      if (!this.waiting(name, request.id)) throw new Refusal("명령이 이미 끝나 실행하지 않았습니다.");
    }
    if (url) this.sites.set(sessionId, sites.add(url.host));
    if (tabOpen) {
      if (!url || !this.host?.openPage) throw new Refusal("tab-open에는 http(s) 웹 주소가 필요합니다.");
      await this.host.openPage(sessionId, url.href);
      shared = true; pageControl = this.host.pageControl?.(sessionId);
    }
    if (shared) {
      if (!pageControl || !this.host?.pageCommand) throw new Refusal("공유 웹 탭 연결을 사용할 수 없습니다.");
      const result = await this.host.pageCommand(sessionId, request.id, tabOpen ? "goto" : parsed.command, parsed.args, pageControl);
      return { code: result.error ? 1 : 0, stdout: result.error ? "" : result.observation?.text ?? `완료: ${parsed.command}\n${result.page?.url ?? ""}`, stderr: result.error ?? "" };
    }
    if (this.engine === "lightpanda") {
      this.setWindow({ kind: "agent", sessionId, url: url?.href ?? null, title: null, busy: true, at: Date.now() });
      try {
        const stdout = await this.panda.command(name, [parsed.command, ...parsed.args]);
        const result = { code: 0, stdout, stderr: "" };
        this.noteOutput(name, sessionId, result, entry.work.cwd);
        return result;
      } catch (error) {
        if (this.engine === "lightpanda") this.setWindow({ kind: "closed" });
        throw error;
      }
    }
    const fresh = this.host?.lookup(sessionId) ?? entry;
    await this.ensureWindow(fresh.session, fresh.work);
    const agent = this.agent!;
    // `open` would restart the browser: with the window up it is a move to the address.
    const moves: Move[] = [];
    const args = parsed.command === "open" ? (url ? ["goto", url.href] : ["snapshot"]) : [parsed.command, ...this.placedPaths(parsed.command, parsed.args, request.cwd, fresh.work.cwd, moves)];
    agent.lastAt = Date.now();
    // Unit 9: no picture of the page while a value the gateway typed shows as text (a "show password" toggle).
    if ((parsed.command === "screenshot" || parsed.command === "pdf") && !(await this.showsNoTyped(name, agent.cwd))) {
      throw new Refusal("저장한 비밀 값이 화면에 글자로 보이는 상태라 찍지 않았습니다. 비밀번호 칸을 다시 가리거나 다른 페이지로 옮긴 뒤 찍으세요.");
    }
    this.setWindow({ ...(this.window.kind === "agent" ? this.window : { kind: "agent", sessionId, url: null, title: null, at: Date.now() }), busy: true } as AgentBrowserWindow);
    // Unit 9: every file the command writes or changes in the output folder passes the same hiding as its answer.
    let result = await this.cli(name, args, agent.cwd);
    if (/is not open|not open, please run open/i.test(`${result.stdout}${result.stderr}`)) {
      // The window was closed under us (by the user): open it again once.
      this.dropAgent();
      const again = this.host?.lookup(sessionId) ?? entry;
      await this.ensureWindow(again.session, again.work);
      result = await this.cli(name, args, this.agent!.cwd);
    }
    const removed = await this.sweep(name);
    // Ruling C: a file the AI asked for inside its work folder, hidden, goes there now; the answer names where.
    const placed = await this.placeAll(moves, removed);
    let stdout = result.stdout;
    for (const move of placed) if (move.to) for (const form of [move.from, relative(this.agent?.cwd ?? agent.cwd, move.from)]) stdout = stdout.split(form).join(move.to);
    result = { ...result, stdout: absoluteLinks(stdout, this.agent?.cwd ?? agent.cwd, resolve) + removedNote(removed) + placedNote(placed) };
    this.noteOutput(name, sessionId, result, agent.cwd);
    this.armIdle();
    return result;
  }

  /** The wrapper that sent a request still waits for it (it touches its .wait file every second). */
  private waiting(name: string, id: string) {
    try {
      return statSync(join(this.paths.spool, name, `${id}.wait`)).mtimeMs > Date.now() - (this.options.waitGraceMs ?? 5000);
    } catch {
      return false;
    }
  }

  /** Why this session may not use the browser now, as a refusal; nothing when it may. */
  private blocker(sessionId: string) {
    if (this.paused.has(sessionId)) throw new Refusal("사용자가 이 세션의 브라우저를 멈췄습니다. 사용자가 다시 켤 때까지 기다리고, 무엇이 필요한지 알려 주세요.");
    if (this.window.kind === "login") throw new Refusal("사용자가 브라우저 창에서 로그인하는 중입니다. 로그인 창이 닫힌 뒤에 다시 시도하세요.");
  }

  /**
   * Unit 9, by place: a file a command writes is written only into the gateway's output folder, where
   * every new or changed file is hidden after the command. A file flag (`--filename`, or any flag
   * naming a file, path, folder or output) is read the way the CLI would (a relative name from the
   * engine's folder). Inside the output folder: written there. Inside the work folder (round 3,
   * ruling C): written into a fresh folder of the output folder, hidden by the sweep, and then moved
   * to the asked place (`moves`). Anywhere else, or through a link: refused before the CLI runs.
   * Files a command only reads (upload, drop's --path) are the engine's working folder's.
   */
  private placedPaths(command: string, args: string[], cwd: string, work: string, moves: Move[]) {
    const absolute = (value: string) => (isAbsolute(value) ? value : resolve(cwd, value));
    const placed: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      const flag = /^--([A-Za-z][\w-]*)(?:=([\s\S]*))?$/.exec(arg);
      const reads = command === "drop" && flag?.[1] === "path";
      if (flag && (reads || /file|path|dir|output/i.test(flag[1]!))) {
        let value = flag[2];
        if (value === undefined) {
          value = args[index + 1];
          index += 1;
        }
        if (value === undefined || value === "" || /^-./.test(value)) throw new Refusal(`--${flag[1]}에 파일 이름이 없습니다.`);
        placed.push(`--${flag[1]}=${reads ? absolute(value) : this.placeOf(absolute(value), work, moves)}`);
        continue;
      }
      placed.push(command === "upload" && !arg.startsWith("-") ? absolute(arg) : arg);
    }
    return placed;
  }

  /** Where the CLI writes a file asked for at `target`: in the output folder, or a fresh folder of it for the work folder (then moved). */
  private placeOf(target: string, work: string, moves: Move[]): string {
    const root = this.paths.output;
    const refuse = () => new Refusal(`파일은 이 대화의 작업 폴더(${work}) 안에만 쓸 수 있습니다(링크를 거치지 않는 곳). 예: --filename=shot.png 또는 --filename=결과/페이지.pdf. Workbench가 비밀 값을 숨긴 뒤 그 자리에 두고, 결과에 그 경로를 알려 줍니다.`);
    if (within(root, target)) return this.inOutput(target, refuse);
    const base = [work, realOr(work)].find((folder) => within(folder, target));
    if (!base || resolve(target) === resolve(base) || !noLinkBelow(base, dirname(target))) throw refuse();
    try { if (lstatSync(target).isSymbolicLink()) throw refuse(); } catch (error) { if (error instanceof Refusal) throw error; }
    const from = join(root, `asked-${randomUUID()}`, basename(target));
    mkdirSync(dirname(from), { recursive: true, mode: 0o700 });
    moves.push({ from, to: resolve(target), base });
    return from;
  }

  /** A path in the output folder, or a refusal (through a link). A file there with another name (a hard link) is unlinked first, so the CLI never writes through it. */
  private inOutput(target: string, refuse: () => Refusal) {
    const root = this.paths.output;
    mkdirSync(root, { recursive: true });
    const inside = relative(root, target);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw refuse();
    let at = root;
    for (const part of inside.split(sep)) {
      at = join(at, part);
      try {
        if (lstatSync(at).isSymbolicLink()) throw refuse();
      } catch (error) {
        if (error instanceof Refusal) throw error;
        break;
      }
    }
    try {
      const info = lstatSync(target);
      if (!info.isFile() || info.nlink > 1) rmSync(target, { force: true });
    } catch { /* Not there yet. */ }
    return target;
  }

  /** The files the AI asked for in its work folder, hidden by the sweep, moved there (each: where it went, or why not). */
  private async placeAll(moves: Move[], removed: string[]): Promise<Placed[]> {
    const out: Placed[] = [];
    for (const move of moves) {
      const failed = (why: string): Placed => ({ ...move, asked: move.to, to: null, why });
      try {
        if (removed.includes(move.from)) { out.push(failed("removed")); continue; }
        let info;
        try { info = await lstat(move.from); } catch { out.push(failed("none")); continue; }
        if (!info.isFile()) { out.push(failed("not_file")); continue; }
        try {
          const done = await this.place(move.from, move.to, move.base);
          out.push(done.to ? { ...move, asked: move.to, ...done } : failed(done.why ?? "failed"));
        } catch { out.push(failed("failed")); }
      } finally {
        await rm(dirname(move.from), { recursive: true, force: true }).catch(() => undefined);
        this.lastMarks.delete(move.from);
      }
    }
    return out;
  }

  /** What the gateway itself put in work folders: a later command may write over these (and only these). */
  private readonly ownPlaced = new Map<string, string>();

  /**
   * One hidden file to its asked place in the work folder: folders made as needed, never through a
   * link; a file already there is written over only when it is this gateway's own earlier output
   * (the same file as it left it); otherwise the file goes under the next free name ("shot-2.png").
   */
  private async place(from: string, to: string, base: string): Promise<{ to: string | null; renamed?: boolean; why?: string }> {
    const folder = dirname(to);
    if (!noLinkBelow(base, folder)) return { to: null, why: "link" };
    mkdirSync(folder, { recursive: true });
    if (!noLinkBelow(base, folder)) return { to: null, why: "link" };
    const temp = join(folder, `.wb-place-${randomUUID()}`);
    await copyFile(from, temp, fsConstants.COPYFILE_EXCL);
    try {
      const ext = extname(to), stem = to.slice(0, to.length - ext.length);
      for (let round = 1; round < 100; round += 1) {
        const target = round === 1 ? to : `${stem}-${round}${ext}`;
        let existing: Awaited<ReturnType<typeof lstat>> | null = null;
        try { existing = await lstat(target); } catch { existing = null; }
        if (existing) {
          const own = existing.isFile() && this.ownPlaced.get(target) === `${existing.ino}:${existing.size}:${existing.mtimeMs}`;
          if (!own) continue;
          await rename(temp, target);
        } else {
          // link() never replaces: a file made meanwhile under this name stays as it is.
          try { await link(temp, target); } catch { continue; }
          await rm(temp, { force: true });
        }
        const info = await lstat(target);
        this.ownPlaced.set(target, `${info.ino}:${info.size}:${info.mtimeMs}`);
        return { to: target, ...(round > 1 ? { renamed: true } : {}) };
      }
      return { to: null, why: "taken" };
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  /**
   * An answer as the engine may read it: stored values replaced in its text and in the snapshot
   * files it links (the daemon writes them before it answers; they are rewritten before the engine
   * hears of them).
   */
  private async hidden(result: CliResult, cwd: string, name: string): Promise<CliResult> {
    const removed = await this.hideFiles(`${result.stdout}\n${result.stderr}`, cwd, name);
    return { ...result, stdout: await this.hideText(name, result.stdout + removedNote(removed)), stderr: await this.hideText(name, result.stderr) };
  }

  /** Long text hidden in pieces cut at line ends, with the event loop given a turn between them (ruling B). */
  private async hideText(name: string, text: string): Promise<string> {
    if (text.length <= TEXT_PIECE) return this.hide(name, text);
    const out: string[] = [];
    for (let at = 0; at < text.length;) {
      let end = Math.min(text.length, at + TEXT_PIECE);
      if (end < text.length) {
        const line = text.lastIndexOf("\n", end - 1);
        if (line >= at + TEXT_PIECE / 2) end = line + 1;
      }
      out.push(this.hide(name, text.slice(at, end)));
      at = end;
      if (at < text.length) await turn();
    }
    return out.join("");
  }

  /** What the byte scanner looks for in a browser output file: the stored values' forms and the typed values (`loose`: only those hidden anywhere in text). */
  private needleCache: { key: string; needles: Needles } | null = null;
  private needles(name: string, loose: boolean): Needles | null {
    const typed = this.typedIn.get(name);
    const live = typed && typed.until >= Date.now() ? stillTyped(typed.entries).map((entry) => entry.value).filter((value) => value && (!loose || (value.length >= 6 && !/^\d+$/.test(value)))) : [];
    const forms = [...new Set([...(this.storedNeedles?.() ?? []), ...live])];
    if (!forms.length) return null;
    const key = forms.join("\u0000");
    if (this.needleCache?.key !== key) this.needleCache = { key, needles: needlesOf(forms) };
    return this.needleCache.needles;
  }

  /**
   * Text from a window as anything but the gateway may see it: the scrubber, then the values typed
   * into it. JSON is judged decoded (ruling E): a string that is exactly a typed or stored value is
   * replaced whole, any other gets this text rule, and the JSON is written again.
   */
  private hide(name: string, text: string): string {
    const typed = this.typedIn.get(name);
    if (typed && typed.until < Date.now()) this.typedIn.delete(name);
    const live = typed && typed.until >= Date.now() ? stillTyped(typed.entries).filter((entry) => entry.value) : [];
    const rule = (part: string) => {
      const shown = this.scrubOutput ? this.scrubOutput(part) : part;
      return live.length ? hideTyped(shown, live) : shown;
    };
    const exact = (part: string) => {
      const hit = part ? live.find((entry) => entry.value === part) : undefined;
      return hit ? `[비밀: ${hit.label}]` : part ? this.storedExact?.(part) ?? null : null;
    };
    return hideDecoded(text, rule, exact) ?? rule(text);
  }

  /** Whether no value typed into this window shows as text on its page now (asked of the daemon directly: this runs inside the window's own turn). */
  private async showsNoTyped(name: string, cwd: string): Promise<boolean> {
    const typed = this.typedIn.get(name);
    if (!typed || typed.until < Date.now()) return true;
    const socket = daemonSocket(name, this.paths.profile, this.socketsDir);
    if (!socket) return false;
    const shown = await daemonRun(socket, { _: ["eval", SHOWN] }, { cwd, raw: true, timeoutMs: 10_000 });
    if (shown.error) return false;
    // The eval's answer is the page's JSON, quoted once or twice: read back to plain text before looking.
    let value: unknown = shown.text.trim();
    for (let round = 0; round < 3 && typeof value === "string"; round += 1) { try { value = JSON.parse(value as string); } catch { break; } }
    const page = value && typeof value === "object" ? value as { values?: unknown; text?: unknown; blind?: unknown } : { text: String(value) };
    // A frame or a shadow root the check could not read may show the value: no picture (fail closed).
    if ("blind" in page && Number(page.blind) > 0) return false;
    const text = [...(Array.isArray(page.values) ? page.values.map(String) : []), String(page.text ?? "")].join("\n");
    return hideTyped(text, stillTyped(typed.entries)) === text;
  }

  /**
   * The files an answer links (any title: a snapshot, find or eval results, console, anything later),
   * hidden in place when they lie in the output folder or a `.playwright-cli` folder of the work folder.
   */
  private async hideFiles(text: string, cwd: string, name: string) {
    const removed: string[] = [];
    // The output folder's files are the sweep's (every new or changed one, linked or not).
    const places = [...new Set([this.agent?.cwd ?? cwd, cwd].map((dir) => join(dir, ".playwright-cli")))];
    for (const [, file] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      for (const path of new Set([resolve(this.agent?.cwd ?? cwd, file!), resolve(cwd, file!)])) {
        if (!places.some((place) => path.startsWith(`${place}${sep}`))) continue;
        try {
          if (!lstatSync(path).isFile()) continue;
        } catch { continue; }
        if ((await this.hideFile(name, path)) === "removed") removed.push(path);
      }
    }
    return removed;
  }

  /** A file's mark (what it is now), or null when it is gone. */
  private markOf(path: string): string | null {
    try {
      const info = lstatSync(path);
      return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}:${info.nlink}`;
    } catch { return null; }
  }

  /** Every file in the output folder (its subfolders too) with what it is now. */
  private outputMarks(): Map<string, string> {
    const marks = new Map<string, string>();
    const walk = (dir: string, depth: number) => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        const path = join(dir, entry);
        try {
          const info = lstatSync(path);
          if (info.isDirectory() && depth < 8) walk(path, depth + 1);
          else marks.set(path, `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}:${info.nlink}`);
        } catch { /* Gone. */ }
      }
    };
    walk(this.paths.output, 0);
    return marks;
  }

  /** The output folder as the last sweep left it (each file's mark). */
  private lastMarks = new Map<string, string>();
  private sweeping: Promise<unknown> = Promise.resolve();

  /**
   * The output folder walked once (after a command): every file new or changed since the last sweep
   * (a file the daemon wrote between commands too) is hidden or removed, one sweep at a time, off
   * the event loop (ruling B). The removed ones.
   */
  private sweep(name: string): Promise<string[]> {
    const run = this.sweeping.then(async () => {
      const now = this.outputMarks();
      const removed: string[] = [];
      for (const [path, mark] of now) {
        if (this.lastMarks.get(path) === mark) continue;
        if ((await this.hideFile(name, path)) === "removed") { removed.push(path); now.delete(path); continue; }
        const after = this.markOf(path);
        if (after) now.set(path, after); else now.delete(path);
      }
      this.lastMarks = now;
      return removed;
    });
    this.sweeping = run.catch(() => undefined);
    return run;
  }

  /** The browser session ended: what its commands wrote in the output folder goes (minor of round 3). */
  private emptyOutput() {
    try {
      for (const entry of readdirSync(this.paths.output)) rmSync(join(this.paths.output, entry), { recursive: true, force: true });
    } catch { /* Nothing there. */ }
    this.lastMarks = new Map();
  }

  /**
   * One file as the engine may read it (ruling B: off the event loop, one scanner). It is opened
   * without following a link; a link, a file with another name (a hard link: nlink > 1) or one that
   * cannot be read is removed. Text up to 8 MiB is rewritten hidden in pieces (through a new file,
   * so a read-only one is replaced too) and then searched by bytes once more: a value the text rule
   * could not place removes it. Anything else is searched by the byte scanner of the outgoing-file
   * check (channels/file-scan.ts): a file that holds a value is removed, one that holds none is left.
   */
  private async hideFile(name: string, path: string): Promise<"kept" | "hidden" | "removed"> {
    const remove = async () => {
      await rm(path, { force: true }).catch(() => undefined);
      return "removed" as const;
    };
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return remove();
      if (!info.isFile()) return "kept";
    } catch { return "kept"; }
    let handle;
    try {
      handle = await openFile(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    } catch {
      return remove();
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) return "kept";
      // Another name of the same file (a hard link planted in the folder): never rewritten through it.
      if (info.nlink > 1) return await remove();
      if (info.size <= TEXT_MAX) {
        const bytes = await handle.readFile();
        if (!bytes.includes(0) && isUtf8(bytes)) {
          const text = bytes.toString("utf8");
          const shown = await this.hideText(name, text);
          let state: "kept" | "hidden" = "kept";
          if (shown !== text) {
            const temp = join(dirname(path), `.wb-hide-${randomUUID()}`);
            await writeFile(temp, shown, { mode: 0o600, flag: "wx" });
            await rename(temp, path);
            state = "hidden";
          }
          const verify = this.needles(name, true);
          const found = verify ? await contentReason(path, basename(path), verify) : null;
          return found === "secret-content" || found === "unreadable" ? await remove() : state;
        }
      }
      const needles = this.needles(name, false);
      if (!needles) return "kept";
      const found = await contentReason(path, basename(path), needles, undefined, () => handle!.createReadStream({ start: 0, autoClose: false, highWaterMark: 1024 * 1024 }));
      return found === "secret-content" || found === "unreadable" ? await remove() : "kept";
    } catch {
      return remove();
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * The gateway's own commands on a session's agent window (unit 9: a stored login typed by the
   * host), over the CLI daemon's socket (browse-host.ts): no process, no command line; one at a time
   * with the session's own commands. A code when there is no such window to use.
   */
  hostPage(sessionId: string): HostPage | "browser_off" | "shared_tab" | "needs_chromium" | "browser_missing" | "paused" | "login_window" | "no_page" {
    const entry = this.host?.lookup(sessionId);
    if (!entry?.session.browser) return "browser_off";
    if (entry.session.pageAgent || this.host?.hasPage?.(sessionId)) return "shared_tab";
    if (this.engine !== "chromium") return "needs_chromium";
    if (this.installer.state.state !== "ready") return "browser_missing";
    if (this.paused.has(sessionId)) return "paused";
    if (this.window.kind === "login") return "login_window";
    const name = browserSessionName(sessionId);
    if (this.agent?.name !== name || (this.agent.daemonPid && !alive(this.agent.daemonPid))) return "no_page";
    const cwd = this.agent.cwd;
    return hostPageOf(name, this.paths.profile, cwd, <T>(work: () => Promise<T>) => {
      const next = (this.chains.get(name) ?? Promise.resolve()).then(work);
      this.chains.set(name, next.then(() => undefined, () => undefined));
      return next;
    }, {
      typed: (label, values, key) => {
        const known = this.typedIn.get(name);
        const entries = [...(known && known.until >= Date.now() ? stillTyped(known.entries) : []), ...values.map((value) => ({ label, value, ...(key ? { key } : {}) }))];
        this.typedIn.set(name, { entries, until: Date.now() + TYPED_MS });
      },
      // A step's mark ends with its step; its value stays hidden two more minutes (round 4, ruling P4).
      forget: (key) => {
        const known = this.typedIn.get(name);
        if (!known) return;
        for (const entry of known.entries) if (entry.key === key && entry.goneAt === undefined) entry.goneAt = Date.now() + FORGET_MS;
      },
      live: () => {
        const known = this.typedIn.get(name);
        return Boolean(known && known.until >= Date.now() && stillTyped(known.entries).length);
      },
      hide: (text) => this.hide(name, text),
      files: async (text) => {
        await this.hideFiles(text, cwd, name);
        await this.sweep(name);
      },
      timedOut: (since) => this.sweepOutput(name, since),
      sockets: this.socketsDir,
      ...(this.options.hostTimeoutMs ? { timeoutMs: this.options.hostTimeoutMs } : {}),
    });
  }

  /**
   * A gateway command timed out: the daemon may still write its snapshot file, whose link never
   * comes back. The output folder's files from then on are rewritten hidden now and twice later.
   */
  private sweepOutput(name: string, _since: number) {
    const sweep = () => { void this.sweep(name).catch(() => undefined); };
    sweep();
    for (const delay of [10_000, 40_000]) setTimeout(sweep, delay).unref();
  }

  /** Remember the page the session is on and its last snapshot (for describing refs on approval cards). */
  private noteOutput(name: string, sessionId: string, result: CliResult, cwd: string) {
    const text = result.stdout;
    const url = /- Page URL: (.+)/.exec(text)?.[1]?.trim() ?? null;
    const title = /- Page Title: (.*)/.exec(text)?.[1]?.trim() ?? null;
    const inline = /### Snapshot\n```yaml\n([\s\S]*?)```/.exec(text)?.[1];
    const file = /\[Snapshot\]\(([^)]+)\)/.exec(text)?.[1];
    if (this.agent?.name === name) {
      if (inline) {
        this.agent.snapshot = this.hide(name, inline);
        this.agent.snapshotFile = null;
      } else if (file) {
        this.agent.snapshotFile = resolve(cwd, file);
      }
    }
    const current = this.window.kind === "agent" && this.window.sessionId === sessionId ? this.window : null;
    this.setWindow({ kind: "agent", sessionId, url: url ?? current?.url ?? null, title: title ?? current?.title ?? null, busy: false, at: Date.now() });
  }

  private lastSnapshot(name: string) {
    if (this.agent?.name !== name) return "";
    if (this.agent.snapshot) return this.agent.snapshot;
    try {
      return this.agent.snapshotFile ? readFileSync(this.agent.snapshotFile, "utf8") : "";
    } catch {
      return "";
    }
  }

  /** The real Playwright CLI, outside any engine sandbox, with this install's browser and no user overrides. */
  /** The daemons' sockets: in the data folder, this user's only (unit 9: the gateway's own commands go over them). */
  get socketsDir() {
    return join(this.paths.root, "s");
  }

  private cli(name: string, args: string[], cwd: string, timeout = 120_000): Promise<CliResult> {
    mkdirSync(this.socketsDir, { recursive: true, mode: 0o700 });
    chmodSync(this.socketsDir, 0o700);
    // PWTEST_CLI_GLOBAL_CONFIG: the home folder's ~/.playwright/cli.config.json (session or trace saving) is not merged in.
    const env = browserEnv({ PLAYWRIGHT_BROWSERS_PATH: this.paths.browsers, NO_UPDATE_NOTIFIER: "1", PWTEST_SOCKETS_DIR: this.socketsDir, PWTEST_CLI_GLOBAL_CONFIG: this.paths.root });
    // Variables that would override the config (another profile, browser or endpoint).
    for (const key of Object.keys(env)) if (key.startsWith("PLAYWRIGHT_MCP_") || key === "PLAYWRIGHT_CLI_SESSION") delete env[key];
    return new Promise((done) => {
      execFile(process.execPath, [this.cliJs, `-s=${name}`, ...args], { cwd: existsSync(cwd) ? cwd : this.paths.root, env, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
        done({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }

  // ---- the one window ---------------------------------------------------------------------------

  /** A live process holding the profile (Chromium's SingletonLock), other than ours. */
  private profileHolder(): number | null {
    try {
      const target = readlinkSync(join(this.paths.profile, "SingletonLock"));
      const at = target.lastIndexOf("-");
      const host = target.slice(0, at);
      const pid = Number(target.slice(at + 1));
      return host === hostname() && alive(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  /** Open this session's window unless it is open; another session's idle window is closed first. */
  private async ensureWindow(session: Session, work: Work) {
    const name = browserSessionName(session.id);
    if (this.agent?.name === name && (!this.agent.daemonPid || alive(this.agent.daemonPid))) return;
    if (this.agent && this.agent.name !== name) {
      const other = this.host?.lookup(this.agent.sessionId);
      if (other && isBusy(other.session) && Date.now() - this.agent.lastAt < IN_USE_MS) {
        throw new Refusal(`다른 세션('${other.session.purpose}')이 지금 브라우저를 쓰고 있습니다. 한 번에 한 세션만 쓸 수 있으니 그 작업이 끝난 뒤에 다시 시도하세요.`);
      }
      await this.closeAgent();
    }
    if (this.window.kind === "login") throw new Refusal("사용자가 브라우저 창에서 로그인하는 중입니다. 로그인 창이 닫힌 뒤에 다시 시도하세요.");
    if (this.profileHolder()) throw new Refusal("다른 브라우저 창이 에이전트 브라우저 프로필을 쓰고 있습니다. 사용자에게 그 창을 닫아 달라고 하세요.");
    this.writeConfig();
    const result = await this.cli(name, ["open", "about:blank", `--config=${this.paths.config}`], work.cwd, 90_000);
    if (result.code !== 0) throw new Refusal(`브라우저 창을 열지 못했습니다: ${lastLine(result)}`);
    const pid = Number(/opened with pid (\d+)/.exec(result.stdout)?.[1] ?? 0) || null;
    this.agent = { name, sessionId: session.id, cwd: existsSync(work.cwd) ? work.cwd : this.paths.root, daemonPid: pid, lastAt: Date.now(), snapshot: null, snapshotFile: null };
    this.setWindow({ kind: "agent", sessionId: session.id, url: "about:blank", title: null, busy: false, at: Date.now() });
  }

  /** The agent's window is gone (closed here, by the user, or its process ended). */
  private dropAgent() {
    if (this.agent) this.typedIn.delete(this.agent.name);
    this.emptyOutput();
    this.agent = null;
    if (this.window.kind === "agent") this.setWindow({ kind: "closed" });
    this.refreshSignedIn();
  }

  private async closeAgent() {
    const agent = this.agent;
    if (!agent) return;
    await this.cli(agent.name, ["close"], agent.cwd, 30_000);
    // The daemon exits once its browser is closed; give Chromium a moment to let go of the profile.
    for (let index = 0; index < 50 && (alive(agent.daemonPid) || this.profileHolder()); index += 1) await new Promise((done) => setTimeout(done, 100));
    if (this.agent === agent) this.dropAgent();
  }

  /** `close` from the session's own engine: its window, if it holds it. */
  private async closeOwn(sessionId: string): Promise<CliResult> {
    if (this.engine === "lightpanda") {
      await this.panda.close(browserSessionName(sessionId));
      if (this.window.kind === "agent" && this.window.sessionId === sessionId) this.setWindow({ kind: "closed" });
      return { code: 0, stdout: "백그라운드 브라우저 세션을 닫았습니다.\n", stderr: "" };
    }
    if (this.agent?.sessionId !== sessionId) return { code: 0, stdout: "브라우저 창이 이미 닫혀 있습니다.\n", stderr: "" };
    await this.closeAgent();
    return { code: 0, stdout: "브라우저 창을 닫았습니다. 로그인 상태는 프로필에 남아 있습니다.\n", stderr: "" };
  }

  private armIdle() {
    const ms = this.options.idleCloseMs ?? 30 * 60_000;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      const agent = this.agent;
      const owner = agent ? this.host?.lookup(agent.sessionId) : null;
      if (agent && (!owner || !isBusy(owner.session))) void this.closeAgent();
      else if (agent) this.armIdle();
    }, ms);
    this.idle.unref();
  }

  /**
   * A plain launch of the same Chromium on the same profile, for the user to sign in: no
   * automation switches (sites like Google refuse sign-in in automated browsers), the same
   * cookie encryption as the agent's launches. The agent's window is closed first (one Chromium
   * per profile); with the sign-in window already open the address opens as a new tab in it.
   */
  async openLogin(rawUrl: string | null) {
    if (this.engine === "lightpanda") throw new HttpError(409, "browser_login", "직접 로그인하려면 호환 브라우저를 선택하세요. 프로필은 별도로 유지됩니다.");
    if (this.installer.state.state !== "ready") throw new HttpError(409, "browser_missing", "에이전트 브라우저를 먼저 설치하세요.");
    const url = this.loginUrl(rawUrl);
    const chrome = this.options.chrome ?? this.paths.chrome;
    const args = [`--user-data-dir=${this.paths.profile}`, PASSWORD_STORE, "--no-first-run", "--no-default-browser-check", ...(this.options.headless ? ["--headless=new"] : []), url];
    if (!this.login || !alive(this.login.pid)) noPasswordManager(this.paths.profile);
    if (this.login && alive(this.login.pid)) {
      spawn(chrome, args, { stdio: "ignore", detached: true, env: browserEnv() }).unref();
      this.setWindow({ kind: "login", url });
      return this.status();
    }
    if (this.agent) await this.closeAgent();
    if (this.profileHolder()) throw new HttpError(409, "profile_busy", "다른 브라우저 창이 이 프로필을 쓰고 있습니다. 그 창을 닫은 뒤 다시 시도하세요.");
    const child = spawn(chrome, args, { stdio: "ignore", detached: true, env: browserEnv() });
    child.unref();
    if (!child.pid) throw new HttpError(500, "browser_failed", "브라우저를 열지 못했습니다.");
    this.login = { pid: child.pid, child };
    child.on("exit", () => {
      if (this.login?.child === child) this.loginClosed();
    });
    this.setWindow({ kind: "login", url });
    return this.status();
  }

  private loginUrl(raw: string | null) {
    const text = raw?.trim();
    if (!text) return LOGIN_SITES[0]!.url;
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
      return url.href;
    } catch {
      throw new HttpError(400, "invalid_url", "웹 주소(https://…)를 입력하세요.");
    }
  }

  /** Close the sign-in window (Chromium saves what it has on a normal close). */
  async closeLogin() {
    const login = this.login;
    if (!login) return this.status();
    try {
      process.kill(login.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    for (let index = 0; index < 100 && alive(login.pid); index += 1) await new Promise((done) => setTimeout(done, 100));
    if (this.login === login) this.loginClosed();
    return this.status();
  }

  private loginClosed() {
    this.login = null;
    if (this.window.kind === "login") this.setWindow({ kind: "closed" });
    this.refreshSignedIn();
  }

  /**
   * After a restart: a Chromium still holding the profile is either the sign-in window (kept, and
   * watched) or an agent window of the last run (closed: its session will open a fresh one).
   */
  private async adoptRunning() {
    const pid = this.profileHolder();
    if (!pid) return;
    let command = "";
    try {
      command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      return;
    }
    if (!command.includes(this.paths.profile)) return;
    if (!command.includes("--remote-debugging-pipe")) {
      this.login = { pid, child: null };
      this.setWindow({ kind: "login", url: null });
      return;
    }
    await this.closeStaleDaemons();
  }

  /** Agent windows a previous gateway left open on this profile: closed by their session names. */
  private async closeStaleDaemons() {
    const base = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ms-playwright", "daemon");
    let folders: string[] = [];
    try {
      folders = readdirSync(base);
    } catch {
      return;
    }
    for (const folder of folders) {
      let files: string[] = [];
      try {
        files = readdirSync(join(base, folder)).filter((file) => /^wb-[a-z0-9]+\.session$/.test(file));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const config = JSON.parse(readFileSync(join(base, folder, file), "utf8")) as { name: string; socketPath?: string; workspaceDir?: string; browser?: { userDataDir?: string } };
          if (config.browser?.userDataDir !== this.paths.profile || !config.socketPath) continue;
          const open = await new Promise<boolean>((done) => {
            const socket = connect(config.socketPath!, () => {
              socket.destroy();
              done(true);
            });
            socket.on("error", () => done(false));
          });
          if (open) await this.cli(config.name, ["close"], config.workspaceDir ?? this.paths.root, 30_000);
        } catch {
          // Not ours, or unreadable.
        }
      }
    }
  }

  private refreshSignedIn() {
    const sites = readSignedIn(this.paths.profile);
    if (sites && sites.join() !== this.signedIn.join()) {
      this.signedIn = sites;
      this.publish();
    }
  }

  /** Bring the window to the front: niri's IPC when present, by the browser's process. */
  async focus(): Promise<{ ok: boolean; message: string }> {
    if (this.engine === "lightpanda") return { ok: false, message: "Lightpanda는 백그라운드에서 탐색하므로 표시할 창이 없습니다." };
    const roots = this.login ? [this.login.pid] : this.agent?.daemonPid ? childrenOf(this.agent.daemonPid) : [];
    if (!roots.length) return { ok: false, message: "열린 브라우저 창이 없습니다." };
    const pids = new Set(roots.flatMap((pid) => [pid, ...childrenOf(pid)]));
    try {
      const { stdout } = await run("niri", ["msg", "--json", "windows"], { timeout: 3000 });
      const target = (JSON.parse(stdout) as { id: number; pid: number | null }[]).find((window) => window.pid !== null && pids.has(window.pid));
      if (target) {
        await run("niri", ["msg", "action", "focus-window", "--id", String(target.id)], { timeout: 3000 });
        return { ok: true, message: "" };
      }
    } catch {
      // Not niri, or no such window.
    }
    return { ok: false, message: "창을 앞으로 가져오지 못했습니다. 작업 표시줄이나 창 목록에서 Chromium 창을 고르세요." };
  }

  /** "멈춤": the session's commands are refused (the window stays for the user) until resumed. */
  setPaused(sessionId: string, paused: boolean) {
    if (paused) {
      this.paused.add(sessionId);
      this.expire(sessionId, "decline");
      if (this.engine === "lightpanda") this.panda.stop(browserSessionName(sessionId));
    } else {
      this.paused.delete(sessionId);
    }
    this.publish();
    return this.status();
  }

  // ---- approval cards -----------------------------------------------------------------------------

  private ask(sessionId: string, title: string, detail: string, reason: string) {
    const item: Pending["item"] = { kind: "approval", id: `browser:${randomUUID()}`, title, detail, reason, decision: null, at: Date.now() };
    this.host?.upsertItem(sessionId, item);
    this.host?.updateSession(sessionId, { status: "awaitingApproval", activity: "승인 필요" });
    return new Promise<boolean>((resolve) => this.approvals.set(item.id, { sessionId, item, resolve }));
  }

  /** An answer to one of the gateway's own cards; false when it is not one (or already settled). */
  answer(sessionId: string, itemId: string, decision: ApprovalDecision) {
    const pending = this.approvals.get(itemId);
    if (!pending || pending.sessionId !== sessionId) return false;
    this.settle(itemId, pending, decision);
    return true;
  }

  private settle(itemId: string, pending: Pending, decision: ApprovalDecision | "expired") {
    this.approvals.delete(itemId);
    this.host?.upsertItem(pending.sessionId, { ...pending.item, decision });
    const waiting = [...this.approvals.values()].some((other) => other.sessionId === pending.sessionId);
    const session = this.host?.lookup(pending.sessionId)?.session;
    if (!waiting && session?.status === "awaitingApproval") this.host?.updateSession(pending.sessionId, { status: "running", activity: "브라우저 사용 중" });
    pending.resolve(decision === "accept");
  }

  /** Settle a session's open cards (a stop, a pause, the browser switched off). */
  expire(sessionId: string, decision: ApprovalDecision | "expired" = "expired") {
    for (const [itemId, pending] of [...this.approvals]) if (pending.sessionId === sessionId) this.settle(itemId, pending, decision);
  }

  /** A raised access answers the cards it no longer asks for (as engines do). */
  accessChanged(sessionId: string, access: AccessMode) {
    if (access !== "full") return;
    for (const [itemId, pending] of [...this.approvals]) if (pending.sessionId === sessionId) this.settle(itemId, pending, "accept");
  }

  // ---- engines --------------------------------------------------------------------------------------

  engineHooks(): BrowserEngineHooks {
    return {
      pathDirs: () => [this.paths.bin],
      sessionEnv: (session): Record<string, string> => (session.browser ? { PLAYWRIGHT_CLI_SESSION: browserSessionName(session.id) } : {}),
      instructions: (session) => {
        if (!session.browser) return null;
        const name = browserSessionName(session.id);
        if (session.pageAgent || this.host?.hasPage?.(session.id)) return `${SHARED_BROWSER_HELP}\nYour browser session: playwright-cli -s=${name}${session.pageAgent ? "" : "\nOn a new user request after human interaction, tab-open <current URL> resumes control of your existing tab. Snapshot first to confirm its current address."}`;
        return `${browserInstructions(name, this.engine)}\nFor a visible Workbench web tab or a site the user signed into in Workbench, use playwright-cli tab-open <http(s) URL>. This uses the native default browser profile and routes subsequent snapshot/read/fill/click/navigation commands to that same page, not Lightpanda. Existing login state in that profile is used automatically; it does not import logins from other apps or profiles. Public background research may keep the default browser. Never silently switch browsers after an error.\nAfter tab-open, the shared-tab driver works as follows:\n${SHARED_BROWSER_HELP}`;
      },
      offNote: (session) => browserOffNote(browserSessionName(session.id)),
      allowsCommand: (sessionId, command) => Boolean(this.host?.lookup(sessionId)?.session.browser) && isPlainBrowserCommand(command),
      writableRoots: (session) => (session.browser ? [join(this.paths.spool, browserSessionName(session.id))] : []),
      told: (sessionId) => this.told[sessionId] ?? null,
      setTold: (sessionId, on) => {
        this.told[sessionId] = on;
        writeFileSync(this.paths.told, JSON.stringify(this.told));
      },
    };
  }

  async shutdown() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    if (this.idle) clearTimeout(this.idle);
    for (const watcher of this.watchers.values()) watcher.close();
    for (const sessionId of new Set([...this.approvals.values()].map((pending) => pending.sessionId))) this.expire(sessionId);
    // The agent's window goes with the app; a sign-in window is the user's and stays.
    await this.closeAgent().catch(() => undefined);
    await this.panda.shutdown();
  }
}
