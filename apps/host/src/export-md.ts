import { PROVIDER_LABEL, type Handoff, type Proposal, type Session, type TranscriptItem, type Work } from "@workbench/contracts";

// "마크다운으로 내보내기": a conversation as a Markdown file a person reads and other tools reuse.
// Made by fixed rules from the stored log — no model, no summary — so the same conversation always
// gives the same file. The cleaning is light: the request numbers become `##` headings, headings
// inside messages move down two levels so the outline stays the conversation's, the engine's private
// reasoning is left out and tool calls are folded into one line (or listed, when asked).

export type ExportContext = {
  session: Session;
  work: Work;
  /** Folder names from the top. */
  folders: string[];
  items: TranscriptItem[];
  artifactName: (artifactId: string) => string | null;
  proposal: (proposalId: string) => (Proposal & { name: string | null }) | null;
  handoff: (handoffId: string) => Handoff | null;
  sessionLabel: (sessionId: string) => string | null;
  /** List every tool call instead of one summary line. */
  tools?: boolean;
};

const pad = (value: number) => String(value).padStart(2, "0");
const day = (at: number) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const clock = (at: number) => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const stamp = (at: number) => `${day(at)} ${clock(at)}`;

/** A YAML scalar that never needs a second look: always double-quoted. */
const yamlString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;

/** One line for a heading: the first non-empty line, without Markdown marks, at most 60 characters. */
export function headingOf(text: string) {
  const line =
    text
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry && !entry.startsWith("```")) ?? "";
  const flat = line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+>]\s+/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
  return flat.length > 60 ? `${flat.slice(0, 60).trimEnd()}…` : flat || "(빈 요청)";
}

/**
 * A message's Markdown, tidied: headings moved down two levels (`#` → `###`, never past `######`),
 * trailing spaces removed and runs of blank lines shortened — never inside fenced code.
 */
export function tidyMessage(text: string) {
  const out: string[] = [];
  let fence: string | null = null;
  let blank = 0;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const open = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      out.push(raw);
      if (open && raw.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (open) {
      fence = open[1]!;
      blank = 0;
      out.push(raw.trimEnd());
      continue;
    }
    const line = raw.trimEnd();
    if (!line) {
      blank += 1;
      if (blank <= 1) out.push("");
      continue;
    }
    blank = 0;
    const heading = /^(#{1,6})(\s.*)$/.exec(line);
    out.push(heading ? `${"#".repeat(Math.min(heading[1]!.length + 2, 6))}${heading[2]}` : line);
  }
  while (out.length && !out[0]) out.shift();
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join("\n");
}

const TOOL_LABEL: Record<string, string> = { command: "명령", fileChange: "파일 변경", search: "검색", web: "웹", mcp: "MCP", agent: "에이전트", other: "도구" };

function toolSummary(tools: Extract<TranscriptItem, { kind: "tool" }>[]) {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.tool, (counts.get(tool.tool) ?? 0) + 1);
  return [...counts].map(([kind, count]) => `${TOOL_LABEL[kind] ?? "도구"} ${count}`).join(" · ");
}

