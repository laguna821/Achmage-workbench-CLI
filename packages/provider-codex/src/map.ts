import type { ItemStatus, PlanStep, TranscriptItem } from "@workbench/contracts";
import type { ThreadItem } from "./generated/v2/ThreadItem.ts";
import type { TurnPlanStep } from "./generated/v2/TurnPlanStep.ts";
import { isAbsolute, resolve } from "node:path";

const MAX_OUTPUT = 20_000;

function clip(text: string | null | undefined, max = MAX_OUTPUT): string | null {
  if (!text) {
    return null;
  }
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function toItemStatus(status: string): ItemStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "declined":
      return "declined";
    default:
      return "running";
  }
}

/** Convert a Codex thread item to the UI transcript shape. Returns null for items the UI does not show. */
export function mapThreadItem(item: ThreadItem, at: number, inProgress: boolean): TranscriptItem | null {
  switch (item.type) {
    case "agentMessage":
      return { kind: "assistant", id: item.id, text: item.text, streaming: inProgress, at };
    case "plan":
      return { kind: "assistant", id: item.id, text: item.text, streaming: inProgress, at };
    case "reasoning": {
      const text = (item.summary.length ? item.summary : item.content).join("\n\n");
      return { kind: "reasoning", id: item.id, text, at };
    }
    case "commandExecution": {
      let status = toItemStatus(item.status);
      if (status === "completed" && item.exitCode !== null && item.exitCode !== 0) {
        status = "failed";
      }
      // Files the command reads, as Codex parsed it (`cat`, `sed -n`, `head`…), made absolute.
      const reads = (item.commandActions ?? []).flatMap((action) => (action.type === "read" && action.path ? [isAbsolute(String(action.path)) ? String(action.path) : resolve(String(item.cwd ?? "/"), String(action.path))] : []));
      return {
        kind: "tool",
        id: item.id,
        tool: "command",
        title: item.command,
        detail: item.cwd ? String(item.cwd) : null,
        output: clip(item.aggregatedOutput),
        status,
        at,
        ...(reads.length ? { reads } : {}),
      };
    }
    case "fileChange": {
      const paths = item.changes.map((change) => change.path);
      return {
        kind: "tool",
        id: item.id,
        tool: "fileChange",
        title: paths.length === 1 ? paths[0] : `파일 ${paths.length}개 변경`,
        detail: paths.join("\n"),
        output: clip(item.changes.map((change) => change.diff).join("\n")),
        status: toItemStatus(item.status),
        at,
        paths,
      };
    }
    case "mcpToolCall":
      return {
        kind: "tool",
        id: item.id,
        tool: "mcp",
        title: `${item.server} · ${item.tool}`,
        detail: clip(JSON.stringify(item.arguments), 2_000),
        output: null,
        status: toItemStatus(item.status),
        at,
      };
    case "webSearch":
      return {
        kind: "tool",
        id: item.id,
        tool: "web",
        title: "웹 검색",
        detail: null,
        output: null,
        status: inProgress ? "running" : "completed",
        at,
      };
    case "contextCompaction":
      return { kind: "notice", id: item.id, level: "info", text: "대화가 길어 앞부분을 압축했습니다.", at };
    case "imageView":
      // Codex looked at a picture (its image viewer); the adapter adds the picture itself.
      return {
        kind: "tool",
        id: item.id,
        tool: "other",
        title: `그림 보기 · ${String(item.path).split(/[\\/]/).pop()}`,
        detail: String(item.path),
        output: null,
        status: "completed",
        at,
      };
    default:
      return null;
  }
}

export function mapPlanSteps(steps: TurnPlanStep[]): PlanStep[] {
  return steps.map((step) => ({ text: step.step, status: step.status }));
}
