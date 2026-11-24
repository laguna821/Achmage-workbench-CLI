import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, watch, writeSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

// The two file operations of every tool that answers an engine through a spool folder (workbench-find, -peers,
// -desktop, -remote, -credential, the agent browser's playwright-cli). The folder is writable by the engine — a
// sandboxed one too — and the gateway is not sandboxed, so nothing in it is trusted (security review of 0.5.6):
// - a request is read only if it is a regular file (not a symlink, a FIFO or a device), through O_NOFOLLOW and
//   O_NONBLOCK, at most `cap` bytes, and is taken away whatever it was;
// - an answer is written to a temp name the gateway chose at random, created with O_EXCL (it refuses an existing
//   path and a symlink), then renamed onto `<id>.res.json` only if that path is not a symlink or anything but a
//   file (rename itself never follows a link); the id must be a plain id, so the answer stays in the folder.

/** A request's id as the wrappers make it (base-36 time, a dash, hex). */
export const SPOOL_ID = /^[a-z0-9-]{4,40}$/;

/**
 * The request at `path` as JSON; null when refused (not a regular file, larger than `cap`, not JSON); undefined when
 * it was not there (already taken: a watcher and the slow look can both hand over the same file). The file is taken away.
 */
export function readSpoolRequest(path: string, cap: number): unknown {
  let fd: number | null = null;
  let gone = false;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > cap) return null;
    const buffer = Buffer.alloc(cap + 1);
    let length = 0;
    for (let read; length <= cap && (read = readSync(fd, buffer, length, cap + 1 - length, null)) > 0;) length += read;
    if (length > cap) return null;
    return JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown;
  } catch (error) {
    gone = (error as NodeJS.ErrnoException).code === "ENOENT";
    return gone ? undefined : null;
  } finally {
    if (fd !== null) closeSync(fd);
    if (!gone) try { unlinkSync(path); } catch { /* Gone meanwhile, or a folder: left to the engine. */ }
  }
}

/** Writes `answer` as `<dir>/<id>.res.json` (see above); false when it was not written. */
export function writeSpoolAnswer(dir: string, id: string, answer: unknown, mode = 0o600): boolean {
  if (!SPOOL_ID.test(id)) return false;
  const out = join(dir, `${id}.res.json`);
  const part = join(dir, `.wb-${randomBytes(12).toString("hex")}.part`);
  let fd: number | null = null;
  try {
    fd = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    const bytes = Buffer.from(JSON.stringify(answer));
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
    closeSync(fd);
    fd = null;
    try { if (!lstatSync(out).isFile()) throw new Error("answer path is not a file"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    renameSync(part, out);
    return true;
  } catch {
    if (fd !== null) try { closeSync(fd); } catch { /* closed */ }
    try { unlinkSync(part); } catch { /* never made */ }
    return false;
  }
}

/** An argument as it may be shown back in an answer: one line, cut short. */
export function shownArg(text: string, limit = 40): string {
  const line = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : line;
}

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
