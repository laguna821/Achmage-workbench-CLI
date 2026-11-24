import { execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import { win32, posix } from "node:path";
import { promisify } from "node:util";
import { engineEnv } from "../engine-env.ts";
import { commandNames, envValue, launchFor, pathDirs, realFs, type EngineLaunch, type LocateContext } from "../engine-locate.ts";

// Where Google's Antigravity CLI (`agy`) is on this computer, whether it is new enough for Workbench's ACP
// client, and the environment it is started with. Workbench never installs, patches or bundles it: the
// person installs it with Google's own installer (shown and run in a visible terminal tab) and agy updates
// itself. Study: ux/reports/gemini-engine-study.md § G rules 1, 9, 10.

const run = promisify(execFile);

/** Orca's gate, the one part of Orca worth copying (§ G rule 9): agy before 1.5.2 had ACP bugs Workbench cannot work around. */
export const AGY_MIN_VERSION = "1.5.2";
/** Recommended (study § H): agy 1.5.10–1.5.13 fixed many ACP bugs; between the two the card says so in one line. */
export const AGY_RECOMMENDED_VERSION = "1.5.12";

export type AgyBinary = EngineLaunch & { version: string | null };

/** "1.5.13" ≥ "1.5.2". Unknown or unreadable versions are not ok. */
export function agyVersionOk(version: string | null | undefined, min = AGY_MIN_VERSION) {
  if (!version || !/^\d+\.\d+/.test(version)) return false;
  const a = version.split(/[^\d]+/).filter(Boolean).map(Number), b = min.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff) return diff > 0;
  }
  return true;
}

/**
 * Every place agy may be, in the order a shell would find it, then Google's installer folders:
 * `~/.local/bin/agy` (macOS, Linux) and `%LOCALAPPDATA%\agy\bin\agy.exe` (Windows). `WORKBENCH_AGY_BIN`
 * overrides (checks use the stand-in).
 */
export function agyCandidates(ctx: Pick<LocateContext, "platform" | "env" | "home" | "fs" | "node">): EngineLaunch[] {
  const p = ctx.platform === "win32" ? win32 : posix;
  const full = { ...ctx, arch: process.arch } as LocateContext;
  const forced = envValue(ctx.env, "WORKBENCH_AGY_BIN", ctx.platform);
  if (forced) {
    const launch = ctx.fs.kind(forced) === "file" ? launchFor(forced, "override", full) : null;
    return launch ? [launch] : [];
  }
  const out: EngineLaunch[] = [];
  const seen = new Set<string>();
  const take = (file: string, origin: EngineLaunch["origin"]) => {
    if (ctx.fs.kind(file) !== "file") return;
    const launch = launchFor(file, origin, full);
    if (!launch) return;
    const key = ctx.platform === "win32" ? ctx.fs.real(launch.command).toLowerCase() : ctx.fs.real(launch.command);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(launch);
  };
  for (const dir of pathDirs(ctx.env, ctx.platform)) for (const name of commandNames("agy", ctx)) take(p.join(dir, name), "path");
  if (ctx.platform === "win32") {
    const local = envValue(ctx.env, "LOCALAPPDATA", "win32") ?? p.join(ctx.home, "AppData", "Local");
    take(p.join(local, "agy", "bin", "agy.exe"), "native");
  } else {
    take(p.join(ctx.home, ".local", "bin", "agy"), "native");
  }
  return out;
}

/** The first agy found that answers `--version` (or the first found at all, with no version). */
export async function resolveAgy(env: NodeJS.ProcessEnv = process.env): Promise<AgyBinary | null> {
  const candidates = agyCandidates({ platform: platform(), env, home: homedir(), fs: realFs, node: process.execPath });
  let first: AgyBinary | null = null;
  for (const launch of candidates) {
    let version: string | null = null;
    try {
      const { stdout } = await run(launch.command, [...launch.args, "--version"], { timeout: 15_000, windowsHide: true, env: agyEnv({ base: env, launch }) });
      version = /\b\d+\.\d+\.\d+[\w.-]*/.exec(stdout)?.[0] ?? null;
    } catch { /* not runnable: try the next */ }
    if (version) return { ...launch, version };
    first ??= { ...launch, version: null };
  }
  return first;
}

/**
 * Variables that would move agy from the person's subscription sign-in to another account or a billed route
 * (§ G rule 10; subscription login only, the owner 2026-11-21): a Gemini / Google API key, a Cloud project or
 * ADC, Vertex. None of them is ever passed, so agy can never silently bill a key.
 */
const KEY_VARS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"];
const CLOUD_PATTERN = /^(GOOGLE_CLOUD_|GOOGLE_APPLICATION_CREDENTIALS$|GOOGLE_GENAI_USE_VERTEXAI$|GOOGLE_VERTEX|VERTEX_|CLOUDSDK_|GCLOUD_|AGY_ADC_AUTH$)/;

export function strippedAgyVars(env: NodeJS.ProcessEnv, os: NodeJS.Platform = process.platform): string[] {
  return Object.keys(env).filter((name) => {
    const key = os === "win32" ? name.toUpperCase() : name;
    return KEY_VARS.includes(key) || CLOUD_PATTERN.test(key);
  });
}

export function agyEnv(options: { base?: NodeJS.ProcessEnv; launch?: Pick<EngineLaunch, "command" | "kind" | "env" | "paths">; paths?: string[]; extra?: Record<string, string>; os?: NodeJS.Platform } = {}): NodeJS.ProcessEnv {
  const base = { ...(options.base ?? process.env) };
  for (const name of strippedAgyVars(base, options.os)) delete base[name];
  const launch = options.launch;
  return engineEnv({ base, platform: options.os, command: launch?.kind === "native" ? launch.command : undefined, paths: [...(options.paths ?? []), ...(launch?.paths ?? [])], extra: { ...launch?.env, ...options.extra } });
}

/**
 * Google's official installer, as its install page and the CMDS plugin give it, run in a visible
 * terminal tab by the person's press (never silently). `WORKBENCH_AGY_INSTALLER` (checks only) runs a
 * local stand-in instead, so no check ever reaches Google.
 */
export function agyInstallCommand(os: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { shell: string; args: string[]; shown: string } {
  const standIn = env.WORKBENCH_AGY_INSTALLER;
  if (standIn) return { shell: process.execPath, args: [standIn], shown: `node ${standIn}` };
  if (os === "win32") {
    const shown = "irm https://antigravity.google/cli/install.ps1 | iex";
    return { shell: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", shown], shown };
  }
  const shown = "curl -fsSL https://antigravity.google/cli/install.sh | bash";
  return { shell: "/bin/sh", args: ["-c", shown], shown };
}

/** Google's pages the settings card links to (opened only by the person's click). */
export const GEMINI_LINKS = {
  faq: "https://antigravity.google/docs/faq",
  terms: "https://antigravity.google/terms",
  install: "https://antigravity.google/docs/install?tab=cli",
} as const;
