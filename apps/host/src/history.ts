import type { HistoryEvent, HistoryFilter, HistoryPage, TranscriptItem } from "@workbench/contracts";
import { firstLine } from "./timeline.ts";

// 활동 › 기록: what happened, newest first, a page at a time, read from what the gateway already stores.
// Each source (transcript items, revisions, 수정안, conversations, documents) gives its newest rows older than
// the cursor, at most `limit` each; the page is their merge, cut where the first full source ran out (an
// older row of another source could be newer than that source's next unread row).

export const HISTORY_PAGE = 100;
export const HISTORY_MAX = 200;

/** A position in the list: the last line's time and id (ids break ties between lines of the same moment). */
export type HistoryCursor = { at: number; id: string };

export const encodeCursor = (cursor: HistoryCursor) => `${cursor.at}:${cursor.id}`;
export function decodeCursor(raw: string | null | undefined): HistoryCursor | null {
  if (!raw) return null;
  const colon = raw.indexOf(":");
  const at = Number(raw.slice(0, colon));
  if (colon < 1 || !Number.isSafeInteger(at)) return null;
  return { at, id: raw.slice(colon + 1) };
}

/** Newer first; at the same moment the greater id first (the SQL orders the same way). */
export const newer = (a: HistoryCursor, b: HistoryCursor) => (a.at !== b.at ? b.at - a.at : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** One source's rows (newest first) and whether it stopped at its limit (more may wait behind its last row). */
export type HistorySource = { events: HistoryEvent[]; last: HistoryCursor | null };

export type HistoryQuery = { before: HistoryCursor | null; limit: number; workId: string | null; filter: HistoryFilter };

/** Merge the sources into one page. `drop`: rows read but not listed (they still count for the cut). */
export function mergeHistory(sources: HistorySource[], limit: number, drop: (event: HistoryEvent) => boolean = () => false): HistoryPage {
  // The cut: the newest of the full sources' last rows; nothing older than it is certain yet.
  let cut: HistoryCursor | null = null;
  for (const source of sources) if (source.last && (!cut || newer(source.last, cut) < 0)) cut = source.last;
  const all = sources.flatMap((source) => source.events).filter((event) => !cut || newer(event, cut) <= 0);
  all.sort(newer);
  const kept = all.filter((event) => !drop(event));
  const events = kept.slice(0, limit);
  const end = events.length === limit ? events.at(-1)! : cut;
  return { events, next: end && (events.length === limit || cut) ? encodeCursor({ at: end.at, id: end.id }) : null };
}

/** A transcript item as a line, or null when it is not one a person reads in the history. */
export function itemEvent(row: { sessionId: string; workId: string; provider: string | null; status: string | null; item: TranscriptItem }): HistoryEvent | null {
  const { item, sessionId, workId } = row;
  const base = { id: `item:${sessionId}:${item.id}`, at: item.at, workId, sessionId, artifactId: item.office?.artifactId ?? null, itemId: item.id, provider: row.provider === "claude" || row.provider === "codex" ? row.provider as "claude" | "codex" : null };
  if (item.kind === "user") {
    const via = item.origin ? "phone" : item.scheduled ? "schedule" : item.link ? "link" : item.from || item.peer ? "handover" : item.steered ? "steer" : "pc";
    const text = firstLine(item.text, 60);
    return { ...base, kind: "request", via, ...(text ? { text } : {}), ...(item.waitedMs ? { waitedMs: item.waitedMs } : {}) };
  }
  if (item.kind === "turnEnd") {
    const kind = item.status === "failed" ? "failed" : item.status === "interrupted" ? "stopped" : "answer";
    return { ...base, kind, durationMs: item.durationMs ?? null, ...(item.cause ? { cause: item.cause } : {}) };
  }
  if (item.kind === "approval") {
    const decision = item.decision ?? null;
    return {
      ...base, kind: item.officeInteraction ? "question" : "approval", decision,
      ...(decision === null && row.status === "awaitingApproval" ? { open: true } : {}),
      ...(item.plan ? { plan: true } : {}),
      ...(item.officeInteraction?.prompt ? { text: firstLine(item.officeInteraction.prompt, 60) } : item.title ? { text: firstLine(item.title, 60) } : {}),
    };
  }
  return null;
}

/** The store's part (store.historySources), named here so this file needs no database. */
export type HistoryReader = { historySources(query: HistoryQuery): { sources: HistorySource[]; applied: (artifactIds: string[]) => Set<string> } };

/**
 * One page of 활동 › 기록. A revision that a 수정안 became is said once, by the 수정안's line ("수정안 적용").
 * `limit` is kept between 1 and HISTORY_MAX.
 */
export function readHistory(store: HistoryReader, query: Omit<HistoryQuery, "limit"> & { limit?: number }): HistoryPage {
  const limit = Math.min(HISTORY_MAX, Math.max(1, Math.floor(query.limit ?? HISTORY_PAGE)));
  const { sources, applied } = store.historySources({ ...query, limit });
  const revised = sources.flatMap((source) => source.events).filter((event) => event.kind === "doc-revised" && event.author === "engine");
  const fromProposal = applied([...new Set(revised.map((event) => event.artifactId!))]);
  return mergeHistory(sources, limit, (event) => event.kind === "doc-revised" && fromProposal.has(`${event.artifactId}:${event.revision}`));
}

export const HISTORY_FILTERS: readonly HistoryFilter[] = ["all", "attention", "done", "problem"];
