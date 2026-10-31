import type { OfficeSettings } from "./office-settings.mjs";
export type OfficeWebTools = {
  capabilities(): Promise<Record<string, unknown>>;
  invoke(name: string, args: unknown[], signal: AbortSignal): Promise<unknown>;
};
export function createOfficeWebTools(store: OfficeSettings, injected?: Record<string, (...args: any[]) => any>): OfficeWebTools;
