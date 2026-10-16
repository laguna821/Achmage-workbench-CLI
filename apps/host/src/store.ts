import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Folder, Session, TranscriptItem, Work } from "@workbench/contracts";

// Local state only: works, folders, sessions, transcript items and request ids.
// Never place this database in Dropbox (live SQLite must not be synced).

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
    `);
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
      return;
    }
    const next = this.db
      .prepare("SELECT COALESCE(MAX(ord), 0) + 1 AS ord FROM items WHERE session_id = ?")
      .get(sessionId);
    this.db
      .prepare("INSERT INTO items (session_id, item_id, ord, json) VALUES (?, ?, ?, ?)")
      .run(sessionId, item.id, Number(next?.ord ?? 1), JSON.stringify(item));
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
