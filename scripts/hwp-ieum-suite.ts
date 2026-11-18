// Ieum's whole vendored HWP test suite (vendor/ieumoffice/apps/hwp/tests, unedited) against the
// engine Workbench runs (third_party/hop/engine.ts) or any engine folder, with the tests that are
// KNOWN to fail on it listed with their reason in scripts/hwp-ieum-suite/expected.json (H4b, MUST 3).
//
//   node scripts/hwp-ieum-suite.ts [--engine DIR] [--out FILE] [--tree DIR --expected FILE]
//
// --tree runs the apps/hwp tests of ANOTHER IeumOffice checkout (e.g. a newer release, without its
// own node_modules) instead of the vendored ones: the checkout is mirrored by symbolic links into a
// temporary folder whose node_modules holds the vendored tree's third-party packages and the
// checkout's own workspace packages (@genoffice/*), and Node and Vite keep the links' paths
// (NODE_PRESERVE_SYMLINKS, resolve.preserveSymlinks) so both find that node_modules. The checkout
// is not written to. Packages the checkout needs and the vendored tree lacks make those test files
// fail to load; the list of known failures for that tree is --expected.
//
// Exit 0 when exactly the listed tests fail; 1 when another test fails (a regression to explain or
// fix) or a listed one now passes (the list is stale); 64 on a usage error. The vendored files are
// read in place; Ieum's own vitest runs them with scripts/hwp-ieum-suite/vitest.config.mjs, which
// points `@rhwp/core` at the engine. Nothing of a document is printed: test names and counts only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ENGINE_DIR } from "../third_party/hop/engine.ts";
import { repoRoot } from "./hwp-studio-harness.ts";
import { IEUM_HWP_DIR } from "./ieum-earlier-source.mjs";

