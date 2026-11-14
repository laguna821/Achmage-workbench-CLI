import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// For tests only: a stand-in for the Telegram Bot API on 127.0.0.1. It speaks the few methods the
// adapter uses, keeps what it was asked, and can misbehave on request (conflict, failures, rate
// limit, a connection cut before or after the work was done). Nothing here contacts Telegram.

type Json = Record<string, unknown>;
export type Call = { method: string; params: Json; at: number; file?: { field: string; name: string; bytes: number; head?: string }; messageId?: number };

const ENTITY_TYPES = new Set(["bold", "italic", "underline", "strikethrough", "spoiler", "code", "pre", "text_link", "blockquote", "expandable_blockquote"]);
const STYLE_TYPES = new Set(["bold", "italic", "underline", "strikethrough", "spoiler"]);
const CODE_TYPES = new Set(["code", "pre"]);

/**
 * Why Telegram would refuse these entities over this text, or null. Written from the Bot API's
 * "Formatting options" rules, kept strict: offsets and lengths in UTF-16 units inside the text,
 * never splitting a surrogate pair, at most 100 entities, a text_link with a web / mail / tg
 * address, and nesting only as allowed (two entities either do not share characters or one holds
 * the other; bold, italic, underline, strike and spoiler may hold or sit in anything but code and
 * pre; everything else holds nothing of its own kind or any other).
 */
export function entityProblem(text: string, entities: unknown): string | null {
  if (!Array.isArray(entities)) return "entities must be an array";
  if (entities.length > 100) return "too many entities";
  const surrogateInside = (at: number) => at > 0 && at < text.length && /[\udc00-\udfff]/.test(text[at]!) && /[\ud800-\udbff]/.test(text[at - 1]!);
  const list = entities as { type?: unknown; offset?: unknown; length?: unknown; url?: unknown }[];
  for (const entity of list) {
    if (typeof entity.type !== "string" || !ENTITY_TYPES.has(entity.type)) return `unsupported entity type ${String(entity.type)}`;
    if (!Number.isInteger(entity.offset) || !Number.isInteger(entity.length) || (entity.offset as number) < 0 || (entity.length as number) < 1) return "entity offset or length is not valid";
    const start = entity.offset as number, end = start + (entity.length as number);
    if (end > text.length) return "entity end is out of the text";
    if (surrogateInside(start) || surrogateInside(end)) return "entity bound splits a character";
    if (entity.type === "text_link" && !(typeof entity.url === "string" && /^(?:https?:\/\/|mailto:|tg:\/\/)\S+$/i.test(entity.url))) return "text_link needs a valid url";
  }
  for (const a of list) for (const b of list) {
    if (a === b) continue;
    const aStart = a.offset as number, aEnd = aStart + (a.length as number), bStart = b.offset as number, bEnd = bStart + (b.length as number);
    if (aEnd <= bStart || bEnd <= aStart) continue;
    const bInA = aStart <= bStart && bEnd <= aEnd;
    if (!bInA && !(bStart <= aStart && aEnd <= bEnd)) return "entities cross each other";
    if (!bInA) continue;
    const outer = String(a.type), inner = String(b.type);
    if (CODE_TYPES.has(outer) || CODE_TYPES.has(inner)) return `${inner} can't be inside ${outer}`;
    if (!STYLE_TYPES.has(outer) && !STYLE_TYPES.has(inner)) return `${inner} can't be inside ${outer}`;
  }
  return null;
}

/** A made-up token in the shape Telegram uses; it was never issued. */
export const FAKE_TOKEN = "7000000001:AAF" + "k".repeat(8) + "-Fake_token-for-loopback-01";

