// "찾는 길": one index for people (Ctrl+K) and engines (`workbench-find`). The gateway answers
// from its own records only; no model is asked.

import type { Provider, SearchResult } from "./index.ts";

/** What a search covers: everything, or one kind of record (the chips in Ctrl+K, switched with Tab). */
export type SearchScope = "all" | "project" | "session" | "document" | "decision" | "vault";

export const SEARCH_SCOPES: SearchScope[] = ["all", "project", "session", "document", "decision", "vault"];

export const SCOPE_LABEL: Record<SearchScope, string> = {
  all: "전체",
  project: "프로젝트",
  session: "세션",
  document: "문서",
  decision: "결정",
  vault: "볼트",
};

/** A scope from a query string or a command line (English or Korean names); "all" otherwise. */
export function parseSearchScope(value: string | null | undefined): SearchScope {
  const text = (value ?? "").trim().toLowerCase();
  const found = SEARCH_SCOPES.find((scope) => scope === text || SCOPE_LABEL[scope] === text);
  if (found) return found;
  if (text === "work" || text === "works" || text === "작업") return "project";
  if (text === "sessions" || text === "대화") return "session";
  if (text === "documents" || text === "doc" || text === "docs") return "document";
  if (text === "decisions" || text === "질문") return "decision";
  if (text === "note" || text === "notes" || text === "노트") return "vault";
  return "all";
}

/**
 * What one index entry is. Work titles, session titles, requests, replies, plans, attachment
 * names, documents and vault notes come from the gateway today; decisions, open questions and
 * events are for the project layer to add through the same index (see search-index.ts `put`).
 */
export type SearchKind = "work" | "session" | "user" | "assistant" | "plan" | "attachment" | "document" | "note" | "decision" | "question" | "event";

export const SEARCH_KIND_LABEL: Record<SearchKind, string> = {
  work: "프로젝트",
  session: "세션",
  user: "요청",
  assistant: "답",
  plan: "계획",
  attachment: "첨부",
  document: "문서",
  note: "노트",
  decision: "결정",
  question: "열린 질문",
  event: "기록",
};

/** One found record, with where it is and a stretch of its text around the match. */
export type FoundHit = {
  /** The index entry's key (`item:<session>:<item>`, `doc:<artifact>`, `work:<id>`, `note:<path>`…). */
  key: string;
  kind: SearchKind;
  scope: Exclude<SearchScope, "all">;
  workId: string | null;
  sessionId: string | null;
  itemId: string | null;
  artifactId: string | null;
  /** A vault note's vault-relative path, or a document's file. */
  path: string | null;
  /** What the row is called: work title, session name, document or note title. */
  title: string;
  /** Matched character ranges within `title`. */
  titleRanges: [number, number][];
  at: number | null;
  /** The engine of the session it belongs to (for a document: of the session that made its latest revision). */
  provider: Provider | null;
  /** The session it belongs to, by name (a document: the session that made its latest revision). */
  sessionTitle: string | null;
  /** Document revision shown (the latest). */
  revision: number | null;
  snippet: string;
  /** Matched character ranges within `snippet`. */
  ranges: [number, number][];
  score: number;
  /**
   * A document whose latest revision an engine made: the reply of that turn. When the reply
   * matched too it is not listed again — document and reply are one row.
   */
  answer: { sessionId: string; itemId: string; at: number; snippet: string; ranges: [number, number][]; matched: boolean } | null;
  /** A plan's decision, a note's folder… shown after the kind. */
  detail: string | null;
};

/** Hits of one work (or of the vault) in rank order; `total` counts all of them, not only those shown. */
export type FoundGroup = {
  /** The work id, `vault` for vault notes, or `none`. */
  key: string;
  workId: string | null;
  title: string;
  /** App folders above the work, top first. */
  trail: string[];
  total: number;
  hits: FoundHit[];
  /** The score of its best hit (groups come in this order). */
  best: number;
};

/**
 * A page of a search: groups by work in rank order, with totals so nothing is cut silently.
 * Grouped (`group` null): `offset`/`limit` count groups, each with its best `per` hits. One group
 * (`group` set): `offset`/`limit` count that group's hits. The fields of `SearchResult` stay for
 * older callers.
 */
export type SearchPage = SearchResult & {
  scope: SearchScope;
  /** Hits in this scope (after rows of a document and its reply were joined). */
  total: number;
  /** Groups in this scope. */
  groupsTotal: number;
  /** Hits per scope, for the chips. */
  counts: Record<SearchScope, number>;
  offset: number;
  limit: number;
  group: string | null;
  groups: FoundGroup[];
  /** The words searched for after Korean particles were taken off (shown when they differ). */
  terms: string[];
};

export type SearchRequest = {
  q: string;
  scope?: SearchScope;
  offset?: number;
  limit?: number;
  per?: number;
  group?: string | null;
  archived?: boolean;
  provider?: Provider | null;
  folderId?: string | null;
};
