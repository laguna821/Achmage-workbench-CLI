import { ClaudeTranscriptMapper } from "@workbench/provider-claude";
import { mapThreadItem } from "@workbench/provider-codex";
import type { TranscriptItem } from "@workbench/contracts";

// "가져오기": an engine's own record of a conversation, as the transcript Workbench shows. Pure
// (no engine is asked here); the adapters read the records and the sessions keep the result.

/** What Claude Code keeps per message (`getSessionMessages`): no times, so they are spread out. */
export type ClaudeRecord = { type: "user" | "assistant" | "system"; uuid: string; message: unknown; parent_tool_use_id: string | null };

/** Codex's turns (`thread/read` with turns): item lists with start and end times (seconds). */
export type CodexTurn = { id: string; items: { type: string; [key: string]: unknown }[]; status: string; startedAt: number | null; completedAt: number | null };

/** Text the user typed, without what Claude Code itself put in user messages (command echoes, caveats). */
function typed(content: unknown): string | null {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part): part is { type: "text"; text: string } => Boolean(part) && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
            .map((part) => part.text)
            .join("\n")
        : "";
  const trimmed = text.trim();
  if (!trimmed || /^<(command-|local-command-|system-reminder)/.test(trimmed) || trimmed.startsWith("Caveat:")) return null;
  return trimmed;
}

/**
 * A Claude Code conversation: requests as they were typed, replies and tool steps through the
 * same mapper as live turns, a turn end before each next request. Times run evenly from the
 * conversation's start to its last change (Claude Code's record has none per message here).
 */
export function claudeHistory(records: ClaudeRecord[], from: number, to: number): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const step = records.length > 1 ? Math.max(1, (to - from) / (records.length - 1)) : 0;
  let index = 0;
  const mapper = new ClaudeTranscriptMapper(() => Math.round(from + index * step));
  let turn: string | null = null;
  const end = () => {
    if (turn) items.push({ kind: "turnEnd", id: `end:${turn}`, status: "completed", durationMs: null, at: Math.round(from + Math.max(0, index - 1) * step) });
    turn = null;
  };
  for (; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.parent_tool_use_id) continue;
    const message = (record.message ?? {}) as { role?: string; content?: unknown };
    if (record.type === "user") {
      const text = typed(message.content);
      if (text) {
        end();
        turn = record.uuid;
        items.push({ kind: "user", id: `user:${record.uuid}`, text, at: Math.round(from + index * step) });
        continue;
      }
    }
    if (record.type !== "user" && record.type !== "assistant") continue;
    const outputs = mapper.handle({ type: record.type, message, parent_tool_use_id: null, uuid: record.uuid, session_id: "" } as never, turn ?? record.uuid);
    for (const output of outputs) {
      if (output.type !== "upsert") continue;
      const at = items.findIndex((item) => item.id === output.item.id);
      if (at >= 0) items[at] = output.item;
      else items.push(output.item);
    }
  }
  end();
  // A step whose result never came (the record ends mid-turn) is not running any more.
  return items.map((item) => (item.kind === "tool" && item.status === "running" ? { ...item, status: "completed" as const } : item));
}

/** A Codex thread's turns: each request, what Codex did and said, and how the turn ended. */
export function codexHistory(turns: CodexTurn[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const turn of turns) {
    const started = (turn.startedAt ?? turn.completedAt ?? 0) * 1000;
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const text = typed(item.content);
        if (text) items.push({ kind: "user", id: `user:${String(item.id)}`, text, at: started });
        continue;
      }
      const mapped = mapThreadItem(item as never, started, false);
      if (mapped) items.push(mapped);
    }
    const status = turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "failed" : "completed";
    items.push({ kind: "turnEnd", id: `end:${turn.id}`, status, durationMs: turn.startedAt && turn.completedAt ? (turn.completedAt - turn.startedAt) * 1000 : null, at: (turn.completedAt ?? turn.startedAt ?? 0) * 1000 });
  }
  return items;
}
