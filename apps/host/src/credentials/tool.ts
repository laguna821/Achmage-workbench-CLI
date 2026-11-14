import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Session } from "@workbench/contracts";
import type { BrowserEngineHooks } from "../browse.ts";
import { cmdLauncherSource, launcherSource } from "../browse-wrapper.ts";
import type { EventBus } from "../bus.ts";
import { findSessionName, findWrapperSource, isPlainFindCommand } from "../find-tool.ts";
import type { ToolAnswer } from "./service.ts";

// `workbench-credential`: the AI's way to the credential store, knowing names only. The same
// transport as workbench-find and workbench-desktop: the command writes its request as a file into
// its conversation's spool folder and the gateway answers with a file (Codex's sandbox lets a
// command write into a folder it is given, not connect anywhere). What tells the gateway which
// conversation asks is the folder the request is in: `<data>/credential-tool/spool/wf-<session>`,
// made by the gateway under a 0700 folder, given to that conversation only (Claude: its variable;
// Codex: its thread id in threads.json; Codex's sandbox: the only writable root among the spools).
// Requests in any other folder are not read. A program running as the same OS user can write
// there too: that is the same trust the other engine tools have.

const USAGE = `workbench-credential list
workbench-credential need --name <이름> --kind login|api-key|card|other --site <사이트> --fields <칸1,칸2>
workbench-credential fill --name <이름> --ref <칸>=<참조> [--ref …] [--submit <참조>]
workbench-credential step --name <이름> --kind code|approve|link|pc …
workbench-credential mcp …   (아직 없음: fail:not_available_yet)`;

const INSTRUCTIONS = `Credentials only the person has (a site login, a one-time code, an API key, a card): use workbench-credential. You never see the values.
- workbench-credential list: names, kinds and sites in the store.
- workbench-credential need --name <short name> --kind login|api-key|card|other --site <site or service> --fields <field1,field2>
  ok: it is in the store. fail:handover_sent: the person was asked for it; write one short status line and end your turn. When it is ready, a request "[자동 이어 하기] …" comes in this conversation: continue where you stopped. fail:handover_waiting: already asked; end your turn the same way.
- Never ask for a password, code or key in the conversation, and never print or echo one.
- mcp answers fail:not_available_yet for now.`;

export type CredentialToolOptions = {
  dataDir: string;
  sessions: ReadonlyMap<string, Session>;
  bus: EventBus;
  /** The answer to one command of a conversation (CredentialService.run). */
  run: (sessionId: string, args: string[]) => Promise<ToolAnswer>;
  /** Unit 9: the lines of `fill` and `step` (credentials/fill.ts), when the gateway has them. */
  instructions?: string;
  pollMs?: number;
};

export class CredentialTool {
  readonly root: string;
  private readonly bin: string;
  private readonly options: CredentialToolOptions;
  private readonly byName = new Map<string, string>();
  private readonly threads = new Map<string, string>();
  private readonly busy = new Set<string>();
  /** Spool folders handed to an engine (its conversation ran with the tool): the only ones looked at. */
  private readonly active = new Map<string, { sessionId: string; watcher: FSWatcher | null }>();
  private readonly timer: NodeJS.Timeout;
  private readonly unsubscribe: () => void;

