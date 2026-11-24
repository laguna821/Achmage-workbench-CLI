import type { TranscriptItem } from "@workbench/contracts";

// "이 프로젝트의 다른 대화 읽기" (0.5.6, host peer-read.ts): an engine's `workbench-peers` call is shown as one
// readable line — what the gateway's answer says first ("「서론 고치기」 대화를 읽었습니다 · 최근 3개") —
// not as a command line. The same for the MCP form of the tool (an engine that takes its tools as mcpServers).

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** The command line itself, out of a shell wrapper (`/bin/bash -lc '…'`, as Codex reports it). */
function bare(line: string): string {
  const text = line.trim();
  const wrapped = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(text);
  return (wrapped ? wrapped[2]! : text).trim();
}

/**
 * A line that only runs workbench-peers (one call, or several joined with `&&`), with no pipe, redirection,
 * substitution or other command: the host's isPlainFindCommand with the name swapped (find-tool.ts). Anything
 * else is shown as the raw command, so `workbench-peers list && rm -rf ~` cannot hide behind the friendly line.
 */
function plainPeers(line: string): boolean {
  return line.split("&&").every((part) => {
    const text = part.trim();
    if (!/^workbench-peers(?:\s|$)/.test(text)) return false;
    const unquoted = text.replace(/'[^']*'/g, "''").replace(/"[^"$`\\]*"/g, '""');
    return !/[;&|`$<>\\\n\r(){}'"]/.test(unquoted.replace(/''|""/g, ""));
  });
}

/** Which request of workbench-peers this step is, or null when it is not one. */
function peerCall(item: ToolItem): "list" | "read" | null {
  if (item.tool === "command") {
    const line = bare(item.title);
    if (!plainPeers(line)) return null;
    const match = /^workbench-peers\s+(list|read)\b/.exec(line);
    return match ? (match[1] as "list" | "read") : null;
  }
  if (item.tool === "mcp") {
    const match = /workbench-peers\b.*\b(list_conversations|read_conversation)\b/.exec(item.title);
    return match ? (match[1] === "list_conversations" ? "list" : "read") : null;
  }
  return null;
}

const SAID = /^「[^\n]*」 (?:대화를 읽었습니다 · 최근 \d+개|(?:프로젝트|자리)의 다른 대화 \d+개를 봤습니다)$/;

/** The readable line of a workbench-peers step, or null for any other step. */
export function peerLine(item: ToolItem): string | null {
  const call = peerCall(item);
  if (!call) return null;
  if (item.status === "running") return call === "read" ? "다른 대화를 읽는 중" : "이 프로젝트의 다른 대화를 보는 중";
  const first = item.output?.trimStart().split("\n")[0]?.trim() ?? "";
  if (item.status === "completed" && SAID.test(first)) return first;
  if (item.status === "declined") return call === "read" ? "다른 대화 읽기를 거절했습니다" : "다른 대화 목록 보기를 거절했습니다";
  return call === "read" ? "다른 대화를 읽지 못했습니다" : "다른 대화 목록을 보지 못했습니다";
}
