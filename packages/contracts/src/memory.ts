/**
 * What the app uses now (`GET /api/memory`): resident memory in bytes — the total and its three parts.
 * No process name, path or command line is part of the answer.
 *
 * `measure` says what was summed: "pss" (Linux: each process's proportional share, shared pages counted
 * once), "rss" (resident set / working set: shared pages counted in every process that maps them), or
 * "mixed" (Linux: some processes' share could not be read and their resident set was used).
 *
 * `known: false`: this system's process table could not be read, or the app's window was not found in
 * it — the readout then shows nothing rather than a number that leaves the window out.
 */
export type AppMemory =
  | { known: false }
  | {
      known: true;
      totalBytes: number;
      /** The app's window process(es) and their children (the web view's processes). */
      windowBytes: number;
      /** Every process the gateway started that is still alive: AI engine CLIs, document tools, the search worker, exports. */
      toolsBytes: number;
      /** The gateway process itself. */
      gatewayBytes: number;
      measure: "pss" | "rss" | "mixed";
      /** When it was read (ms); the gateway reads at most once in 30 s. */
      at: number;
    };
