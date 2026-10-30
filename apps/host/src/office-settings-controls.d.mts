import type { OfficeSettings } from "./office-settings.mjs";
export type OfficeAiHostActions = {
  install?(provider: "codex" | "claude-code"): Promise<{ ok: boolean; reason?: "failed" | "unsupported"; error?: string }>;
};
type Operation = (...args: any[]) => any;
export type OfficeSettingsControlOverrides = Partial<Record<
  "detect" | "listModels" | "codexModels" | "customModels" | "localModels" | "localInspect" |
  "localTest" | "chat" | "mediaTest" | "searchTest" | "geminiConnect" | "openRouterConnect" | "freeQuota" | "openUrl", Operation>> & {
  subscriptionActions?: Record<string, Operation>;
};
export function createOfficeSettingsControls(dataDir: string, store: OfficeSettings, injected?: OfficeSettingsControlOverrides, hostActions?: OfficeAiHostActions): {
  close(): void;
  invoke(channel: string, args: unknown[], owner: string, signal: AbortSignal): Promise<any>;
};
