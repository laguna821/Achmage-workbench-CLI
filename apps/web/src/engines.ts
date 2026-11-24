import type { Provider, ProviderStatus } from "@workbench/contracts";

/**
 * The engines a new conversation may start with (0.5.6): Claude and Codex always (their own cards find,
 * install and sign them in); Gemini once the person's Antigravity CLI is found on this PC (설정 › AI 엔진 › Gemini).
 */
export function engineChoices(providers?: Partial<Record<Provider, ProviderStatus>> | null): Provider[] {
  return providers?.gemini?.installed ? ["claude", "codex", "gemini"] : ["claude", "codex"];
}
