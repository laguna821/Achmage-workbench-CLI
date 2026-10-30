import type { AgentMessage, AgentToolDef } from "../../../vendor/ieumoffice/packages/agent-core/src/types.ts";
export const OFFICE_SECRET_PLACEHOLDER: string;
export type OfficeAiChunk = { requestId: string; type: string; text?: string; [key: string]: unknown };
export type OfficeAiStream = { requestId: string; sessionId?: string; settings: unknown; system: string; messages: AgentMessage[]; tools?: AgentToolDef[]; maxTokens?: number };
export type OfficeAiChat = { settings: unknown; system: string; user: string };
export type OfficeAiStatus = { provider: string; state: string; meteredAccepted: boolean; [key: string]: unknown };
export interface OfficeAiEngine {
  settings(): Record<string, unknown>;
  statuses(recheck?: boolean): Promise<Record<string, OfficeAiStatus>>;
  stream(request: OfficeAiStream, sessionId: string, signal: AbortSignal, send: (chunk: OfficeAiChunk) => void): Promise<void>;
  chat(request: OfficeAiChat, signal: AbortSignal): Promise<{ ok: boolean; content?: string; error?: string; [key: string]: unknown }>;
}
export type OfficeAiTestDeps = {
  detect?: (provider: string, ...args: unknown[]) => Promise<{ provider: string; state: string; loginMethod?: string; loginKind?: string; account?: string }>;
  listModels?: (...args: unknown[]) => Promise<unknown[]>;
  stream?: (provider: string, config: Record<string, unknown>, system: string, messages: AgentMessage[], tools: AgentToolDef[], maxTokens: number, callbacks: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<void>;
  chat?: (...args: unknown[]) => Promise<{ ok: boolean; content?: string; error?: string }>;
};
export function createOfficeAiEngine(dataDir: string, injected?: OfficeAiTestDeps): OfficeAiEngine;
export function shutdownOfficeAiProviders(): void;