function toolLine(tool: Extract<TranscriptItem, { kind: "tool" }>) {
  const state = tool.status === "completed" ? "" : tool.status === "declined" ? " (거절됨)" : tool.status === "failed" ? " (실패)" : " (진행 중)";
  const title = tool.title.replace(/`/g, "'");
  const paths = tool.paths?.length ? ` — ${tool.paths.map((path) => `\`${path.split(/[\\/]/).pop()}\``).join(", ")}` : "";
  return `- ${TOOL_LABEL[tool.tool] ?? "도구"}: \`${title}\`${paths}${state}`;
}

/** The conversation as Markdown (deterministic: the same log gives the same text). */
export function sessionMarkdown(context: ExportContext): string {
  const { session, work, items } = context;
  const engine = PROVIDER_LABEL[session.provider];
  const requests = items.filter((item) => item.kind === "user");
  const first = items[0]?.at ?? session.createdAt;
  const last = items.at(-1)?.at ?? session.updatedAt;

  const front = [
    "---",
    `title: ${yamlString(session.purpose)}`,
    `work: ${yamlString(work.title)}`,
    ...(context.folders.length ? [`folder: ${yamlString(context.folders.join(" / "))}`] : []),
    `engine: ${engine}`,
    ...(session.engineModel ? [`model: ${yamlString(session.engineModel)}`] : []),
    `session: ${session.id}`,
    ...(session.nativeSessionId ? [`native-session: ${session.nativeSessionId}`] : []),
    `created: ${stamp(first)}`,
    `updated: ${stamp(last)}`,
    `requests: ${requests.length}`,
    "source: Achmage Workbench",
    "---",
  ];
  const lines: string[] = [...front, "", `# ${session.purpose}`, ""];
  const span = day(first) === day(last) ? `${stamp(first)} – ${clock(last)}` : `${stamp(first)} – ${stamp(last)}`;
  lines.push(`작업 **${work.title}** · ${engine} · ${span} · 요청 ${requests.length}개`);

  let number = 0;
  let speakerShown = false;
  let pendingTools: Extract<TranscriptItem, { kind: "tool" }>[] = [];
  const flushTools = () => {
    if (!pendingTools.length) return;
    if (context.tools) lines.push("", ...pendingTools.map(toolLine));
    else lines.push("", `_${toolSummary(pendingTools)}_`);
    pendingTools = [];
  };
  const speaker = (at: number) => {
    if (speakerShown) return;
    speakerShown = true;
    lines.push("", `**${engine}** · ${clock(at)}`);
  };

  for (const item of items) {
    if (item.kind !== "tool") flushTools();
    switch (item.kind) {
      case "user": {
        number += 1;
        speakerShown = false;
        lines.push("", `## ${number}. ${headingOf(item.text)}`, "");
        lines.push(item.from ? `**${item.from.label}에서 온 요청** · ${clock(item.at)}` : `**나** · ${clock(item.at)}`);
        const request = tidyMessage(item.text);
        if (request) lines.push("", request);
        const notes: string[] = [];
        if (item.refs?.length) {
          notes.push(`붙인 문서: ${item.refs.map((ref) => `${ref.name} r${ref.revision}(${ref.mode === "edit" ? "고치기" : "읽기"})${ref.selection ? ` — ${ref.selection}` : ""}`).join(", ")}`);
        }
        if (item.create) notes.push(`새 문서 요청: ${item.create.name}`);
        if (item.notes?.length) notes.push(`붙인 볼트 노트(읽기 전용): ${item.notes.map((note) => `${note.title} (${note.path})`).join(", ")}`);
        if (notes.length) lines.push("", ...notes.map((note) => `> ${note}`));
        break;
      }
      case "assistant": {
        const reply = tidyMessage(item.text);
        if (!reply) break;
        speaker(item.at);
        lines.push("", reply);
        if (item.streaming) lines.push("", "_(응답 중에 내보냄)_");
        break;
      }
      case "tool":
        speaker(item.at);
        pendingTools.push(item);
        break;
      case "reasoning":
        break;
      case "plan": {
        speaker(item.at);
        lines.push("", "**계획**", "", ...item.steps.map((step) => `- [${step.status === "completed" ? "x" : " "}] ${step.text}${step.status === "inProgress" ? " (진행 중)" : ""}`));
        break;
      }
      case "approval": {
        const decision = item.decision === "accept" ? "허용함" : item.decision === "decline" ? "거절함" : item.decision === "expired" ? "응답 없이 지나감" : "답을 기다리는 중";
        const detail = item.detail ? ` — \`${item.detail.split("\n")[0]!.replace(/`/g, "'").slice(0, 120)}\`` : "";
        lines.push("", `> 승인 요청: ${item.title}${detail} → ${decision}`);
        break;
      }
      case "notice":
        lines.push("", `> ${item.level === "error" ? "오류" : "알림"}: ${item.text.replace(/\n+/g, " ")}`);
        break;
      case "artifact": {
        const name = context.artifactName(item.artifactId) ?? "문서";
        lines.push("", `> 문서 ${item.change === "created" ? "만듦" : "바뀜"}: ${name} r${item.revision}`);
        break;
      }
      case "proposal": {
        const proposal = context.proposal(item.proposalId);
        if (!proposal) break;
        const state =
          proposal.status === "applied" ? `적용됨 → r${proposal.appliedRevision}` : proposal.status === "discarded" ? "버림" : proposal.status === "empty" ? "바뀐 것 없음" : "적용 전";
        lines.push("", `> 수정안: ${proposal.name ?? "문서"} r${proposal.baseRevision} 기준 +${proposal.added} −${proposal.removed} (${state})`);
        break;
      }
      case "handoff": {
        const handoff = context.handoff(item.handoffId);
        if (!handoff) break;
        const target = context.sessionLabel(handoff.targetSessionId) ?? "다른 세션";
        lines.push("", `> 다른 세션에 보냄: ${target} — ${handoff.status === "answered" ? "답 받음" : handoff.status === "failed" ? "실패" : "답 기다리는 중"}`);
        if (handoff.reply && handoff.targetSessionId !== session.id) lines.push(">", ...tidyMessage(handoff.reply).split("\n").map((line) => (line ? `> ${line}` : ">")));
        break;
      }
      case "turnEnd":
        if (item.status === "interrupted") lines.push("", "_중단됨_");
        else if (item.status === "failed") lines.push("", "_응답이 끝나지 못했습니다_");
        break;
    }
  }
  flushTools();
  return `${lines.join("\n").trimEnd()}\n`;
}

/** File name for a conversation's export: its first day and its name, safe on every system. */
export function exportFileName(session: Session, first: number) {
  const name = session.purpose.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "세션";
  return `${day(first)} ${name}.md`;
}
