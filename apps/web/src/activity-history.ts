import type { HistoryEvent, Provider } from "@workbench/contracts";

// 활동 › 기록: the gateway's lines (GET /api/activity/history) as a person reads them. Pure: what a line
// says, one conversation's run folded into one line, the day groups, a fresh first page joined to the
// pages already read.

/** How a line finds its project, conversation and document in the app's state. */
export type HistoryContext = {
  work: (id: string) => { title: string } | null;
  session: (id: string) => { purpose: string; provider: Provider; artifactId?: string | null } | null;
  artifact: (id: string) => { name: string } | null;
};

/** "8초", "3분 12초", "1시간 2분". */
export function took(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "1초 미만";
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분${seconds % 60 ? ` ${seconds % 60}초` : ""}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}시간${minutes % 60 ? ` ${minutes % 60}분` : ""}`;
}

/** A wait in the resource manager's line shorter than this is not said. */
export const WAIT_SAID = 5_000;

const quote = (text: string | undefined) => (text ? ` 「${text}」` : "");

const VIA: Record<NonNullable<HistoryEvent["via"]>, string> = {
  pc: "요청", phone: "휴대폰에서 요청", schedule: "예약으로 요청", handover: "넘겨받은 요청", link: "이어진 대화에서 온 요청", steer: "진행 중에 덧붙인 요청",
};

const CAUSE: Record<string, string> = { stop: "직접 멈춤", crash: "엔진이 꺼짐", restart: "앱이 다시 시작됨" };

function answered(event: HistoryEvent): string {
  if (event.decision === "accept") return event.kind === "question" ? "답함" : event.plan ? "진행함" : "허용함";
  if (event.decision === "decline") return event.kind === "question" ? "넘김" : event.plan ? "계획을 더 다듬게 함" : "거절함";
  if (event.decision === "expired") return "지나감";
  return event.open ? "기다리는 중" : "답하지 않음";
}

/** What happened, in one line (the project, the conversation and the engine are said beside it). */
export function historyText(event: HistoryEvent): string {
  switch (event.kind) {
    case "request": {
      const waited = event.waitedMs && event.waitedMs >= WAIT_SAID ? ` · 차례를 ${took(event.waitedMs)} 기다림` : "";
      return `${VIA[event.via ?? "pc"]}${quote(event.text)}${waited}`;
    }
    case "answer": return `답을 마침${event.durationMs ? ` · ${took(event.durationMs)}` : ""}`;
    case "failed": return "답하지 못함 (실패)";
    case "stopped": return `멈춤${event.cause && CAUSE[event.cause] ? ` (${CAUSE[event.cause]})` : ""}`;
    case "approval": return `${event.plan ? "계획 확인 요청" : `승인 요청${quote(event.text)}`} · ${answered(event)}`;
    case "question": return `질문${quote(event.text)} · ${answered(event)}`;
    case "doc-created": return event.author === "engine" ? "AI가 문서를 만듦" : event.author === "external" ? "다른 프로그램에서 만든 문서" : "문서를 만듦";
    case "doc-revised": {
      const who = event.author === "engine" ? "AI가 문서를 고침" : event.author === "external" ? "다른 프로그램에서 고침" : "문서를 고침";
      return `${who}${event.revision ? ` (${event.revision}판)` : ""}`;
    }
    case "proposal-applied": return "수정안 적용";
    case "proposal-discarded": return "수정안 버림";
    case "doc-renamed": return `이름 바꿈${quote(event.from)} →${quote(event.name)}`;
    case "doc-removed": return event.removal === "trash" ? "휴지통으로 옮김" : "목록에서 뺌";
    case "session-created": return "대화를 만듦";
    case "session-archived": return "대화를 보관함";
  }
}

/** The tone of a line's mark: a problem, something that waits for the person, or plain. */
export function historyTone(event: HistoryEvent): "error" | "attention" | "plain" {
  if (event.kind === "failed" || event.kind === "stopped" || ((event.kind === "approval" || event.kind === "question") && event.decision === "decline")) return "error";
  if (event.open) return "attention";
  return "plain";
}

/** Lines about a document (its subject is the document, also when an AI wrote it). */
const DOC_KINDS = new Set<HistoryEvent["kind"]>(["doc-created", "doc-revised", "proposal-applied", "proposal-discarded", "doc-renamed", "doc-removed"]);
export const aboutDocument = (event: HistoryEvent) => DOC_KINDS.has(event.kind) && Boolean(event.artifactId);

/** What a line belongs to: its conversation, or its document. */
export function subjectOf(event: HistoryEvent): string | null {
  if (aboutDocument(event)) return `doc:${event.artifactId}`;
  return event.sessionId ? `session:${event.sessionId}` : null;
}

/** Where a line belongs, as said under it: the project, then the conversation or document. */
export function historyPlace(event: HistoryEvent, ctx: HistoryContext): { project: string; subject: string; engine: Provider | null } {
  const project = ctx.work(event.workId)?.title ?? "지운 프로젝트";
  if (aboutDocument(event)) return { project, subject: ctx.artifact(event.artifactId!)?.name ?? event.name ?? "문서", engine: null };
  const session = event.sessionId ? ctx.session(event.sessionId) : null;
  // A document's AI: its document, with the engine.
  if (session?.artifactId) return { project, subject: `${ctx.artifact(session.artifactId)?.name ?? "문서"} · 문서 AI`, engine: session.provider };
  return { project, subject: session?.purpose ?? "대화", engine: session?.provider ?? event.provider ?? null };
}

export type HistoryEntry =
  | { kind: "one"; key: string; at: number; event: HistoryEvent }
  | { kind: "fold"; key: string; at: number; events: HistoryEvent[]; summary: string };

/** Lines of one conversation (or document) closer than this fold together. */
export const FOLD_GAP = 30 * 60_000;

const dayOf = (at: number) => { const date = new Date(at); return date.getFullYear() * 10_000 + date.getMonth() * 100 + date.getDate(); };

/** Never folded away: what failed, stopped or was refused, and what still waits for the person. */
const standsAlone = (event: HistoryEvent) => historyTone(event) !== "plain";

const COUNTED: [string, (event: HistoryEvent) => boolean][] = [
  ["요청", (event) => event.kind === "request"],
  ["답", (event) => event.kind === "answer"],
  ["승인 요청", (event) => event.kind === "approval"],
  ["질문", (event) => event.kind === "question"],
  ["만듦", (event) => event.kind === "doc-created"],
  ["고침", (event) => event.kind === "doc-revised"],
  ["수정안", (event) => event.kind === "proposal-applied" || event.kind === "proposal-discarded"],
  ["기타", (event) => ["session-created", "session-archived", "doc-renamed", "doc-removed"].includes(event.kind)],
];

function summary(events: HistoryEvent[], ctx: HistoryContext): string {
  const first = events[0]!;
  const place = historyPlace(first, ctx);
  const head = aboutDocument(first) ? `문서 「${place.subject}」` : `대화 「${place.subject}」`;
  const counts = COUNTED.map(([label, test]) => [label, events.filter(test).length] as const).filter(([, count]) => count).map(([label, count]) => `${label} ${count}건`);
  return `${head} · ${counts.join(", ")}`;
}

/**
 * One conversation's (or document's) lines, each within FOLD_GAP of the next and on the same day, become one
 * expandable line at the place of the newest — also between other conversations' lines, so forty conversations
 * running at once stay readable. Problems and what still asks stay lines of their own.
 */
export function foldHistory(events: HistoryEvent[], ctx: HistoryContext): HistoryEntry[] {
  const out: ({ kind: "one"; key: string; at: number; event: HistoryEvent } | { kind: "open"; key: string; at: number; events: HistoryEvent[] })[] = [];
  const open = new Map<string, { kind: "open"; key: string; at: number; events: HistoryEvent[] }>();
  for (const event of events) {
    const subject = subjectOf(event);
    if (!subject || standsAlone(event)) { out.push({ kind: "one", key: event.id, at: event.at, event }); continue; }
    const group = open.get(subject);
    const last = group?.events.at(-1);
    if (group && last && last.at - event.at <= FOLD_GAP && dayOf(last.at) === dayOf(event.at)) { group.events.push(event); continue; }
    const next = { kind: "open" as const, key: `${subject}@${event.id}`, at: event.at, events: [event] };
    open.set(subject, next);
    out.push(next);
  }
  return out.map((entry) => entry.kind === "one" ? entry
    : entry.events.length === 1 ? { kind: "one", key: entry.events[0]!.id, at: entry.at, event: entry.events[0]! }
    : { kind: "fold", key: entry.key, at: entry.at, events: entry.events, summary: summary(entry.events, ctx) });
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** 오늘, 어제, then "11월 14일 (토)" (and the year when it is another year). */
export function historyDay(at: number, now: number): string {
  const day = dayOf(at);
  if (day === dayOf(now)) return "오늘";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === dayOf(yesterday.getTime())) return "어제";
  const date = new Date(at);
  const year = date.getFullYear() === new Date(now).getFullYear() ? "" : `${date.getFullYear()}년 `;
  return `${year}${date.getMonth() + 1}월 ${date.getDate()}일 (${WEEKDAYS[date.getDay()]})`;
}

/** Entries by day, newest first (they come newest first). */
export function historyDays(entries: HistoryEntry[], now: number): { key: number; label: string; entries: HistoryEntry[] }[] {
  const out: { key: number; label: string; entries: HistoryEntry[] }[] = [];
  for (const entry of entries) {
    const key = dayOf(entry.at);
    const last = out.at(-1);
    if (last && last.key === key) last.entries.push(entry);
    else out.push({ key, label: historyDay(entry.at, now), entries: [entry] });
  }
  return out;
}

/** "14:05" */
export const clock = (at: number) => new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

/** A fresh first page before the lines already read (each once; the older ones only past the fresh page's end). */
export function mergePages(fresh: HistoryEvent[], read: HistoryEvent[]): HistoryEvent[] {
  if (!fresh.length) return read;
  const ids = new Set(fresh.map((event) => event.id));
  const end = fresh.at(-1)!.at;
  return [...fresh, ...read.filter((event) => !ids.has(event.id) && event.at <= end)];
}
