// Adapted from IeumOffice (https://github.com/pblsketch/openoffice)
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
 * The environment for an engine process: a copy of `base` without `BILLING_ENV_VARS`. Windows
 * matches variable names without regard to case, as the system does. With an absolute
 * `command`, its folder goes to the front of PATH (engines start helper programs by name).
 */
export function engineEnv(options: { base?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; command?: string; extra?: Record<string, string> } = {}) {
  const platform = options.platform ?? process.platform;
  const env: NodeJS.ProcessEnv = { ...(options.base ?? process.env) };
  const stripped = new Set(BILLING_ENV_VARS);
  for (const name of Object.keys(env)) {
    if (stripped.has(platform === "win32" ? name.toUpperCase() : name)) delete env[name];
  }
  const command = options.command;
  if (command && isAbsolute(command)) {
    const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
    env[key] = `${dirname(command)}${delimiter}${env[key] ?? ""}`;
  }
  return { ...env, ...options.extra };
}

/** `engineEnv` for the Claude Agent SDK, which wants plain strings and a client tag. */
export function claudeSdkEnv(command: string): Record<string, string> {
  const env = engineEnv({ command, extra: { CLAUDE_AGENT_SDK_CLIENT_APP: "achmage-workbench/0.1" } });
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
