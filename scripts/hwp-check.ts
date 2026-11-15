// `npm run check:hwp` — the Hangul engine gate, run by the engine unit before AND after a change
// of engine or studio (HWP_CORPUS_ROOT must point at the corpus, e.g. refs-ext/rhwp-0.9.0):
//   1. scripts/hwp-corpus-check.ts run       every corpus document opened, laid out, saved on six paths
//   2. scripts/hwp-corpus-check.ts compare   against scripts/hwp-corpus/baseline.json
//   3. scripts/hwp-studio-census-check.ts    the built studio's report vs the gateway's census
// One after the other (each is heavy). Exit 0 only when every step exits 0; otherwise the first
// non-zero exit code (a skipped document is not a pass). `--keep FILE` keeps the corpus run's result.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./hwp-studio-harness.ts";

const keep = (() => { const index = process.argv.indexOf("--keep"); return index >= 0 ? process.argv[index + 1] : undefined; })();
const scratch = keep ? undefined : mkdtempSync(join(tmpdir(), "wb-hwp-check-"));
const result = keep ?? join(scratch!, "corpus.json");
const steps: [string, string[]][] = [
  ["corpus run", ["scripts/hwp-corpus-check.ts", "run", "--out", result]],
  ["corpus compare with the baseline", ["scripts/hwp-corpus-check.ts", "compare", "scripts/hwp-corpus/baseline.json", result]],
  ["studio census check", ["scripts/hwp-studio-census-check.ts"]],
];
let exitCode = 0;
try {
  for (const [name, args] of steps) {
    console.log(`\n== check:hwp — ${name}`);
    const run = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: "inherit" });
    const code = run.status ?? 1;
    console.log(`== ${name}: exit ${code}`);
    if (code !== 0 && exitCode === 0) exitCode = code;
  }
} finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
console.log(`\ncheck:hwp ${exitCode === 0 ? "passed" : `FAILED (exit ${exitCode})`}`);
process.exitCode = exitCode;
