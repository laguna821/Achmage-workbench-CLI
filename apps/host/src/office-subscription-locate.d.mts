type Provider = "codex" | "claude-code";
type Program = { provider: Provider; command: string; prefixArgs: string[]; env: Record<string, string>; entry: string; source: string };
export function locateSubscriptionProgram(provider: Provider, options?: { configuredPath?: string }): Promise<Program | null>;
export function resolveSubscriptionProgram(provider: Provider, options?: { configuredPath?: string }): Promise<Program>;
