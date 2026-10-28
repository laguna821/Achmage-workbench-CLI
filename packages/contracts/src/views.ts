// View modes ("흐름" on home): what happened when, as the gateway reads it from the stored
// conversations and document revisions. No model is involved.

/** One turn of a session: from its request to its end; `end` is null while it has not ended. */
export type TimelineTurn = {
  sessionId: string;
  workId: string;
  start: number;
  end: number | null;
  status: "completed" | "interrupted" | "failed" | "open";
};

/** A document revision, drawn as a tick on its work's row. */
export type TimelineRevision = {
  artifactId: string;
  workId: string;
  revision: number;
  at: number;
  author: "user" | "engine" | "external";
};

export type Timeline = { since: number; turns: TimelineTurn[]; revisions: TimelineRevision[] };
