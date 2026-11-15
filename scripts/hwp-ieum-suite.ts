// Ieum's whole vendored HWP test suite (vendor/ieumoffice/apps/hwp/tests, unedited) against the
// engine Workbench runs (third_party/hop/engine.ts) or any engine folder, with the tests that are
// KNOWN to fail on it listed with their reason in scripts/hwp-ieum-suite/expected.json (H4b, MUST 3).
//
//   node scripts/hwp-ieum-suite.ts [--engine DIR] [--out FILE]
//
// Exit 0 when exactly the listed tests fail; 1 when another test fails (a regression to explain or
// fix) or a listed one now passes (the list is stale); 64 on a usage error. The vendored files are
// read in place; Ieum's own vitest runs them with scripts/hwp-ieum-suite/vitest.config.mjs, which
// points `@rhwp/core` at the engine. Nothing of a document is printed: test names and counts only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ENGINE_DIR } from "../third_party/hop/engine.ts";
import { repoRoot } from "./hwp-studio-harness.ts";

type Expected = { engine: string; failures: { test: string; class: "environment" | "upstream" | "engine-version"; reason: string }[] };
const option = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const engine = resolve(option("--engine") ?? join(repoRoot, ENGINE_DIR));
if (!existsSync(join(engine, "rhwp.js"))) { console.error(`no engine in ${engine}`); process.exit(64); }
const app = join(repoRoot, "vendor/ieumoffice/apps/hwp");
const vitest = join(repoRoot, "vendor/ieumoffice/node_modules/vitest/vitest.mjs");
const scratch = mkdtempSync(join(tmpdir(), "wb-ieum-suite-"));
const report = join(scratch, "report.json");
try {
  const run = spawnSync(process.execPath, [vitest, "run", "--config", join(repoRoot, "scripts/hwp-ieum-suite/vitest.config.mjs"), "--reporter=json", `--outputFile=${report}`], {
    cwd: app, env: { ...process.env, HWP_ENGINE_DIR: engine }, stdio: ["ignore", "ignore", "inherit"], maxBuffer: 1 << 26,
  });
  if (!existsSync(report)) { console.error(`vitest wrote no report (exit ${run.status})`); process.exit(1); }
  const result = JSON.parse(readFileSync(report, "utf8")) as { numTotalTests: number; numPassedTests: number; numFailedTests: number; testResults: { name: string; message?: string; assertionResults: { fullName: string; status: string }[] }[] };
  const id = (file: string, name: string) => `${file.slice(app.length + 1)} > ${name}`;
  const failed = result.testResults.flatMap((file) => file.assertionResults.filter((test) => test.status === "failed").map((test) => id(file.name, test.fullName)));
  // a suite that fails to load has no assertion results: count it by file
  const broken = result.testResults.filter((file) => file.assertionResults.length === 0 && file.message).map((file) => id(file.name, "(the file does not load)"));
  const expected = JSON.parse(readFileSync(join(repoRoot, "scripts/hwp-ieum-suite/expected.json"), "utf8")) as Expected;
  const listed = new Map(expected.failures.map((item) => [item.test, item]));
  const actual = new Set([...failed, ...broken]);
  const unexpected = [...actual].filter((test) => !listed.has(test));
  const stale = [...listed.keys()].filter((test) => !actual.has(test));
  console.log(`Ieum HWP suite on ${engine.slice(repoRoot.length + 1) || engine}: ${result.numTotalTests} tests, ${result.numPassedTests} passed, ${result.numFailedTests} failed, ${broken.length} files did not load`);
  const byClass = new Map<string, number>();
  for (const item of expected.failures) if (actual.has(item.test)) byClass.set(item.class, (byClass.get(item.class) ?? 0) + 1);
  console.log(`known failures (scripts/hwp-ieum-suite/expected.json): ${[...byClass].map(([kind, count]) => `${kind} ${count}`).join(", ") || "none"}`);
  for (const test of unexpected) console.log(`UNEXPECTED failure: ${test}`);
  for (const test of stale) console.log(`listed but passes now: ${test}`);
  const out = option("--out");
  if (out) writeFileSync(out, JSON.stringify({ engine, total: result.numTotalTests, passed: result.numPassedTests, failed: [...actual].sort(), unexpected, stale }, null, 2) + "\n");
  process.exitCode = unexpected.length || stale.length ? 1 : 0;
} finally { rmSync(scratch, { recursive: true, force: true }); }