  constructor(options: CredentialToolOptions) {
    this.options = options;
    this.root = join(options.dataDir, "credential-tool");
    this.bin = join(this.root, "bin");
    mkdirSync(this.bin, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, "spool"), { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    // Rewritten each start: the launcher names this gateway's Node.
    const script = join(this.bin, "workbench-credential.mjs");
    writeFileSync(script, findWrapperSource(this.root, USAGE)
      .replaceAll("workbench-find", "workbench-credential").replaceAll("WORKBENCH_FIND_SESSION", "WORKBENCH_CREDENTIAL_SESSION")
      .replaceAll("이 세션의 찾기 폴더가 없습니다", "이 대화의 도구 폴더가 없습니다").replaceAll("Workbench 기록을 찾을 수 없습니다", "이 도구를 쓸 수 없습니다"));
    writeFileSync(join(this.bin, "workbench-credential"), launcherSource(process.execPath, script), { mode: 0o755 });
    chmodSync(join(this.bin, "workbench-credential"), 0o755);
    writeFileSync(join(this.bin, "workbench-credential.cmd"), cmdLauncherSource(process.execPath, script));
    for (const session of options.sessions.values()) this.changed(session);
    this.unsubscribe = options.bus.subscribe((event) => { if (event.type === "session.upserted") this.changed(event.session); });
    // Watchers can miss a file: a slow look as well, over the folders in use only.
    this.timer = setInterval(() => this.tick(), options.pollMs ?? 1_000);
    this.timer.unref();
  }

  private changed(session: Session) {
    const name = findSessionName(session.id);
    this.byName.set(name, session.id);
    if (session.provider === "codex" && session.nativeSessionId && this.threads.get(session.nativeSessionId) !== name) {
      this.threads.set(session.nativeSessionId, name);
      writeFileSync(join(this.root, "threads.json.tmp"), JSON.stringify(Object.fromEntries(this.threads)), { mode: 0o600 });
      renameSync(join(this.root, "threads.json.tmp"), join(this.root, "threads.json"));
    }
  }

  private spool(session: Session) {
    this.changed(session);
    const name = findSessionName(session.id);
    const dir = join(this.root, "spool", name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!this.active.has(name)) {
      let watcher: FSWatcher | null = null;
      try {
        watcher = watch(dir, { persistent: false }, (_event, file) => { if (file && /^[a-z0-9-]{4,40}\.req\.json$/.test(String(file))) void this.take(session.id, dir, String(file)); });
        watcher.on("error", () => watcher?.close());
      } catch { /* The slow look still finds requests. */ }
      this.active.set(name, { sessionId: session.id, watcher });
    }
    return dir;
  }

  /** For tests: the spool folders looked at. */
  get watched() { return [...this.active.keys()]; }

  /** Only the folders handed to a conversation's engine are read. */
  private tick() {
    for (const [name, { sessionId }] of this.active) {
      const dir = join(this.root, "spool", name);
      let files: string[];
      try { files = readdirSync(dir); } catch { continue; }
      for (const file of files) {
        if (/^[a-z0-9-]{4,40}\.req\.json$/.test(file)) void this.take(sessionId, dir, file);
        else if (/^[a-z0-9-]+\.res\.json$/.test(file)) {
          try { if (Date.now() - statSync(join(dir, file)).mtimeMs > 10 * 60_000) rmSync(join(dir, file), { force: true }); } catch { /* Gone meanwhile. */ }
        }
      }
    }
  }

  private async take(sessionId: string, dir: string, file: string) {
    const path = join(dir, file);
    if (this.busy.has(path)) return;
    this.busy.add(path);
    try {
      let request: { id: unknown; args: unknown };
      try {
        if (statSync(path).size > 16_384) { rmSync(path, { force: true }); return; }
        request = JSON.parse(readFileSync(path, "utf8")) as { id: unknown; args: unknown };
        rmSync(path, { force: true });
      } catch { return; }
      if (typeof request.id !== "string" || file !== `${request.id}.req.json` || !Array.isArray(request.args) || request.args.length > 20 || request.args.some((arg) => typeof arg !== "string" || arg.length > 400)) return;
      let result: ToolAnswer;
      try {
        result = this.options.sessions.has(sessionId) ? await this.options.run(sessionId, request.args as string[]) : { code: 1, stdout: "fail:unknown_session\n", stderr: "" };
      } catch {
        result = { code: 1, stdout: "fail:unavailable\n", stderr: "" };
      }
      try {
        const out = join(dir, `${request.id}.res.json`);
        writeFileSync(`${out}.tmp`, JSON.stringify(result), { mode: 0o600 });
        renameSync(`${out}.tmp`, out);
      } catch { /* The command was stopped meanwhile. */ }
    } finally {
      this.busy.delete(path);
    }
  }

  /** The other engine tools' hooks with this one added. */
  hooks(base: BrowserEngineHooks): BrowserEngineHooks {
    return {
      ...base,
      pathDirs: () => [...base.pathDirs(), this.bin],
      sessionEnv: (session) => { this.spool(session); return { ...base.sessionEnv(session), WORKBENCH_CREDENTIAL_SESSION: findSessionName(session.id) }; },
      writableRoots: (session) => [...base.writableRoots(session), this.spool(session)],
      // It only names entries or asks the person; the values never reach the engine. A plain line runs without a card.
      allowsCommand: (id, command) => base.allowsCommand(id, command) || (command.includes("workbench-credential") && isPlainFindCommand(command.replaceAll("workbench-credential", "workbench-find"))),
      extraInstructions: (session) => [base.extraInstructions?.(session), [INSTRUCTIONS, this.options.instructions].filter(Boolean).join("\n")].filter(Boolean).join("\n\n"),
    };
  }

  close() {
    for (const { watcher } of this.active.values()) watcher?.close();
    clearInterval(this.timer);
    this.unsubscribe();
  }
}
