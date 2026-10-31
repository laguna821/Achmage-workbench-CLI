import type { OfficeSettings } from "./office-settings.mjs";
export type OfficeWebTools = {
  capabilities(): Promise<Record<string, unknown>>;
  invoke(name: string, args: unknown[], signal: AbortSignal, document?: { path: string }): Promise<unknown>;
};
export function createOfficeWebTools(store: OfficeSettings, injected?: Record<string, (...args: any[]) => any>, context?: (recheck?: boolean) => Promise<{ path: "screen" | "headless"; statuses?: any; dataDir?: string }>): OfficeWebTools;
