import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type ResolvedBinary = { path: string; version: string; source: "installed" | "bundled" | "override" };

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

async function newest(candidates: string[], source: ResolvedBinary["source"]): Promise<ResolvedBinary | null> {
  let best: ResolvedBinary | null = null;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const version = await versionOf(candidate);
    if (version && (!best || compareVersions(version, best.version) > 0)) {
      best = { path: candidate, version, source };
    }
  }
  return best;
}

/**
 * Folders where the official installers and Node version managers put command line tools,
 * besides PATH: a desktop app started from the launcher often has a shorter PATH than a shell.
 * (The list follows IeumOffice's locate.ts, Apache-2.0.)
 */
function toolFolders(): string[] {
  const home = homedir();
  const folders = [
    join(home, ".local/bin"),
    join(home, ".npm-global/bin"),
    join(home, ".volta/bin"),
    join(home, ".bun/bin"),
    join(home, ".yarn/bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  try {
    const nvm = join(home, ".nvm/versions/node");
    for (const version of readdirSync(nvm)) folders.push(join(nvm, version, "bin"));
  } catch {
    // No nvm.
  }
  return folders;
}

function candidates(name: string): string[] {
  const onPath = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return [...new Set([...onPath, ...toolFolders()])].map((dir) => join(dir, name)).filter((path) => existsSync(path));
}

/**
 * Codex: newest of an explicit override, `codex` on PATH and in the usual tool folders, and the
 * engine bundled with the ChatGPT desktop app (it usually ships a newer engine, which matters for
 * new models).
 */
export function resolveCodex(): Promise<ResolvedBinary | null> {
  const override = process.env.WORKBENCH_CODEX_BIN;
  if (override) {
    return newest([override], "override");
  }
  return newest([...candidates("codex"), "/usr/lib/chatgpt/resources/codex"].filter((path) => existsSync(path)), "installed");
}

/**
 * Claude: the user's installed official `claude` first (kept up to date by its own updater),
 * falling back to the binary shipped with the Agent SDK, which is reported as such.
 */
export async function resolveClaude(sdkBundled: string | null): Promise<ResolvedBinary | null> {
  const override = process.env.WORKBENCH_CLAUDE_BIN;
  if (override) {
    return newest([override], "override");
  }
  for (const candidate of candidates("claude")) {
    const version = await versionOf(candidate);
    if (version) {
      return { path: candidate, version, source: "installed" };
    }
  }
  if (sdkBundled && existsSync(sdkBundled)) {
    const version = await versionOf(sdkBundled);
    if (version) {
      return { path: sdkBundled, version, source: "bundled" };
    }
  }
  return null;
}
