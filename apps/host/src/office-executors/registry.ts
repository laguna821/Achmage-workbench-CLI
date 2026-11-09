import type { DocFormat } from "@workbench/contracts";
import type { ExecutorMode } from "../document-execution-lease.ts";

/** Promote an original tool set only after its send/selection/questions adapter exists. */
export function officeExecutorMode(format: DocFormat): ExecutorMode {
  // Slides' subsequent queue/QC loops still need one request-level owner.
  return ["markdown", "docx", "hwp", "hwpx", "xmind", "html", "xlsx", "pdf", "epub"].includes(format) ? "independent-renderer" : "ui-required";
}
