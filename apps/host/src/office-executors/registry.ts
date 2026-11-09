import type { DocFormat } from "@workbench/contracts";
import type { ExecutorMode } from "../document-execution-lease.ts";

/** Promote an original tool set only after its send/selection/questions adapter exists. */
export function officeExecutorMode(format: DocFormat): ExecutorMode {
  return format === "markdown" ? "independent-renderer" : "ui-required";
}
