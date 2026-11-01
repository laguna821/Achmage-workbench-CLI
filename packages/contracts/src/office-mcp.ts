import type { OfficeOutputPlan } from "./office-output.ts";

/** Fixed editor operations only; no renderer-supplied code or filesystem access. */
export type OfficeMcpRequest =
  | { kind: "status" }
  | { kind: "command"; family: "docx" | "xlsx" | "pptx"; command: string; payload?: unknown }
  | { kind: "read" }
  | { kind: "save"; plan?: OfficeOutputPlan }
  | { kind: "close"; discard: boolean };

export type OfficeMcpReply =
  | { status: "ok"; result: { value: unknown } }
  | { status: "not_ready" }
  | { status: "error"; error: { reason: string; message: string } };

export const OFFICE_MCP_SETTINGS_CHANNELS = new Set([
  "home:get-mcp-status", "home:set-mcp-settings", "home:get-mcp-logs",
  "home:clear-mcp-logs", "home:open-mcp-log-file",
]);
