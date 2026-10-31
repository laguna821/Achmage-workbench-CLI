import type { AgentMessage, AgentToolDef } from "../../../vendor/ieumoffice/packages/agent-core/src/types.ts";
import type { OfficeSettings } from "./office-settings.mjs";
import type { OfficeAiHostActions } from "./office-settings-controls.mjs";
import type { OfficeWebTools } from "./office-web-tools.mjs";
export const OFFICE_SECRET_PLACEHOLDER: string;
export type OfficeAiChunk = { requestId: string; type: string; text?: string; [key: string]: unknown };
export type OfficeAiStream = { requestId: string; sessionId?: string; settings: unknown; system: string; messages: AgentMessage[]; tools?: AgentToolDef[]; maxTokens?: number };
export type OfficeAiChat = { settings: unknown; system: string; user: string };
export type OfficeAiStatus = { provider: string; state: string; meteredAccepted: boolean; [key: string]: unknown };
export interface OfficeAiEngine {
  settings(): Record<string, unknown>;
  select?(input: unknown): Promise<Record<string, unknown>>;
  statuses(recheck?: boolean, trusted?: boolean): Promise<Record<string, OfficeAiStatus>>;
  configuration?: OfficeSettings;
  webTools?: OfficeWebTools;
  settingsInvoke?(channel: string, args: unknown[], owner: string, signal: AbortSignal): Promise<unknown>;
  setMeteredAccepted?(provider: string, accepted: boolean): Promise<unknown>;
  close?(): void;
  stream(request: OfficeAiStream, sessionId: string, signal: AbortSignal, send: (chunk: OfficeAiChunk) => void): Promise<void>;
  chat(request: OfficeAiChat, signal: AbortSignal): Promise<{ ok: boolean; content?: string; error?: string; [key: string]: unknown }>;
}
export type OfficeAiTestDeps = {
  webTools?: Record<string, (...args: any[]) => any>;
  settingsStore?: OfficeSettings;
  detect?: (provider: string, ...args: unknown[]) => Promise<{ provider: string; state: string; loginMethod?: string; loginKind?: string; account?: string }>;
  listModels?: (...args: unknown[]) => Promise<unknown[]>;
  stream?: (provider: string, config: Record<string, unknown>, system: string, messages: AgentMessage[], tools: AgentToolDef[], maxTokens: number, callbacks: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<void>;
  chat?: (...args: unknown[]) => Promise<{ ok: boolean; content?: string; error?: string }>;
};
export function createOfficeAiEngine(dataDir: string, injected?: OfficeAiTestDeps, hostActions?: OfficeAiHostActions): OfficeAiEngine;
export function shutdownOfficeAiProviders(): void;
