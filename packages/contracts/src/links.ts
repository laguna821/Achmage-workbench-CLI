// Linked sessions ("세션 잇기"): two to six sessions answer each other in turn, relayed by the
// gateway within the rounds and minutes the user set. Fixed rules decide when it stops — no model
// is asked — and the user's own input always comes first: writing into a participant pauses it.

export type LinkState = "active" | "paused" | "ended";

/**
 * Why a link stands still.
 * Paused: manual (멈춤), typed (the user wrote into a participant), usage (the 5-hour limit is nearly
 * used), restart (the app restarted), busy (the next session was doing something else).
 * Ended: stopped (끊기), agreed (a last line [[합의]]), done ([[끝]]), rounds, time, empty (an empty
 * reply), repeat (a reply saying again what was said), failed, interrupted, gone (a participant left).
 */
export type LinkReason =
  | "manual"
  | "typed"
  | "usage"
  | "restart"
  | "busy"
  | "stopped"
  | "agreed"
  | "done"
  | "rounds"
  | "time"
  | "empty"
  | "repeat"
  | "failed"
  | "interrupted"
  | "gone";

export type SessionLink = {
  id: string;
  /** Sessions in speaking order (2–6); the first answers the goal first. */
  participants: string[];
  /** What the user wants the sessions to reach, in the user's words. */
  goal: string;
  /** Each participant speaks at most this many times. */
  maxRounds: number;
  /** Time the link may run, not counting pauses or waiting approvals. */
  maxMinutes: number;
  state: LinkState;
  /** Why it is paused or ended; null while active. */
  reason: LinkReason | null;
  /** Messages handed over so far; the goal sent to the first session is the first. */
  hops: number;
  /** Index (in participants) of the session whose answer is awaited or was last given. */
  turn: number;
  /** Active time counted up to `clockFrom`. */
  elapsedMs: number;
  /** When the clock last started; null while it stands (paused, ended, an approval waits). */
  clockFrom: number | null;
  /** The user went on past the usage limit: usage no longer pauses this link. */
  usageAllowed: boolean;
  startedAt: number;
  endedAt: number | null;
  updatedAt: number;
};

/** On a request a link handed to a session: which link, which message of how many, from whom. */
export type LinkHop = { linkId: string; hop: number; of: number; fromSessionId: string | null };

export type StartLinkRequest = {
  /** Client-generated; becomes the link id, so repeating it never starts twice. */
  requestId: string;
  participants: string[];
  goal: string;
  maxRounds: number;
  maxMinutes: number;
};

/** One turn of a link, for "주고받은 내용" (all participants in one column). */
export type LinkTurn = {
  /** The request item that carried the message. */
  id: string;
  hop: number;
  sessionId: string;
  at: number;
  /** What the session received (the goal, or the previous reply). */
  request: string;
  reply: string;
  status: "running" | "completed" | "interrupted" | "failed";
};

export const LINK_LIMITS = { participants: { min: 2, max: 6 }, rounds: { min: 1, max: 20 }, minutes: { min: 1, max: 240 } } as const;

export const LINK_PRESETS = [
  { id: "light", label: "가볍게", rounds: 1, minutes: 10 },
  { id: "normal", label: "보통", rounds: 3, minutes: 30 },
  { id: "deep", label: "깊게", rounds: 6, minutes: 60 },
] as const;

export const LINK_REASON_LABEL: Record<LinkReason, string> = {
  manual: "멈춤",
  typed: "직접 입력해서 멈춤",
  usage: "5시간 사용량이 90%를 넘어 멈춤",
  restart: "앱이 다시 시작되어 멈춤",
  busy: "다음 세션이 다른 일을 하는 중이라 멈춤",
  stopped: "끊음",
  agreed: "합의",
  done: "끝 표시",
  rounds: "정한 왕복을 마침",
  time: "정한 시간이 지남",
  empty: "빈 답",
  repeat: "같은 답이 되풀이됨",
  failed: "응답 실패",
  interrupted: "응답이 중단됨",
  gone: "참여 세션이 빠짐",
};

/** Messages a link may hand over in all: every participant speaks `maxRounds` times. */
export const linkMaxHops = (link: Pick<SessionLink, "participants" | "maxRounds">) => link.participants.length * link.maxRounds;

/** Active time so far (pauses and waiting approvals not counted). */
export const linkElapsedMs = (link: Pick<SessionLink, "elapsedMs" | "clockFrom">, now: number) =>
  link.elapsedMs + (link.clockFrom === null ? 0 : Math.max(0, now - link.clockFrom));

/** The active or paused link a session takes part in (a session is in at most one). */
export function liveLinkOf(links: Iterable<SessionLink>, sessionId: string): SessionLink | null {
  for (const link of links) if (link.state !== "ended" && link.participants.includes(sessionId)) return link;
  return null;
}
