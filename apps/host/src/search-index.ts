import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Artifact, ArtifactRevision, SearchKind, SearchScope, Session, TranscriptItem, Work } from "@workbench/contracts";
import { noteTags, parseFrontmatter, splitFrontmatter, type FrontmatterValue } from "./frontmatter.ts";
import { likePattern, textExpression, wordStream, wordsExpression, type ParsedQuery } from "./search-text.ts";

// The search index: one row per thing that can be found (search_entries), and two FTS5 tables over
// the same rows (search-text.ts says why two). Rows are put and removed by key; putting the same
// content again changes nothing (each row keeps a signature of what it holds).
//
// Where rows come from: the store (requests, replies, plans, attachment names, documents, work and
// session titles; store.ts), the vault mirror (notes; search.ts). The project layer adds decisions,
// open questions and events through `put`/`remove`, or a whole source through `source` (rebuilt
// when its version changes). Keys start with the source's name: `decision:<work>:<n>`.

/** Text kept per row: replies, documents and notes longer than this are searched in their first part. */
export const BODY_LIMIT = 200_000;

/** bm25 column weights: a title or alias ×3, tags and properties ×2, the text ×1. */
const WEIGHTS = "3.0, 2.0, 1.0";

/** One thing the index can find. */
export type IndexEntry = {
  /** Unique and stable; starts with the source's name (`item:`, `doc:`, `work:`, `note:`, `decision:`…). */
  key: string;
  kind: SearchKind;
  scope: Exclude<SearchScope, "all">;
  workId?: string | null;
  sessionId?: string | null;
  itemId?: string | null;
  artifactId?: string | null;
  /** A note's vault-relative path, a document's file. */
  path?: string | null;
  at: number;
  /** Shown, and ranked ×3 together with `aliases`. */
  title: string;
  aliases?: string[];
  /** Ranked ×2 together with property values. */
  tags?: string[];
  properties?: [string, FrontmatterValue][];
  /** Ranked ×1. */
  body: string;
  /** The user's own words (a request they typed): ranked a little higher. */
  own?: boolean;
  /** Shown with the hit (a document's revision and author, a plan's decision…). */
  extra?: Record<string, unknown>;
  /** What the row holds, to skip putting it again; computed from the content when absent. */
  sig?: string;
};

/** A row that matched, with its raw score (bm25: lower is better; 0 when only LIKE matched). */
export type MatchedRow = {
  id: number;
  key: string;
  kind: SearchKind;
  scope: Exclude<SearchScope, "all">;
  workId: string | null;
  sessionId: string | null;
  itemId: string | null;
  artifactId: string | null;
  path: string | null;
  at: number;
  own: boolean;
  title: string;
  extra: Record<string, unknown>;
  rank: number;
};

const sha = (text: string) => createHash("sha1").update(text).digest("base64url");

const valueText = (value: FrontmatterValue) => (value ?? []).join(" ");

/** The title field: the title and its aliases, one per line. */
const titleField = (entry: IndexEntry) => [entry.title, ...(entry.aliases ?? [])].filter(Boolean).join("\n");
/** The tags field: tags, then `key value` per property. */
const tagsField = (entry: IndexEntry) => [...(entry.tags ?? []), ...(entry.properties ?? []).map(([key, value]) => `${key} ${valueText(value)}`.trim())].filter(Boolean).join("\n");

