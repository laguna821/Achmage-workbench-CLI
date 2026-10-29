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
  /** The transcript item. */
  itemId?: string;
  /** A request's text (its start is enough). */
  text?: string | null;
};

type Open = { sessionId: string; workId: string; start: number; itemId?: string; text?: string };

const MAX_TURNS = 20_000;
const MAX_REVISIONS = 5_000;

const endStatus = (status: string | null): TimelineTurn["status"] => (status === "interrupted" || status === "failed" ? status : "completed");

/** A request's first written line, short enough for a calendar label. */
export function firstLine(text: string | null | undefined, limit = 80): string | undefined {
  const line = (text ?? "")
    .split("\n")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!line) return undefined;
  const chars = Array.from(line);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : line;
}

const opened = (mark: TurnMark): Open => {
  const text = firstLine(mark.text);
  return { sessionId: mark.sessionId, workId: mark.workId, start: mark.at, ...(mark.itemId ? { itemId: mark.itemId } : {}), ...(text ? { text } : {}) };
};

/**
 * Pair requests with turn ends, per session. A request opens a turn; a request steered into it
 * belongs to it; a plain request while a turn is still open means that turn never recorded its end
 * (the app stopped), so it is closed there as interrupted. A turn end without a request in range
 * (it began earlier, or it was a compaction) starts its duration before.
 *
 * With `until`, only turns that overlap `[since, until)` are kept: the marks may include the
 * request still open at `since` and the first mark at or after `until` (store.turnMarks), so a
 * turn crossing an edge keeps its real start and end.
 */
export function buildTimeline(marks: TurnMark[], revisions: TimelineRevision[], since: number, until?: number): Timeline {
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
      open = opened(mark);
      continue;
    }
    if (open) turns.push({ ...open, end: mark.at, status: endStatus(mark.status) });
    else turns.push({ sessionId: mark.sessionId, workId: mark.workId, start: mark.at - Math.max(0, mark.durationMs ?? 0), end: mark.at, status: endStatus(mark.status) });
    open = null;
  }
  if (open) turns.push({ ...open, end: null, status: "open" });
  const end = until ?? Infinity;
  // An open turn's end is unknown here (the session may still be working): it stays, the screen decides.
  const inside = turns.filter((turn) => turn.start < end && (turn.end === null || turn.end > since || turn.start >= since));
  const recent = inside.sort((a, b) => a.start - b.start).slice(-MAX_TURNS);
  const kept = revisions.filter((revision) => revision.at >= since && revision.at < end);
  return {
    since,
    ...(until !== undefined ? { until } : {}),
    turns: recent,
    revisions: kept.sort((a, b) => a.at - b.at).slice(-MAX_REVISIONS),
  };
}
