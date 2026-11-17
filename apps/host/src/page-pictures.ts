import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";

// Page pictures made before they are needed (0.5.3 doc-pages-first, point 2): when a revision of a
// Word/PowerPoint/Excel or Hangul document is recorded, its page pictures are made in the
// background — low priority (after a quiet moment), one job at a time, never while the machine is
// short of memory or another heavy document job of the gateway runs (then nothing is made now: the
// pictures are made on demand when a page view asks). Pictures live per revision in the document's
// own folder (`r<N>.pages/`, `r<N>.cover.png`), so they go with the document; the whole cache is
// kept under a size bound, oldest first, never the current revision of a document.

export type PictureJob = (artifactId: string, revision: number) => Promise<void>;

export type PicturesOptions = {
  /** Make the pictures of one revision. */
  make: PictureJob;
  /** The pictures of this revision are already there. */
  has(artifactId: string, revision: number): boolean;
  /** Still the document's current revision (an older one waiting is not made). */
  current(artifactId: string, revision: number): boolean;
  /** Another heavy document job of the gateway runs now (text index, a page view's own rendering). */
  busy(): boolean;
  /** Bytes of memory the machine has available now. */
  memoryAvailable?: () => number;
  /** Below this, nothing is made (bytes). */
  minMemory?: number;
  /** After this quiet time from the last save (ms): saves in a row make one job. */
  delayMs?: number;
  /** How long a job waits for another heavy job to end before it is skipped (ms). */
  busyWaitMs?: number;
  /** Run after each made job: keeps the cache under its bound. */
  sweep?: () => void;
};

/** The quiet moment before a job (ms). */
export const PICTURE_DELAY_MS = 4000;
/** A job waits this long for another heavy document job to end, then is skipped (ms). */
export const PICTURE_BUSY_WAIT_MS = 30_000;
/** Nothing is made with less memory available than this (bytes): 1.5 GiB. */
export const PICTURE_MIN_MEMORY = 1.5 * 1024 ** 3;
/** The whole picture cache of the gateway (bytes): 400 MiB. */
export const PICTURE_CACHE_BOUND = 400 * 1024 ** 2;
/** At most this many documents wait; a newer save of a waiting document takes its place. */
export const PICTURE_WAITING = 8;

/** MemAvailable from /proc/meminfo (Linux), else the free memory the OS reports. */
export function memoryAvailable(): number {
  try {
    const match = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
    if (match) return Number(match[1]) * 1024;
  } catch {
    // Not Linux.
  }
  return freemem();
}

export type PictureOutcome = "made" | "had" | "stale" | "low-memory" | "busy" | "failed";

export class PagePictures {
  private readonly waiting = new Map<string, number>();
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;
  private readonly options: Required<Omit<PicturesOptions, "sweep">> & Pick<PicturesOptions, "sweep">;
  /** What became of each job (newest last, a few kept): for tests and the report. */
  readonly log: { artifactId: string; revision: number; outcome: PictureOutcome }[] = [];

  constructor(options: PicturesOptions) {
    this.options = { memoryAvailable, minMemory: PICTURE_MIN_MEMORY, delayMs: PICTURE_DELAY_MS, busyWaitMs: PICTURE_BUSY_WAIT_MS, ...options };
  }

  /** Make this revision's pictures in the background (a newer revision of the same document takes the place of one waiting). */
  add(artifactId: string, revision: number) {
    const before = this.waiting.get(artifactId);
    // Asked again for what already waits (a tab asking for its picture): the quiet moment is not restarted.
    if (before !== undefined && before >= revision) { this.running ??= this.drain(); return; }
    this.waiting.delete(artifactId);
    this.waiting.set(artifactId, revision);
    while (this.waiting.size > PICTURE_WAITING) this.waiting.delete(this.waiting.keys().next().value!);
    this.restartQuiet();
    this.running ??= this.drain();
  }

  /** Resolves once nothing waits or runs (tests). */
  async settled() {
    while (this.running) await this.running;
  }

