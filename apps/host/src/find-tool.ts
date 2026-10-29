import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Session } from "@workbench/contracts";
import type { BrowserEngineHooks } from "./browse.ts";
import { launcherSource } from "./browse-wrapper.ts";
import type { EventBus } from "./bus.ts";
import { findUsage, type Finder } from "./search.ts";

// `workbench-find`: the engines' way to Workbench's records — the same index and syntax as
// Ctrl+K (search.ts), read only, no model. It works like the agent browser's playwright-cli
// wrapper (browse-wrapper.ts): the command writes its request as a file into its session's spool
// folder and the gateway answers with a file, because Codex's sandbox lets a command write into a
// folder it is given but not connect anywhere. The session is named by WORKBENCH_FIND_SESSION
// (Claude's process) or by the Codex thread the command runs in (CODEX_THREAD_ID, threads.json).

const WRAPPER = String.raw`// Achmage Workbench: workbench-find for engine sessions (written by the gateway; see find-tool.ts).
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const ROOT = __ROOT__;
const USAGE = __USAGE__;
const argv = process.argv.slice(2);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const say = (fd, text) => { if (text) writeSync(fd, text); };

function sessionName() {
  if (process.env.WORKBENCH_FIND_SESSION) return process.env.WORKBENCH_FIND_SESSION;
  const thread = process.env.CODEX_THREAD_ID;
  if (thread) {
    try {
      return JSON.parse(readFileSync(join(ROOT, "threads.json"), "utf8"))[thread] ?? null;
    } catch {}
  }
  return null;
}

function main() {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    say(argv.length ? 1 : 2, USAGE + "\n");
    return argv.length ? 0 : 2;
  }
  const name = sessionName();
  if (!name || !/^wf-[a-z0-9]+$/.test(name)) {
    say(2, "workbench-find: Achmage Workbench 세션 안에서만 쓸 수 있습니다.\n");
    return 1;
  }
  const dir = join(ROOT, "spool", name);
  if (!existsSync(dir)) {
    say(2, "workbench-find: 이 세션의 찾기 폴더가 없습니다. Workbench가 켜져 있는지 사용자에게 확인하세요.\n");
    return 1;
  }
  const id = Date.now().toString(36) + "-" + randomBytes(4).toString("hex");
  const request = join(dir, id + ".req.json");
  const response = join(dir, id + ".res.json");
  try {
    writeFileSync(request + ".tmp", JSON.stringify({ id, args: argv, cwd: process.cwd() }));
    renameSync(request + ".tmp", request);
  } catch {
    // A read-only turn ("계획 먼저", or a work folder inside the vault) cannot write anywhere.
    say(2, "workbench-find: 이 턴은 읽기 전용이라 Workbench 기록을 찾을 수 없습니다. 다음 요청에서 다시 해 보세요.\n");
    return 1;
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (existsSync(response)) {
      let result;
      try {
        result = JSON.parse(readFileSync(response, "utf8"));
      } catch {
        Atomics.wait(sleeper, 0, 0, 30);
        continue;
      }
      rmSync(response, { force: true });
      say(1, result.stdout);
      say(2, result.stderr);
      return typeof result.code === "number" ? result.code : 1;
    }
    Atomics.wait(sleeper, 0, 0, 30);
  }
  rmSync(request, { force: true });
  say(2, "workbench-find: Workbench가 1분 동안 답하지 않았습니다. 사용자에게 알리세요.\n");
  return 1;
}

process.exitCode = main();
`;

/** The wrapper's JavaScript for a find folder. */
export function findWrapperSource(root: string) {
  return WRAPPER.replace("__ROOT__", JSON.stringify(root)).replace("__USAGE__", JSON.stringify(findUsage()));
}

