// vitest globalSetup (main process): after the whole run, remove the per-file temp folders of THIS run
// (test-temp-root.ts names them wv<this process id in base 36>-…) that a file could not remove itself —
// a file whose tests are all skipped runs no afterAll. Other runs' folders are not touched.
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup() {
  const dir = tmpdir(), mine = `wv${process.pid.toString(36)}-`;
  return () => {
    for (const name of readdirSync(dir)) if (name.startsWith(mine)) rmSync(join(dir, name), { recursive: true, force: true });
  };
}
