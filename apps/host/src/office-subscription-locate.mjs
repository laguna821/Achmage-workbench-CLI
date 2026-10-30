// Host-only platform adapter. Every original subscription consumer uses this module
// in the host bundle; the explicit-path implementation remains the reviewed original.
import { locateSubscriptionProgram as originalLocate, subscriptionProviderLabel } from "../../../vendor/ieumoffice/packages/ai-provider/src/subscription/locate.ts";
import { AiRunError } from "../../../vendor/ieumoffice/packages/ai-provider/src/run-error.ts";
import { launchEnv, resolveClaude, resolveCodex, sdkBundledBinary } from "./binaries.ts";
export * from "../../../vendor/ieumoffice/packages/ai-provider/src/subscription/locate.ts";

export async function locateSubscriptionProgram(provider, options = {}) {
  if (options.configuredPath?.trim()) return originalLocate(provider, options);
  const binary = provider === "codex" ? await resolveCodex() : await resolveClaude(sdkBundledBinary());
  if (!binary) return null;
  // Carry launch arguments and tool search paths, without copying the host's secrets
  // into program.env. The original process layer still owns billing-env sanitization.
  const env = { ...binary.env };
  for (const [key, value] of Object.entries(launchEnv(binary))) {
    if (key.toLowerCase() === "path" && value !== undefined) env[key] = value;
  }
  return { provider, command: binary.command, prefixArgs: [...binary.args], env,
    entry: binary.kind === "node" ? binary.args[0] : binary.command,
    source: binary.source === "managed" ? "managed" : "path" };
}

export async function resolveSubscriptionProgram(provider, options = {}) {
  const program = await locateSubscriptionProgram(provider, options);
  if (program) return program;
  throw new AiRunError("not-installed", `${subscriptionProviderLabel(provider)} CLI was not found`, { provider });
}
