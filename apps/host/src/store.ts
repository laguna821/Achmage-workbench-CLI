import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Workspace, WorktreeCreation, TerminalSession, PreparationJob } from "@workbench/contracts";
import type { Artifact, ArtifactRevision, Folder, Handoff, HistoryEvent, Proposal, Session, SessionLink, TimelineRevision, TranscriptItem, Work } from "@workbench/contracts";
import type { TurnMark } from "./timeline.ts";
import { itemEvent, type HistoryCursor, type HistoryQuery, type HistorySource } from "./history.ts";
import { SearchIndex, documentEntry, documentKey, itemEntries, itemKey, sessionEntry, workEntry, type WorkExtras } from "./search-index.ts";
import type { HubJournalEntry, RequestOrigin } from "@workbench/contracts";
import { isRequestOrigin } from "@workbench/contracts";
import { ChannelStore } from "./channels/store.ts";

// Local state only: works, folders, sessions, transcript items and request ids.
// Never place this database in Dropbox (live SQLite must not be synced).

/**
 * Bumped when what the search index holds changes; the index is then rebuilt once (search-index.ts).
 * 1: messages and documents in two trigram tables. 2: one ranked index (2-gram and trigram) of
 * requests, replies, plans, attachment names, documents, works, sessions and vault notes.
 */
// 3: native-search raw cache with exact structured fields (only derived data is rebuilt).
const SEARCH_VERSION = "5-fast-find-prompt-recovery";

export const STORE_SCHEMA_VERSION = 1;
/** When free pages are given back: at least 8 MiB and a fifth of the file (the owner's had 51 MB free of 78). */
/** SQLITE_BUSY / SQLITE_LOCKED (another connection or process has the file). */
export const busyError = (error: unknown) => {
  const code = Number((error as { errcode?: number })?.errcode) & 0xff;
  return code === 5 || code === 6 || /database is (locked|busy)|database table is locked/i.test(String((error as Error)?.message ?? ""));
};
export const COMPACT_RULE = { minFreeBytes: 8 * 1024 * 1024, minFreeShare: 0.2 } as const;
export type StoreMigration = { from: number; to: number; backupPath: string | null };

