import type {
  SDKMessage,
  SDKRateLimitInfo,
} from "@anthropic-ai/claude-agent-sdk";
import type { PlanStep, ToolKind, TranscriptItem, UsageWindow } from "@workbench/contracts";

// Converts the Claude Agent SDK message stream into transcript items.
// Text is streamed through `stream_event`s; tool calls and results come from the
// complete assistant/user messages, which carry full tool input and output.

export type MapperOutput =
  | { type: "upsert"; item: TranscriptItem }
  | { type: "delta"; itemId: string; text: string }
  | { type: "init"; nativeSessionId: string; model: string }
  | { type: "turnEnd"; status: "completed" | "failed"; durationMs: number | null; error: string | null }
  | { type: "usage"; window: UsageWindow }
  | { type: "activity"; text: string | null }
  | { type: "authError"; message: string };

const MAX_OUTPUT = 20_000;

function clip(text: string, max = MAX_OUTPUT) {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

type ToolView = { tool: ToolKind; title: string; detail: string | null; activity: string; paths?: string[] };

export function describeTool(name: string, input: Record<string, unknown>): ToolView {
  switch (name) {
    case "Bash":
      return {
        tool: "command",
        title: str(input.command) ?? "Bash",
        detail: str(input.description),
        activity: "명령 실행 중",
      };
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return {
        tool: "fileChange",
        title: str(input.file_path) ?? str(input.notebook_path) ?? name,
        detail: null,
        activity: "파일 수정 중",
        paths: [str(input.file_path) ?? str(input.notebook_path)].filter((path): path is string => Boolean(path)),
      };
    case "Read":
      return { tool: "search", title: `읽기 ${str(input.file_path) ?? ""}`.trim(), detail: null, activity: "파일 읽는 중" };
    case "Glob":
    case "Grep":
      return {
        tool: "search",
        title: `${name} ${str(input.pattern) ?? ""}`.trim(),
        detail: str(input.path),
        activity: "찾는 중",
      };
    case "WebSearch":
    case "WebFetch":
      return {
        tool: "web",
        title: str(input.query) ?? str(input.url) ?? name,
        detail: null,
        activity: "웹 확인 중",
      };
    case "Task":
    case "Agent":
      return {
        tool: "agent",
        title: str(input.description) ?? "하위 에이전트",
        detail: null,
        activity: "하위 작업 진행 중",
      };
    default:
      if (name.startsWith("mcp__")) {
        const [, server, tool] = name.split("__");
        return {
          tool: "mcp",
          title: `${server ?? "mcp"} · ${tool ?? name}`,
          detail: clip(JSON.stringify(input), 2_000),
          activity: "도구 사용 중",
        };
      }
      return { tool: "other", title: name, detail: clip(JSON.stringify(input), 2_000), activity: "도구 사용 중" };
  }
}

function toPlanSteps(input: Record<string, unknown>): PlanStep[] {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  return todos.map((todo) => {
    const record = (todo ?? {}) as Record<string, unknown>;
    const status = record.status === "completed" ? "completed" : record.status === "in_progress" ? "inProgress" : "pending";
    return { text: str(record.content) ?? str(record.activeForm) ?? "", status };
  });
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const block = (part ?? {}) as Record<string, unknown>;
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

const WINDOW_LABEL: Record<string, string> = {
  five_hour: "5시간",
  seven_day: "주간",
  seven_day_opus: "주간 · Opus",
  seven_day_sonnet: "주간 · Sonnet",
};

export function usageFromRateLimit(info: SDKRateLimitInfo): UsageWindow | null {
  if (!info.rateLimitType || !(info.rateLimitType in WINDOW_LABEL)) {
    return null;
  }
  const utilization = info.utilization;
  const usedPercent =
    typeof utilization === "number" ? Math.round((utilization <= 1 ? utilization * 100 : utilization) * 10) / 10 : null;
  const resetsAt = typeof info.resetsAt === "number" ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : null;
  return { label: WINDOW_LABEL[info.rateLimitType], usedPercent, resetsAt };
}

export class ClaudeTranscriptMapper {
  private messageId: string | null = null;
  private readonly streamedMessages = new Set<string>();
  private readonly blockItems = new Map<number, { id: string; kind: "assistant" | "reasoning"; text: string }>();
  private readonly toolItems = new Map<string, TranscriptItem & { kind: "tool" }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Item id used for the per-session plan (TodoWrite) so updates replace one card. */
  planItemId(turnKey: string) {
    return `plan:${turnKey}`;
  }

  handle(message: SDKMessage, turnKey: string): MapperOutput[] {
    const out: MapperOutput[] = [];
    switch (message.type) {
      case "system": {
        if (message.subtype === "init") {
          out.push({ type: "init", nativeSessionId: message.session_id, model: message.model });
        }
        break;
      }
      case "stream_event": {
        if (message.parent_tool_use_id) {
          break;
        }
        const event = message.event;
        if (event.type === "message_start") {
          this.messageId = event.message.id;
          this.blockItems.clear();
        } else if (event.type === "content_block_start" && this.messageId) {
          const block = event.content_block;
          if (block.type === "text" || block.type === "thinking") {
            const kind = block.type === "text" ? "assistant" : "reasoning";
            const id = `${this.messageId}:${event.index}`;
            this.streamedMessages.add(this.messageId);
            this.blockItems.set(event.index, { id, kind, text: "" });
            if (kind === "assistant") {
              out.push({ type: "upsert", item: { kind, id, text: "", streaming: true, at: this.now() } });
            }
            out.push({ type: "activity", text: kind === "assistant" ? "응답 작성 중" : "생각하는 중" });
          }
        } else if (event.type === "content_block_delta") {
          const target = this.blockItems.get(event.index);
          if (!target) {
            break;
          }
          const delta = event.delta;
          const text = delta.type === "text_delta" ? delta.text : delta.type === "thinking_delta" ? delta.thinking : "";
          if (text) {
            if (target.kind === "reasoning" && !target.text) {
              // Thinking is often omitted; create the item only when there is something to show.
              target.text = text;
              out.push({ type: "upsert", item: { kind: "reasoning", id: target.id, text, at: this.now() } });
            } else {
              target.text += text;
              out.push({ type: "delta", itemId: target.id, text });
            }
          }
        } else if (event.type === "content_block_stop") {
          const target = this.blockItems.get(event.index);
          if (target?.kind === "assistant") {
            out.push({ type: "upsert", item: { kind: "assistant", id: target.id, text: target.text, streaming: false, at: this.now() } });
          }
        }
        break;
      }
      case "assistant": {
        if (message.parent_tool_use_id) {
          break;
        }
        if (message.error === "authentication_failed" || message.error === "oauth_org_not_allowed") {
          out.push({ type: "authError", message: "Claude 로그인이 필요합니다." });
        }
        const streamed = this.streamedMessages.has(message.message.id);
        message.message.content.forEach((block, index) => {
          if (block.type === "text" && !streamed && block.text.trim()) {
            out.push({
              type: "upsert",
              item: { kind: "assistant", id: `${message.message.id}:final:${message.uuid}:${index}`, text: block.text, streaming: false, at: this.now() },
            });
          } else if (block.type === "tool_use") {
            const input = (block.input ?? {}) as Record<string, unknown>;
            if (block.name === "TodoWrite") {
              out.push({ type: "upsert", item: { kind: "plan", id: this.planItemId(turnKey), steps: toPlanSteps(input), at: this.now() } });
              return;
            }
            const view = describeTool(block.name, input);
            const item: TranscriptItem & { kind: "tool" } = {
              kind: "tool",
              id: block.id,
              tool: view.tool,
              title: view.title,
              detail: view.detail,
              output: null,
              status: "running",
              at: this.now(),
              ...(view.paths?.length ? { paths: view.paths } : {}),
            };
            this.toolItems.set(block.id, item);
            out.push({ type: "upsert", item });
            out.push({ type: "activity", text: view.activity });
          }
        });
        break;
      }
      case "user": {
        const content = message.message.content;
        if (!Array.isArray(content)) {
          break;
        }
        for (const part of content) {
          if (part.type !== "tool_result") {
            continue;
          }
          const tool = this.toolItems.get(part.tool_use_id);
          if (!tool) {
            continue;
          }
          const output = toolResultText(part.content);
          const updated: TranscriptItem & { kind: "tool" } = {
            ...tool,
            status: tool.status === "declined" ? "declined" : part.is_error ? "failed" : "completed",
            output: output ? clip(output) : null,
          };
          this.toolItems.set(tool.id, updated);
          out.push({ type: "upsert", item: updated });
        }
        out.push({ type: "activity", text: "응답 준비 중" });
        break;
      }
      case "result": {
        const failed = message.subtype !== "success" || message.is_error;
        const error =
          message.subtype === "success"
            ? message.is_error
              ? message.result
              : null
            : message.errors.join("\n") || message.subtype;
        out.push({ type: "turnEnd", status: failed ? "failed" : "completed", durationMs: message.duration_ms, error });
        out.push({ type: "activity", text: null });
        break;
      }
      case "rate_limit_event": {
        const window = usageFromRateLimit(message.rate_limit_info);
        if (window) {
          out.push({ type: "usage", window });
        }
        break;
      }
      case "auth_status": {
        if (message.error) {
          out.push({ type: "authError", message: message.error });
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  /** Mark a tool the user declined so its later error result shows as declined, not failed. */
  markDeclined(toolUseId: string): TranscriptItem | null {
    const tool = this.toolItems.get(toolUseId);
    if (!tool) {
      return null;
    }
    const updated = { ...tool, status: "declined" as const };
    this.toolItems.set(toolUseId, updated);
    return updated;
  }
}
