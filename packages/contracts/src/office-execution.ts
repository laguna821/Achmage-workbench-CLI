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
/** Original documents are saved before handoff; data carries their transient
 * selection, page/chapter and writer state, not an alternative editing engine. */
export type OriginalDocumentExecutionState = {
  format: "docx" | "pptx" | "xlsx" | "hwp" | "hwpx" | "pdf" | "html" | "xmind" | "epub";
  data: Record<string, unknown>;
};
export type OfficeExecutionState = MarkdownExecutionState | OriginalDocumentExecutionState;
export type OfficeInteractionField = {
  id: string;
  prompt: string;
  options?: { id: string; label: string }[];
  multiple?: boolean;
  required?: boolean;
  allowOther?: boolean;
};
export type OfficeInteractionRequest = { prompt: string; fields: OfficeInteractionField[] };
export type OfficeInteractionResponse = Record<string, string | string[]>;
export type OfficeStoredInteraction = OfficeInteractionRequest & { response?: OfficeInteractionResponse };
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
