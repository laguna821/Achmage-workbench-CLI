// View modes ("흐름" on home): what happened when, as the gateway reads it from the stored
// conversations and document revisions. No model is involved.

/** One turn of a session: from its request to its end; `end` is null while it has not ended. */
export type TimelineTurn = {
  sessionId: string;
  workId: string;
  start: number;
  end: number | null;
  status: "completed" | "interrupted" | "failed" | "open";
  /** The request that opened the turn (a transcript item id), so a calendar mark opens the conversation there. */
  itemId?: string;
  /** The request's first line, shortened (for the calendar's labels). */
  text?: string;
};

/** A document revision, drawn as a tick on its work's row. */
export type TimelineRevision = {
  artifactId: string;
  workId: string;
  revision: number;
  at: number;
  author: "user" | "engine" | "external";
};

/** Turns and revisions in `[since, until)`; without `until`, everything since `since`. */
export type Timeline = { since: number; until?: number; turns: TimelineTurn[]; revisions: TimelineRevision[] };

// 활동 › 기록: what happened, newest first, read from what the gateway already stores (requests, turn
// ends, approvals and questions, revisions, 수정안, conversations, documents taken out or renamed).

export type HistoryKind =
  | "request" | "answer" | "failed" | "stopped" | "approval" | "question"
  | "doc-created" | "doc-revised" | "proposal-applied" | "proposal-discarded" | "doc-renamed" | "doc-removed"
  | "session-created" | "session-archived";

/** Who sent a request: this PC, the paired phone chat, a schedule, another conversation, a 세션 잇기 relay, a 끼어들기. */
export type HistoryVia = "pc" | "phone" | "schedule" | "handover" | "link" | "steer";

export type HistoryEvent = {
  /** Unique and stable (paging cursor's tie-break). */
  id: string;
  kind: HistoryKind;
  at: number;
  workId: string;
  sessionId: string | null;
  artifactId: string | null;
  /** The transcript item it is (opens the conversation there). */
  itemId: string | null;
  /** The engine of its conversation. */
  provider?: "claude" | "codex" | null;
  /** request: who sent it, its first line, how long it waited for a free slot (ms; only when it did). */
  via?: HistoryVia;
  text?: string;
  waitedMs?: number;
  /** answer / failed / stopped: how long the turn took; why it stopped. */
  durationMs?: number | null;
  cause?: string | null;
  /** approval / question: the answer (null: still asked); `open`: its conversation waits for it now. */
  decision?: "accept" | "decline" | "expired" | null;
  open?: boolean;
  plan?: boolean;
  /** document events: its name (now), the revision and who wrote it; a rename's old and new names. */
  name?: string;
  revision?: number;
  author?: "user" | "engine" | "external";
  from?: string;
  removal?: "trash" | "unlisted";
};

/** all · 내가 확인할 것 (asked, not answered, its conversation waits) · 끝난 일 · 문제 (failed, stopped, refused). */
export type HistoryFilter = "all" | "attention" | "done" | "problem";

/** One page, newest first; `next` continues after its last line (null: nothing older). */
export type HistoryPage = { events: HistoryEvent[]; next: string | null };