export class FakeTelegram {
  readonly token: string;
  readonly botId: string;
  readonly username = "wb_7k3q9x_bot";
  readonly calls: Call[] = [];
  /** Updates not yet confirmed by an offset past them. */
  private queue: Json[] = [];
  private nextUpdate = 1000;
  private nextMessage = 1;
  private waiters: (() => void)[] = [];
  private server: Server | null = null;
  private readonly files = new Map<string, { path: string; bytes: Buffer; reported?: number }>();
  /** How the next uploads (sendDocument / sendPhoto) answer, first in first out: null goes through; `refuse` 400, `busy` 502, `limit` 429 with retry_after. */
  nextUpload: ("refuse" | "busy" | "limit" | null)[] = [];
  /** Each getUpdates answers 409 while set (another program polls with the same token). */
  conflict = false;
  /** How many of the next getUpdates answer 409 (a poll of our own that overlapped). */
  conflictOnce = 0;
  /** Every call answers 401 while set (the token was revoked). */
  unauthorized = false;
  /** How many of the next getUpdates fail with a 502. */
  failPolls = 0;
  /** The next sendMessage: `refuse` 400, `forbid` 403, `gone` 404, `limit` 429 with retry_after, `busy` 502, `cut-before` / `cut-after` drop the connection before / after doing the work. */
  nextSend: ("refuse" | "forbid" | "gone" | "limit" | "busy" | "cut-before" | "cut-after" | "unchanged")[] = [];
  /** How many of the next sendMessage / editMessageText calls that carry entities are refused as Telegram refuses formatting it cannot parse (400). */
  refuseFormatted = 0;
  /** The retry_after of a 429, in seconds. Not 1, so that a test can tell it from the adapter's own fallback. */
  retryAfter = 7;
  /** How long an empty getUpdates is held open at most. */
  holdMs = 150;
  url = "";
  /** How many of the next deleteMessage calls are refused (a message the bot may not delete). */
  failDelete = 0;
  /** Other bots this stand-in knows (their getMe only): a token of a different bot. */
  readonly others = new Set<string>();

  constructor(token = FAKE_TOKEN) {
    this.token = token;
    this.botId = token.split(":")[0]!;
  }

  async start() {
    this.server = createServer((req, res) => { void this.handle(req, res).catch(() => { res.destroy(); }); });
    await new Promise<void>((done) => this.server!.listen(0, "127.0.0.1", done));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    for (const wake of this.waiters.splice(0)) wake();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }

  // What a test makes happen at the messenger

  private push(update: Json) {
    const stamped = { update_id: this.nextUpdate++, ...update };
    this.queue.push(stamped);
    for (const wake of this.waiters.splice(0)) wake();
    return stamped;
  }

  /** The same update delivered again (its offset was never confirmed). */
  redeliver(update: Json) {
    this.queue.push(update);
    for (const wake of this.waiters.splice(0)) wake();
  }

  private person(userId: number, name = "길동", last = "홍", username = "hong") {
    return { id: userId, is_bot: false, first_name: name, last_name: last, username };
  }

  message(text: string, options: { userId?: number; chatId?: number; chatType?: string; date?: number; extra?: Json } = {}) {
    const userId = options.userId ?? 555, chatId = options.chatId ?? userId;
    return this.push({ message: { message_id: this.nextMessage++, from: this.person(userId), chat: { id: chatId, type: options.chatType ?? "private" }, date: options.date ?? Math.floor(Date.now() / 1000), ...(text ? { text } : {}), ...options.extra } });
  }

  /** The person edits a message they sent (Telegram sends the whole message again, with its id). */
  edit(message: { message_id: number }, text: string, options: { userId?: number; chatId?: number } = {}) {
    const userId = options.userId ?? 555, chatId = options.chatId ?? userId;
    const now = Math.floor(Date.now() / 1000);
    return this.push({ edited_message: { message_id: message.message_id, from: this.person(userId), chat: { id: chatId, type: "private" }, date: now, edit_date: now, text } });
  }

  /** What a Mini App opened from a keyboard button sends back (`Telegram.WebApp.sendData`). */
  webAppData(data: string, options: { userId?: number; chatId?: number } = {}) {
    const userId = options.userId ?? 555, chatId = options.chatId ?? userId;
    return this.push({ message: { message_id: this.nextMessage++, from: this.person(userId), chat: { id: chatId, type: "private" }, date: Math.floor(Date.now() / 1000), web_app_data: { data, button_text: "입력 양식 열기" } } });
  }

  press(data: string, options: { userId?: number; chatId?: number; messageId?: number } = {}) {
    const userId = options.userId ?? 555, chatId = options.chatId ?? userId;
    return this.push({ callback_query: { id: `cb-${this.nextUpdate}`, from: this.person(userId), data, message: { message_id: options.messageId ?? 1, chat: { id: chatId, type: chatId < 0 ? "group" : "private" }, date: Math.floor(Date.now() / 1000) } } });
  }

  addedToGroup(chatId: number, userId = 555) {
    return this.push({ my_chat_member: { chat: { id: chatId, type: "supergroup", title: "모임" }, from: this.person(userId), date: Math.floor(Date.now() / 1000), old_chat_member: { status: "left" }, new_chat_member: { status: "member" } } });
  }

  /** A file at Telegram; `reported`: the size getFile says (a file that turns out larger when fetched). */
  file(fileId: string, path: string, bytes: Buffer, reported?: number) {
    this.files.set(fileId, { path, bytes, ...(reported !== undefined ? { reported } : {}) });
  }

