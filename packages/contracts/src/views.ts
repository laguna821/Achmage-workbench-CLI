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
