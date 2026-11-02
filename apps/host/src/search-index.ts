import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Artifact, ArtifactRevision, SearchKind, SearchScope, Session, TranscriptItem, Work } from "@workbench/contracts";
import { noteTags, parseFrontmatter, splitFrontmatter, type FrontmatterValue } from "./frontmatter.ts";

// A derived raw-text cache and source identities. Fast Find owns matching and ranking in one
// persistent Rust worker. SQLite holds no second full-text index; all original records stay in
// Store/VaultMirror. Changing cache versions only rebuilds these derived tables.

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
  /** Shown title; Fast Find scores title and alias fields using its original tiers. */
  title: string;
  aliases?: string[];
  /** Structured tag field, separate from exact property keys and values. */
  tags?: string[];
  properties?: [string, FrontmatterValue][];
  /** Full unmodified source body. */
  body: string;
  /** The user's own words (a request they typed): ranked a little higher. */
  own?: boolean;
  /** Shown with the hit (a document's revision and author, a plan's decision…). */
  extra?: Record<string, unknown>;
  /** What the row holds, to skip putting it again; computed from the content when absent. */
  sig?: string;
};

/** Metadata for a source identity selected by Fast Find, without loading the body. */
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
};

const sha = (text: string) => createHash("sha1").update(text).digest("base64url");

export type CachedSearchRow = MatchedRow & {
  body: string;
  fields: { title: string; aliases: string[]; tags: string[]; properties: [string, FrontmatterValue][]; pathSegments: string[] };
};

const valueText = (value: FrontmatterValue) => (value ?? []).join(" ");

/** The title field: the title and its aliases, one per line. */
const titleField = (entry: IndexEntry) => [entry.title, ...(entry.aliases ?? [])].filter(Boolean).join("\n");
/** The tags field: tags, then `key value` per property. */
const tagsField = (entry: IndexEntry) => [...(entry.tags ?? []), ...(entry.properties ?? []).map(([key, value]) => `${key} ${valueText(value)}`.trim())].filter(Boolean).join("\n");

export class SearchIndex {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly listeners = new Set<(keys: string[] | null) => void>();

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
      CREATE TABLE IF NOT EXISTS search_cache (
        entry_id INTEGER PRIMARY KEY,
        body TEXT NOT NULL,
        fields TEXT NOT NULL
      );
      DROP TABLE IF EXISTS search_text;
      DROP TABLE IF EXISTS search_words;
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
    const extra = entry.extra && Object.keys(entry.extra).length ? JSON.stringify(entry.extra) : null;
    const fields = [entry.kind, entry.scope, entry.workId ?? null, entry.sessionId ?? null, entry.itemId ?? null, entry.artifactId ?? null, entry.path ?? null, Math.round(entry.at) || 0, entry.own ? 1 : 0, entry.title ?? "", extra] as const;
    const sig = entry.sig ?? sha(JSON.stringify([fields, title, tags, text, entry.properties ?? []]));
    if (existing?.sig === sig) return false;
    this.transaction(() => {
      let id: number;
      if (existing) {
        id = Number(existing.id);
        this.prepare("UPDATE search_entries SET kind = ?, scope = ?, work_id = ?, session_id = ?, item_id = ?, artifact_id = ?, path = ?, at = ?, own = ?, title = ?, extra = ?, sig = ? WHERE id = ?").run(...fields, sig, id);
      } else {
        id = Number(
          this.prepare("INSERT INTO search_entries (kind, scope, work_id, session_id, item_id, artifact_id, path, at, own, title, extra, sig, key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...fields, sig, entry.key).lastInsertRowid,
        );
      }
      // Keep structured metadata and the full source body for the native engine. Never recover
      // YAML keys from the flattened legacy tags column, or append search tokens to raw text.
      this.prepare("INSERT OR REPLACE INTO search_cache (entry_id, body, fields) VALUES (?, ?, ?)").run(id, text, JSON.stringify({
        title: entry.title ?? "", aliases: entry.aliases ?? [], tags: entry.tags ?? [],
        properties: entry.properties ?? [], pathSegments: entry.path?.split(/[\\/]/).filter(Boolean) ?? [],
      }));
    });
    this.changed([entry.key]);
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
    const row = this.prepare("SELECT key FROM search_entries WHERE id = ?").get(id) as { key: string } | undefined;
    this.prepare("DELETE FROM search_cache WHERE entry_id = ?").run(id);
    this.prepare("DELETE FROM search_entries WHERE id = ?").run(id);
    if (row) this.changed([row.key]);
  }

