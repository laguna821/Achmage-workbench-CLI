// Every test file gets its own temp folder (vitest setupFiles, vitest.config.ts): TMPDIR/TMP/TEMP point
// into it while the file runs, so whatever its tests and the gateways, editors and git processes they
// start put under os.tmpdir() lands there, and the folder is removed after the file's last hook.
// The suites used to leave thousands of folders behind (wb-removal-*, wb-office-output-*, wb-editors-*,
// wb-docs-*, …; 3 GB of the RAM-backed /tmp in one afternoon of runs).
// WB_TEST_TMP_REPORT=<file>: before removing, append one line per test file with what was still in its
// folder, by name prefix (how a helper that does not clean up is found; the count is 0 when they all do).
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { removeTempDirs } from "./test-temp.ts";

// The resource manager (0.5.3) of every test gateway reads a stand-in machine with room for many turns, so a
// full run under memory pressure does not make unrelated tests wait in its line (tests of the manager give their own).
process.env.WORKBENCH_MACHINE ??= JSON.stringify({ totalBytes: 64 * 2 ** 30, availableBytes: 48 * 2 ** 30, cores: 16 });
// 0.5.4: test gateways start their stand-in engines as before, never in scopes of the user's systemd (a test of
// the scopes asks for them itself).
process.env.WORKBENCH_ENGINE_SCOPE ??= "off";

// WB_TEST_TMP_ROOT=0 turns it off (to measure what the suites leave without it).
const on = process.env.WB_TEST_TMP_ROOT !== "0";
const outer = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
// Named after the vitest main process (the workers' parent): its teardown (test-temp-global.ts) removes
// any folder of its own run that a file could not remove itself (all its tests skipped: no afterAll).
// Kept SHORT ("wv" + that pid in base 36): tests listen on Unix sockets under this folder, and a socket
// path has a limit of about 107 bytes (a longer name made browse-files' page-check socket fail).
export const rootPrefix = (pid: number) => `wv${pid.toString(36)}-`;
const root = on ? mkdtempSync(join(tmpdir(), rootPrefix(process.ppid))) : "";
if (on) process.env.TMPDIR = process.env.TMP = process.env.TEMP = root;

beforeAll(() => { if (on) process.env.TMPDIR = process.env.TMP = process.env.TEMP = root; });

// tempDir() folders: after the test that made them, and the rest after the file (test-temp.ts)
afterEach(() => removeTempDirs("test"));

afterAll(async () => {
  removeTempDirs("file");
  if (!on) return;
  const report = process.env.WB_TEST_TMP_REPORT;
  if (report) {
    const left = readdirSync(root);
    const prefixes = new Map<string, number>();
    for (const name of left) { const prefix = name.replace(/[-_.]?[A-Za-z0-9]{6}$/, ""); prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1); }
    const file = (expect.getState().testPath ?? "?").split("/apps/").pop() ?? "?";
    appendFileSync(report, `${left.length}\t${file}\t${[...prefixes].map(([prefix, count]) => `${prefix}×${count}`).join(" ")}\n`);
  }
  for (const [key, value] of Object.entries(outer)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  // a gateway closed in the file's own afterAll may still be finishing a write: retry a moment
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
