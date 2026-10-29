import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { promisify } from "node:util";
import { engineEnv } from "./engine-env.ts";
import { engineCandidates, envValue, launchFor, realFs, type EngineLaunch, type EngineName, type LocateContext } from "./engine-locate.ts";
import { npmCli } from "./npm.ts";
import { shellAdded } from "./shell-env.ts";

const run = promisify(execFile);

/**
 * An engine found on this computer and how to start it. `path` is what was found (shown on
 * screen), `command` + `args` what is started. `source`: the user's own install, Workbench's
 * (`managed`), the copy shipped with the Agent SDK (`bundled`), or one set by environment.
 */
export type ResolvedBinary = EngineLaunch & { version: string; source: "installed" | "bundled" | "override" | "managed" };

/** Where Workbench installs engines (set once at start, engine-install.ts). */
let managedDir: string | null = null;
export function setManagedEnginesDir(dir: string | null) {
  managedDir = dir;
}

/** npm's global prefix, asked of npm once when no engine is found the usual ways. */
let npmPrefix: string | null | undefined;

async function askNpmPrefix(): Promise<string | null> {
  if (npmPrefix !== undefined) return npmPrefix;
  npmPrefix = null;
  const cli = npmCli();
  if (!cli) return null;
  try {
    const { stdout } = await run(process.execPath, [cli, "prefix", "-g"], { timeout: 15_000, windowsHide: true, env: { ...process.env, NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false" } });
    const prefix = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
    npmPrefix = prefix || null;
  } catch {
    // No usable npm: nothing more to look at.
  }
  return npmPrefix;
}

function context(extra: Partial<LocateContext> = {}): LocateContext {
  return {
    platform: platform(),
    arch: arch(),
    env: process.env,
    home: homedir(),
    fs: realFs,
    node: process.execPath,
    shellDirs: shellAdded,
    managedDir,
    npmPrefix: npmPrefix ?? null,
    // Checks that need an engine missing on a computer that has one look only in the user's folders.
    systemWide: process.env.WORKBENCH_ENGINE_SEARCH !== "user",
    ...extra,
  };
}

/** The environment an engine's own commands run with (its launcher's variables and folders). */
export function launchEnv(launch: Pick<EngineLaunch, "command" | "kind" | "env" | "paths">, options: { paths?: string[]; extra?: Record<string, string> } = {}) {
  return engineEnv({ command: launch.kind === "native" ? launch.command : undefined, paths: [...(options.paths ?? []), ...launch.paths], extra: { ...launch.env, ...options.extra } });
}

const versions = new Map<string, { stamp: number; version: string | null }>();

/** The version an engine prints (`--version`), remembered until its file changes. */
async function versionOf(launch: EngineLaunch): Promise<string | null> {
  const file = launch.kind === "native" ? launch.command : (launch.args[0] ?? launch.command);
  let stamp = 0;
  try {
    stamp = statSync(file).mtimeMs;
  } catch {
    // A Windows app alias: probe every time.
  }
  const key = [launch.command, ...launch.args].join("\u0000");
  const known = versions.get(key);
  if (known && stamp && known.stamp === stamp) return known.version;
  let version: string | null = null;
  try {
    const { stdout } = await run(launch.command, [...launch.args, "--version"], { timeout: 15_000, windowsHide: true, env: launchEnv(launch) });
    version = stdout.trim().split(/\s+/).find((token) => /^\d+\.\d+/.test(token)) ?? (stdout.trim() || null);
  } catch {
    version = null;
  }
  versions.set(key, { stamp, version });
  return version;
}

function compareVersions(a: string, b: string) {
  const pa = a.split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = b.split(/[^\d]+/).filter(Boolean).map(Number);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const sourceOf = (launch: EngineLaunch): ResolvedBinary["source"] =>
  launch.origin === "override" ? "override" : launch.origin === "managed" ? "managed" : launch.origin === "sdk" ? "bundled" : "installed";

async function probe(launch: EngineLaunch): Promise<ResolvedBinary | null> {
  const version = await versionOf(launch);
  return version ? { ...launch, version, source: sourceOf(launch) } : null;
}

async function override(engine: EngineName): Promise<ResolvedBinary | null | undefined> {
  const value = envValue(process.env, engine === "codex" ? "WORKBENCH_CODEX_BIN" : "WORKBENCH_CLAUDE_BIN", platform());
  if (!value) return undefined;
  const launch = launchFor(value, "override", context());
  return launch ? probe(launch) : null;
}

/**
 * Codex: an explicit override, else the newest of the user's own copies (PATH, npm, its installer,
 * the ChatGPT app, editor extensions: the app usually ships a newer engine, which matters for new
 * models), else the one Workbench installed.
 */
export async function resolveCodex(): Promise<ResolvedBinary | null> {
  const forced = await override("codex");
  if (forced !== undefined) return forced;
  const pick = async (candidates: EngineLaunch[]) => {
    let best: ResolvedBinary | null = null;
    for (const candidate of candidates.filter((entry) => entry.origin !== "managed")) {
      const found = await probe(candidate);
      if (found && (!best || compareVersions(found.version, best.version) > 0)) best = found;
    }
    for (const candidate of best ? [] : candidates.filter((entry) => entry.origin === "managed")) {
      best = await probe(candidate);
      if (best) break;
    }
    return best;
  };
  const found = await pick(engineCandidates("codex", context()));
  if (found || npmPrefix !== undefined) return found;
  // A custom npm prefix (.npmrc) is only known to npm itself.
  return (await askNpmPrefix()) ? pick(engineCandidates("codex", context())) : null;
}

/**
 * Claude: the user's own official `claude` first (kept up to date by its own updater), then the
 * one Workbench installed, then the binary shipped with the Agent SDK, which is reported as such.
 */
export async function resolveClaude(sdkBundled: string | null): Promise<ResolvedBinary | null> {
  const forced = await override("claude");
  if (forced !== undefined) return forced;
  const first = async (candidates: EngineLaunch[]) => {
    for (const candidate of candidates) {
      const found = await probe(candidate);
      if (found) return found;
    }
    return null;
  };
  const found = await first(engineCandidates("claude", context({ sdkClaude: sdkBundled })));
  if ((found && found.origin !== "sdk") || npmPrefix !== undefined) return found;
  return (await askNpmPrefix()) ? first(engineCandidates("claude", context({ sdkClaude: sdkBundled }))) : found;
}
