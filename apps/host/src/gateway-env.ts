import { readSync } from "node:fs";
/**
 * Variables that point at the gateway's own doors: the OS vault helper, the terminal worker and the
 * gateway's token. The gateway reads them once when it starts and removes them from its own
 * environment, so nothing it starts afterwards inherits them (engines, IeumOffice's AI runners,
 * terminals, document jobs): every child process copies `process.env` unless told otherwise.
 */
const NAMES = ["WORKBENCH_SECRET_BIN", "WORKBENCH_PTY_BIN", "WORKBENCH_TOKEN"] as const;
type Name = typeof NAMES[number];
const taken = new Map<Name, string | undefined>();

/** Read and remove every one of them (the gateway's first act; idempotent). */
export function takeGatewayOnlyEnv() { for (const name of NAMES) gatewayOnly(name); }

/** The value the gateway started with; removed from `process.env` on first read. */
export function gatewayOnly(name: Name): string | undefined {
  if (!taken.has(name)) {
    const key = Object.keys(process.env).find((entry) => process.platform === "win32" ? entry.toUpperCase() === name : entry === name);
    taken.set(name, key ? process.env[key] : undefined);
    if (key) delete process.env[key];
  }
  return taken.get(name);
}

/**
 * The gateway's per-run vault ticket (sec-vault round 2). The app's binary, which started this
 * gateway (`--host-runtime`, or the window in its own mode), registered it in the OS keyring and
 * wrote the ticket as the first line of this process's stdin; `WORKBENCH_GATEWAY_TICKET=stdin` says
 * so (the variable holds no value). The ticket stays in this module's memory: never in the
 * environment, an argument, a file, a log or an error message; it goes to the vault helper only
 * over the helper's stdin (office-vault.ts). Read before anything else is started.
 */
let ticket: string | null | undefined;
export function takeGatewayTicket(read: (fd: number, into: Buffer) => number = defaultRead): string | null {
  if (ticket !== undefined) return ticket;
  const key = Object.keys(process.env).find((entry) => process.platform === "win32" ? entry.toUpperCase() === "WORKBENCH_GATEWAY_TICKET" : entry === "WORKBENCH_GATEWAY_TICKET");
  const from = key ? process.env[key] : undefined;
  if (key) delete process.env[key];
  ticket = null;
  if (from !== "stdin") return ticket;
  // Exactly one line of 64 hex characters; nothing after it is read here.
  const line = Buffer.alloc(65);
  let got = 0;
  try {
    while (got < 65) { const n = read(0, line.subarray(got)); if (n <= 0) break; got += n; }
  } catch { /* no ticket: the vault refuses this gateway and it says so */ }
  const text = line.subarray(0, got).toString("latin1");
  ticket = /^[0-9a-f]{64}\n$/.test(text) ? text.slice(0, 64) : null;
  line.fill(0);
  return ticket;
}
/** The ticket taken at start (null: this gateway was not started by the app's binary). */
export function gatewayTicket(): string | null { return ticket ?? null; }

function defaultRead(fd: number, into: Buffer): number {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { return readSync(fd, into, 0, into.length, null); }
    catch (error) {
      // A non-blocking pipe with nothing yet: wait a little (the launcher writes right after it registers).
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN" || Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