export class SearchIndex {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_entries (
        id INTEGER PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        work_id TEXT,
        session_id TEXT,
        item_id TEXT,
        artifact_id TEXT,
        path TEXT,
        at INTEGER NOT NULL DEFAULT 0,
        own INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        sig TEXT NOT NULL DEFAULT '',
        extra TEXT
      );
      CREATE INDEX IF NOT EXISTS search_entries_session ON search_entries (session_id, at);
      CREATE INDEX IF NOT EXISTS search_entries_work ON search_entries (work_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_text USING fts5(title, tags, body, tokenize = 'trigram');
      CREATE VIRTUAL TABLE IF NOT EXISTS search_words USING fts5(title, tags, body, tokenize = 'unicode61 remove_diacritics 2', content = '', contentless_delete = 1);
    `);
  }

  private prepare(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Run writes as one transaction (a rebuild, a batch of notes); nested calls join the outer one. */
  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Put an entry (replacing the one with its key). False when it already held exactly this. */
  put(entry: IndexEntry): boolean {
    const existing = this.prepare("SELECT id, sig FROM search_entries WHERE key = ?").get(entry.key) as { id: number; sig: string } | undefined;
    // Rows put often with the same content (a session saved on every status change) stop here.
    if (entry.sig !== undefined && existing?.sig === entry.sig) return false;
    const title = titleField(entry);
    const tags = tagsField(entry);
    const text = entry.body ?? "";
    const body = text.length > BODY_LIMIT ? text.slice(0, BODY_LIMIT) : text;
    const extra = entry.extra && Object.keys(entry.extra).length ? JSON.stringify(entry.extra) : null;
    const fields = [entry.kind, entry.scope, entry.workId ?? null, entry.sessionId ?? null, entry.itemId ?? null, entry.artifactId ?? null, entry.path ?? null, Math.round(entry.at) || 0, entry.own ? 1 : 0, entry.title ?? "", extra] as const;
    const sig = entry.sig ?? sha(JSON.stringify([fields, title, tags, body]));
    if (existing?.sig === sig) return false;
    this.transaction(() => {
      let id: number;
      if (existing) {
        id = Number(existing.id);
        this.prepare("DELETE FROM search_text WHERE rowid = ?").run(id);
        this.prepare("DELETE FROM search_words WHERE rowid = ?").run(id);
        this.prepare("UPDATE search_entries SET kind = ?, scope = ?, work_id = ?, session_id = ?, item_id = ?, artifact_id = ?, path = ?, at = ?, own = ?, title = ?, extra = ?, sig = ? WHERE id = ?").run(...fields, sig, id);
      } else {
        id = Number(
          this.prepare("INSERT INTO search_entries (kind, scope, work_id, session_id, item_id, artifact_id, path, at, own, title, extra, sig, key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...fields, sig, entry.key).lastInsertRowid,
        );
      }
      this.prepare("INSERT INTO search_text (rowid, title, tags, body) VALUES (?, ?, ?, ?)").run(id, title, tags, body);
      this.prepare("INSERT INTO search_words (rowid, title, tags, body) VALUES (?, ?, ?, ?)").run(id, wordStream(title), wordStream(tags), wordStream(body));
    });
    return true;
  }

  /** Take an entry out (nothing when there is none). */
  remove(key: string) {
    const existing = this.prepare("SELECT id FROM search_entries WHERE key = ?").get(key) as { id: number } | undefined;
    if (!existing) return false;
    this.transaction(() => this.drop(Number(existing.id)));
    return true;
  }

  private drop(id: number) {
    this.prepare("DELETE FROM search_text WHERE rowid = ?").run(id);
    this.prepare("DELETE FROM search_words WHERE rowid = ?").run(id);
    this.prepare("DELETE FROM search_entries WHERE id = ?").run(id);
  }

  /** Take out every entry whose key starts with a prefix (a source's, a vault's notes). */
  removePrefix(prefix: string) {
    const rows = this.prepare("SELECT id FROM search_entries WHERE key >= ? AND key < ?").all(prefix, `${prefix}￿`) as { id: number }[];
    if (rows.length) this.transaction(() => rows.forEach((row) => this.drop(Number(row.id))));
    return rows.length;
  }

  /** The signature of an entry, or null. */
  signature(key: string): string | null {
    const row = this.prepare("SELECT sig FROM search_entries WHERE key = ?").get(key) as { sig: string } | undefined;
    return row ? String(row.sig) : null;
  }

  /** The kind an entry has now, or null. */
  kindOf(key: string): SearchKind | null {
    const row = this.prepare("SELECT kind FROM search_entries WHERE key = ?").get(key) as { kind: string } | undefined;
    return row ? (String(row.kind) as SearchKind) : null;
  }

  /** Keys and signatures of the entries under a prefix (what the vault sync compares). */
  signatures(prefix: string): Map<string, string> {
    const rows = this.prepare("SELECT key, sig FROM search_entries WHERE key >= ? AND key < ?").all(prefix, `${prefix}￿`) as { key: string; sig: string }[];
    return new Map(rows.map((row) => [String(row.key), String(row.sig)]));
  }

  /** Change the kind of an entry in place (a reply that turned out to be a plan). */
  relabel(key: string, kind: SearchKind) {
    this.prepare("UPDATE search_entries SET kind = ? WHERE key = ?").run(kind, key);
  }

  /** Everything out (a rebuild). */
  clear() {
    this.transaction(() => {
      this.db.exec("DELETE FROM search_entries");
      this.db.exec("DELETE FROM search_text");
      this.db.exec("DELETE FROM search_words");
    });
  }

  /**
   * A source of entries kept by another module (the project layer's decisions, open questions or
   * events): when `version` differs from the one the index holds, its entries (keys `<name>:…`)
   * are dropped and `entries()` is put again; afterwards the module keeps them with put/remove.
   */
  source(name: string, version: string, entries: () => Iterable<IndexEntry>) {
    const metaKey = `search.source.${name}`;
    const row = this.prepare("SELECT value FROM meta WHERE key = ?").get(metaKey) as { value: string } | undefined;
    if (row?.value === version) return false;
    this.transaction(() => {
      this.removePrefix(`${name}:`);
      for (const entry of entries()) {
        if (!entry.key.startsWith(`${name}:`)) throw new Error(`search source ${name}: key ${entry.key} is not under its name`);
        this.put(entry);
      }
      this.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(metaKey, version);
    });
    return true;
  }

  /** Forget which source versions were put (they are all put again; a rebuild). */
  forgetSources() {
    this.db.exec("DELETE FROM meta WHERE key LIKE 'search.source.%'");
  }

  /** Rows matching every part of a query, with their raw bm25 rank (unsorted, unfiltered). */
  match(query: ParsedQuery): MatchedRow[] {
    const words = wordsExpression(query.parts);
    const text = textExpression(query.parts);
    const likes = query.parts.flatMap((part) => (part.like ? [part.like] : []));
    if (!words && !text && !likes.length) return [];
    const tables: string[] = [];
    const where: string[] = [];
    const params: string[] = [];
    const rank: string[] = [];
    if (words) {
      tables.push("search_words");
      where.push("search_words MATCH ?");
      params.push(words);
      rank.push(`bm25(search_words, ${WEIGHTS})`);
    }
    if (text || likes.length) {
      tables.push("search_text");
      if (text) {
        where.push("search_text MATCH ?");
        params.push(text);
        rank.push(`bm25(search_text, ${WEIGHTS})`);
      }
      for (const needle of likes) {
        const pattern = likePattern(needle);
        where.push("(search_text.title LIKE ? ESCAPE '\\' OR search_text.tags LIKE ? ESCAPE '\\' OR search_text.body LIKE ? ESCAPE '\\')");
        params.push(pattern, pattern, pattern);
      }
    }
    const [first, second] = tables;
    const sql = `SELECT e.id, e.key, e.kind, e.scope, e.work_id, e.session_id, e.item_id, e.artifact_id, e.path, e.at, e.own, e.title, e.extra, ${rank.length ? rank.join(" + ") : "0"} AS rank
      FROM ${first}${second ? ` JOIN ${second} ON ${second}.rowid = ${first}.rowid` : ""} JOIN search_entries e ON e.id = ${first}.rowid
      WHERE ${where.join(" AND ")}`;
    let rows: Record<string, unknown>[];
    try {
      rows = this.prepare(sql).all(...params) as Record<string, unknown>[];
    } catch {
      // A query FTS5 cannot read (it should not happen: every token is quoted) finds nothing.
      return [];
    }
    return rows.map((row) => ({
      id: Number(row.id),
      key: String(row.key),
      kind: String(row.kind) as SearchKind,
      scope: String(row.scope) as MatchedRow["scope"],
      workId: row.work_id === null ? null : String(row.work_id),
      sessionId: row.session_id === null ? null : String(row.session_id),
      itemId: row.item_id === null ? null : String(row.item_id),
      artifactId: row.artifact_id === null ? null : String(row.artifact_id),
      path: row.path === null ? null : String(row.path),
      at: Number(row.at),
      own: Number(row.own) === 1,
      title: String(row.title),
      extra: row.extra ? (JSON.parse(String(row.extra)) as Record<string, unknown>) : {},
      rank: Number(row.rank),
    }));
  }

  /** Ids of rows where one of these search_words phrases occurs (the "together, as typed" boost). */
  phraseIds(phrases: string[]): Set<number> {
    if (!phrases.length) return new Set();
    try {
      const rows = this.prepare("SELECT rowid FROM search_words WHERE search_words MATCH ?").all(phrases.join(" OR ")) as { rowid: number }[];
      return new Set(rows.map((row) => Number(row.rowid)));
    } catch {
      return new Set();
    }
  }

  /** The stored text of rows (for snippets). */
  texts(ids: number[]): Map<number, { title: string; tags: string; body: string }> {
    const out = new Map<number, { title: string; tags: string; body: string }>();
    for (let start = 0; start < ids.length; start += 200) {
      const chunk = ids.slice(start, start + 200);
      const rows = this.db.prepare(`SELECT rowid, title, tags, body FROM search_text WHERE rowid IN (${chunk.map(() => "?").join(", ")})`).all(...chunk) as Record<string, unknown>[];
      for (const row of rows) out.set(Number(row.rowid), { title: String(row.title ?? ""), tags: String(row.tags ?? ""), body: String(row.body ?? "") });
    }
    return out;
  }

  /** Rows and stored text size, for the record ("찾는 길" reports the index size). */
  stats() {
    const rows = Number((this.prepare("SELECT COUNT(*) AS count FROM search_entries").get() as { count: number }).count);
    const byKind = Object.fromEntries((this.prepare("SELECT kind, COUNT(*) AS count FROM search_entries GROUP BY kind").all() as { kind: string; count: number }[]).map((row) => [String(row.kind), Number(row.count)]));
    return { rows, byKind };
  }
}

// ── records as entries ─────────────────────────────────────────────────────────────────────

/** Keys of a session's transcript item. */
export const itemKey = (sessionId: string, itemId: string) => `item:${sessionId}:${itemId}`;
export const attachmentKey = (sessionId: string, itemId: string) => `attach:${sessionId}:${itemId}`;

/**
 * What a transcript item puts into the index (null under a key: take that key out). Requests and
 * finished replies, plans waiting for the go-ahead (with their text), and the names of files that
 * went with a request. A request relayed from another session (세션 잇기) is that session's reply
 * and is found there.
 */
export function itemEntries(sessionId: string, workId: string | null, item: TranscriptItem): { key: string; entry: IndexEntry | null }[] {
  const base = { sessionId, workId, itemId: item.id, at: item.at, scope: "session" as const };
  if (item.kind === "user") {
    const relayed = Boolean(item.link?.fromSessionId);
    const entry: IndexEntry | null = relayed || !item.text.trim()
      ? null
      : {
          ...base,
          key: itemKey(sessionId, item.id),
          kind: "user",
          title: "",
          // Documents and vault notes that went with the request, by name.
          tags: [...(item.refs ?? []).map((ref) => ref.name), ...(item.notes ?? []).map((note) => note.title)],
          body: item.text,
          own: !item.peer,
          extra: item.plan ? { plan: true } : undefined,
        };
    const files = item.attachments?.map((file) => file.name).filter(Boolean) ?? [];
    return [
      { key: itemKey(sessionId, item.id), entry },
      {
        key: attachmentKey(sessionId, item.id),
        entry: files.length ? { ...base, key: attachmentKey(sessionId, item.id), kind: "attachment", title: files.join(", "), body: "", own: !item.peer, extra: { request: item.text.slice(0, 200) } } : null,
      },
    ];
  }
  if (item.kind === "assistant") {
    return [{ key: itemKey(sessionId, item.id), entry: !item.streaming && item.text.trim() ? { ...base, key: itemKey(sessionId, item.id), kind: "assistant", title: "", body: item.text } : null }];
  }
  if (item.kind === "approval" && item.plan && item.detail?.trim()) {
    return [{ key: itemKey(sessionId, item.id), entry: { ...base, key: itemKey(sessionId, item.id), kind: "plan", title: "", body: item.detail, extra: { decision: item.decision } } }];
  }
  return [];
}

export const sessionKey = (sessionId: string) => `session:${sessionId}`;

/** A session by its name (the row that finds "과제 채점 기준표" by its title). */
export const sessionEntry = (session: Session): IndexEntry => ({
  key: sessionKey(session.id),
  kind: "session",
  scope: "session",
  workId: session.workId,
  sessionId: session.id,
  at: session.createdAt ?? 0,
  title: session.purpose ?? "",
  body: "",
  sig: `session|${session.workId}|${session.purpose ?? ""}`,
});

export const workKey = (workId: string) => `work:${workId}`;

/** What the project layer adds to a work's entry: aliases, tags and properties of its note, its memo. */
export type WorkExtras = { aliases?: string[]; tags?: string[]; properties?: [string, FrontmatterValue][]; text?: string };

/** A work by its title, aliases, tags and properties (ranked ×3 / ×2 against a body match). */
export function workEntry(work: Work, extras: WorkExtras | null = null): IndexEntry {
  const tags = [...new Set([...(work.tags ?? []), ...(extras?.tags ?? [])])];
  const entry: IndexEntry = {
    key: workKey(work.id),
    kind: "work",
    scope: "project",
    workId: work.id,
    at: work.createdAt ?? 0,
    title: work.title ?? "",
    aliases: extras?.aliases ?? [],
    tags,
    properties: extras?.properties ?? [],
    body: extras?.text ?? "",
  };
  return { ...entry, sig: `work|${sha(JSON.stringify([work.title, entry.aliases, tags, entry.properties, entry.body]))}` };
}

export const documentKey = (artifactId: string) => `doc:${artifactId}`;

/** A Markdown file that is a record of a conversation ("마크다운으로 내보내기", "주고받은 내용"): found in the conversation instead. */
export function isSessionRecord(properties: [string, FrontmatterValue][]) {
  const value = (name: string) => properties.find(([key]) => key.trim().replace(/:$/, "").toLowerCase() === name)?.[1] ?? null;
  return (value("source") ?? []).some((entry) => entry.trim() === "Achmage Workbench") && Boolean(value("session")?.length || value("link")?.length);
}

/**
 * A document's latest revision: its file name (and a Markdown page's title and aliases) ranked
 * like a title, its properties like tags, its text (null: not readable as text yet — then only the
 * name is found). Session records are left out (null).
 */
export function documentEntry(artifact: Artifact, revision: ArtifactRevision | null, text: string | null): IndexEntry | null {
  const title = artifact.name;
  let aliases: string[] = [];
  let tags: string[] = [];
  let properties: [string, FrontmatterValue][] = [];
  let body = text ?? "";
  if (text !== null && (artifact.format === "markdown" || artifact.format === "text")) {
    const { yaml, body: rest } = splitFrontmatter(text);
    const front = parseFrontmatter(yaml);
    if (isSessionRecord(front)) return null;
    const named = (key: string) => front.find(([name]) => name.trim().replace(/:$/, "").toLowerCase() === key)?.[1] ?? [];
    aliases = [...named("title"), ...named("aliases")].map((value) => value.trim()).filter(Boolean);
    tags = noteTags(front, "");
    properties = front.filter(([key]) => !/^(title|aliases|tags)$/i.test(key.trim().replace(/:$/, "")));
    body = rest;
  }
  return {
    key: documentKey(artifact.id),
    kind: "document",
    scope: "document",
    workId: artifact.workId,
    artifactId: artifact.id,
    path: artifact.path,
    at: revision?.at ?? artifact.updatedAt,
    title,
    aliases,
    tags,
    properties,
    body,
    // Who made the latest revision: an engine's session is shown with the document (and its reply joins it).
    extra: { revision: artifact.revision, author: revision?.author ?? null, format: artifact.format, ...(revision?.sessionId ? { revisionSession: revision.sessionId } : {}) },
  };
}

export const noteKey = (path: string) => `note:${path}`;