  /** Stop waiting jobs (the gateway closing). */
  stop() {
    this.waiting.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wake?.();
  }

  private restartQuiet() {
    if (!this.wake) return;
    if (this.timer) clearTimeout(this.timer);
    const wake = this.wake;
    this.timer = setTimeout(() => { this.timer = null; wake(); }, this.options.delayMs);
  }

  private quiet() {
    return new Promise<void>((done) => {
      this.wake = () => { this.wake = null; done(); };
      this.restartQuiet();
    });
  }

  private note(artifactId: string, revision: number, outcome: PictureOutcome) {
    this.log.push({ artifactId, revision, outcome });
    if (this.log.length > 50) this.log.shift();
  }

  private async drain() {
    try {
      while (this.waiting.size) {
        await this.quiet();
        if (!this.waiting.size) break;
        const [artifactId, revision] = this.waiting.entries().next().value!;
        this.waiting.delete(artifactId);
        const { has, current, busy, make, minMemory } = this.options;
        if (!current(artifactId, revision)) { this.note(artifactId, revision, "stale"); continue; }
        if (has(artifactId, revision)) { this.note(artifactId, revision, "had"); continue; }
        // Short of memory, or the gateway runs another heavy document job: skipped, made on demand instead.
        if (this.options.memoryAvailable() < minMemory) { this.note(artifactId, revision, "low-memory"); continue; }
        // Another heavy document job (the text index of the same save, a page view's render): wait for it, a while.
        const waitUntil = Date.now() + this.options.busyWaitMs;
        while (busy() && Date.now() < waitUntil) await new Promise((done) => setTimeout(done, Math.min(1000, this.options.busyWaitMs)));
        if (busy()) { this.note(artifactId, revision, "busy"); continue; }
        try {
          await make(artifactId, revision);
          this.note(artifactId, revision, "made");
        } catch {
          this.note(artifactId, revision, "failed");
        }
        try { this.options.sweep?.(); } catch { /* the bound is kept next time */ }
      }
    } finally {
      this.running = null;
    }
  }
}

/** One picture entry of the cache: a revision's page folder or its cover file. */
type Entry = { path: string; artifactId: string; revision: number; bytes: number; at: number };

const PICTURE_NAME = /^r(\d+)\.(pages|cover\.png|cover\.svg|cover\.json)$/;

function sizeOf(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of readdirSync(path)) total += sizeOf(join(path, name));
  return total;
}

/** Every picture of the cache under `root` (`<root>/<artifactId>/r<N>.pages`, `r<N>.cover.png`). */
export function pictureEntries(root: string): Entry[] {
  const entries: Entry[] = [];
  let ids: string[] = [];
  try { ids = readdirSync(root); } catch { return entries; }
  for (const artifactId of ids) {
    let names: string[] = [];
    try { names = readdirSync(join(root, artifactId)); } catch { continue; }
    for (const name of names) {
      const match = PICTURE_NAME.exec(name);
      if (!match) continue;
      const path = join(root, artifactId, name);
      try {
        entries.push({ path, artifactId, revision: Number(match[1]), bytes: sizeOf(path), at: statSync(path).mtimeMs });
      } catch {
        // Went while it was read.
      }
    }
  }
  return entries;
}

/**
 * Keep the picture cache under `bound` bytes: the oldest pictures go first, never those of a
 * document's current revision (`keep`). Returns the bytes left and what was removed.
 */
export function sweepPictures(root: string, bound: number, keep: (artifactId: string, revision: number) => boolean) {
  const entries = pictureEntries(root);
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const removed: string[] = [];
  for (const entry of entries.filter((item) => !keep(item.artifactId, item.revision)).sort((a, b) => a.at - b.at)) {
    if (total <= bound) break;
    rmSync(entry.path, { recursive: true, force: true });
    total -= entry.bytes;
    removed.push(entry.path);
  }
  return { bytes: total, removed };
}
