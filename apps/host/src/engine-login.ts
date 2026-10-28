// Adapted from IeumOffice (https://github.com/pblsketch/openoffice)
// packages/ai-provider/src/subscription/status.ts (parseClaudeAuthStatus, codexAccountInfo) and
// contract.ts (subscriptionAccountOf) @ 9052297, Apache-2.0 (see third_party/ieumoffice).
// Changes: one result type for both engines; the login-kind ledger and metered consent are left
// out; the plan is kept for display.
import type { LoginMethod } from "@workbench/contracts";

/**
 * What an engine says about its login, read only through known values: an unexpected value reads
 * as `unknown`, and nothing an engine printed is passed on except a plan identifier and an
 * e-mail address of the expected shape.
 */
export type EngineLogin = { signedIn: false } | { signedIn: true; method: LoginMethod; plan: string | null; account: string | null };

const ACCOUNT = /^[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63})+$/u;

/** An e-mail address and nothing else, or null. */
export function accountOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const account = value.trim();
  return account.length <= 254 && ACCOUNT.test(account) ? account : null;
}

/** A plan as the engines name it (`max`, `pro`, `plus`, `team`), or null for anything else. */
function planOf(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/i.test(value) && value !== "unknown" ? value : null;
}

const asRecord = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

const CLAUDE_METERED = new Set(["api_key", "api_key_helper", "third_party"]);

/**
 * `claude auth status --json`. A subscription is reported only for a claude.ai login on
 * Anthropic's own API that names a plan; an API key, a key helper, or any other backend
 * (Bedrock, Vertex, a gateway) is metered.
 */
export function parseClaudeAuthStatus(stdout: string): EngineLogin | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asRecord(JSON.parse(stdout.slice(start, end + 1)));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.loggedIn !== "boolean") return null;
  if (!parsed.loggedIn) return { signedIn: false };
  const plan = planOf(parsed.subscriptionType);
  const account = accountOf(parsed.email);
  const otherBackend = typeof parsed.apiProvider === "string" && parsed.apiProvider !== "" && parsed.apiProvider !== "firstParty";
  if ((typeof parsed.authMethod === "string" && CLAUDE_METERED.has(parsed.authMethod)) || otherBackend) {
    return { signedIn: true, method: "metered", plan: null, account };
  }
  if (parsed.authMethod === "claude.ai" && parsed.apiProvider === "firstParty" && plan) {
    return { signedIn: true, method: "subscription", plan, account };
  }
  return { signedIn: true, method: "unknown", plan, account };
}

/** The Codex app-server's `account/read`: a ChatGPT login is a subscription, an API key is metered. */
export function codexAccountInfo(accountRead: unknown): EngineLogin | null {
  const result = asRecord(accountRead);
  if (!result) return null;
  const account = asRecord(result.account);
  if (!account) {
    if (result.requiresOpenaiAuth === true) return { signedIn: false };
    // No account and none required: Codex points at another model provider.
    return { signedIn: true, method: "unknown", plan: null, account: null };
  }
  if (account.type === "chatgpt") return { signedIn: true, method: "subscription", plan: planOf(account.planType), account: accountOf(account.email) };
  if (account.type === "apiKey") return { signedIn: true, method: "metered", plan: null, account: null };
  return { signedIn: true, method: "unknown", plan: null, account: null };
}