/** A session's name in the spool: `wf-` and its id's letters and digits. */
export const findSessionName = (sessionId: string) => `wf-${sessionId.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

/**
 * A command line that only runs workbench-find (or several joined with `&&`), with no pipe,
 * redirection or substitution: read only, so it runs without an approval card under any access.
 */
export function isPlainFindCommand(line: string): boolean {
  let text = line.trim();
  const wrapped = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(text);
  if (wrapped) text = wrapped[2]!.trim();
  return text.split("&&").every((part) => isOneFindCommand(part.trim()));
}

function isOneFindCommand(text: string) {
  if (!/^workbench-find(?:\s|$)/.test(text)) return false;
  // Quoted arguments are fine; inside double quotes `$`, backquote and backslash still expand.
  const unquoted = text.replace(/'[^']*'/g, "''").replace(/"[^"$`\\]*"/g, '""');
  return !/[;&|`$<>\\\n\r(){}'"]/.test(unquoted.replace(/''|""/g, ""));
}

export type FindToolOptions = {
  dataDir: string;
  finder: Finder;
  sessions: () => ReadonlyMap<string, Session>;
  bus: EventBus;
  /** How often spool folders are looked at besides their watchers (tests shorten it). */
  pollMs?: number;
};

type FindRequest = { id: string; args: string[]; cwd: string | null };

export class FindTool {
  readonly root: string;
  readonly bin: string;
  readonly spool: string;
  private readonly threadsFile: string;
  private readonly options: FindToolOptions;
  /** spool name -> session id */
  private readonly byName = new Map<string, string>();
  /** Codex thread id -> spool name, as threads.json last had it */
  private threads = new Map<string, string>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly poll: NodeJS.Timeout;
  private readonly unsubscribe: () => void;

  constructor(options: FindToolOptions) {
    this.options = options;
    this.root = join(options.dataDir, "find");
    this.bin = join(this.root, "bin");
    this.spool = join(this.root, "spool");
    this.threadsFile = join(this.root, "threads.json");
    for (const dir of [this.root, this.bin, this.spool]) mkdirSync(dir, { recursive: true });
    // Requests and answers carry the user's records: this user's alone.
    chmodSync(this.root, 0o700);
    // Rewritten each start: the launcher names this gateway's Node.
    const script = join(this.bin, "workbench-find.mjs");
    writeFileSync(script, findWrapperSource(this.root));
    writeFileSync(join(this.bin, "workbench-find"), launcherSource(process.execPath, script), { mode: 0o755 });
    chmodSync(join(this.bin, "workbench-find"), 0o755);
    for (const session of options.sessions().values()) this.sessionChanged(session);
    this.writeThreads(true);
    this.unsubscribe = options.bus.subscribe((event) => {
      if (event.type === "session.upserted") this.sessionChanged(event.session);
    });
    // Watchers can miss a file: a slow look as well.
    this.poll = setInterval(() => this.tick(), options.pollMs ?? 500);
    this.poll.unref();
  }

  /** A session changed: its name is known, and a Codex thread id goes into threads.json. */
  private sessionChanged(session: Session) {
    const name = findSessionName(session.id);
    this.byName.set(name, session.id);
    if (session.provider !== "codex" || !session.nativeSessionId || this.threads.get(session.nativeSessionId) === name) return;
    this.threads.set(session.nativeSessionId, name);
    this.writeThreads();
  }

  private writeThreads(force = false) {
    if (!force && !this.threads.size) return;
    writeFileSync(`${this.threadsFile}.tmp`, JSON.stringify(Object.fromEntries(this.threads)));
    renameSync(`${this.threadsFile}.tmp`, this.threadsFile);
  }

  /** The session's spool folder, made (and watched) on first use. */
  private spoolOf(session: Session) {
    const name = findSessionName(session.id);
    this.byName.set(name, session.id);
    const dir = join(this.spool, name);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!this.watchers.has(name)) {
      try {
        const watcher = watch(dir, { persistent: false }, (_event, file) => {
          if (file && String(file).endsWith(".req.json")) this.take(name, String(file));
        });
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(name);
        });
        this.watchers.set(name, watcher);
      } catch {
        // The slow look still finds requests.
      }
    }
    return dir;
  }

  private tick() {
    let names: string[];
    try {
      names = readdirSync(this.spool);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      const dir = join(this.spool, name);
      try {
        for (const file of readdirSync(dir)) {
          if (file.endsWith(".req.json")) this.take(name, file);
          // Answers nobody picked up (the command was stopped) do not stay.
          else if (file.endsWith(".res.json") && now - statSync(join(dir, file)).mtimeMs > 10 * 60_000) rmSync(join(dir, file), { force: true });
        }
      } catch {
        // Gone meanwhile.
      }
    }
  }

  /** Answer one request file (search.ts `find`), then take it away. */
  private take(name: string, file: string) {
    const path = join(this.spool, name, file);
    let request: FindRequest;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      rmSync(path, { force: true });
      request = {
        id: String(raw.id ?? ""),
        args: Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === "string").slice(0, 40) : [],
        cwd: typeof raw.cwd === "string" ? raw.cwd : null,
      };
    } catch {
      return;
    }
    if (!/^[a-z0-9-]{4,40}$/.test(request.id)) return;
    const sessionId = this.byName.get(name);
    let result: { code: number; stdout: string; stderr: string };
    try {
      result = sessionId && this.options.sessions().has(sessionId)
        ? this.options.finder.find(request.args, { sessionId, cwd: request.cwd })
        : { code: 1, stdout: "", stderr: "workbench-find: 이 세션을 Workbench에서 찾지 못했습니다.\n" };
    } catch (error) {
      result = { code: 1, stdout: "", stderr: `workbench-find: 찾지 못했습니다: ${error instanceof Error ? error.message : String(error)}\n` };
    }
    const out = join(this.spool, name, `${request.id}.res.json`);
    try {
      writeFileSync(`${out}.tmp`, JSON.stringify(result));
      renameSync(`${out}.tmp`, out);
    } catch {
      // The folder went away meanwhile.
    }
  }

  /** What the engine adapters need: the command on PATH, the session's name, its writable spool, no card. */
  engineHooks() {
    return {
      pathDirs: () => [this.bin],
      sessionEnv: (session: Session): Record<string, string> => {
        this.spoolOf(session);
        return { WORKBENCH_FIND_SESSION: findSessionName(session.id) };
      },
      writableRoots: (session: Session) => [this.spoolOf(session)],
      allowsCommand: (command: string) => isPlainFindCommand(command),
    };
  }

  close() {
    clearInterval(this.poll);
    this.unsubscribe();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}

/**
 * The hooks the engine adapters get: the agent browser's (browse.ts) with workbench-find added
 * (its folder on PATH, its session variable, its spool among the writable folders, and its plain
 * command lines let through without a card, since it only reads).
 */
export function withFindTool(browser: BrowserEngineHooks | null, find: ReturnType<FindTool["engineHooks"]>): BrowserEngineHooks {
  return {
    pathDirs: () => [...(browser?.pathDirs() ?? []), ...find.pathDirs()],
    sessionEnv: (session) => ({ ...(browser?.sessionEnv(session) ?? {}), ...find.sessionEnv(session) }),
    instructions: (session) => browser?.instructions(session) ?? null,
    offNote: (session) => browser?.offNote(session) ?? "",
    allowsCommand: (sessionId, command) => Boolean(browser?.allowsCommand(sessionId, command)) || find.allowsCommand(command),
    writableRoots: (session) => [...(browser?.writableRoots(session) ?? []), ...find.writableRoots(session)],
    told: (sessionId) => browser?.told(sessionId) ?? null,
    setTold: (sessionId, on) => browser?.setTold(sessionId, on),
  };
}