  // What a test reads back

  of(method: string) { return this.calls.filter((call) => call.method === method); }
  /** The message id this stand-in gave a sent message. */
  sentIdOf(call: Call): number { return this.sentIds.get(call) ?? -1; }
  private readonly sentIds = new Map<Call, number>();
  texts(chatId = 555) { return this.of("sendMessage").filter((call) => call.params.chat_id === chatId).map((call) => String(call.params.text)); }
  /** The callback data of a button on the last message carrying one with this label. */
  buttonData(label: string): string {
    return this.button(label).data;
  }
  /** A button with this label as the chat shows it now (an edit replaces a message's keyboard), and the message it sits on. */
  button(label: string): { data: string; messageId: number } {
    const seen = new Set<number>();
    for (const call of [...this.calls].reverse()) {
      if (call.method !== "sendMessage" && call.method !== "editMessageText") continue;
      const messageId = call.method === "sendMessage" ? call.messageId : Number(call.params.message_id);
      if (messageId === undefined || seen.has(messageId)) continue;
      seen.add(messageId);
      const rows = (call.params.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? [];
      const button = rows.flat().find((entry) => entry.text === label);
      if (button) return { data: button.callback_data, messageId };
    }
    throw new Error(`no button labelled ${label}`);
  }
  /** What a message shows now: its last edit, else as sent. */
  shown(messageId: number): string | null {
    for (const call of [...this.calls].reverse()) {
      if (call.method === "editMessageText" && Number(call.params.message_id) === messageId) return String(call.params.text);
      if (call.method === "sendMessage" && call.messageId === messageId) return String(call.params.text);
    }
    return null;
  }
  pending() { return this.queue.length; }

  // The API

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  private reply(res: ServerResponse, status: number, body: Json) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private fail(res: ServerResponse, code: number, description: string, parameters?: Json) {
    this.reply(res, code, { ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) });
  }