  /** Take out every entry whose key starts with a prefix (a source's, a vault's notes). */
  removePrefix(prefix: string) {
    const rows = this.prepare("SELECT id FROM search_entries WHERE key >= ? AND key < ?").all(prefix, `${prefix}￿`) as { id: number }[];
    if (rows.length) this.transaction(() => rows.forEach((row) => this.drop(Number(row.id))));
    return rows.length;
  }

  removeWork(workId: string) {
    const rows = this.prepare("SELECT id FROM search_entries WHERE work_id = ?").all(workId) as { id: number }[];
    this.transaction(() => rows.forEach(row => this.drop(Number(row.id))));
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
    this.changed([key]);
  }

  /** Everything out (a rebuild). */
  clear() {
    this.transaction(() => {
      this.db.exec("DELETE FROM search_entries");
      this.db.exec("DELETE FROM search_cache");
    });
    this.changed(null);
  }

  /** Notifications are hints to reread committed state, not copies of in-transaction writes.
   * A rolled-back outer transaction therefore cannot leak a speculative body to the worker. */
  private changed(keys: string[] | null) { for (const listener of this.listeners) listener(keys); }
  subscribe(listener: (keys: string[] | null) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** Bounded raw cache pages, or the current values of a changed-key batch. */
  cached(options: { after?: number; limit?: number; keys?: string[] } = {}): CachedSearchRow[] {
    if (options.keys && !options.keys.length) return [];
    const sql = `SELECT e.*, c.body, c.fields FROM search_entries e JOIN search_cache c ON c.entry_id = e.id WHERE ${
      options.keys ? `e.key IN (${options.keys.map(() => "?").join(",")})` : "e.id > ?"
    } ORDER BY e.id LIMIT ?`;
    const args = options.keys ?? [options.after ?? 0];
    const rows = this.db.prepare(sql).all(...args, options.limit ?? 500) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id), key: String(row.key), kind: row.kind as SearchKind, scope: row.scope as MatchedRow["scope"],
      workId: row.work_id === null ? null : String(row.work_id), sessionId: row.session_id === null ? null : String(row.session_id),
      itemId: row.item_id === null ? null : String(row.item_id), artifactId: row.artifact_id === null ? null : String(row.artifact_id),
      path: row.path === null ? null : String(row.path), at: Number(row.at), own: Number(row.own) === 1,
      title: String(row.title), extra: row.extra ? JSON.parse(String(row.extra)) : {},
      body: String(row.body), fields: JSON.parse(String(row.fields)),
    }));
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

  /** Bounded metadata lookups for compact native candidates; never fetch every result's body. */
  rows(keys: string[]): Map<string, MatchedRow> {
    const out = new Map<string, MatchedRow>();
    for (let start = 0; start < keys.length; start += 500) {
      const batch = keys.slice(start, start + 500);
      const rows = this.db.prepare(`SELECT * FROM search_entries WHERE key IN (${batch.map(() => "?").join(",")})`).all(...batch) as Record<string, unknown>[];
      for (const row of rows) out.set(String(row.key), {
        id: Number(row.id), key: String(row.key), kind: row.kind as SearchKind, scope: row.scope as MatchedRow["scope"],
        workId: row.work_id === null ? null : String(row.work_id), sessionId: row.session_id === null ? null : String(row.session_id),
        itemId: row.item_id === null ? null : String(row.item_id), artifactId: row.artifact_id === null ? null : String(row.artifact_id),
        path: row.path === null ? null : String(row.path), at: Number(row.at), own: Number(row.own) === 1,
        title: String(row.title), extra: row.extra ? JSON.parse(String(row.extra)) : {},
      });
    }
    return out;
  }

  /** Selected source text, for previews and legacy callers only. */
  texts(ids: number[]): Map<number, { title: string; tags: string; body: string }> {
    const out = new Map<number, { title: string; tags: string; body: string }>();
    for (let start = 0; start < ids.length; start += 200) {
      const chunk = ids.slice(start, start + 200);
      const rows = this.db.prepare(`SELECT entry_id, body, fields FROM search_cache WHERE entry_id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as { entry_id: number; body: string; fields: string }[];
      for (const row of rows) {
        const fields = JSON.parse(row.fields) as CachedSearchRow["fields"];
        out.set(Number(row.entry_id), { title: [fields.title, ...fields.aliases].join("\n"), tags: tagsField({ ...fields, key: "", kind: "note", scope: "vault", at: 0, body: "" }), body: row.body });
      }
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
