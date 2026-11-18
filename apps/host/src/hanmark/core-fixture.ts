// Test helper: the app's one kordoc (the bundled hallym-kordoc core runner), as the gateway runs it.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findKordocRunner } from "../kordoc.ts";
import { runCore } from "../hangul-convert.ts";

export async function generateWithCore(markdown: string, extra: Record<string, unknown> = {}): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "wb-hanmark-core-"));
  try {
    const result = await runCore(findKordocRunner()!, { mode: "generate", markdown, outputDir: join(dir, "out"), ...extra }, { cwd: dir });
    const file = result.files?.find((entry) => entry.path.endsWith(".hwpx"))?.path;
    if (!file) throw new Error(`core generate failed: ${JSON.stringify(result.failure)}`);
    return readFileSync(file);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function readWithCore(input: string, options: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-hanmark-core-"));
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await runCore(findKordocRunner()!, { mode: "read", input, options, outputDir: join(dir, "out") }, { cwd: dir });
  } finally { process.env = saved; rmSync(dir, { recursive: true, force: true }); }
}