  private parse(req: IncomingMessage, raw: Buffer): { params: Json; file?: Call["file"] } {
    const type = req.headers["content-type"] ?? "";
    if (type.startsWith("application/json")) return { params: raw.length ? (JSON.parse(raw.toString("utf8")) as Json) : {} };
    const boundary = /boundary=(.+)$/.exec(type)?.[1];
    if (!boundary) return { params: {} };
    const params: Json = {};
    let file: Call["file"];
    for (const part of raw.toString("latin1").split(`--${boundary}`)) {
      const split = part.indexOf("\r\n\r\n");
      if (split < 0) continue;
      const head = part.slice(0, split), content = part.slice(split + 4).replace(/\r\n$/, "");
      const name = /name="([^"]+)"/.exec(head)?.[1];
      if (!name) continue;
      const filename = /filename="([^"]*)"/.exec(head)?.[1];
      if (filename !== undefined) file = { field: name, name: Buffer.from(filename, "latin1").toString("utf8"), bytes: content.length, head: Buffer.from(content.slice(0, 8), "latin1").toString("hex") };
      else {
        const value = Buffer.from(content, "latin1").toString("utf8");
        params[name] = /^-?\d+$/.test(value) ? Number(value) : value;
      }
    }
    return { params, file };
  }

  /** What a real Bot API would refuse in a text message (its description), or null. A refused message is not kept. */
  private malformed(params: Json): string | null {
    const text = typeof params.text === "string" ? params.text : "";
    if (!text.trim()) return "Bad Request: message text is empty";
    if (text.length > 4096) return "Bad Request: message is too long";
    if (params.parse_mode !== undefined && params.entities !== undefined) return "Bad Request: can't use parse_mode together with entities";
    if (params.entities === undefined) return null;
    if (this.refuseFormatted > 0) {
      this.refuseFormatted -= 1;
      return "Bad Request: can't parse entities: refused by the test";
    }
    const problem = entityProblem(text, params.entities);
    return problem ? `Bad Request: can't parse entities: ${problem}` : null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const download = /^\/file\/bot([^/]+)\/(.+)$/.exec(path);
    if (download) {
      const entry = [...this.files.values()].find((file) => file.path === decodeURIComponent(download[2]!));
      if (download[1] !== this.token || !entry) return this.fail(res, 404, "Not Found");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(entry.bytes.length) });
      return void res.end(entry.bytes);
    }
    const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(path);
    if (!match) return this.fail(res, 404, "Not Found");
    const raw = await this.body(req);
    if (this.others.has(match[1]!) && match[2] === "getMe") return this.reply(res, 200, { ok: true, result: { id: Number(match[1]!.split(":")[0]), is_bot: true, first_name: "다른 봇", username: "another_bot" } });
    if (match[1] !== this.token || this.unauthorized) return this.fail(res, 401, "Unauthorized");
    const method = match[2]!, { params, file } = this.parse(req, raw);
    this.calls.push({ method, params, at: Date.now(), ...(file ? { file } : {}) });
    const ok = (result: unknown) => this.reply(res, 200, { ok: true, result });
    switch (method) {
      case "getMe":
        return ok({ id: Number(this.botId), is_bot: true, first_name: "홍길동의 Workbench", username: this.username });
      case "getUpdates": {
        if (this.conflict || this.conflictOnce > 0) {
          if (this.conflictOnce > 0) this.conflictOnce -= 1;
          return this.fail(res, 409, "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running");
        }
        if (this.failPolls > 0) {
          this.failPolls -= 1;
          return this.fail(res, 502, "Bad Gateway");
        }
        // An offset past an update confirms it: it is never delivered again.
        const offset = typeof params.offset === "number" ? params.offset : null;
        if (offset !== null) this.queue = this.queue.filter((update) => Number(update.update_id) >= offset);
        if (!this.queue.length) {
          await new Promise<void>((done) => {
            const timer = setTimeout(done, Math.min(this.holdMs, Number(params.timeout ?? 0) * 1000));
            this.waiters.push(() => { clearTimeout(timer); done(); });
            req.on("close", () => { clearTimeout(timer); done(); });
          });
        }
        if (res.destroyed || !this.server) return;
        return ok(this.queue.slice(0, 100));
      }
      case "sendMessage": {
        const fault = this.nextSend.shift();
        // A refused message was not taken: it is not among the calls.
        if (fault === "refuse" || fault === "forbid" || fault === "gone" || fault === "limit" || fault === "busy") this.calls.pop();
        if (fault === "refuse") return this.fail(res, 400, "Bad Request: chat not found");
        if (fault === "forbid") return this.fail(res, 403, "Forbidden: bot was blocked by the user");
        if (fault === "gone") return this.fail(res, 404, "Not Found");
        if (fault === "busy") return this.fail(res, 502, "Bad Gateway");
        if (fault === "limit") return this.fail(res, 429, `Too Many Requests: retry after ${this.retryAfter}`, { retry_after: this.retryAfter });
        if (fault === "cut-before") {
          this.calls.pop();
          return void req.socket.destroy();
        }
        const malformed = this.malformed(params);
        if (malformed) {
          this.calls.pop();
          return this.fail(res, 400, malformed);
        }
        const message = { message_id: this.nextMessage++, chat: { id: params.chat_id }, text: params.text };
        this.sentIds.set(this.calls[this.calls.length - 1]!, message.message_id);
        const call = this.calls.at(-1);
        if (call?.method === "sendMessage") call.messageId = message.message_id;
        if (fault === "cut-after") return void req.socket.destroy();
        return ok(message);
      }
      case "editMessageText": {
        if (this.nextSend[0] === "unchanged") {
          this.nextSend.shift();
          return this.fail(res, 400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message");
        }
        const malformed = this.malformed(params);
        if (malformed) {
          this.calls.pop();
          return this.fail(res, 400, malformed);
        }
        return ok({ message_id: params.message_id });
      }
      case "sendDocument":
      case "sendPhoto": {
        const fault = this.nextUpload.shift() ?? null;
        if (fault) this.calls.pop();
        if (fault === "refuse") return this.fail(res, 400, "Bad Request: PHOTO_INVALID_DIMENSIONS");
        if (fault === "busy") return this.fail(res, 502, "Bad Gateway");
        if (fault === "limit") return this.fail(res, 429, `Too Many Requests: retry after ${this.retryAfter}`, { retry_after: this.retryAfter });
        return ok({ message_id: this.nextMessage++, chat: { id: params.chat_id } });
      }
      case "getFile": {
        const entry = this.files.get(String(params.file_id));
        return entry ? ok({ file_id: params.file_id, file_size: entry.reported ?? entry.bytes.length, file_path: entry.path }) : this.fail(res, 400, "Bad Request: invalid file_id");
      }
      case "deleteMessage":
        if (this.failDelete > 0) {
          this.failDelete -= 1;
          return this.fail(res, 400, "Bad Request: message can't be deleted");
        }
        return ok(true);
      case "answerCallbackQuery":
      case "sendChatAction":
      case "leaveChat":
      case "setMyCommands":
      case "setMyDescription":
      case "deleteWebhook":
        return ok(true);
      default:
        return this.fail(res, 404, `Not Found: method ${method}`);
    }
  }
}
