import { busyError, type Store } from "./store.ts";
export { COMPACT_RULE } from "./store.ts";

/**
 * The state database's quiet upkeep (0.5.3, G4): ended terminals past their retention leave with their output
 * (terminals.ts prune), the search cache is kept within its bound (search-index.ts boundCache), free pages are
 * given back (store.ts compact), and the logs are trimmed. It runs only when `quiet()` says nothing is at work
 * (no turn, no task, no unsaved document, no update being prepared, not stopping), a few minutes after start
 * and then every half hour; never on a write path. The backup before a migration happens at open (store.ts),
 * before this exists.
 */
export type MaintenanceResult = { skipped: string } | { skipped: null; pruned: number; trimmed: number; compacted: boolean; logs: number };

export class StoreMaintenance {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: {
    store: Store;
    /** null: quiet; otherwise what is at work (the run is skipped). */
    quiet: () => string | null;
    terminals?: { prune: () => number };
    logs?: () => number;
    firstDelayMs?: number;
    everyMs?: number;
    onError?: (error: unknown) => void;
  };
  constructor(options: StoreMaintenance["options"]) { this.options = options; }

  runOnce(): MaintenanceResult {
    const busy = this.options.quiet();
    if (busy) return { skipped: busy };
    // Each step is a write; with another connection or process holding the file it is skipped at once (no wait,
    // no retry loop) and done at the next round. The records in memory change only after a write commits.
    const quietly = <T,>(step: () => T, otherwise: T): T => {
      try { return this.options.store.noBusyWait(step); } catch (error) { if (busyError(error)) return otherwise; throw error; }
    };
    const pruned = quietly(() => this.options.terminals?.prune() ?? 0, 0);
    const trimmed = quietly(() => this.options.store.search.boundCache().trimmed, 0);
    // The search cache cut and the terminals removed above free pages that the compaction can give back.
    const { compacted } = this.options.store.compact();
    const logs = this.options.logs?.() ?? 0;
    return { skipped: null, pruned, trimmed, compacted, logs };
  }

  start() {
    const tick = (delay: number) => {
      this.timer = setTimeout(() => {
        try { this.runOnce(); } catch (error) { this.options.onError?.(error); }
        tick(this.options.everyMs ?? 30 * 60_000);
      }, delay);
      this.timer.unref?.();
    };
    tick(this.options.firstDelayMs ?? 5 * 60_000);
  }

  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
