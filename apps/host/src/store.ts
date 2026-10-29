import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Workspace, WorktreeCreation, TerminalSession } from "@workbench/contracts";
import type { Artifact, ArtifactRevision, Folder, Handoff, Proposal, Session, SessionLink, TimelineRevision, TranscriptItem, Work } from "@workbench/contracts";
import type { TurnMark } from "./timeline.ts";
import { SearchIndex, documentEntry, documentKey, itemEntries, itemKey, sessionEntry, workEntry, type WorkExtras } from "./search-index.ts";

// Local state only: works, folders, sessions, transcript items and request ids.
// Never place this database in Dropbox (live SQLite must not be synced).

/**
 * Bumped when what the search index holds changes; the index is then rebuilt once (search-index.ts).
 * 1: messages and documents in two trigram tables. 2: one ranked index (2-gram and trigram) of
 * requests, replies, plans, attachment names, documents, works, sessions and vault notes.
 */
const SEARCH_VERSION = "2";

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
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
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worktree_creations (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS terminals (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, json TEXT NOT NULL);
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
    `);
    this.search = new SearchIndex(this.db);
    if (this.getMeta("search.version") !== SEARCH_VERSION) this.rebuildSearch();
  }

  /** The search index ("찾는 길"): every request, reply, plan, document, work, session and note. */
  readonly search: SearchIndex;

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

  /** Search is a convenience: a record that cannot be indexed now is indexed again after its next change. */
  private indexSafely(write: () => void) {
    try {
      write();
    } catch {
      // Left out of the index for now; never in the way of saving the record itself.
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
    const latest = this.db.prepare("SELECT json FROM revisions WHERE artifact_id = ? ORDER BY revision DESC LIMIT 1").get(artifactId);
    this.indexSafely(() => {
      const entry = documentEntry(artifact, latest ? (JSON.parse(String(latest.json)) as ArtifactRevision) : null, text);
      if (entry) this.search.put(entry);
      else this.search.remove(`doc:${artifactId}`);
    });
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
          WHERE a.work_id = ? AND json_extract(r.json, '$.at') >= ?
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
          WHERE json_extract(r.json, '$.at') >= ? AND json_extract(r.json, '$.at') < ?`,
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

  workspaces(): Workspace[] {
    return this.all<Workspace>("SELECT json FROM workspaces");
  }

  saveWorkspace(workspace: Workspace) {
    this.db.prepare("INSERT OR REPLACE INTO workspaces (id, work_id, json) VALUES (?, ?, ?)").run(workspace.id, workspace.workId, JSON.stringify(workspace));
  }

  worktreeCreations(): WorktreeCreation[] { return this.all<WorktreeCreation>("SELECT json FROM worktree_creations ORDER BY rowid DESC"); }
  terminals(): TerminalSession[] { return this.all<TerminalSession>("SELECT json FROM terminals ORDER BY rowid DESC"); }
  saveTerminal(terminal: TerminalSession) {
    this.db.prepare("INSERT INTO terminals (id, workspace_id, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(terminal.id, terminal.workspaceId, JSON.stringify(terminal));
  }
  appendTerminalOutput(id: string, start: number, data: Buffer, limit: number) {
    this.db.prepare("INSERT INTO terminal_output (terminal_id, start, end, data) VALUES (?, ?, ?, ?)").run(id, start, start + data.length, data);
    this.db.prepare("DELETE FROM terminal_output WHERE terminal_id=? AND end<=?").run(id, start + data.length - limit);
    return Number(this.db.prepare("SELECT MIN(start) AS first FROM terminal_output WHERE terminal_id=?").get(id)?.first ?? start);
  }
  readTerminalOutput(id: string, cursor: number): { start: number; end: number; data: Uint8Array }[] {
    return this.db.prepare("SELECT start,end,data FROM terminal_output WHERE terminal_id=? AND end>? ORDER BY start LIMIT 16").all(id, cursor) as unknown as { start: number; end: number; data: Uint8Array }[];
  }
  saveWorktreeCreation(job: WorktreeCreation) {
    this.db.prepare("INSERT INTO worktree_creations (id, work_id, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(job.id, job.workId, JSON.stringify(job));
  }

  /** Additive data migrations commit together or leave all original rows intact. */
  transaction<T>(run: () => T): T {
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
    if (item.kind === "user" || item.kind === "assistant" || item.kind === "approval") this.indexSafely(() => this.indexItem(sessionId, item));
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
