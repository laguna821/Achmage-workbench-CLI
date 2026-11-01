import { OFFICE_SETTINGS_CHANNELS } from "./office-settings.ts";

/** Narrow requests from the original knowledge screen to its authenticated parent. */
export const KNOWLEDGE_HOME_CHANNELS = new Set([
  ...OFFICE_SETTINGS_CHANNELS,
  "kb:list", "kb:search", "kb:read", "kb:open-scope", "kb:close-scope", "kb:create-document",
  "home:starred", "home:starred-groups", "home:open-path",
  "home:knowledge-manage", "home:knowledge-settings",
  "home:skills", "home:skill-settings",
  "ai:stream", "ai:stream-cancel",
]);
export type KnowledgeHomeRequest = { type: "knowledge:request"; requestId: string; channel: string; args: unknown[] };
export type KnowledgeHomeReply = { type: "knowledge:reply"; requestId: string; value?: unknown; error?: string };
