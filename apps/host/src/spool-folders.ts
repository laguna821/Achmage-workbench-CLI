import { mkdirSync, readdirSync, rmSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

/**
 * The spool folders of a file-transport tool (workbench-desktop, workbench-find …), looked at only for the
 * conversations whose engine was handed the tool, and never for an archived one (0.5.3 A9). A watcher
 * answers a request at once; a slow look over the same folders catches what a watcher missed. Before,
 * the desktop tool read a folder for EVERY session ever known four times a second (most of them did not
 * exist), and the find tool every folder on disk twice a second.
 */
export class SpoolFolders {
  private readonly active = new Map<string, { sessionId: string; watcher: FSWatcher | null }>();
  private readonly timer: NodeJS.Timeout;
  private readonly root: string;
  private readonly request: RegExp;
  private readonly take: (sessionId: string, dir: string, file: string) => void;
  constructor(root: string, options: { request: RegExp; take(sessionId: string, dir: string, file: string): void; pollMs?: number; answerMaxAgeMs?: number }) {
    this.root = root;
    this.request = options.request;
    this.take = options.take;
    const answerMaxAgeMs = options.answerMaxAgeMs ?? 10 * 60_000;
    this.timer = setInterval(() => this.look(answerMaxAgeMs), options.pollMs ?? 2_000);
    this.timer.unref();
  }

  /** The folder of a conversation whose engine is handed the tool: made, watched and looked at from now on. */
  open(name: string, sessionId: string) {
    const dir = join(this.root, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!this.active.has(name)) {
      let watcher: FSWatcher | null = null;
      try {
        watcher = watch(dir, { persistent: false }, (_event, file) => { if (file && this.request.test(String(file))) this.take(sessionId, dir, String(file)); });
        watcher.on("error", () => { watcher?.close(); const entry = this.active.get(name); if (entry) entry.watcher = null; });
      } catch { /* The slow look still finds requests. */ }
      this.active.set(name, { sessionId, watcher });
    }
    return dir;
  }

  /** A conversation archived or gone: its folder is not looked at any more (the next engine start opens it again). */
  close(name: string) {
    const entry = this.active.get(name);
    if (!entry) return;
    entry.watcher?.close();
    this.active.delete(name);
  }

  /** The folders looked at (tests). */
  get names() { return [...this.active.keys()]; }

  /** Tests: as if every watcher had missed its events. */
  dropWatchers() { for (const entry of this.active.values()) { entry.watcher?.close(); entry.watcher = null; } }

  private look(answerMaxAgeMs: number) {
    const now = Date.now();
    for (const [name, { sessionId }] of this.active) {
      const dir = join(this.root, name);
      let files: string[];
      try { files = readdirSync(dir); } catch { continue; }
      for (const file of files) {
        if (this.request.test(file)) this.take(sessionId, dir, file);
        // Answers nobody picked up (the command was stopped) do not stay.
        else if (file.endsWith(".res.json")) {
          try { if (now - statSync(join(dir, file)).mtimeMs > answerMaxAgeMs) rmSync(join(dir, file), { force: true }); } catch { /* Gone meanwhile. */ }
        }
      }
    }
  }

  stop() {
    clearInterval(this.timer);
    for (const entry of this.active.values()) entry.watcher?.close();
    this.active.clear();
  }
}
