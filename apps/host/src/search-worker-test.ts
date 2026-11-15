// Test helper: the tests that reach the Rust search worker (apps/desktop/search-worker) through the
// gateway's search. The gateway finds the worker by WORKBENCH_SEARCH_WORKER_BIN (or the desktop app's
// own binary, WORKBENCH_APP_BIN). Where neither is set, a worker built in this checkout
// (`cargo build --release --manifest-path apps/desktop/search-worker/Cargo.toml`) is used. Without any,
// those tests are SKIPPED with the reason in their name — except in CI, where the release workflow
// builds the worker first (.github/workflows/release.yml, job "web") and an absent one must fail.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { it, type TestFunction } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const built = ["release", "debug"].map((profile) => resolve(root, `apps/desktop/search-worker/target/${profile}/workbench-search-worker`)).find((path) => existsSync(path));
if (!process.env.WORKBENCH_SEARCH_WORKER_BIN && !process.env.WORKBENCH_APP_BIN && built) process.env.WORKBENCH_SEARCH_WORKER_BIN = built;

/** Null when the worker is there (or in CI); otherwise why the search tests are skipped. */
export const NO_SEARCH_WORKER: string | null = process.env.WORKBENCH_SEARCH_WORKER_BIN || process.env.WORKBENCH_APP_BIN || process.env.CI
  ? null
  : "skipped: no Rust search worker (set WORKBENCH_SEARCH_WORKER_BIN, or cargo build --release --manifest-path apps/desktop/search-worker/Cargo.toml)";
if (NO_SEARCH_WORKER) console.warn(`search tests ${NO_SEARCH_WORKER}`);

/** `it` for a test that needs the search worker: skipped, with the reason in its name, when there is none. */
export function itWithSearch(name: string, fn: TestFunction, timeout?: number) {
  if (NO_SEARCH_WORKER) return it.skip(`${name} [${NO_SEARCH_WORKER}]`, fn);
  return it(name, fn, timeout);
}

/** A test name that carries the skip reason while the worker is absent (for it.each / it.runIf forms). */
export const withSearchReason = (name: string) => (NO_SEARCH_WORKER ? `${name} [${NO_SEARCH_WORKER}]` : name);
/** `it` (or `it.skip` when the worker is absent) for the it.each form. */
export const itSearch = NO_SEARCH_WORKER ? it.skip : it;
