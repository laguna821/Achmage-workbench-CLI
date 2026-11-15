// Test helper: `tempDir(prefix)` makes a temp folder that is removed after the test that made it (or
// after the test file, when made outside a test). The removal runs after the file's own afterEach /
// afterAll hooks (it is registered first, in test-temp-root.ts, and vitest runs after-hooks in reverse),
// so a gateway or store the test closes in its own hook is closed before its folder goes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

const made: { test: string[]; file: string[] } = { test: [], file: [] };

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  (expect.getState().currentTestName ? made.test : made.file).push(dir);
  return dir;
}

/** Removes the folders made during the test that just ended ("test") or during the file ("file"). */
export function removeTempDirs(scope: "test" | "file") {
  for (const dir of (scope === "file" ? [...made.test, ...made.file] : made.test).splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (scope === "file") made.test.length = made.file.length = 0;
}
