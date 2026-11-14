import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ChannelKind } from "@workbench/contracts";
import { redact } from "./redact.ts";
import { cutAt, parseCommand } from "./shape.ts";

// The channel's own tables, in the gateway's database beside the existing ones. All of them are
// new tables an older gateway never reads; nothing existing is rewritten.

/** A paired chat: one person in one direct chat of one bot. */
export type Binding = {
  id: string;
  kind: ChannelKind;
  botId: string;
  chatId: string;
  userId: string;
  displayName: string;
  handle: string | null;
  createdAt: number;
  /** "연결 끊기" at the PC: the chat is nobody again. */
  revokedAt: number | null;
  /** "멈춤" at the PC. */
  pausedAt: number | null;
  /** "잠금" from the chat; undone only at the PC. */
  lockedAt: number | null;
  /** The conversation plain text goes to ("지금 대화"); the desktop's own current conversation is another thing. */
  pointerWorkId: string | null;
  pointerSessionId: string | null;
  prefs: Record<string, unknown>;
};

/** `undeliverable`: the messenger refused it for good, or it failed too often; never tried again. */
export type OutboxState = "pending" | "sending" | "sent" | "unknown" | "undeliverable";
export type OutboxRow = { key: string; bindingId: string; state: OutboxState; messageId: string | null; sessionId: string | null; requestId: string | null; createdAt: number; updatedAt: number; toldAt: number | null };

export type ButtonRow = {
  token: string; bindingId: string; chatId: string; userId: string; sessionId: string | null; itemId: string | null;
  kind: string; data: string | null; messageId: string | null; createdAt: number; expiresAt: number; usedAt: number | null;
};

export type AuditEntry = { at: number; bindingId: string | null; kind: ChannelKind; action: string; sessionId?: string | null; requestId?: string | null; target?: string | null; result?: string | null };
export type AuditRow = Required<AuditEntry> & { id: number };

const AUDIT_KEEP = 20_000;

type Row = Record<string, unknown>;
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const number = (value: unknown) => (value === null || value === undefined ? null : Number(value));

/**
 * The message a phone sends when it opens the PC's pairing link carries the one-time value
 * (`/start <value>`). The value is used from memory when the message arrives and is never written:
 * the record keeps the bare command. It is found the way the core reads it (`parseCommand`), so
 * any text the core would take as a pairing value is one this takes out. (A deleted row's bytes
 * can linger in the database file, so "forgotten when handled" is not enough for it.)
 */
function withoutPairingValue(payload: string): string {
  let event: unknown;
  try { event = JSON.parse(payload); } catch { return payload; }
  if (!event || typeof event !== "object") return payload;
  const message = event as { type?: unknown; text?: unknown };
  if (message.type !== "message" || typeof message.text !== "string") return payload;
  const command = parseCommand(message.text);
  if (command?.command !== "start" || !command.value) return payload;
  return JSON.stringify({ ...message, text: "/start" });
}

