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
      /**
       * macOS (0.5.4): the web view's page processes are not in the sum — WKWebView's are started by the
       * system (launchd), and `ps` cannot tell which app they draw for. The window's part is then the app's
       * own process (with its launcher). Absent elsewhere.
       */
      pagesLeftOut?: true;
      /**
       * The AI engines alive now (0.5.3 B1): one Claude Code process per conversation, one Codex app-server
       * for all of Codex's; the memory of each process with everything it started (MCP servers, hooks).
       * `bytes` null: its process could not be told apart on this system. Absent from older gateways.
       */
      engines?: EngineMemory[];
    };

export type EngineMemory = {
  provider: "claude" | "codex";
  /** The conversations it serves (one for Claude; those loaded in the shared app-server for Codex), with their titles. */
  sessions: { id: string; title: string }[];
  bytes: number | null;
  /** No turn runs and nothing waits on it: "쉬는 엔진 지금 끄기" closes it. */
  idle: boolean;
};
