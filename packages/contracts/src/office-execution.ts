import type { OfficeHostMessage, TranscriptItem } from "./index.ts";
import type { OfficeTurnReceipt } from "./office-ai.ts";

/** Original renderer state, not a replacement Markdown editing implementation. */
export type MarkdownExecutionState = {
  format: "markdown";
  snapshot: { body: string; frontmatter: string };
  document: Record<string, unknown>;
  selection: Record<string, unknown>;
  scope: unknown;
};
export type OfficeExecutionState = MarkdownExecutionState;
export type OfficeExecutionBoot = {
  init: Extract<OfficeHostMessage, { type: "office:init" }>;
  page: string;
  instruction: string;
  state: OfficeExecutionState;
};
export type OfficeExecutionObservation = {
  receipt: OfficeTurnReceipt;
  items: TranscriptItem[];
};
