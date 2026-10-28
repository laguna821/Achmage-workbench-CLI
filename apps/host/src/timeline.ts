import type { Timeline, TimelineRevision, TimelineTurn } from "@workbench/contracts";

// Home "흐름": turns and document revisions over time, read from what the gateway already stores
// (requests, turn ends, revisions). Pure, so the pairing rules can be tested without a database.

/** A stored request or turn end, in the order it was stored in its session. */
export type TurnMark = {
  sessionId: string;
  workId: string;
  kind: "user" | "turnEnd";
  at: number;
  status: string | null;
  durationMs: number | null;
  /** A request sent into a running turn ("끼어들기"): part of that turn, not a new one. */
  steered: boolean;
};

type Open = { sessionId: string; workId: string; start: number };

const MAX_TURNS = 20_000;
const MAX_REVISIONS = 5_000;

const endStatus = (status: string | null): TimelineTurn["status"] => (status === "interrupted" || status === "failed" ? status : "completed");

/**
 * Pair requests with turn ends, per session. A request opens a turn; a request steered into it
 * belongs to it; a plain request while a turn is still open means that turn never recorded its end
 * (the app stopped), so it is closed there as interrupted. A turn end without a request in range
 * (it began earlier, or it was a compaction) starts its duration before.
 */
export function buildTimeline(marks: TurnMark[], revisions: TimelineRevision[], since: number): Timeline {
  const turns: TimelineTurn[] = [];
  let open: Open | null = null;
  let session: string | null = null;
  for (const mark of marks) {
    if (mark.sessionId !== session) {
      if (open) turns.push({ ...open, end: null, status: "open" });
      open = null;
      session = mark.sessionId;
    }
    if (mark.kind === "user") {
      if (open && mark.steered) continue;
      if (open) turns.push({ ...open, end: mark.at, status: "interrupted" });
      open = { sessionId: mark.sessionId, workId: mark.workId, start: mark.at };
      continue;
    }
    const start = open ? open.start : mark.at - Math.max(0, mark.durationMs ?? 0);
    turns.push({ sessionId: mark.sessionId, workId: mark.workId, start, end: mark.at, status: endStatus(mark.status) });
    open = null;
  }
  if (open) turns.push({ ...open, end: null, status: "open" });
  const recent = turns.sort((a, b) => a.start - b.start).slice(-MAX_TURNS);
  return { since, turns: recent, revisions: [...revisions].sort((a, b) => a.at - b.at).slice(-MAX_REVISIONS) };
}
