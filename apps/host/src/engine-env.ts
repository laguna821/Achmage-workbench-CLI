// Adapted from IeumOffice (https://github.com/pblsketch/ieumoffice)
// packages/ai-provider/src/subscription/env.ts @ 9052297, Apache-2.0 (see third_party/ieumoffice).
// Changes: the Windows-only HOME fix and the per-launch PATH/extra options are left out; a client
// tag for the Claude Agent SDK is added.
import { delimiter, dirname, isAbsolute } from "node:path";

/**
 * Variables an engine is never started with: each one moves Claude Code or Codex from the user's
 * subscription login to another billing route (an API key, a cloud provider, a proxy). A
 * variable left in the gateway's own environment would otherwise switch every session silently.
 * `CLAUDE_CODE_OAUTH_TOKEN` stays: it is a subscription credential.
 */
export const BILLING_ENV_VARS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
];

/** Which billing variables are set in an environment (names only, for the connection screen). */
export function billingVarsIn(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const names = new Set(BILLING_ENV_VARS);
  return Object.keys(env).filter((name) => env[name] && names.has(platform === "win32" ? name.toUpperCase() : name));
}

/**
 * The app's own variables (`WORKBENCH_*`, `GENOFFICE_*`) the gateway runs with, and the few an
 * engine is given. The rest point at the gateway's own doors and never reach an engine: the
 * vault helper (`WORKBENCH_SECRET_BIN`) and the terminal worker (`WORKBENCH_PTY_BIN`), the gateway's
 * token and port, the login unit's runner, test stand-ins, the engines' own binary choices.
 * Kept, and why:
 * - `WORKBENCH_DATA_DIR`: the tools Workbench puts on the engines' PATH (workbench-find,
 *   workbench-credential, workbench-desktop, workbench-hwp, the IeumOffice launcher) find the
 *   app's folder by it; its path is fixed anyway.
 * - `WORKBENCH_APP_BIN`: workbench-hwp's font list and IeumOffice's exports run the app's binary;
 *   that binary answers secrets only to the gateway itself (gateway_caller.rs).
 * - `WORKBENCH_RESOURCES_DIR`: the same tools find the bundled kordoc, IeumOffice and skills.
 * A session's own variables (WORKBENCH_FIND_SESSION and the like) are passed as `extra`.
 * The person's own environment is theirs to give their engines and passes as before.
 */
export const ENGINE_APP_ENV_VARS: readonly string[] = ["WORKBENCH_DATA_DIR", "WORKBENCH_APP_BIN", "WORKBENCH_RESOURCES_DIR"];
const appVariable = (upper: string) => upper.startsWith("WORKBENCH_") || upper.startsWith("GENOFFICE_");

/**
 * The environment for an engine process: a copy of `base` without `BILLING_ENV_VARS` and, of the
 * app's own variables, only `ENGINE_APP_ENV_VARS`. Windows
 * matches variable names without regard to case, as the system does. With an absolute
 * `command`, its folder goes to the front of PATH (engines start helper programs by name), and
 * `paths` before it (tools Workbench gives the engines, like the agent browser's playwright-cli);
 * after them the app's tool wrappers (`<data>/bin`, `setEngineToolDir`).
 */
let toolDir: string | null = null;
/** `<data>/bin` (tool-bin.ts): first on every engine's PATH, never on the gateway's own. */
export function setEngineToolDir(dir: string | null) { toolDir = dir; }
/** A copy of `base` with the app's tool wrappers first on PATH (the person's terminals in the app). */
export function withEngineTools(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!toolDir) return { ...base };
  const key = Object.keys(base).find((name) => name.toLowerCase() === "path") ?? "PATH";
  return { ...base, [key]: [toolDir, base[key] ?? ""].join(delimiter) };
}

export function engineEnv(options: { base?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; command?: string; extra?: Record<string, string>; paths?: string[] } = {}) {
  const platform = options.platform ?? process.platform;
  const env: NodeJS.ProcessEnv = { ...(options.base ?? process.env) };
  const stripped = new Set(BILLING_ENV_VARS), kept = new Set(ENGINE_APP_ENV_VARS);
  for (const name of Object.keys(env)) {
    const key = platform === "win32" ? name.toUpperCase() : name;
    if (stripped.has(key) || (appVariable(name.toUpperCase()) && !kept.has(key))) delete env[name];
  }
  const command = options.command;
  const front = [...(options.paths ?? []), ...(command && isAbsolute(command) ? [dirname(command)] : []), ...(toolDir ? [toolDir] : [])];
  if (front.length) {
    const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
    env[key] = [...front, env[key] ?? ""].join(delimiter);
  }
  return { ...env, ...options.extra };
}

/** `engineEnv` for the Claude Agent SDK, which wants plain strings and a client tag. */
export function claudeSdkEnv(command: string, options: { paths?: string[]; extra?: Record<string, string> } = {}): Record<string, string> {
  const env = engineEnv({ command, paths: options.paths, extra: { CLAUDE_AGENT_SDK_CLIENT_APP: "achmage-workbench/0.1", ...options.extra } });
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