type Expected = { engine: string; failures: { test: string; class: "environment" | "upstream" | "engine-version" | "workbench-choice"; reason: string }[] };
const option = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const engine = resolve(option("--engine") ?? join(repoRoot, ENGINE_DIR));
if (!existsSync(join(engine, "rhwp.js"))) { console.error(`no engine in ${engine}`); process.exit(64); }
// The suite's own tree: the checkout the Hangul page builds from (scripts/ieum-earlier-source.mjs).
const vendored = join(repoRoot, IEUM_HWP_DIR);
const vitest = join(vendored, "node_modules/vitest/vitest.mjs");
const scratch = mkdtempSync(join(tmpdir(), "wb-ieum-suite-"));
const report = join(scratch, "report.json");
const treeOption = option("--tree");
if (treeOption && !option("--expected")) { console.error("--tree needs --expected FILE"); process.exit(64); }
/** A mirror of another IeumOffice checkout by links, with a node_modules: the vendored tree's packages + the checkout's own workspace packages. */
function mirror(tree: string): string {
  const root = join(scratch, "tree");
  mkdirSync(join(root, "node_modules", "@genoffice"), { recursive: true });
  // apps/hwp is a real folder (vitest's working folder: a linked one would resolve to the checkout itself)
  for (const entry of readdirSync(tree)) if (entry !== "node_modules" && entry !== ".git" && entry !== "apps") symlinkSync(join(tree, entry), join(root, entry));
  for (const entry of readdirSync(join(tree, "apps"))) if (entry !== "hwp") { mkdirSync(join(root, "apps"), { recursive: true }); symlinkSync(join(tree, "apps", entry), join(root, "apps", entry)); }
  mkdirSync(join(root, "apps", "hwp"), { recursive: true });
  for (const entry of readdirSync(join(tree, "apps", "hwp"))) if (entry !== "node_modules") symlinkSync(join(tree, "apps", "hwp", entry), join(root, "apps", "hwp", entry));
  for (const entry of readdirSync(join(vendored, "node_modules"))) if (entry !== "@genoffice" && entry !== ".bin") symlinkSync(join(vendored, "node_modules", entry), join(root, "node_modules", entry));
  for (const group of ["packages", "apps"]) for (const dir of readdirSync(join(tree, group))) {
    const manifest = join(tree, group, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const name = String(JSON.parse(readFileSync(manifest, "utf8")).name ?? "");
    if (name.startsWith("@genoffice/") && !existsSync(join(root, "node_modules", name))) symlinkSync(join(root, group, dir), join(root, "node_modules", name));
  }
  return root;
}
const tree = treeOption ? mirror(resolve(treeOption)) : undefined;
const app = join(tree ?? vendored, "apps/hwp");
try {
  const run = spawnSync(process.execPath, [vitest, "run", "--config", join(repoRoot, "scripts/hwp-ieum-suite/vitest.config.mjs"), "--reporter=json", `--outputFile=${report}`], {
    cwd: app, env: { ...process.env, HWP_ENGINE_DIR: engine, ...(tree ? { NODE_PRESERVE_SYMLINKS: "1", HWP_SUITE_PRESERVE_SYMLINKS: "1" } : {}) }, stdio: ["ignore", "ignore", "inherit"], maxBuffer: 1 << 26,
  });
  if (!existsSync(report)) { console.error(`vitest wrote no report (exit ${run.status})`); process.exit(1); }
  const result = JSON.parse(readFileSync(report, "utf8")) as { numTotalTests: number; numPassedTests: number; numFailedTests: number; testResults: { name: string; message?: string; assertionResults: { fullName: string; status: string }[] }[] };
  const id = (file: string, name: string) => `${file.slice(app.length + 1)} > ${name}`;
  const failed = result.testResults.flatMap((file) => file.assertionResults.filter((test) => test.status === "failed").map((test) => id(file.name, test.fullName)));
  // a suite that fails to load has no assertion results: count it by file
  const broken = result.testResults.filter((file) => file.assertionResults.length === 0 && file.message).map((file) => id(file.name, "(the file does not load)"));
  // the list for the vendored tree's release: v0.13.0 since the Hangul page moved (unit hwp13); expected.json is v0.12.7's
const expectedFile = resolve(option("--expected") ?? join(repoRoot, "scripts/hwp-ieum-suite", IEUM_HWP_DIR === "vendor/ieumoffice" ? "expected-v0.13.0.json" : "expected.json"));
const expected = JSON.parse(readFileSync(expectedFile, "utf8")) as Expected;
  const listed = new Map(expected.failures.map((item) => [item.test, item]));
  const actual = new Set([...failed, ...broken]);
  const unexpected = [...actual].filter((test) => !listed.has(test));
  const stale = [...listed.keys()].filter((test) => !actual.has(test));
  console.log(`Ieum HWP suite${treeOption ? ` of ${treeOption}` : ""} on ${engine.slice(repoRoot.length + 1) || engine}: ${result.numTotalTests} tests, ${result.numPassedTests} passed, ${result.numFailedTests} failed, ${broken.length} files did not load`);
  const byClass = new Map<string, number>();
  for (const item of expected.failures) if (actual.has(item.test)) byClass.set(item.class, (byClass.get(item.class) ?? 0) + 1);
  console.log(`known failures (${expectedFile.slice(repoRoot.length + 1) || expectedFile}): ${[...byClass].map(([kind, count]) => `${kind} ${count}`).join(", ") || "none"}`);
  for (const test of unexpected) console.log(`UNEXPECTED failure: ${test}`);
  for (const test of stale) console.log(`listed but passes now: ${test}`);
  const out = option("--out");
  // why a file did not load: the first line of its error (a missing package, a missing export …), no document text
  const loadErrors = Object.fromEntries(result.testResults.filter((file) => file.assertionResults.length === 0 && file.message).map((file) => [id(file.name, "(the file does not load)"), String(file.message).split("\n")[0].slice(0, 300)]));
  if (out) writeFileSync(out, JSON.stringify({ engine, total: result.numTotalTests, passed: result.numPassedTests, failed: [...actual].sort(), unexpected, stale, loadErrors }, null, 2) + "\n");
  process.exitCode = unexpected.length || stale.length ? 1 : 0;
} finally { rmSync(scratch, { recursive: true, force: true }); }
