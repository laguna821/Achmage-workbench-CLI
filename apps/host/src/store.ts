import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Artifact, ArtifactRevision, Folder, Handoff, Proposal, Session, SessionLink, TimelineRevision, TranscriptItem, Work } from "@workbench/contracts";
import type { TurnMark } from "./timeline.ts";

// Local state only: works, folders, sessions, transcript items and request ids.
// Never place this database in Dropbox (live SQLite must not be synced).

/** Bumped when what the search index holds changes; the index is then rebuilt once. */
const SEARCH_VERSION = "1";

/** Messages the search covers: what the user asked and what the engine answered (not tools or reasoning). */
export function searchableText(item: TranscriptItem): string | null {
  if (item.kind === "user") return item.text;
  if (item.kind === "assistant" && !item.streaming && item.text.trim()) return item.text;
  return null;
}

/** A search term as a LIKE pattern (`%`, `_` and the escape character taken literally). */
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

export type ItemHit = { sessionId: string; itemId: string; kind: "user" | "assistant"; at: number; text: string };

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items (
        session_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (session_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, path TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (
        artifact_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (artifact_id, revision)
      );
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      -- Full-text search over messages and documents. Trigram: matches any part of a word, so Korean
      -- finds without a morphological analyser; terms shorter than three characters scan instead.
      -- Row ids follow the items and artifacts tables, so a changed row replaces its entry directly.
      CREATE VIRTUAL TABLE IF NOT EXISTS item_search USING fts5(text, session_id UNINDEXED, item_id UNINDEXED, kind UNINDEXED, at UNINDEXED, tokenize = 'trigram');
      CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(text, artifact_id UNINDEXED, tokenize = 'trigram');
    `);
    if (this.getMeta("search.version") !== SEARCH_VERSION) this.rebuildSearch();
  }

  /** Index every stored message again (first start with search, or after the index format changed). */
  private rebuildSearch() {
    this.db.exec("DELETE FROM item_search");
    const rows = this.db.prepare("SELECT rowid, session_id, json FROM items").all();
    const insert = this.db.prepare("INSERT INTO item_search (rowid, text, session_id, item_id, kind, at) VALUES (?, ?, ?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        const item = JSON.parse(String(row.json)) as TranscriptItem;
        const text = searchableText(item);
        if (text !== null) insert.run(Number(row.rowid), text, String(row.session_id), item.id, item.kind, item.at);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.setMeta("search.version", SEARCH_VERSION);
  }

  private indexItem(sessionId: string, item: TranscriptItem) {
    const row = this.db.prepare("SELECT rowid FROM items WHERE session_id = ? AND item_id = ?").get(sessionId, item.id);
    if (!row) return;
    const rowid = Number(row.rowid);
    this.db.prepare("DELETE FROM item_search WHERE rowid = ?").run(rowid);
    const text = searchableText(item);
    if (text !== null) {
      this.db
        .prepare("INSERT INTO item_search (rowid, text, session_id, item_id, kind, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(rowid, text, sessionId, item.id, item.kind, item.at);
    }
  }

  /** Messages containing every term (case-insensitive), most recent first. */
  searchItems(terms: string[], limit = 500): ItemHit[] {
    if (!terms.length) return [];
    const where = terms.map(() => "text LIKE ? ESCAPE '\\'").join(" AND ");
    return this.db
      .prepare(`SELECT session_id, item_id, kind, at, text FROM item_search WHERE ${where} ORDER BY CAST(at AS INTEGER) DESC LIMIT ?`)
      .all(...terms.map(likePattern), limit)
      .map((row) => ({ sessionId: String(row.session_id), itemId: String(row.item_id), kind: row.kind === "user" ? "user" : "assistant", at: Number(row.at), text: String(row.text) }));
  }

  /** The searchable text of a document's latest revision (or none). */
  indexDocument(artifactId: string, text: string | null) {
    const row = this.db.prepare("SELECT rowid FROM artifacts WHERE id = ?").get(artifactId);
    if (!row) return;
    const rowid = Number(row.rowid);
    this.db.prepare("DELETE FROM document_search WHERE rowid = ?").run(rowid);
    if (text?.trim()) this.db.prepare("INSERT INTO document_search (rowid, text, artifact_id) VALUES (?, ?, ?)").run(rowid, text, artifactId);
  }

  /** Every document entry gone, before all are indexed again (also entries older versions left behind). */
  clearDocumentIndex() {
    this.db.exec("DELETE FROM document_search");
  }

  searchDocuments(terms: string[], limit = 50): { artifactId: string; text: string }[] {
    if (!terms.length) return [];
    const where = terms.map(() => "text LIKE ? ESCAPE '\\'").join(" AND ");
    return this.db
      .prepare(`SELECT artifact_id, text FROM document_search WHERE ${where} LIMIT ?`)
      .all(...terms.map(likePattern), limit)
      .map((row) => ({ artifactId: String(row.artifact_id), text: String(row.text) }));
  }

  /** Requests and turn ends since a time, in stored order per session (home "흐름"). */
  turnMarks(since: number): TurnMark[] {
    return this.db
      .prepare(
        `SELECT i.session_id, s.work_id, json_extract(i.json, '$.kind') AS kind, json_extract(i.json, '$.at') AS at,
                json_extract(i.json, '$.status') AS status, json_extract(i.json, '$.durationMs') AS duration, json_extract(i.json, '$.steered') AS steered
           FROM items i JOIN sessions s ON s.id = i.session_id
          WHERE json_extract(i.json, '$.kind') IN ('user', 'turnEnd') AND json_extract(i.json, '$.at') >= ?
          ORDER BY i.session_id, i.ord`,
      )
      .all(since)
      .map((row) => ({
        sessionId: String(row.session_id),
        workId: String(row.work_id),
        kind: row.kind === "user" ? "user" : "turnEnd",
        at: Number(row.at),
        status: row.status === null ? null : String(row.status),
        durationMs: row.duration === null ? null : Number(row.duration),
        steered: Number(row.steered ?? 0) === 1,
      }));
  }

  /** A work's requests and the time its finished turns took (project facts). */
  workCounts(workId: string): { requests: number; turnMs: number } {
    const rows = this.db
      .prepare(
        `SELECT json_extract(i.json, '$.kind') AS kind, COUNT(*) AS n, SUM(json_extract(i.json, '$.durationMs')) AS ms
           FROM items i JOIN sessions s ON s.id = i.session_id
          WHERE s.work_id = ? AND json_extract(i.json, '$.kind') IN ('user', 'turnEnd')
          GROUP BY kind`,
      )
      .all(workId);
    const of = (kind: string) => rows.find((row) => row.kind === kind);
    return { requests: Number(of("user")?.n ?? 0), turnMs: Number(of("turnEnd")?.ms ?? 0) };
  }

  /** Requests and plan decisions of a work since a time, newest first (project "기록"). */
  workItems(workId: string, since: number, limit: number): { sessionId: string; item: TranscriptItem }[] {
    return this.db
      .prepare(
        `SELECT i.session_id, i.json FROM items i JOIN sessions s ON s.id = i.session_id
          WHERE s.work_id = ? AND json_extract(i.json, '$.kind') IN ('user', 'approval') AND json_extract(i.json, '$.at') >= ?
          ORDER BY json_extract(i.json, '$.at') DESC LIMIT ?`,
      )
      .all(workId, since, limit)
      .map((row) => ({ sessionId: String(row.session_id), item: JSON.parse(String(row.json)) as TranscriptItem }));
  }

  /** Document revisions of a work since a time, newest first, with who wrote them. */
  workRevisions(workId: string, since: number, limit: number): ArtifactRevision[] {
    return this.db
      .prepare(
        `SELECT r.json FROM revisions r JOIN artifacts a ON a.id = r.artifact_id
          WHERE a.work_id = ? AND json_extract(r.json, '$.at') >= ?
          ORDER BY json_extract(r.json, '$.at') DESC LIMIT ?`,
      )
      .all(workId, since, limit)
      .map((row) => JSON.parse(String(row.json)) as ArtifactRevision);
  }

  /** Document revisions since a time (home "흐름"). */
  revisionMarks(since: number): TimelineRevision[] {
    return this.db
      .prepare(
        `SELECT r.artifact_id, a.work_id, r.revision, json_extract(r.json, '$.at') AS at, json_extract(r.json, '$.author') AS author
           FROM revisions r JOIN artifacts a ON a.id = r.artifact_id
          WHERE json_extract(r.json, '$.at') >= ?`,
      )
      .all(since)
      .map((row) => ({
        artifactId: String(row.artifact_id),
        workId: String(row.work_id),
        revision: Number(row.revision),
        at: Number(row.at),
        author: row.author === "engine" ? "engine" : row.author === "external" ? "external" : "user",
      }));
  }

  close() {
    this.db.close();
  }

  folders(): Folder[] {
    return this.all<Folder>("SELECT json FROM folders");
  }

  works(): Work[] {
    return this.all<Work>("SELECT json FROM works");
  }

  sessions(): Session[] {
    return this.all<Session>("SELECT json FROM sessions");
  }

  saveFolder(folder: Folder) {
    this.db.prepare("INSERT OR REPLACE INTO folders (id, json) VALUES (?, ?)").run(folder.id, JSON.stringify(folder));
  }

  saveWork(work: Work) {
    this.db.prepare("INSERT OR REPLACE INTO works (id, json) VALUES (?, ?)").run(work.id, JSON.stringify(work));
  }

  saveSession(session: Session) {
    this.db
      .prepare("INSERT OR REPLACE INTO sessions (id, work_id, json) VALUES (?, ?, ?)")
      .run(session.id, session.workId, JSON.stringify(session));
  }

  items(sessionId: string): TranscriptItem[] {
    return this.db
      .prepare("SELECT json FROM items WHERE session_id = ? ORDER BY ord")
      .all(sessionId)
      .map((row) => JSON.parse(String(row.json)) as TranscriptItem);
  }

  saveItem(sessionId: string, item: TranscriptItem) {
    const existing = this.db
      .prepare("SELECT ord FROM items WHERE session_id = ? AND item_id = ?")
      .get(sessionId, item.id);
    if (existing) {
      this.db
        .prepare("UPDATE items SET json = ? WHERE session_id = ? AND item_id = ?")
        .run(JSON.stringify(item), sessionId, item.id);
    } else {
      const next = this.db
        .prepare("SELECT COALESCE(MAX(ord), 0) + 1 AS ord FROM items WHERE session_id = ?")
        .get(sessionId);
      this.db
        .prepare("INSERT INTO items (session_id, item_id, ord, json) VALUES (?, ?, ?, ?)")
        .run(sessionId, item.id, Number(next?.ord ?? 1), JSON.stringify(item));
    }
    if (item.kind === "user" || item.kind === "assistant") this.indexItem(sessionId, item);
  }

  artifacts(): Artifact[] {
    return this.all<Artifact>("SELECT json FROM artifacts");
  }

  saveArtifact(artifact: Artifact) {
    // An upsert keeps the row id the document index is keyed by (a replace gave a new one on every
    // save, leaving the old text found under the document).
    this.db
      .prepare("INSERT INTO artifacts (id, work_id, path, json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET work_id = excluded.work_id, path = excluded.path, json = excluded.json")
      .run(artifact.id, artifact.workId, artifact.path, JSON.stringify(artifact));
  }

  revisions(artifactId: string): ArtifactRevision[] {
    return this.db
      .prepare("SELECT json FROM revisions WHERE artifact_id = ? ORDER BY revision")
      .all(artifactId)
      .map((row) => JSON.parse(String(row.json)) as ArtifactRevision);
  }

  saveRevision(revision: ArtifactRevision) {
    this.db
      .prepare("INSERT INTO revisions (artifact_id, revision, json) VALUES (?, ?, ?)")
      .run(revision.artifactId, revision.revision, JSON.stringify(revision));
  }

  proposals(): Proposal[] {
    return this.all<Proposal>("SELECT json FROM proposals");
  }

  saveProposal(proposal: Proposal) {
    this.db
      .prepare("INSERT OR REPLACE INTO proposals (id, artifact_id, json) VALUES (?, ?, ?)")
      .run(proposal.id, proposal.artifactId, JSON.stringify(proposal));
  }

  handoffs(): Handoff[] {
    return this.all<Handoff>("SELECT json FROM handoffs");
  }

  saveHandoff(handoff: Handoff) {
    this.db.prepare("INSERT OR REPLACE INTO handoffs (id, json) VALUES (?, ?)").run(handoff.id, JSON.stringify(handoff));
  }

  links(): SessionLink[] {
    return this.all<SessionLink>("SELECT json FROM links");
  }

  saveLink(link: SessionLink) {
    this.db.prepare("INSERT OR REPLACE INTO links (id, json) VALUES (?, ?)").run(link.id, JSON.stringify(link));
  }

  /** Returns the stored text hash when the request id was already used. */
  findRequest(requestId: string): { sessionId: string; textHash: string } | null {
    const row = this.db.prepare("SELECT session_id, text_hash FROM requests WHERE request_id = ?").get(requestId);
    return row ? { sessionId: String(row.session_id), textHash: String(row.text_hash) } : null;
  }

  saveRequest(requestId: string, sessionId: string, textHash: string) {
    this.db
      .prepare("INSERT INTO requests (request_id, session_id, text_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(requestId, sessionId, textHash, Date.now());
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  private all<T>(sql: string): T[] {
    return this.db
      .prepare(sql)
      .all()
      .map((row) => JSON.parse(String(row.json)) as T);
  }
}