export class Store {
  private readonly db: DatabaseSync;
  readonly migration: StoreMigration;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    const existing = path !== ":memory:" && existsSync(path);
    let version = 0, needsBackup = false;
    // Reject a future DB before opening a writable connection or changing its journal mode.
    if (existing) {
      const probe = new DatabaseSync(path, { readOnly: true });
      try {
        version = Number(probe.prepare("PRAGMA user_version").get()?.user_version ?? 0);
        if (version > STORE_SCHEMA_VERSION) throw Object.assign(Error(`이 데이터베이스는 더 새로운 Workbench가 사용한 schema ${version}입니다. 지원 버전은 ${STORE_SCHEMA_VERSION}이며 원본은 변경하지 않았습니다.`), { code: "future_schema" });
        const hasTables = Number(probe.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()?.n ?? 0) > 0;
        const hasMeta = Boolean(probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get());
        const searchVersion = hasMeta ? probe.prepare("SELECT value FROM meta WHERE key = 'search.version'").get()?.value : null;
        needsBackup = hasTables && (version < STORE_SCHEMA_VERSION || searchVersion !== SEARCH_VERSION);
      } finally { probe.close(); }
    }
    this.db = new DatabaseSync(path);
    let backupPath: string | null = null;
    try {
      if (needsBackup) {
        const folder = join(dirname(path), "backups"); mkdirSync(folder, { recursive: true, mode: 0o700 }); chmodSync(folder, 0o700);
        backupPath = join(folder, `${basename(path)}.schema-${version}.${Date.now()}-${randomUUID()}.sqlite`);
        // SQLite takes a coherent snapshot including committed WAL pages. Never copy a live DB file.
        this.db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
        chmodSync(backupPath, 0o600);
        const backup = new DatabaseSync(backupPath, { readOnly: true });
        try { if (backup.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw Error("마이그레이션 전 복구본을 확인하지 못했습니다."); }
        finally { backup.close(); }
      }
    } catch (error) { this.db.close(); throw error; }
    this.migration = { from: version, to: STORE_SCHEMA_VERSION, backupPath };
    // Writes report their rowid as a BigInt. FTS5 keeps the delete markers of the search index at
    // rowids past 2^53 and SQLite's "last inserted rowid" can be one of them after a search write;
    // read as a number it threw on the next INSERT, UPDATE or DELETE (of any table) and stopped
    // the gateway. Reads keep numbers.
    const prepare = this.db.prepare.bind(this.db);
    this.db.prepare = (sql: string) => {
      const statement = prepare(sql);
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) statement.setReadBigInts(true);
      return statement;
    };
    try {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      -- 0.5.3 (A8): in WAL, NORMAL syncs at checkpoints, not on every commit. A power cut can lose the last
      -- moments (the last transactions: the end of a transcript, a terminal's last output batch); the database
      -- stays consistent (WAL is atomic). An application crash loses nothing that was committed.
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 3000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worktree_creations (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS terminals (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_preparations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS terminal_output (terminal_id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(terminal_id, start));
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
      CREATE TABLE IF NOT EXISTS hub_deliveries (
        id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL, payload_hash TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, json TEXT NOT NULL,
        UNIQUE(connector_id, delivery_id, workflow_id),
        UNIQUE(connector_id, payload_hash, workflow_id)
      );
      CREATE INDEX IF NOT EXISTS hub_deliveries_recent ON hub_deliveries(created_at DESC);
      CREATE INDEX IF NOT EXISTS hub_deliveries_state ON hub_deliveries(state);
      -- 활동 › 기록 (history.ts): requests, turn ends and approvals newest first, without reading every item.
      CREATE INDEX IF NOT EXISTS items_kind_at ON items(json_extract(json, '$.kind'), json_extract(json, '$.at'));
      COMMIT;
    `);
    // Additive, without a schema version: an older gateway names its columns and never reads this one.
    if (!this.db.prepare("SELECT 1 AS found FROM pragma_table_info('requests') WHERE name = 'origin'").get()) this.db.exec("ALTER TABLE requests ADD COLUMN origin TEXT");
    this.channels = new ChannelStore(this.db);
    this.search = new SearchIndex(this.db);
    if (this.getMeta("search.version") !== SEARCH_VERSION) this.rebuildSearch();
    this.db.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
    if (backupPath) this.setMeta("schema.last-backup", JSON.stringify(this.migration));
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* No transaction open. */ } this.db.close(); throw error; }
  }

  /** The search index ("찾는 길"): every request, reply, plan, document, work, session and note. */
  readonly search: SearchIndex;

  /** The messenger channel's tables (channels/store.ts): new tables beside the existing ones. */
  readonly channels: ChannelStore;

  /** What the project layer adds to a work's search entry (aliases, tags, properties); see search-index.ts. */
  workExtras: ((workId: string) => WorkExtras | null) | null = null;

  /**
   * Index everything stored again (the first start with this index, or after its format changed).
   * Documents are indexed again by the documents layer (it reads their revisions), vault notes by
   * the vault sync (search.ts); both see their entries missing.
   */
  private rebuildSearch() {
    this.db.exec("DROP TABLE IF EXISTS item_search; DROP TABLE IF EXISTS document_search;");
    this.search.clear();
    this.search.forgetSources();
    this.search.transaction(() => {
      const workOf = new Map<string, string>();
      for (const row of this.db.prepare("SELECT id, work_id, json FROM sessions").all()) {
        workOf.set(String(row.id), String(row.work_id));
        this.search.put(sessionEntry(JSON.parse(String(row.json)) as Session));
      }
      for (const work of this.works()) this.search.put(workEntry(work, this.workExtras?.(work.id) ?? null));
      let session: string | null = null;
      let lastReply: string | null = null;
      for (const row of this.db.prepare("SELECT session_id, json FROM items ORDER BY session_id, ord").all()) {
        const sessionId = String(row.session_id);
        if (sessionId !== session) {
          session = sessionId;
          lastReply = null;
        }
        const item = JSON.parse(String(row.json)) as TranscriptItem;
        for (const { entry } of itemEntries(sessionId, workOf.get(sessionId) ?? null, item)) if (entry) this.search.put(entry);
        if (item.kind === "assistant") lastReply = item.id;
        else if (item.kind === "user") lastReply = null;
        else if (item.kind === "approval" && item.plan && !item.detail?.trim() && lastReply) this.search.relabel(itemKey(sessionId, lastReply), "plan");
      }
    });
    this.db.prepare("DELETE FROM meta WHERE key = 'search.documents'").run();
    this.setMeta("search.version", SEARCH_VERSION);
  }

  /** Keep a transcript item's search entries (requests, finished replies, plans, attachment names). */
  private indexItem(sessionId: string, item: TranscriptItem) {
    const changes = itemEntries(sessionId, this.workOf(sessionId), item);
    for (const { key, entry } of changes) {
      if (!entry) {
        this.search.remove(key);
        continue;
      }
      // A reply already marked as a plan stays one when it is saved again.
      if (entry.kind === "assistant" && this.search.kindOf(key) === "plan") entry.kind = "plan";
      this.search.put(entry);
    }
    // A plan waiting for the go-ahead without its own text: the reply above it is the plan.
    if (item.kind === "approval" && item.plan && !item.detail?.trim()) {
      const above = this.db
        .prepare("SELECT json FROM items WHERE session_id = ? AND ord < (SELECT ord FROM items WHERE session_id = ? AND item_id = ?) ORDER BY ord DESC LIMIT 40")
        .all(sessionId, sessionId, item.id)
        .map((row) => JSON.parse(String(row.json)) as TranscriptItem);
      const reply = above.find((entry) => entry.kind === "assistant" || entry.kind === "user");
      if (reply?.kind === "assistant") this.search.relabel(itemKey(sessionId, reply.id), "plan");
    }
  }

  /** Preserve the source even on an index error, and retry from source on next startup. */
  private indexSafely(write: () => void) {
    try {
      write();
    } catch {
      // A user's prompt may never change again. Do not leave it missing permanently.
      this.setMeta("search.version", "repair-required");
    }
  }

  private workOf(sessionId: string): string | null {
    const row = this.db.prepare("SELECT work_id FROM sessions WHERE id = ?").get(sessionId);
    return row ? String(row.work_id) : null;
  }

  /** Put a work into the search index again (its title, tags, or what the project layer adds changed). */
  indexWork(workId: string) {
    const row = this.db.prepare("SELECT json FROM works WHERE id = ?").get(workId);
    if (row) this.search.put(workEntry(JSON.parse(String(row.json)) as Work, this.workExtras?.(workId) ?? null));
  }

  /**
   * The searchable text of a document's latest revision (null: none yet — the document is then
   * found by its name). Conversation records ("세션 기록") are left out: the conversation is there.
   */
  indexDocument(artifactId: string, text: string | null) {
    const row = this.db.prepare("SELECT json FROM artifacts WHERE id = ?").get(artifactId);
    if (!row) return;
    const artifact = JSON.parse(String(row.json)) as Artifact;
    // A removed document is not found (a late background read must not bring it back).
    if (artifact.removed) return this.removeDocumentEntry(artifactId);
    const latest = this.db.prepare("SELECT json FROM revisions WHERE artifact_id = ? ORDER BY revision DESC LIMIT 1").get(artifactId);
    this.indexSafely(() => {
      const entry = documentEntry(artifact, latest ? (JSON.parse(String(latest.json)) as ArtifactRevision) : null, text);
      if (entry) this.search.put(entry);
      else this.search.remove(`doc:${artifactId}`);
    });
  }

  /** A document leaves search (taken out of its project; found again once restored). */
  removeDocumentEntry(artifactId: string) {
    this.indexSafely(() => this.search.remove(documentKey(artifactId)));
  }

  /** A document deleted for good: its record, revisions and proposals. */
  deleteArtifact(artifactId: string) {
    this.transaction(() => {
      for (const table of ["proposals", "revisions"]) this.db.prepare(`DELETE FROM ${table} WHERE artifact_id = ?`).run(artifactId);
      this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(artifactId);
    });
    this.removeDocumentEntry(artifactId);
  }

  /** Whether a document is in the search index yet (by its name at least). */
  hasDocumentEntry(artifactId: string) {
    return this.search.signature(documentKey(artifactId)) !== null;
  }

  /** Every document entry gone, before all are indexed again (also entries older versions left behind). */
  clearDocumentIndex() {
    this.indexSafely(() => this.search.removePrefix("doc:"));
  }

  /**
   * Requests and turn ends in `[since, until)`, in stored order per session (home "흐름"). Also,
   * per session, the request still open at `since` (its turn began before) and the first mark at
   * or after `until` (it ends a turn that runs past the window), so turns crossing an edge keep
   * their real start and end (timeline.ts keeps only turns that overlap the window).
   */
  turnMarks(since: number, until = Number.MAX_SAFE_INTEGER): TurnMark[] {
    return this.db
      .prepare(
        `WITH marks AS (
           SELECT i.session_id AS session_id, s.work_id AS work_id, i.item_id AS item_id, i.ord AS ord,
                  json_extract(i.json, '$.kind') AS kind, json_extract(i.json, '$.at') AS at,
                  json_extract(i.json, '$.status') AS status, json_extract(i.json, '$.durationMs') AS duration, json_extract(i.json, '$.steered') AS steered,
                  CASE json_extract(i.json, '$.kind') WHEN 'user' THEN substr(json_extract(i.json, '$.text'), 1, 400) END AS text
             FROM items i JOIN sessions s ON s.id = i.session_id
            WHERE json_extract(i.json, '$.kind') IN ('user', 'turnEnd')
         ), around AS (
           SELECT marks.*, LAG(at) OVER w AS before_at, LEAD(at) OVER w AS after_at
             FROM marks WINDOW w AS (PARTITION BY session_id ORDER BY ord)
         )
         SELECT * FROM around
          WHERE (at >= ?1 AND at < ?2)
             OR (at < ?1 AND kind = 'user' AND (after_at IS NULL OR after_at >= ?1))
             OR (at >= ?2 AND before_at < ?2)
          ORDER BY session_id, ord`,
      )
      .all(since, until)
      .map((row) => ({
        sessionId: String(row.session_id),
        workId: String(row.work_id),
        kind: row.kind === "user" ? "user" : "turnEnd",
        at: Number(row.at),
        status: row.status === null ? null : String(row.status),
        durationMs: row.duration === null ? null : Number(row.duration),
        steered: Number(row.steered ?? 0) === 1,
        itemId: String(row.item_id),
        text: row.text === null || row.text === undefined ? null : String(row.text),
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

  /** The last turn end of each session of a work (project "멈춘 곳"). */
  lastTurnEnds(workId: string): Map<string, Extract<TranscriptItem, { kind: "turnEnd" }>> {
    const rows = this.db
      .prepare(
        `SELECT i.session_id, i.json FROM items i
           JOIN (SELECT i.session_id, MAX(i.ord) AS ord FROM items i JOIN sessions s ON s.id = i.session_id
                  WHERE s.work_id = ? AND json_extract(i.json, '$.kind') = 'turnEnd' GROUP BY i.session_id) last
             ON last.session_id = i.session_id AND last.ord = i.ord`,
      )
      .all(workId);
    return new Map(rows.map((row) => [String(row.session_id), JSON.parse(String(row.json)) as Extract<TranscriptItem, { kind: "turnEnd" }>] as const));
  }

  /** Requests, plan decisions and worktree applies of a work since a time, newest first (project "기록"). */
  workItems(workId: string, since: number, limit: number): { sessionId: string; item: TranscriptItem }[] {
    return this.db
      .prepare(
        `SELECT i.session_id, i.json FROM items i JOIN sessions s ON s.id = i.session_id
          WHERE s.work_id = ?
            AND (json_extract(i.json, '$.kind') IN ('user', 'approval') OR (json_extract(i.json, '$.kind') = 'notice' AND i.item_id LIKE 'worktree-applied:%'))
            AND json_extract(i.json, '$.at') >= ?
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
          WHERE a.work_id = ? AND json_extract(a.json, '$.removed') IS NULL AND json_extract(r.json, '$.at') >= ?
          ORDER BY json_extract(r.json, '$.at') DESC LIMIT ?`,
      )
      .all(workId, since, limit)
      .map((row) => JSON.parse(String(row.json)) as ArtifactRevision);
  }

  /** Document revisions in `[since, until)` (home "흐름"). */
  revisionMarks(since: number, until = Number.MAX_SAFE_INTEGER): TimelineRevision[] {
    return this.db
      .prepare(
        `SELECT r.artifact_id, a.work_id, r.revision, json_extract(r.json, '$.at') AS at, json_extract(r.json, '$.author') AS author
           FROM revisions r JOIN artifacts a ON a.id = r.artifact_id
          WHERE json_extract(a.json, '$.removed') IS NULL AND json_extract(r.json, '$.at') >= ? AND json_extract(r.json, '$.at') < ?`,
      )
      .all(since, until)
      .map((row) => ({
        artifactId: String(row.artifact_id),
        workId: String(row.work_id),
        revision: Number(row.revision),
        at: Number(row.at),
        author: row.author === "engine" ? "engine" : row.author === "external" ? "external" : "user",
      }));
  }

  /**
   * 활동 › 기록: each source's newest rows older than the cursor (history.ts merges them). Only projects that
   * still exist (a deleted project's kept documents wait in 보관함, not here). `filter` narrows in SQL, so a
   * page of 문제 is a page of problems.
   */
  historySources(query: HistoryQuery): { sources: HistorySource[]; applied: (artifactIds: string[]) => Set<string> } {
    const { before, limit, workId, filter } = query;
    const at = before?.at ?? Number.MAX_SAFE_INTEGER;
    const id = before?.id ?? "￿";
    const work = workId ?? null;
    const source = <T>(rows: T[], key: (row: T) => HistoryCursor, map: (row: T) => HistoryEvent | null): HistorySource => ({
      events: rows.map(map).filter((event): event is HistoryEvent => Boolean(event)),
      last: rows.length >= limit ? key(rows.at(-1)!) : null,
    });
    const sources: HistorySource[] = [];
    // Transcript items: requests, turn ends, approvals and questions; one source per kind, each read newest
    // first along the index items_kind_at (a page reads about `limit` rows of each kind, not the whole table).
    const kinds: Record<"user" | "turnEnd" | "approval", string | null> = filter === "attention" ? { user: null, turnEnd: null, approval: "AND json_extract(i.json, '$.decision') IS NULL AND json_extract(s.json, '$.status') = 'awaitingApproval'" }
      : filter === "done" ? { user: null, turnEnd: "AND json_extract(i.json, '$.status') = 'completed'", approval: null }
      : filter === "problem" ? { user: null, turnEnd: "AND json_extract(i.json, '$.status') IN ('failed', 'interrupted')", approval: "AND json_extract(i.json, '$.decision') = 'decline'" }
      : { user: "", turnEnd: "", approval: "" };
    for (const [kind, narrow] of Object.entries(kinds)) {
      if (narrow === null) continue;
      const items = this.db.prepare(
        `SELECT i.session_id AS session_id, s.work_id AS work_id, i.json AS json, json_extract(s.json, '$.provider') AS provider, json_extract(s.json, '$.status') AS status,
                json_extract(i.json, '$.at') AS at, 'item:' || i.session_id || ':' || i.item_id AS key
           FROM items i JOIN sessions s ON s.id = i.session_id JOIN works w ON w.id = s.work_id
          WHERE json_extract(i.json, '$.kind') = ?5 AND json_extract(i.json, '$.at') <= ?1
            AND (json_extract(i.json, '$.at') < ?1 OR 'item:' || i.session_id || ':' || i.item_id < ?2)
            ${narrow} AND (?3 IS NULL OR s.work_id = ?3) AND json_extract(s.json, '$.pageAgent') IS NULL
          ORDER BY json_extract(i.json, '$.at') DESC, key DESC LIMIT ?4`,
      ).all(at, id, work, limit, kind);
      sources.push(source(items, (row) => ({ at: Number(row.at), id: String(row.key) }), (row) => itemEvent({ sessionId: String(row.session_id), workId: String(row.work_id), provider: row.provider === null ? null : String(row.provider), status: row.status === null ? null : String(row.status), item: JSON.parse(String(row.json)) as TranscriptItem })));
    }
    if (filter === "attention" || filter === "problem") return { sources, applied: () => new Set() };
    // Revisions: a document made (1) or revised.
    const revisions = this.db.prepare(
      `SELECT * FROM (
         SELECT r.artifact_id AS artifact_id, a.work_id AS work_id, r.revision AS revision, json_extract(r.json, '$.author') AS author, json_extract(r.json, '$.sessionId') AS session_id,
                json_extract(a.json, '$.name') AS name, json_extract(r.json, '$.at') AS at, 'rev:' || r.artifact_id || ':' || printf('%09d', r.revision) AS key
           FROM revisions r JOIN artifacts a ON a.id = r.artifact_id JOIN works w ON w.id = a.work_id
          WHERE json_extract(a.json, '$.role') IS NULL AND (?3 IS NULL OR a.work_id = ?3))
        WHERE at < ?1 OR (at = ?1 AND key < ?2)
        ORDER BY at DESC, key DESC LIMIT ?4`,
    ).all(at, id, work, limit);
    sources.push(source(revisions, (row) => ({ at: Number(row.at), id: String(row.key) }), (row) => ({
      id: String(row.key), kind: Number(row.revision) === 1 ? "doc-created" : "doc-revised", at: Number(row.at), workId: String(row.work_id),
      sessionId: row.session_id === null ? null : String(row.session_id), artifactId: String(row.artifact_id), itemId: null,
      name: String(row.name), revision: Number(row.revision), author: row.author === "engine" ? "engine" : row.author === "external" ? "external" : "user",
    })));
    // 수정안 applied or discarded (when it was closed).
    const proposals = this.db.prepare(
      `SELECT * FROM (
         SELECT p.id AS proposal_id, p.artifact_id AS artifact_id, a.work_id AS work_id, json_extract(p.json, '$.status') AS status, json_extract(p.json, '$.sessionId') AS session_id,
                json_extract(p.json, '$.appliedRevision') AS revision, json_extract(a.json, '$.name') AS name, json_extract(p.json, '$.updatedAt') AS at, 'prop:' || p.id AS key
           FROM proposals p JOIN artifacts a ON a.id = p.artifact_id JOIN works w ON w.id = a.work_id
          WHERE json_extract(p.json, '$.status') ${filter === "done" ? "= 'applied'" : "IN ('applied', 'discarded')"} AND (?3 IS NULL OR a.work_id = ?3))
        WHERE at < ?1 OR (at = ?1 AND key < ?2)
        ORDER BY at DESC, key DESC LIMIT ?4`,
    ).all(at, id, work, limit);
    sources.push(source(proposals, (row) => ({ at: Number(row.at), id: String(row.key) }), (row) => ({
      id: String(row.key), kind: row.status === "applied" ? "proposal-applied" : "proposal-discarded", at: Number(row.at), workId: String(row.work_id),
      sessionId: row.session_id === null ? null : String(row.session_id), artifactId: String(row.artifact_id), itemId: null, name: String(row.name),
      ...(row.revision === null ? {} : { revision: Number(row.revision) }),
    })));
    const applied = (artifactIds: string[]) => {
      if (!artifactIds.length) return new Set<string>();
      const rows = this.db.prepare(
        `SELECT artifact_id, json_extract(json, '$.appliedRevision') AS revision FROM proposals
          WHERE artifact_id IN (SELECT value FROM json_each(?)) AND json_extract(json, '$.status') = 'applied'`,
      ).all(JSON.stringify(artifactIds));
      return new Set(rows.map((row) => `${String(row.artifact_id)}:${Number(row.revision)}`));
    };
    if (filter === "done") return { sources, applied };
    // Conversations made and archived (a document's or a web tab's AI is part of its document or page).
    const sessions = this.db.prepare(
      `SELECT * FROM (
         SELECT s.id AS session_id, s.work_id AS work_id, json_extract(s.json, '$.provider') AS provider, 'created' AS what, json_extract(s.json, '$.createdAt') AS at, 'conv:' || s.id || ':a' AS key
           FROM sessions s JOIN works w ON w.id = s.work_id
          WHERE json_extract(s.json, '$.documentAgent') IS NULL AND json_extract(s.json, '$.pageAgent') IS NULL AND (?3 IS NULL OR s.work_id = ?3)
         UNION ALL
         SELECT s.id, s.work_id, json_extract(s.json, '$.provider'), 'archived', json_extract(s.json, '$.archivedAt'), 'conv:' || s.id || ':b'
           FROM sessions s JOIN works w ON w.id = s.work_id
          WHERE json_extract(s.json, '$.archivedAt') IS NOT NULL AND json_extract(s.json, '$.documentAgent') IS NULL AND json_extract(s.json, '$.pageAgent') IS NULL AND (?3 IS NULL OR s.work_id = ?3))
        WHERE at < ?1 OR (at = ?1 AND key < ?2)
        ORDER BY at DESC, key DESC LIMIT ?4`,
    ).all(at, id, work, limit);
    sources.push(source(sessions, (row) => ({ at: Number(row.at), id: String(row.key) }), (row) => ({
      id: String(row.key), kind: row.what === "archived" ? "session-archived" : "session-created", at: Number(row.at), workId: String(row.work_id),
      sessionId: String(row.session_id), artifactId: null, itemId: null, provider: row.provider === "claude" || row.provider === "codex" || row.provider === "gemini" ? row.provider : null,
    })));
    // Documents taken out of their project, and the last rename of each (the record keeps only the last).
    const documents = this.db.prepare(
      `SELECT * FROM (
         SELECT a.id AS artifact_id, a.work_id AS work_id, json_extract(a.json, '$.name') AS name, 'removed' AS what, json_extract(a.json, '$.removed.kind') AS removal, NULL AS old,
                json_extract(a.json, '$.removed.at') AS at, 'doc:' || a.id || ':removed' AS key
           FROM artifacts a JOIN works w ON w.id = a.work_id
          WHERE json_extract(a.json, '$.removed.at') IS NOT NULL AND json_extract(a.json, '$.role') IS NULL AND (?3 IS NULL OR a.work_id = ?3)
         UNION ALL
         SELECT a.id, a.work_id, json_extract(a.json, '$.renamed.to'), 'renamed', NULL, json_extract(a.json, '$.renamed.from'),
                json_extract(a.json, '$.renamed.at'), 'doc:' || a.id || ':renamed'
           FROM artifacts a JOIN works w ON w.id = a.work_id
          WHERE json_extract(a.json, '$.renamed.at') IS NOT NULL AND json_extract(a.json, '$.role') IS NULL AND (?3 IS NULL OR a.work_id = ?3))
        WHERE at < ?1 OR (at = ?1 AND key < ?2)
        ORDER BY at DESC, key DESC LIMIT ?4`,
    ).all(at, id, work, limit);
    sources.push(source(documents, (row) => ({ at: Number(row.at), id: String(row.key) }), (row) => ({
      id: String(row.key), kind: row.what === "removed" ? "doc-removed" : "doc-renamed", at: Number(row.at), workId: String(row.work_id),
      sessionId: null, artifactId: String(row.artifact_id), itemId: null, name: basename(String(row.name)),
      ...(row.what === "removed" ? { removal: row.removal === "trash" ? "trash" as const : "unlisted" as const } : { from: basename(String(row.old)) }),
    })));
    return { sources, applied };
  }

  close() {
    this.db.close();
  }

  /**
   * Give free pages back to the file system (0.5.3, G4), when at least COMPACT_RULE's share and size of the file
   * is free. The first time converts the file to auto_vacuum=INCREMENTAL with one VACUUM (a full rewrite in one
   * transaction: a crash in the middle leaves the old file as it was); afterwards an incremental vacuum frees
   * pages without rewriting. Then the WAL is checkpointed so the file really shrinks. Only from the idle
   * maintenance (store-maintenance.ts): never while a turn runs, never on a write path.
   */
  compact(rule: { minFreeBytes: number; minFreeShare: number } = COMPACT_RULE) {
    // Another connection or process holding the lock (a search worker, a backup reading the file): skipped
    // quietly and tried again at the maintenance's next round. No busy wait here (the gateway's event loop would
    // stand still for busy_timeout), no retry loop, never an error to the person.
    return this.noBusyWait(() => {
      this.flushWal();
      const before = this.diskSettings(), free = before.freePages * before.pageSize, size = before.pageCount * before.pageSize;
      if (free < rule.minFreeBytes || free < size * rule.minFreeShare) return { compacted: false, busy: false, freeBytes: free, sizeBytes: size };
      try {
        if (before.autoVacuum !== 2) { this.db.exec("PRAGMA auto_vacuum = INCREMENTAL"); this.db.exec("VACUUM"); }
        else this.db.prepare("PRAGMA incremental_vacuum").all();
      } catch (error) {
        if (busyError(error)) return { compacted: false, busy: true, freeBytes: free, sizeBytes: size };
        throw error;
      }
      // A reader still on old pages keeps the WAL for now; the file shrinks at a later checkpoint.
      this.flushWal();
      const after = this.diskSettings();
      return { compacted: true, busy: false, freeBytes: free, sizeBytes: size, sizeAfterBytes: after.pageCount * after.pageSize };
    });
  }

  /** Run upkeep without waiting on another connection's lock (busy is reported at once); normal writes wait 3 s again after. */
  noBusyWait<T>(run: () => T): T {
    this.db.exec("PRAGMA busy_timeout = 0");
    try { return run(); } finally { this.db.exec("PRAGMA busy_timeout = 3000"); }
  }

  /** Copy the WAL into the file and truncate it (so a VACUUM's result shows in the file's size). */
  flushWal() {
    // With a reader or writer elsewhere, SQLite reports busy in the result (or throws SQLITE_BUSY): nothing to do.
    try { this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all(); } catch (error) { if (!busyError(error)) throw error; }
  }

  /** How the file is kept (journal, sync, vacuum mode, pages); for the maintenance and its tests. */
  diskSettings() {
    const one = (pragma: string) => Object.values(this.db.prepare(`PRAGMA ${pragma}`).get() ?? {})[0];
    return {
      journalMode: String(one("journal_mode")), synchronous: Number(one("synchronous")), autoVacuum: Number(one("auto_vacuum")),
      pageSize: Number(one("page_size")), pageCount: Number(one("page_count")), freePages: Number(one("freelist_count")),
    };
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

  workspaces(): Workspace[] {
    return this.all<Workspace>("SELECT json FROM workspaces");
  }

  saveWorkspace(workspace: Workspace) {
    this.db.prepare("INSERT OR REPLACE INTO workspaces (id, work_id, json) VALUES (?, ?, ?)").run(workspace.id, workspace.workId, JSON.stringify(workspace));
  }

  worktreeCreations(): WorktreeCreation[] { return this.all<WorktreeCreation>("SELECT json FROM worktree_creations ORDER BY rowid DESC"); }
  terminals(): TerminalSession[] { return this.all<TerminalSession>("SELECT json FROM terminals ORDER BY rowid DESC"); }
  preparations(): PreparationJob[] { return this.all<PreparationJob>("SELECT json FROM workspace_preparations ORDER BY rowid DESC"); }
  savePreparation(job: PreparationJob) {
    this.db.prepare("INSERT INTO workspace_preparations (id, workspace_id, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(job.id, job.workspaceId, JSON.stringify(job));
  }
  saveTerminal(terminal: TerminalSession) {
    this.db.prepare("INSERT INTO terminals (id, workspace_id, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(terminal.id, terminal.workspaceId, JSON.stringify(terminal));
  }
  appendTerminalOutput(id: string, start: number, data: Buffer, limit: number) {
    this.db.prepare("INSERT INTO terminal_output (terminal_id, start, end, data) VALUES (?, ?, ?, ?)").run(id, start, start + data.length, data);
    this.db.prepare("DELETE FROM terminal_output WHERE terminal_id=? AND end<=?").run(id, start + data.length - limit);
    return Number(this.db.prepare("SELECT MIN(start) AS first FROM terminal_output WHERE terminal_id=?").get(id)?.first ?? start);
  }
  /** A terminal record and its whole journal (an ended terminal past its retention, terminals.ts prune). */
  deleteTerminal(id: string) {
    this.db.prepare("DELETE FROM terminal_output WHERE terminal_id=?").run(id);
    this.db.prepare("DELETE FROM terminals WHERE id=?").run(id);
  }
  /** Drop a terminal's journal before byte `start` (the row across it keeps its tail), in the caller's transaction. */
  trimTerminalOutput(id: string, start: number) {
    this.db.prepare("DELETE FROM terminal_output WHERE terminal_id=? AND end<=?").run(id, start);
    const across = this.db.prepare("SELECT start, data FROM terminal_output WHERE terminal_id=? AND start<? ORDER BY start LIMIT 1").get(id, start) as { start: number; data: Uint8Array } | undefined;
    if (!across) return;
    this.db.prepare("DELETE FROM terminal_output WHERE terminal_id=? AND start=?").run(id, across.start);
    this.db.prepare("INSERT INTO terminal_output (terminal_id, start, end, data) VALUES (?, ?, ?, ?)").run(id, start, Number(across.start) + across.data.length, Buffer.from(across.data).subarray(start - Number(across.start)));
  }
  readTerminalOutput(id: string, cursor: number): { start: number; end: number; data: Uint8Array }[] {
    return this.db.prepare("SELECT start,end,data FROM terminal_output WHERE terminal_id=? AND end>? ORDER BY start LIMIT 16").all(id, cursor) as unknown as { start: number; end: number; data: Uint8Array }[];
  }
  saveWorktreeCreation(job: WorktreeCreation) {
    this.db.prepare("INSERT INTO worktree_creations (id, work_id, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(job.id, job.workId, JSON.stringify(job));
  }

  /** Additive data migrations commit together or leave all original rows intact. Inside another transaction: part of it. */
  transaction<T>(run: () => T): T {
    if (this.db.isTransaction) return run();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveFolder(folder: Folder) {
    this.db.prepare("INSERT OR REPLACE INTO folders (id, json) VALUES (?, ?)").run(folder.id, JSON.stringify(folder));
  }

  deleteFolder(id: string) {
    this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
  }

  /** Remove app records only. Project files and the engines' own archives stay on disk. */
  /** `keep`: documents that outlive the project (trashed ones waiting in 보관함), with their revisions. */
  deleteWork(id: string, keep: ReadonlySet<string> = new Set()) {
    const sessionIds = new Set(this.sessions().filter(session => session.workId === id).map(session => session.id));
    this.transaction(() => {
      this.search.removeWork(id);
      for (const table of ["items", "requests"]) this.db.prepare(`DELETE FROM ${table} WHERE session_id IN (SELECT id FROM sessions WHERE work_id = ?)`).run(id);
      const kept = JSON.stringify([...keep]);
      this.db.prepare("DELETE FROM proposals WHERE artifact_id IN (SELECT id FROM artifacts WHERE work_id = ?)").run(id);
      this.db.prepare("DELETE FROM revisions WHERE artifact_id IN (SELECT id FROM artifacts WHERE work_id = ? AND id NOT IN (SELECT value FROM json_each(?)))").run(id, kept);
      this.db.prepare("DELETE FROM terminal_output WHERE terminal_id IN (SELECT id FROM terminals WHERE workspace_id IN (SELECT id FROM workspaces WHERE work_id = ?))").run(id);
      for (const table of ["terminals", "workspace_preparations"]) this.db.prepare(`DELETE FROM ${table} WHERE workspace_id IN (SELECT id FROM workspaces WHERE work_id = ?)`).run(id);
      for (const handoff of this.handoffs()) if (sessionIds.has(handoff.sourceSessionId) || sessionIds.has(handoff.targetSessionId)) this.db.prepare("DELETE FROM handoffs WHERE id = ?").run(handoff.id);
      for (const link of this.links()) if (link.participants.some(sessionId => sessionIds.has(sessionId))) this.db.prepare("DELETE FROM links WHERE id = ?").run(link.id);
      for (const table of ["sessions", "worktree_creations", "workspaces"]) this.db.prepare(`DELETE FROM ${table} WHERE work_id = ?`).run(id);
      this.db.prepare("DELETE FROM artifacts WHERE work_id = ? AND id NOT IN (SELECT value FROM json_each(?))").run(id, kept);
      this.db.prepare("DELETE FROM works WHERE id = ?").run(id);
      for (const [key, removed] of [["project.notes", new Set([id])], ["project.told", sessionIds]] as const) {
        const raw = this.getMeta(key);
        if (raw) {
          const values = JSON.parse(raw) as Record<string, unknown>;
          for (const key of removed) delete values[key];
          this.setMeta(key, JSON.stringify(values));
        }
      }
      const entries = this.getMeta("project.entries");
      if (entries) this.setMeta("project.entries", JSON.stringify((JSON.parse(entries) as { workId: string }[]).filter(entry => entry.workId !== id)));
    });
  }

  saveWork(work: Work) {
    this.db.prepare("INSERT OR REPLACE INTO works (id, json) VALUES (?, ?)").run(work.id, JSON.stringify(work));
    this.indexSafely(() => this.search.put(workEntry(work, this.workExtras?.(work.id) ?? null)));
  }

  saveSession(session: Session) {
    this.db
      .prepare("INSERT OR REPLACE INTO sessions (id, work_id, json) VALUES (?, ?, ?)")
      .run(session.id, session.workId, JSON.stringify(session));
    this.indexSafely(() => this.search.put(sessionEntry(session)));
  }

  items(sessionId: string): TranscriptItem[] {
    return this.db
      .prepare("SELECT json FROM items WHERE session_id = ? ORDER BY ord")
      .all(sessionId)
      .map((row) => JSON.parse(String(row.json)) as TranscriptItem);
  }

  /** The person's requests of a session only (titles, B3): no need to read and keep its whole transcript. */
  userItems(sessionId: string): TranscriptItem[] {
    return this.db
      .prepare("SELECT json FROM items WHERE session_id = ? AND json_extract(json, '$.kind') = 'user' ORDER BY ord")
      .all(sessionId)
      .map((row) => JSON.parse(String(row.json)) as TranscriptItem);
  }

  /** Applied to every item before it is stored or indexed (the credential scrubber, credentials/install.ts). */
  itemFilter: ((item: TranscriptItem) => TranscriptItem) | null = null;

  saveItem(sessionId: string, raw: TranscriptItem) {
    const item = this.itemFilter ? this.itemFilter(raw) : raw;
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
    if (item.kind === "user" || item.kind === "assistant" || item.kind === "approval") this.indexSafely(() => this.indexItem(sessionId, item));
  }

  artifacts(): Artifact[] {
    return this.all<Artifact>("SELECT json FROM artifacts");
  }

  /**
   * saveArtifact with this one commit synced to disk before it returns (synchronous=FULL for it; the
   * database otherwise runs NORMAL, which a power cut can undo): a rename's journal, written before
   * the file moves, must outlive the move.
   */
  saveArtifactDurably(artifact: Artifact) {
    this.db.exec("PRAGMA synchronous = FULL");
    try { this.saveArtifact(artifact); } finally { this.db.exec("PRAGMA synchronous = NORMAL"); }
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

  /** `origin`: who sent it when it was not typed at this PC (a paired messenger chat). */
  saveRequest(requestId: string, sessionId: string, textHash: string, origin: RequestOrigin | null = null) {
    this.db
      .prepare("INSERT INTO requests (request_id, session_id, text_hash, created_at, origin) VALUES (?, ?, ?, ?, ?)")
      .run(requestId, sessionId, textHash, Date.now(), origin ? JSON.stringify(origin) : null);
  }

  /** Who sent a request, when it came from a paired messenger chat (null: typed at this PC, or unknown). */
  requestOrigin(requestId: string): RequestOrigin | null {
    const raw = this.db.prepare("SELECT origin FROM requests WHERE request_id = ?").get(requestId)?.origin;
    if (typeof raw !== "string") return null;
    try {
      const origin: unknown = JSON.parse(raw);
      return isRequestOrigin(origin) ? origin : null;
    } catch {
      return null;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? String(row.value) : null;
  }

  insertHubDelivery(entry: HubJournalEntry): boolean {
    const d = entry.delivery;
    return Number(this.db.prepare("INSERT OR IGNORE INTO hub_deliveries (id,connector_id,delivery_id,workflow_id,payload_hash,state,created_at,json) VALUES (?,?,?,?,?,?,?,?)")
      .run(d.id,d.connectorId,d.deliveryId,d.workflowId,d.payloadHash,d.state,d.createdAt,JSON.stringify(entry)).changes) > 0;
  }
  updateHubDelivery(entry: HubJournalEntry): void {
    this.db.prepare("UPDATE hub_deliveries SET state=?,json=? WHERE id=?").run(entry.delivery.state,JSON.stringify(entry),entry.delivery.id);
  }
  hubDelivery(id: string): HubJournalEntry | null {
    const row = this.db.prepare("SELECT json FROM hub_deliveries WHERE id=?").get(id);
    return row ? JSON.parse(String(row.json)) as HubJournalEntry : null;
  }
  hubDuplicate(connectorId: string, deliveryId: string, payloadHash: string, workflowId: string): HubJournalEntry | null {
    const row = this.db.prepare("SELECT json FROM hub_deliveries WHERE connector_id=? AND workflow_id=? AND (delivery_id=? OR payload_hash=?) LIMIT 1")
      .get(connectorId,workflowId,deliveryId,payloadHash);
    return row ? JSON.parse(String(row.json)) as HubJournalEntry : null;
  }
  hubDeliveries(activeOnly = false): HubJournalEntry[] {
    return this.all<HubJournalEntry>(activeOnly
      ? "SELECT json FROM hub_deliveries WHERE state IN ('received','accepted','running','waiting_input','outcome_unknown') ORDER BY created_at DESC LIMIT 500"
      : "SELECT json FROM hub_deliveries ORDER BY created_at DESC LIMIT 200");
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  metaEntries(prefix: string): { key: string; value: string }[] {
    return this.db.prepare("SELECT key, value FROM meta WHERE substr(key, 1, ?) = ? ORDER BY key").all(prefix.length, prefix)
      .map((row) => ({ key: String(row.key), value: String(row.value) }));
  }

  private all<T>(sql: string): T[] {
    return this.db
      .prepare(sql)
      .all()
      .map((row) => JSON.parse(String(row.json)) as T);
  }
}
