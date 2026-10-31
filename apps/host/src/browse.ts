import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { connect } from "node:net";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  LOGIN_SITES,
  browserSessionName,
  type AccessMode,
  type AgentBrowserStatus,
  type AgentBrowserWindow,
  type ApprovalDecision,
  type Session,
  type TranscriptItem,
  type Work,
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
import { HttpError } from "./errors.ts";
import { LightpandaBrowser, LightpandaInstall, LIGHTPANDA_VERSION, LIGHTPANDA_HELP } from "./browse-lightpanda.ts";

const run = promisify(execFile);

// The agent browser: one Chromium window on one persistent profile in the app data folder, so a
// sign-in done once stays across app restarts. The gateway owns that window. Engines send
// `playwright-cli` commands through the wrapper on their PATH; the gateway checks each against
// the session's access (approval cards like an engine's), then runs the real Playwright CLI
// outside any engine sandbox. Signing in happens in a plain launch of the same Chromium on the
// same profile (no automation, which Google refuses), never at the same time as the agent.

/** Both launches must agree on how Chromium encrypts cookies, or saved sign-ins read as logged out. */
const PASSWORD_STORE = "--password-store=basic";

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
};

/** What engine adapters ask of the agent browser (both engines the same way). */
export type BrowserEngineHooks = {
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

  constructor(options: AgentBrowserOptions) {
    this.options = options;
    this.paths = browserPaths(options.dataDir);
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(join(this.paths.root, "engine.json"), "utf8")).engine; } catch { /* first launch */ }
    this.engine = options.engine ?? (options.cli ? "chromium" : saved === "chromium" ? "chromium" : "lightpanda");
    const pandaInstall = new LightpandaInstall(this.paths.root);
    this.panda = new LightpandaBrowser(options.lightpanda ?? pandaInstall.binary, options.idleCloseMs);
    this.pandaInstaller = new BrowserInstaller({ ready: () => Boolean(options.lightpanda) || pandaInstall.ready(), steps: () => pandaInstall.steps(), onChange: () => this.publish(), versions: { cli: "MCP", browser: LIGHTPANDA_VERSION } });
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
    const headless = Boolean(this.options.headless);
    const config = {
      browser: {
        browserName: "chromium",
        userDataDir: this.paths.profile,
        // A window the user sees; headless only in checks. Chromium's own sandbox stays on.
        launchOptions: { headless, chromiumSandbox: true, ...(headless ? { channel: "chromium" } : {}) },
        contextOptions: { viewport: null },
      },
      outputDir: this.paths.output,
    };
    writeFileSync(this.paths.config, JSON.stringify(config, null, 2));
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
    for (const sessionId of this.known.keys()) this.expire(sessionId);
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
    const reply = (result: CliResult) => {
      this.inFlight.delete(key);
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
    // Help and the version change nothing.
    if (!parsed.command || parsed.help || request.args.includes("--version")) return this.engine === "lightpanda" ? { code: 0, stdout: LIGHTPANDA_HELP, stderr: "" } : this.cli(name, request.args.filter((arg) => !/^(?:-s|--session)(=|$)/.test(arg)), this.paths.root);
    const kind = browserCommandKind(parsed.command);
    if (kind === "blocked") throw new Refusal(`'${parsed.command}' 명령은 Workbench 브라우저에서 쓸 수 없습니다(쿠키·저장소·네트워크 기록·창 관리는 막혀 있습니다).`);
    if (this.installer.state.state !== "ready") throw new Refusal("에이전트 브라우저가 아직 설치되지 않았습니다. 사용자에게 '브라우저 › 설치'를 부탁하세요.");
    this.blocker(sessionId);
    if (parsed.command === "close") return this.closeOwn(sessionId);
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
      this.blocker(sessionId);
      if (!this.waiting(name, request.id)) throw new Refusal("명령이 이미 끝나 실행하지 않았습니다.");
    }
    if (url) this.sites.set(sessionId, sites.add(url.host));
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
    const args = parsed.command === "open" ? (url ? ["goto", url.href] : ["snapshot"]) : [parsed.command, ...this.absolutePaths(parsed.command, parsed.args, request.cwd)];
    agent.lastAt = Date.now();
    this.setWindow({ ...(this.window.kind === "agent" ? this.window : { kind: "agent", sessionId, url: null, title: null, at: Date.now() }), busy: true } as AgentBrowserWindow);
    let result = await this.cli(name, args, agent.cwd);
    if (/is not open|not open, please run open/i.test(`${result.stdout}${result.stderr}`)) {
      // The window was closed under us (by the user): open it again once.
      this.dropAgent();
      const again = this.host?.lookup(sessionId) ?? entry;
      await this.ensureWindow(again.session, again.work);
      result = await this.cli(name, args, this.agent!.cwd);
    }
    result = { ...result, stdout: absoluteLinks(result.stdout, this.agent?.cwd ?? agent.cwd, resolve) };
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

  /** Relative files in commands that read or write them are the engine's working folder's. */
  private absolutePaths(command: string, args: string[], cwd: string) {
    const absolute = (value: string) => (isAbsolute(value) ? value : resolve(cwd, value));
    return args.map((arg) => {
      const flag = /^(--filename=|--path=)(.+)$/.exec(arg);
      if (flag) return `${flag[1]}${absolute(flag[2]!)}`;
      if (command === "upload" && !arg.startsWith("-")) return absolute(arg);
      return arg;
    });
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
        this.agent.snapshot = inline;
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
  private cli(name: string, args: string[], cwd: string, timeout = 120_000): Promise<CliResult> {
    const env = browserEnv({ PLAYWRIGHT_BROWSERS_PATH: this.paths.browsers, NO_UPDATE_NOTIFIER: "1" });
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
      instructions: (session) => (session.browser ? browserInstructions(browserSessionName(session.id), this.engine) : null),
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