export class ChannelStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_bindings (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, bot_id TEXT NOT NULL, chat_id TEXT NOT NULL, user_id TEXT NOT NULL,
        display_name TEXT NOT NULL, handle TEXT, created_at INTEGER NOT NULL,
        revoked_at INTEGER, paused_at INTEGER, locked_at INTEGER,
        pointer_work_id TEXT, pointer_session_id TEXT, prefs TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS channel_inbox (
        kind TEXT NOT NULL, bot_id TEXT NOT NULL, event_id TEXT NOT NULL,
        received_at INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT,
        PRIMARY KEY (kind, bot_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS channel_outbox (
        key TEXT PRIMARY KEY, binding_id TEXT NOT NULL, state TEXT NOT NULL, message_id TEXT,
        session_id TEXT, request_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, told_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS channel_outbox_state ON channel_outbox(binding_id, state);
      CREATE TABLE IF NOT EXISTS channel_buttons (
        token TEXT PRIMARY KEY, binding_id TEXT NOT NULL, chat_id TEXT NOT NULL, user_id TEXT NOT NULL,
        session_id TEXT, item_id TEXT, kind TEXT NOT NULL, data TEXT, message_id TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS channel_audit (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, binding_id TEXT, kind TEXT NOT NULL, action TEXT NOT NULL,
        session_id TEXT, request_id TEXT, target TEXT, result TEXT
      );
      CREATE INDEX IF NOT EXISTS channel_audit_at ON channel_audit(at DESC);
    `);
  }

  private transaction<T>(run: () => T): T {
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

  // Paired chats

  private toBinding(row: Row): Binding {
    return {
      id: String(row.id), kind: row.kind as ChannelKind, botId: String(row.bot_id), chatId: String(row.chat_id), userId: String(row.user_id),
      displayName: String(row.display_name), handle: text(row.handle), createdAt: Number(row.created_at),
      revokedAt: number(row.revoked_at), pausedAt: number(row.paused_at), lockedAt: number(row.locked_at),
      pointerWorkId: text(row.pointer_work_id), pointerSessionId: text(row.pointer_session_id),
      prefs: JSON.parse(String(row.prefs ?? "{}")) as Record<string, unknown>,
    };
  }

  addBinding(input: Pick<Binding, "kind" | "botId" | "chatId" | "userId" | "displayName"> & { handle?: string | null; createdAt?: number }): Binding {
    const id = randomUUID();
    this.db.prepare("INSERT INTO channel_bindings (id, kind, bot_id, chat_id, user_id, display_name, handle, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.kind, input.botId, input.chatId, input.userId, input.displayName, input.handle ?? null, input.createdAt ?? Date.now());
    return this.binding(id)!;
  }

  binding(id: string): Binding | null {
    const row = this.db.prepare("SELECT * FROM channel_bindings WHERE id = ?").get(id);
    return row ? this.toBinding(row) : null;
  }

  /** Every binding ever made, oldest first (revoked ones stay for the record). */
  bindings(): Binding[] {
    return this.db.prepare("SELECT * FROM channel_bindings ORDER BY rowid").all().map((row) => this.toBinding(row));
  }

  /** The live binding of exactly this person in exactly this chat of this bot; anyone else is nobody. */
  activeBinding(kind: ChannelKind, botId: string, chatId: string, userId: string): Binding | null {
    const row = this.db.prepare("SELECT * FROM channel_bindings WHERE kind = ? AND bot_id = ? AND chat_id = ? AND user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1").get(kind, botId, chatId, userId);
    return row ? this.toBinding(row) : null;
  }

  updateBinding(id: string, patch: Partial<Pick<Binding, "displayName" | "handle" | "revokedAt" | "pausedAt" | "lockedAt" | "pointerWorkId" | "pointerSessionId" | "prefs">>): Binding {
    const columns: Record<string, string> = { displayName: "display_name", handle: "handle", revokedAt: "revoked_at", pausedAt: "paused_at", lockedAt: "locked_at", pointerWorkId: "pointer_work_id", pointerSessionId: "pointer_session_id", prefs: "prefs" };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || !columns[key]) continue;
      this.db.prepare(`UPDATE channel_bindings SET ${columns[key]} = ? WHERE id = ?`).run(key === "prefs" ? JSON.stringify(value) : (value as string | number | null), id);
    }
    const binding = this.binding(id);
    if (!binding) throw new Error("channel binding not found");
    return binding;
  }

  // Inbox: what the messenger delivered. An event is recorded once, however often it is delivered.

  private offsetKey(kind: ChannelKind, botId: string) { return `channel.offset:${kind}:${botId}`; }

  /** Where to ask the messenger to continue from (Telegram: the update id after the last one recorded). */
  offset(kind: ChannelKind, botId: string): string | null {
    return text(this.db.prepare("SELECT value FROM meta WHERE key = ?").get(this.offsetKey(kind, botId))?.value);
  }

  /**
   * Record a batch and where to continue from, together or not at all. Returns the ids that were
   * new. The message itself is kept only until it is handled (`done`).
   */
  record(kind: ChannelKind, botId: string, events: { eventId: string; payload: string }[], nextOffset?: string): string[] {
    return this.transaction(() => {
      const fresh: string[] = [];
      const insert = this.db.prepare("INSERT OR IGNORE INTO channel_inbox (kind, bot_id, event_id, received_at, state, payload) VALUES (?, ?, ?, ?, 'received', ?)");
      for (const event of events) {
        if (typeof event.payload !== "string") throw new Error("channel event has no payload");
        if (Number(insert.run(kind, botId, event.eventId, Date.now(), withoutPairingValue(event.payload)).changes) > 0) fresh.push(event.eventId);
      }
      if (nextOffset !== undefined) this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(this.offsetKey(kind, botId), nextOffset);
      return fresh;
    });
  }

  /** Received and not handled yet, in the order received. */
  pending(kind: ChannelKind, botId: string): { eventId: string; payload: string }[] {
    return this.db.prepare("SELECT event_id, payload FROM channel_inbox WHERE kind = ? AND bot_id = ? AND state = 'received' AND payload IS NOT NULL ORDER BY rowid").all(kind, botId)
      .map((row) => ({ eventId: String(row.event_id), payload: String(row.payload) }));
  }

  seen(kind: ChannelKind, botId: string, eventId: string): "received" | "parked" | "done" | null {
    const state = this.db.prepare("SELECT state FROM channel_inbox WHERE kind = ? AND bot_id = ? AND event_id = ?").get(kind, botId, eventId)?.state;
    return state === "received" || state === "parked" || state === "done" ? state : null;
  }

  /**
   * A message that could not go where it was meant to (its conversation is archived) and waits for
   * the person to say where else: kept, and not handled again by itself after a restart.
   */
  park(kind: ChannelKind, botId: string, eventId: string) {
    this.db.prepare("UPDATE channel_inbox SET state = 'parked' WHERE kind = ? AND bot_id = ? AND event_id = ? AND state = 'received'").run(kind, botId, eventId);
  }

  parked(kind: ChannelKind, botId: string, eventId: string): string | null {
    return text(this.db.prepare("SELECT payload FROM channel_inbox WHERE kind = ? AND bot_id = ? AND event_id = ? AND state = 'parked'").get(kind, botId, eventId)?.payload);
  }

  /** Handled: the id stays (a later delivery of the same event does nothing), the message goes. */
  done(kind: ChannelKind, botId: string, eventId: string) {
    this.db.prepare("UPDATE channel_inbox SET state = 'done', payload = NULL WHERE kind = ? AND bot_id = ? AND event_id = ?").run(kind, botId, eventId);
  }

  /** Handled events older than the messenger could deliver again; parked messages nobody came back to within a day lose their text. */
  pruneInbox(before: number, parkedBefore: number) {
    this.db.prepare("DELETE FROM channel_inbox WHERE state = 'done' AND received_at < ?").run(before);
    this.db.prepare("UPDATE channel_inbox SET state = 'done', payload = NULL WHERE state = 'parked' AND received_at < ?").run(parkedBefore);
  }

  // Outbox: one message per key, sent once.

  private toOutbox(row: Row): OutboxRow {
    return { key: String(row.key), bindingId: String(row.binding_id), state: row.state as OutboxState, messageId: text(row.message_id), sessionId: text(row.session_id), requestId: text(row.request_id), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), toldAt: number(row.told_at) };
  }

  /** Note that a message is owed under this key. False when the key is already there. */
  owe(key: string, owner: { bindingId: string; sessionId?: string | null; requestId?: string | null }): boolean {
    const now = Date.now();
    return Number(this.db.prepare("INSERT OR IGNORE INTO channel_outbox (key, binding_id, state, session_id, request_id, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?, ?)")
      .run(key, owner.bindingId, owner.sessionId ?? null, owner.requestId ?? null, now, now).changes) > 0;
  }

  outbox(key: string): OutboxRow | null {
    const row = this.db.prepare("SELECT * FROM channel_outbox WHERE key = ?").get(key);
    return row ? this.toOutbox(row) : null;
  }

  /** Something said another way (inside a message that went): never to be said again under this key. */
  said(key: string, bindingId: string) {
    const now = Date.now();
    this.db.prepare("INSERT OR IGNORE INTO channel_outbox (key, binding_id, state, created_at, updated_at) VALUES (?, ?, 'sent', ?, ?)").run(key, bindingId, now, now);
  }

  /** Take the right to send it now. Only one caller gets it, and only while it is still owed. */
  begin(key: string): boolean {
    return Number(this.db.prepare("UPDATE channel_outbox SET state = 'sending', updated_at = ? WHERE key = ? AND state = 'pending'").run(Date.now(), key).changes) > 0;
  }

  /**
   * How the send ended: `sent`; `pending` when it certainly did not go (it may be tried again);
   * `unknown` when it may have gone (never sent again).
   */
  settle(key: string, state: "sent" | "pending" | "unknown" | "undeliverable", messageId: string | null = null) {
    this.db.prepare("UPDATE channel_outbox SET state = ?, message_id = COALESCE(?, message_id), updated_at = ? WHERE key = ? AND state = 'sending'").run(state, messageId, Date.now(), key);
  }

  /** At start: what was being sent when the gateway stopped may or may not have gone. Not sent again. */
  interrupted(): OutboxRow[] {
    const rows = this.db.prepare("SELECT * FROM channel_outbox WHERE state = 'sending' ORDER BY created_at, key").all().map((row) => this.toOutbox(row));
    this.db.prepare("UPDATE channel_outbox SET state = 'unknown', updated_at = ? WHERE state = 'sending'").run(Date.now());
    return rows.map((row) => ({ ...row, state: "unknown" as const }));
  }

  /** Still owed (never started, or certainly not gone), oldest first. */
  owed(bindingId?: string): OutboxRow[] {
    const rows = bindingId
      ? this.db.prepare("SELECT * FROM channel_outbox WHERE state = 'pending' AND binding_id = ? ORDER BY created_at, key").all(bindingId)
      : this.db.prepare("SELECT * FROM channel_outbox WHERE state = 'pending' ORDER BY created_at, key").all();
    return rows.map((row) => this.toOutbox(row));
  }

  /** May not have arrived, and the person has not been told so yet. */
  untold(bindingId: string): OutboxRow[] {
    return this.db.prepare("SELECT * FROM channel_outbox WHERE state = 'unknown' AND binding_id = ? AND told_at IS NULL ORDER BY created_at, key").all(bindingId).map((row) => this.toOutbox(row));
  }

  told(keys: string[]) {
    const mark = this.db.prepare("UPDATE channel_outbox SET told_at = ? WHERE key = ?");
    for (const key of keys) mark.run(Date.now(), key);
  }

  /**
   * Answers to a chat the messenger refused for good since the last message that did reach it:
   * how many, and when the last one was given up. Null when there are none.
   */
  undeliverable(bindingId: string): { count: number; at: number } | null {
    const row = this.db.prepare(`SELECT COUNT(*) AS count, MAX(updated_at) AS at FROM channel_outbox WHERE binding_id = ? AND state = 'undeliverable' AND key LIKE 'final:%'
      AND updated_at >= COALESCE((SELECT MAX(updated_at) FROM channel_outbox WHERE binding_id = ? AND state = 'sent'), 0)`).get(bindingId, bindingId);
    const count = Number(row?.count ?? 0);
    return count ? { count, at: Number(row!.at) } : null;
  }

  /** Answers to a chat whose arrival is unknown (the messenger did not answer after the request went) since one certainly arrived. */
  unconfirmed(bindingId: string): { count: number; at: number } | null {
    const row = this.db.prepare(`SELECT COUNT(*) AS count, MAX(updated_at) AS at FROM channel_outbox WHERE binding_id = ? AND state = 'unknown' AND key LIKE 'final:%'
      AND updated_at >= COALESCE((SELECT MAX(updated_at) FROM channel_outbox WHERE binding_id = ? AND state = 'sent'), 0)`).get(bindingId, bindingId);
    const count = Number(row?.count ?? 0);
    return count ? { count, at: Number(row!.at) } : null;
  }

  /** Nothing is owed under this key any more (its request was deleted before it ran). */
  dropOwed(key: string): boolean {
    return Number(this.db.prepare("DELETE FROM channel_outbox WHERE key = ? AND state = 'pending'").run(key).changes) > 0;
  }

  /**
   * Old passing remarks go; those never sent go after `staleBefore` already. The record of an
   * answer (`final:`) stays: it is what keeps a request from being answered a second time.
   */
  pruneOutbox(before: number, staleBefore: number) {
    this.db.prepare("DELETE FROM channel_outbox WHERE key NOT LIKE 'final:%' AND updated_at < ?").run(before);
    this.db.prepare("DELETE FROM channel_outbox WHERE state = 'pending' AND key NOT LIKE 'final:%' AND updated_at < ?").run(staleBefore);
  }

  // Buttons: a random token that means nothing by itself; what it does is written here.

  private toButton(row: Row): ButtonRow {
    return { token: String(row.token), bindingId: String(row.binding_id), chatId: String(row.chat_id), userId: String(row.user_id), sessionId: text(row.session_id), itemId: text(row.item_id),
      kind: String(row.kind), data: text(row.data), messageId: text(row.message_id), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), usedAt: number(row.used_at) };
  }

  addButton(button: Omit<ButtonRow, "createdAt" | "usedAt" | "messageId"> & { createdAt?: number; messageId?: string | null }) {
    this.db.prepare("INSERT INTO channel_buttons (token, binding_id, chat_id, user_id, session_id, item_id, kind, data, message_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(button.token, button.bindingId, button.chatId, button.userId, button.sessionId, button.itemId, button.kind, button.data, button.messageId ?? null, button.createdAt ?? Date.now(), button.expiresAt);
  }

  button(token: string): ButtonRow | null {
    const row = this.db.prepare("SELECT * FROM channel_buttons WHERE token = ?").get(token);
    return row ? this.toButton(row) : null;
  }

  setButtonMessage(tokens: string[], messageId: string) {
    const set = this.db.prepare("UPDATE channel_buttons SET message_id = ? WHERE token = ?");
    for (const token of tokens) set.run(messageId, token);
  }

  /** Use a button: true for exactly one press, and only before it expires. */
  useButton(token: string, now: number): boolean {
    return Number(this.db.prepare("UPDATE channel_buttons SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at > ?").run(now, token, now).changes) > 0;
  }

  /** The other live buttons of the same question go with it (허용 pressed: 거절 is over too). */
  retireButtons(bindingId: string, sessionId: string, itemId: string, now: number): ButtonRow[] {
    const live = this.db.prepare("SELECT * FROM channel_buttons WHERE binding_id = ? AND session_id = ? AND item_id = ? AND used_at IS NULL").all(bindingId, sessionId, itemId).map((row) => this.toButton(row));
    this.db.prepare("UPDATE channel_buttons SET used_at = ? WHERE binding_id = ? AND session_id = ? AND item_id = ? AND used_at IS NULL").run(now, bindingId, sessionId, itemId);
    return live.map((row) => ({ ...row, usedAt: now }));
  }

  /** A message shows something new (a menu edited in place): the buttons it showed before are over. */
  retireMessage(bindingId: string, messageId: string, now: number) {
    this.db.prepare("UPDATE channel_buttons SET used_at = ? WHERE binding_id = ? AND message_id = ? AND used_at IS NULL").run(now, bindingId, messageId);
  }

  /** Live buttons of a question, whoever they were sent to (answered at the PC: all of them are over). */
  liveButtons(sessionId: string, itemId: string): ButtonRow[] {
    return this.db.prepare("SELECT * FROM channel_buttons WHERE session_id = ? AND item_id = ? AND used_at IS NULL").all(sessionId, itemId).map((row) => this.toButton(row));
  }

  pruneButtons(before: number) {
    this.db.prepare("DELETE FROM channel_buttons WHERE expires_at < ?").run(before);
  }

  // Audit: what happened, never what was said. Names, targets and results only.

  audit(entry: AuditEntry) {
    const clean = (value: string | null | undefined) => (value === null || value === undefined ? null : cutAt(redact(value), 300));
    const id = this.db.prepare("INSERT INTO channel_audit (at, binding_id, kind, action, session_id, request_id, target, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(entry.at, entry.bindingId, entry.kind, entry.action, entry.sessionId ?? null, entry.requestId ?? null, clean(entry.target), clean(entry.result)).lastInsertRowid;
    if (Number(id) % 500 === 0) this.db.prepare("DELETE FROM channel_audit WHERE id <= ?").run(Number(id) - AUDIT_KEEP);
  }

  private toAudit(row: Row): AuditRow {
    return { id: Number(row.id), at: Number(row.at), bindingId: text(row.binding_id), kind: row.kind as ChannelKind, action: String(row.action), sessionId: text(row.session_id), requestId: text(row.request_id), target: text(row.target), result: text(row.result) };
  }

  /** Newest first. `since` inclusive, `until` exclusive; `before`: rows older than this id (the next page). */
  auditList(filter: { bindingId?: string; since?: number; until?: number; before?: number; limit?: number } = {}): AuditRow[] {
    const where: string[] = [], values: (string | number)[] = [];
    if (filter.bindingId) { where.push("binding_id = ?"); values.push(filter.bindingId); }
    if (filter.since !== undefined) { where.push("at >= ?"); values.push(filter.since); }
    if (filter.until !== undefined) { where.push("at < ?"); values.push(filter.until); }
    if (filter.before !== undefined) { where.push("id < ?"); values.push(filter.before); }
    const limit = Math.max(1, Math.min(500, Math.trunc(filter.limit ?? 200)));
    return this.db.prepare(`SELECT * FROM channel_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${limit}`).all(...values).map((row) => this.toAudit(row));
  }

  /** The latest record of an action about a target (a stranger told once a day, a lockout that began). */
  lastAudit(action: string, target: string): AuditRow | null {
    const row = this.db.prepare("SELECT * FROM channel_audit WHERE action = ? AND target = ? ORDER BY id DESC LIMIT 1").get(action, target);
    return row ? this.toAudit(row) : null;
  }
}
