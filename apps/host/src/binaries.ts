import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type ResolvedBinary = { path: string; version: string };

async function versionOf(path: string): Promise<string | null> {
  try {
    const { stdout } = await run(path, ["--version"], { timeout: 15_000 });
    return stdout.trim().split(/\s+/).find((token) => /^\d+\.\d+/.test(token)) ?? stdout.trim();
  } catch {
    return null;
  }
}

function compareVersions(a: string, b: string) {
  const pa = a.split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = b.split(/[^\d]+/).filter(Boolean).map(Number);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

async function newest(candidates: string[]): Promise<ResolvedBinary | null> {
  let best: ResolvedBinary | null = null;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const version = await versionOf(candidate);
    if (version && (!best || compareVersions(version, best.version) > 0)) {
      best = { path: candidate, version };
    }
  }
  return best;
}

function onPath(name: string): string[] {
  return (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .map((dir) => join(dir, name))
    .filter((path) => existsSync(path));
}

/**
 * Codex: newest of an explicit override, `codex` on PATH and the engine bundled with the
 * ChatGPT desktop app (it usually ships a newer engine, which matters for new models).
 */
export function resolveCodex(): Promise<ResolvedBinary | null> {
  const override = process.env.WORKBENCH_CODEX_BIN;
  if (override) {
    return newest([override]);
  }
  return newest([...onPath("codex"), "/usr/lib/chatgpt/resources/codex", join(homedir(), ".local/bin/codex")].filter((path) => existsSync(path)));
}

/**
 * Claude: the user's installed official `claude` first (kept up to date by its own updater),
 * falling back to the binary shipped with the Agent SDK.
 */
export async function resolveClaude(sdkBundled: string | null): Promise<ResolvedBinary | null> {
  const override = process.env.WORKBENCH_CLAUDE_BIN;
  const candidates = override ? [override] : [join(homedir(), ".local/bin/claude"), ...onPath("claude")];
  for (const candidate of candidates.filter((path) => existsSync(path))) {
    const version = await versionOf(candidate);
    if (version) {
      return { path: candidate, version };
    }
  }
  if (sdkBundled && existsSync(sdkBundled)) {
    const version = await versionOf(sdkBundled);
    if (version) {
      return { path: sdkBundled, version };
    }
  }
  return null;
}
