import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesktopAction, Session } from "@workbench/contracts";
import type { BrowserEngineHooks } from "./browse.ts";
import { launcherSource, cmdLauncherSource } from "./browse-wrapper.ts";
import { findSessionName, findWrapperSource, isPlainFindCommand } from "./find-tool.ts";
import type { DesktopService } from "./desktop-adapter.ts";
import type { EventBus } from "./bus.ts";

const USAGE = `workbench-desktop snapshot
workbench-desktop screenshot
workbench-desktop act '<JSON DesktopAction>'
workbench-desktop reconcile <commandId>
Only the app window selected by the person in Workbench is available. snapshot returns observationId (id), snapshotId and qualified refs. act JSON: {commandId: unique ID (8-100 letters/digits/_/-), observationId, action, ref, value?}. Actions: click, double-click, right-click, type, set-value, clear, focus, select, toggle, check, uncheck, expand, collapse, scroll, press. press uses value as key combination; other actions require a ref from the current observation. After any action, get a new snapshot. An unknown outcome must be reconciled, never blindly retried. Reusing commandId returns the saved receipt without performing it again. A delivered action does not prove the app saved a file.`;

/** Reuses the existing sandbox-compatible Workbench file transport, without exposing owner tokens. */
export class DesktopTool {
  private readonly root: string;
  private readonly bin: string;
  private readonly byName = new Map<string, string>();
  private readonly threads = new Map<string, string>();
  private readonly timer: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  private readonly service: DesktopService;
  constructor(dataDir: string, service: DesktopService, sessions: ReadonlyMap<string, Session>, bus: EventBus) {
    this.service = service; this.root = join(dataDir, "desktop", "tool"); this.bin = join(this.root, "bin");
    mkdirSync(this.bin, { recursive: true, mode: 0o700 }); mkdirSync(join(this.root, "spool"), { recursive: true, mode: 0o700 });
    const script = join(this.bin, "workbench-desktop.mjs");
    writeFileSync(script, findWrapperSource(this.root, USAGE).replaceAll("workbench-find", "workbench-desktop").replaceAll("WORKBENCH_FIND_SESSION", "WORKBENCH_DESKTOP_SESSION"));
    writeFileSync(join(this.bin, "workbench-desktop"), launcherSource(process.execPath, script), { mode: 0o755 }); chmodSync(join(this.bin, "workbench-desktop"), 0o755);
    writeFileSync(join(this.bin, "workbench-desktop.cmd"), cmdLauncherSource(process.execPath, script));
    for (const session of sessions.values()) this.changed(session);
    this.unsubscribe = bus.subscribe(event => { if (event.type === "session.upserted") this.changed(event.session); });
    this.timer = setInterval(() => this.tick(), 250); this.timer.unref();
  }
  private changed(session: Session) {
    const name = findSessionName(session.id); this.byName.set(name, session.id);
    if (session.provider === "codex" && session.nativeSessionId && this.threads.get(session.nativeSessionId) !== name) {
      this.threads.set(session.nativeSessionId, name);
      writeFileSync(join(this.root, "threads.json.tmp"), JSON.stringify(Object.fromEntries(this.threads)));
      renameSync(join(this.root, "threads.json.tmp"), join(this.root, "threads.json"));
    }
    if (session.archivedAt) this.service.release(session.id);
  }
  private spool(session: Session) { this.changed(session); const dir = join(this.root, "spool", findSessionName(session.id)); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
  private tick() {
    for (const [name, sessionId] of this.byName) {
      const dir = join(this.root, "spool", name);
      try { for (const file of readdirSync(dir)) {
        if (/^[a-z0-9-]+\.req\.json$/.test(file)) void this.take(sessionId, dir, file);
        else if (/^[a-z0-9-]+\.res\.json$/.test(file) && Date.now() - statSync(join(dir, file)).mtimeMs > 600_000) rmSync(join(dir, file), { force: true });
      } } catch { /* A session has not used its tool yet. */ }
    }
  }
  private async take(sessionId: string, dir: string, file: string) {
    const path = join(dir, file); let request: { id: string; args: string[] };
    try { if (statSync(path).size > 100_000) { rmSync(path); return; } request = JSON.parse(readFileSync(path, "utf8")); rmSync(path); } catch { return; }
    if (file !== `${request.id}.req.json` || !Array.isArray(request.args) || request.args.some(arg => typeof arg !== "string")) return;
    let result: { code: number; stdout: string; stderr: string };
    try {
      const [command, payload] = request.args; let response: unknown;
      if (command === "snapshot" && request.args.length === 1) response = await this.service.observe(sessionId);
      else if (command === "screenshot" && request.args.length === 1) response = await this.service.screenshot(sessionId);
      else if (command === "act" && request.args.length === 2) response = await this.service.act(sessionId, JSON.parse(payload!) as DesktopAction);
      else if (command === "reconcile" && request.args.length === 2) response = await this.service.reconcile(sessionId, payload!);
      else throw new Error(USAGE);
      result = { code: 0, stdout: JSON.stringify(response) + "\n", stderr: "" };
    } catch (error) { result = { code: 1, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n` }; }
    try { const out = join(dir, `${request.id}.res.json`); writeFileSync(`${out}.tmp`, JSON.stringify(result), { mode: 0o600 }); renameSync(`${out}.tmp`, out); } catch { /* cancelled caller */ }
  }
  hooks(base: BrowserEngineHooks): BrowserEngineHooks {
    return { ...base, pathDirs: () => [...base.pathDirs(), this.bin],
      sessionEnv: session => { this.spool(session); return { ...base.sessionEnv(session), WORKBENCH_DESKTOP_SESSION: findSessionName(session.id) }; },
      writableRoots: session => [...base.writableRoots(session), this.spool(session)],
      // The server still requires a current human-selected target and exact observation for every action.
      allowsCommand: (id, command) => base.allowsCommand(id, command) || isPlainFindCommand(command.replaceAll("workbench-desktop", "workbench-find")) && command.includes("workbench-desktop"),
      extraInstructions: session => [base.extraInstructions?.(session), `External app interaction uses workbench-desktop. If no app window is connected, ask the person to select it from the 외부 앱 menu. Do not bypass that selection with a raw desktop executable. ${USAGE}`].filter(Boolean).join("\n\n") };
  }
  close() { clearInterval(this.timer); this.unsubscribe(); }
}
