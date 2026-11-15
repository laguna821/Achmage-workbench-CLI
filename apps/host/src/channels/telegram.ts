import { createWriteStream, readFileSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError } from "../errors.ts";
import { plain, splitRich } from "./format.ts";
import type { ChannelLog } from "./log.ts";
import { cutAt } from "./shape.ts";
import type { ChannelStore } from "./store.ts";
import { ChannelSendError, type ChannelAdapter, type ChannelStatus, type ChatRef, type InFile, type Inbound, type Mark, type Out, type SendOptions, type Sender } from "./types.ts";
import { COMMAND_LIST } from "./words.ts";

// Telegram by long polling: the PC only makes outbound requests to the Bot API, so no public
// address is needed. The API address is a constructor parameter; tests point it at a stand-in on
// 127.0.0.1 and the real one is the default.
//
// The bot token is part of every request address (and of every file address). No address, and no
// message text, is ever put into an error or a log line here: errors carry the method name, the
// HTTP status and Telegram's own short description.

export const TELEGRAM_API = "https://api.telegram.org";
const TOKEN_SHAPE = /^\d+:[A-Za-z0-9_-]{30,}$/;
const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;
const PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * Whether a picture's shape is one Telegram takes as a photo: width + height at most 10,000 and
 * neither side more than 20 times the other. Read from a PNG's header or a JPEG's frame header;
 * a shape that cannot be read is tried as a photo, as before.
 */
export function photoShape(bytes: Buffer): boolean {
  let width = 0, height = 0;
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("latin1", 12, 16) === "IHDR") {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 9 < bytes.length && bytes[at] === 0xff;) {
      const marker = bytes[at + 1]!;
      // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC): the frame header has the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) { height = bytes.readUInt16BE(at + 5); width = bytes.readUInt16BE(at + 7); break; }
      at += 2 + bytes.readUInt16BE(at + 2);
    }
  }
  if (!width || !height) return true;
  return width + height <= 10_000 && Math.max(width, height) <= 20 * Math.min(width, height);
}
/** A message older than this when it arrives waited at Telegram (the PC was off or asleep). */
const LATE_MS = 2 * 60_000;
/** The longest wait for a 429 sat through inside the send; a longer one is handed back to the core with the wait. */
const LONGEST_WAIT_S = 30;
/** Refusals that will not change by trying again: a malformed message, a blocked bot, a chat that is gone. */
const PERMANENT = new Set([400, 403, 404]);
const CONFLICT = "다른 PC나 프로그램이 이 봇을 쓰고 있습니다. 같은 봇을 두 곳에서 쓸 수 없습니다. 봇 토큰이 새었을 수도 있으니 [토큰 바꾸기]를 눌러 새 토큰을 넣어 주세요.";
const BAD_TOKEN = "텔레그램이 이 봇 토큰을 받지 않습니다. [토큰 바꾸기]를 눌러 새 토큰을 넣어 주세요.";

type Json = Record<string, unknown>;

// Formatting goes as `entities` (offsets and lengths in UTF-16 units over the text as sent), not as
// a `parse_mode` markup: the text that leaves is exactly the text the phone shows, nothing needs
// escaping, and the 4096 limit counts that text alone.
const ENTITY: Record<Mark["type"], string> = { bold: "bold", italic: "italic", strike: "strikethrough", code: "code", pre: "pre", link: "text_link", quote: "blockquote" };
const entities = (marks: Mark[]) => marks.map((mark) => ({
  type: ENTITY[mark.type], offset: mark.offset, length: mark.length,
  ...(mark.type === "link" && mark.url ? { url: mark.url } : {}), ...(mark.type === "pre" && mark.language ? { language: mark.language } : {}),
}));
/** Telegram refused a message that carried formatting (400): the same text goes once more without it. */
const refusedFormatting = (error: unknown) => error instanceof ChannelSendError && error.code === "telegram_400";

/** What the Bot API answered when it refused a call. */
class TelegramRefusal extends Error {
  readonly status: number;
  readonly retryAfter: number | null;
  constructor(method: string, status: number, description: string, retryAfter: number | null) {
    super(cutAt(`${method}: ${status} ${description}`, 300));
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Why a request did not complete: `before` the connection was made (nothing was sent), or at some later point. */
class TelegramUnreached extends Error {
  readonly before: boolean;
  constructor(method: string, before: boolean, code: string) {
    super(`${method}: ${before ? "not connected" : "no answer"} (${code})`);
    this.before = before;
  }
}

const NOT_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT"]);

function failureCode(error: unknown): string {
  for (let at: unknown = error, depth = 0; at && depth < 4; depth += 1) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string") return code;
    const errors = (at as { errors?: unknown[] }).errors;
    if (Array.isArray(errors) && errors.length) {
      const inner = (errors[0] as { code?: unknown }).code;
      if (typeof inner === "string") return inner;
    }
    at = (at as { cause?: unknown }).cause;
  }
  return error instanceof Error && error.name === "AbortError" ? "timeout" : "failed";
}

async function request(baseUrl: string, token: string, method: string, body: { json?: Json; form?: FormData }, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/bot${token}/${method}`, {
      method: "POST",
      ...(body.form ? { body: body.form } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body.json ?? {}) }),
      signal,
    });
  } catch (error) {
    const code = failureCode(error);
    throw new TelegramUnreached(method, NOT_CONNECTED.has(code), code);
  }
  type Answer = { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } };
  // Not the Bot API's own answer (a proxy's error page) is treated by its status alone.
  const parsed = await (response.json() as Promise<Answer>).catch((): Answer => ({}));
  if (response.ok && parsed.ok) return parsed.result;
  throw new TelegramRefusal(method, response.status, parsed.description ?? "no description", typeof parsed.parameters?.retry_after === "number" ? parsed.parameters.retry_after : null);
}

/** Ask the Bot API who a token belongs to (the registration check). The token is not repeated in any refusal. */
export async function identifyTelegram(token: string, baseUrl = TELEGRAM_API): Promise<{ id: string; username: string; name: string }> {
  const invalid = () => new HttpError(400, "channel_token_invalid", "봇 토큰이 맞지 않습니다. BotFather가 보낸 토큰(숫자:문자)을 그대로 붙여 넣어 주세요.");
  const value = token.trim();
  if (!TOKEN_SHAPE.test(value)) throw invalid();
  try {
    const me = (await request(baseUrl, value, "getMe", {}, AbortSignal.timeout(15_000))) as { id?: number; username?: string; first_name?: string };
    if (typeof me.id !== "number" || String(me.id) !== value.split(":")[0]) throw invalid();
    return { id: String(me.id), username: me.username ?? "", name: me.first_name ?? "" };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof TelegramRefusal && (error.status === 401 || error.status === 404)) throw invalid();
    throw new HttpError(502, "channel_unreachable", "텔레그램에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 해 주세요.");
  }
}

/**
 * Text in parts of at most `limit` UTF-16 units (how Telegram counts): cut at a paragraph end, else
 * a line end, else a space, else at the last character end before the limit (`cutAt`).
 */
export function splitText(text: string, limit = TEXT_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let cut = -1;
    for (const mark of ["\n\n", "\n", " "]) {
      const at = window.lastIndexOf(mark, limit);
      if (at >= limit / 4) { cut = at; break; }
    }
    if (cut < 0) cut = cutAt(rest, limit).length;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** A name as anyone may set it, made safe to show: no control or formatting characters (direction overrides, zero-width), one space between words, at most 64 characters. */
const shown = (value: unknown) => typeof value === "string" ? cutAt(value.replace(/[\p{Cc}\p{Cf}]+/gu, "").replace(/\s+/gu, " ").trim(), NAME_LIMIT).trim() : "";
const NAME_LIMIT = 64;

/** Who wrote, as Telegram fills it in. The PC shows the name, the handle and always the number. */
export function senderOf(from: Json): Sender {
  const name = shown([from.first_name, from.last_name].filter((part) => typeof part === "string" && part).join(" "));
  const handle = shown(from.username);
  return { userId: String(from.id), displayName: name || handle || String(from.id), ...(handle ? { handle } : {}) };
}

export type TelegramOptions = {
  botId: string;
  /** The token when it is needed (opened from the sealed store); kept in memory by the adapter while it runs. */
  token: () => string | Promise<string>;
  baseUrl?: string;
  /** Where the offset and the received updates are written, together. */
  journal: Pick<ChannelStore, "offset" | "record">;
  log: ChannelLog;
  /** How long Telegram holds an empty getUpdates open. */
  pollSeconds?: number;
  /** The least time between two messages to one chat (Telegram asks for about one a second). */
  minSendGapMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  onStatus?: () => void;
  /**
   * Asked for every received message before anything is written (the chat's secret input,
   * secret-window.ts): a message it takes is recorded as the event it gives back, never as text.
   */
  divert?: (update: { eventId: string; chat: ChatRef; from: Sender; message: Json; edited: boolean; files?: InFile[] }) => Inbound | null;
  /** Told of every button press before anything after it in the same batch is read (a press may open the secret input). */
  press?: (update: { chat: ChatRef; from: Sender; token: string; messageId?: string }) => void;
};

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((done) => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
});

export class TelegramAdapter implements ChannelAdapter {
  readonly kind = "telegram" as const;
  readonly botId: string;
  readonly limits = { text: TEXT_LIMIT, caption: CAPTION_LIMIT, uploadBytes: 50 * 1024 * 1024, downloadBytes: 20 * 1024 * 1024, minEditGapMs: 15_000 };
  private readonly options: TelegramOptions;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly gap: number;
  private secret: string | null = null;
  private state: ChannelStatus = { state: "stopped", detail: null };
  /** Per chat: the sends in order, and when the last one went. */
  private readonly lanes = new Map<string, { tail: Promise<void>; lastAt: number }>();

  constructor(options: TelegramOptions) {
    this.options = options;
    this.botId = options.botId;
    this.baseUrl = (options.baseUrl ?? TELEGRAM_API).replace(/\/+$/, "");
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.gap = options.minSendGapMs ?? 1_050;
  }

  status() { return this.state; }

  private setStatus(state: ChannelStatus["state"], detail: string | null = null) {
    if (this.state.state === state && this.state.detail === detail) return;
    this.state = { state, detail };
    this.options.onStatus?.();
  }

  private async token() {
    this.secret ??= await this.options.token();
    return this.secret;
  }

  private async call(method: string, params: Json, signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<unknown> {
    return request(this.baseUrl, await this.token(), method, { json: params }, signal);
  }

  // Receiving

  async start(sink: (event: Inbound) => Promise<void>, signal: AbortSignal): Promise<void> {
    const seconds = this.options.pollSeconds ?? 50;
    this.setStatus("retrying", "연결하는 중");
    try {
      await this.token();
    } catch (error) {
      // The sealed token cannot be opened (the OS keyring is locked or gone): nothing to poll with.
      this.options.log.note("token_unavailable", error);
      return this.setStatus("stopped", "보안 저장소에서 봇 토큰을 읽지 못했습니다. 저장소 잠금을 푼 뒤 [다시 연결]을 누르거나, 토큰을 다시 넣어 주세요.");
    }
    // A webhook left on the bot would block polling; what waits at Telegram is kept. The command menu shows the three words.
    await this.call("deleteWebhook", { drop_pending_updates: false }).catch(() => undefined);
    await this.call("setMyCommands", { commands: COMMAND_LIST }).catch(() => undefined);
    let failures = 0, conflicts = 0;
    while (!signal.aborted) {
      try {
        const offset = this.options.journal.offset("telegram", this.botId);
        const updates = (await this.call(
          "getUpdates",
          { timeout: seconds, ...(offset ? { offset: Number(offset) } : {}), allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member"] },
          AbortSignal.any([signal, AbortSignal.timeout((seconds + 15) * 1000)]),
        )) as (Json & { update_id: number })[];
        failures = 0;
        conflicts = 0;
        this.setStatus("connected");
        if (!updates.length) continue;
        const events = this.backlog(updates.flatMap((update) => this.toInbound(update)));
        // Written down with the next offset in one transaction; the next request confirms it at Telegram.
        this.options.journal.record("telegram", this.botId, events.map((event) => ({ eventId: event.eventId, payload: JSON.stringify(event) })), String(Math.max(...updates.map((update) => update.update_id)) + 1));
        for (const event of events) {
          try {
            await sink(event);
          } catch (error) {
            // It stays in the inbox as received and is handled at the next start.
            this.options.log.note("sink_failed", error);
          }
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof TelegramRefusal && error.status === 409) {
          // One overlap can be a poll of our own that was still open; twice in a row is someone else.
          conflicts += 1;
          if (conflicts >= 2) {
            this.options.log.note("poll_conflict");
            return this.setStatus("conflict", CONFLICT);
          }
          await this.sleep(3_000, signal);
          continue;
        }
        if (error instanceof TelegramRefusal && (error.status === 401 || error.status === 404)) {
          this.options.log.note("poll_unauthorized");
          return this.setStatus("stopped", BAD_TOKEN);
        }
        failures += 1;
        this.setStatus("retrying", `다시 연결 중 (${failures}번째)`);
        this.options.log.note("poll_failed", error);
        // 1, 2, 4 … 60 seconds, with jitter, for as long as it takes (a PC that slept comes back this way).
        await this.sleep(Math.min(60_000, Math.round(1_000 * 2 ** Math.min(failures - 1, 6) * (0.75 + this.random() * 0.5))), signal);
      }
    }
    this.setStatus("stopped");
  }

  private sender(from: Json): Sender {
    return senderOf(from);
  }

  private chat(chat: Json): ChatRef {
    const type = chat.type === "private" ? "dm" : chat.type === "channel" ? "channel" : "group";
    return { kind: "telegram", botId: this.botId, chatId: String(chat.id), chatType: type };
  }

  private toInbound(update: Json & { update_id: number }): Inbound[] {
    const eventId = String(update.update_id);
    const message = (update.message ?? update.edited_message) as Json | undefined;
    if (message) {
      const from = message.from as Json | undefined, chat = message.chat as Json | undefined;
      if (!from || !chat || from.is_bot === true) return [];
      const files: InFile[] = [];
      const photos = message.photo as Json[] | undefined;
      if (photos?.length) {
        const largest = photos[photos.length - 1]!;
        files.push({ fileRef: String(largest.file_id), name: `photo-${String(message.message_id)}.jpg`, mime: "image/jpeg", size: Number(largest.file_size ?? 0), kind: "photo" });
      }
      for (const [field, kind, fallback] of [["document", "file", "application/octet-stream"], ["voice", "voice", "audio/ogg"], ["audio", "audio", "audio/mpeg"]] as const) {
        const file = message[field] as Json | undefined;
        if (file) files.push({ fileRef: String(file.file_id), name: String(file.file_name ?? `${field}-${String(message.message_id)}`), mime: String(file.mime_type ?? fallback), size: Number(file.file_size ?? 0), kind });
      }
      // The files go with it so that a caught message is forwarded whole by [그대로 보내기] (fix round 5, Q2).
      const secret = this.options.divert?.({ eventId, chat: this.chat(chat), from: this.sender(from), message, edited: !update.message, files });
      if (secret) return [secret];
      // An edit of a message sent before is not a new request.
      if (!update.message) return [];
      return [{ type: "message", eventId, chat: this.chat(chat), from: this.sender(from), text: String(message.text ?? message.caption ?? ""), files, at: Number(message.date ?? 0) * 1000 }];
    }
    const press = update.callback_query as Json | undefined;
    if (press) {
      const from = press.from as Json | undefined, chat = (press.message as Json | undefined)?.chat as Json | undefined;
      if (!from || !chat || typeof press.data !== "string") return [];
      // The message the pressed button is on: its id (also when the answer to sending it was lost).
      const pressedOn = Number((press.message as Json | undefined)?.message_id);
      const messageId = pressedOn > 0 ? String(pressedOn) : undefined;
      this.options.press?.({ chat: this.chat(chat), from: this.sender(from), token: press.data, ...(messageId ? { messageId } : {}) });
      return [{ type: "button", eventId, chat: this.chat(chat), from: this.sender(from), token: press.data, ackHandle: String(press.id), at: Date.now(), ...(messageId ? { messageId } : {}) }];
    }
    // Added to a group or channel: handed to the core as an empty message there, which it refuses and leaves.
    const member = update.my_chat_member as Json | undefined;
    if (member) {
      const from = member.from as Json | undefined, chat = member.chat as Json | undefined;
      const status = (member.new_chat_member as Json | undefined)?.status;
      if (!from || !chat || chat.type === "private" || (status !== "member" && status !== "administrator")) return [];
      return [{ type: "message", eventId, chat: this.chat(chat), from: this.sender(from), text: "", files: [], at: Number(member.date ?? 0) * 1000 }];
    }
    return [];
  }

  /** Mark, per direct chat, the first message that waited at Telegram with how many waited. */
  private backlog(events: Inbound[]): Inbound[] {
    const now = Date.now();
    const late = new Map<string, number>();
    for (const event of events) if (event.type === "message" && event.chat.chatType === "dm" && now - event.at > LATE_MS) late.set(event.chat.chatId, (late.get(event.chat.chatId) ?? 0) + 1);
    return events.map((event) => {
      const count = event.type === "message" && event.chat.chatType === "dm" && now - event.at > LATE_MS ? late.get(event.chat.chatId) : undefined;
      if (!count || event.type !== "message") return event;
      late.delete(event.chat.chatId);
      return { ...event, backlog: count };
    });
  }

  // Sending

  /** One at a time per chat, at least `gap` apart; other chats are not held up. */
  private lane<T>(chatId: string, run: () => Promise<T>): Promise<T> {
    const lane = this.lanes.get(chatId) ?? { tail: Promise.resolve(), lastAt: 0 };
    this.lanes.set(chatId, lane);
    const result = lane.tail.then(async () => {
      const wait = lane.lastAt + this.gap - Date.now();
      if (wait > 0) await defaultSleep(wait);
      try {
        return await run();
      } finally {
        lane.lastAt = Date.now();
      }
    });
    lane.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** A call that sends something: refused or never connected → certainly not gone; anything else → may have gone. */
  private async deliver(method: string, body: () => { json?: Json; form?: FormData }): Promise<Json> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return (await request(this.baseUrl, await this.token(), method, body(), AbortSignal.timeout(60_000))) as Json;
      } catch (error) {
        if (error instanceof TelegramRefusal && error.status === 429) {
          // Told to slow down: nothing was sent. A short wait is sat through here, as long as Telegram
          // says; a long one (or a fourth) goes back to the core, which tries again after it.
          const wait = error.retryAfter ?? 1;
          if (wait <= LONGEST_WAIT_S && attempt < 3) {
            await this.sleep(wait * 1000);
            continue;
          }
          throw new ChannelSendError("no", "telegram_429", error.message, { retryAfterMs: wait * 1000 });
        }
        if (error instanceof TelegramRefusal && error.status < 500) throw new ChannelSendError("no", `telegram_${error.status}`, error.message, { permanent: PERMANENT.has(error.status) });
        if (error instanceof TelegramUnreached && error.before) throw new ChannelSendError("no", "not_connected", error.message);
        // A server error or a cut after the request went: it may have been done, so it is never sent again.
        throw new ChannelSendError("unknown", "no_answer", error instanceof Error ? error.message : `${method}: failed`);
      }
    }
  }

  private keyboard(out: Out) {
    // A Mini App can send data back only when it was opened from a keyboard button (not an inline one).
    if (out.webApp) return { keyboard: [[{ text: out.webApp.label, web_app: { url: out.webApp.url } }]], resize_keyboard: true, one_time_keyboard: true };
    return { inline_keyboard: (out.buttons ?? []).map((row) => row.map((button) => ({ text: button.label, callback_data: button.token }))) };
  }

  async send(chat: ChatRef, out: Out, options: SendOptions = {}): Promise<{ messageId: string; unsent?: { name: string; delivered: "no" | "unknown" }[] }> {
    const chatId = Number(chat.chatId);
    return this.lane(chat.chatId, async () => {
      let messageId: string | null = null;
      // The message the buttons sit on (the last part of the text): the one a press comes from.
      let keyboardId: string | null = null;
      // Asked after the wait in the line and before every part: a chat closed meanwhile gets nothing more.
      const stillWanted = () => {
        if (options.stillWanted && !options.stillWanted()) throw new ChannelSendError(messageId ? "unknown" : "no", "withdrawn", "sendMessage: no longer wanted");
      };
      const parts = !out.text.trim() ? [] : out.marks?.length ? splitRich(out.text, out.marks, TEXT_LIMIT) : splitText(out.text).map((text) => ({ text, marks: [] as Mark[] }));
      for (const [index, part] of parts.entries()) {
        const last = index === parts.length - 1;
        stillWanted();
        try {
          const body = (formatted: boolean) => ({ json: {
            // Plain: with each link's address written out (splitRich made the part fit that way too).
            chat_id: chatId, text: formatted ? part.text : plain(part), link_preview_options: { is_disabled: true },
            ...(formatted && part.marks.length ? { entities: entities(part.marks) } : {}),
            ...(out.silent ? { disable_notification: true } : {}),
            ...(last && (out.buttons?.length || out.webApp) ? { reply_markup: this.keyboard(out) } : {}),
          } });
          let sent: Json;
          try {
            sent = await this.deliver("sendMessage", () => body(true));
          } catch (error) {
            // Refused (400): nothing of it was taken, so the same text goes plain, once.
            if (!part.marks.length || !refusedFormatting(error)) throw error;
            this.options.log.note("format_refused", error);
            stillWanted();
            sent = await this.deliver("sendMessage", () => body(false));
          }
          messageId = String(sent.message_id);
          if (last && (out.buttons?.length || out.webApp)) keyboardId = messageId;
        } catch (error) {
          // Part of it is already in the chat: sending the whole again would repeat that part.
          if (index > 0 && error instanceof ChannelSendError) throw new ChannelSendError("unknown", error.code, error.message);
          throw error;
        }
        if (!last && this.gap > 0) await defaultSleep(this.gap);
      }
      const unsent: { name: string; delivered: "no" | "unknown" }[] = [];
      for (const [index, file] of (out.files ?? []).entries()) {
        try {
          stillWanted();
          const bytes = readFileSync(file.path);
          if (bytes.length > this.limits.uploadBytes) throw new ChannelSendError("no", "too_large", "sendDocument: the file is larger than a bot may send");
          // A photo only in the forms Telegram shows as one (an SVG or a GIF goes as a file).
          // A page too long or too large for a photo goes as a file too, instead of failing.
          const photo = /^image\/(png|jpeg|webp)$/.test(file.mime) && bytes.length <= PHOTO_BYTES && photoShape(bytes);
          const sent = await this.deliver(photo ? "sendPhoto" : "sendDocument", () => {
            const form = new FormData();
            form.set("chat_id", String(chatId));
            if (file.caption) form.set("caption", cutAt(file.caption, CAPTION_LIMIT));
            if (out.silent) form.set("disable_notification", "true");
            form.set(photo ? "photo" : "document", new Blob([bytes], { type: file.mime }), file.name);
            return { form };
          });
          messageId = String(sent.message_id);
        } catch (error) {
          // Nothing has gone yet: the send failed as a whole, as before.
          if (!messageId) throw error;
          // Something of the message is in the chat: it is delivered. What did not go is named (a
          // chat closed meanwhile gets nothing more).
          const withdrawn = error instanceof ChannelSendError && error.code === "withdrawn";
          const rest = withdrawn ? (out.files ?? []).slice(index) : [file];
          // Withdrawn: nothing of these was sent (the chat closed before they left).
          for (const left of rest) unsent.push({ name: left.name, delivered: withdrawn || (error instanceof ChannelSendError && error.delivered === "no") ? "no" : "unknown" });
          if (withdrawn) break;
        }
      }
      if (!messageId) throw new ChannelSendError("no", "empty", "sendMessage: nothing to send");
      // Named by the message its buttons sit on: a press is bound to that one, not to a file after it.
      const id = keyboardId ?? messageId;
      return unsent.length ? { messageId: id, unsent } : { messageId: id };
    });
  }

  async edit(chat: ChatRef, messageId: string, out: Out): Promise<void> {
    const kept = out.text.length > TEXT_LIMIT ? cutAt(out.text, TEXT_LIMIT - 1) : out.text;
    const text = kept.length < out.text.length ? `${kept}…` : out.text;
    // Formatted: as one part of a send is (trimmed, the marks over the kept text only).
    const part = out.marks?.length ? splitRich(text, out.marks.filter((mark) => mark.offset < kept.length).map((mark) => ({ ...mark, length: Math.min(mark.length, kept.length - mark.offset) })), Number.MAX_SAFE_INTEGER)[0] : undefined;
    const call = (formatted: boolean) => this.call("editMessageText", {
      chat_id: Number(chat.chatId), message_id: Number(messageId), text: part ? (formatted || plain(part).length > TEXT_LIMIT ? part.text : plain(part)) : text, link_preview_options: { is_disabled: true }, reply_markup: this.keyboard(out),
      ...(formatted && part?.marks.length ? { entities: entities(part.marks) } : {}),
    });
    // The same text again is not a failure.
    const unchanged = (error: unknown) => error instanceof TelegramRefusal && error.status === 400 && /not modified/i.test(error.message);
    try {
      await call(true);
    } catch (error) {
      if (unchanged(error)) return;
      if (!part?.marks.length || !(error instanceof TelegramRefusal && error.status === 400)) throw error;
      this.options.log.note("format_refused", error);
      try {
        await call(false);
      } catch (again) {
        if (!unchanged(again)) throw again;
      }
    }
  }

  async remove(chat: ChatRef, messageId: string): Promise<boolean> {
    return (await this.call("deleteMessage", { chat_id: Number(chat.chatId), message_id: Number(messageId) }).catch(() => false)) === true;
  }

  async ackButton(handle: string, note?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: handle, ...(note ? { text: cutAt(note, 200) } : {}) });
  }

  async typing(chat: ChatRef): Promise<void> {
    await this.call("sendChatAction", { chat_id: Number(chat.chatId), action: "typing" });
  }

  async leave(chat: ChatRef): Promise<void> {
    await this.call("leaveChat", { chat_id: Number(chat.chatId) });
  }

  /** The bot's description, shown before a person starts it ("이 봇은 PC가 켜져 있을 때 답합니다"). */
  async describe(description: string): Promise<void> {
    await this.call("setMyDescription", { description });
  }

  /** Fetch a received file. Its address at Telegram carries the token: it is used here and never passed on or named. */
  async download(file: InFile, toPath: string): Promise<void> {
    if (file.size > this.limits.downloadBytes) throw new ChannelSendError("no", "too_large", "getFile: the file is larger than a bot may fetch");
    const info = (await this.call("getFile", { file_id: file.fileRef }).catch((error: unknown) => {
      throw new ChannelSendError("no", "file_unavailable", error instanceof TelegramRefusal ? error.message : "getFile: failed");
    })) as { file_path?: string; file_size?: number };
    if (!info.file_path || (info.file_size ?? 0) > this.limits.downloadBytes) throw new ChannelSendError("no", "file_unavailable", "getFile: no file to fetch");
    try {
      const response = await fetch(`${this.baseUrl}/file/bot${await this.token()}/${info.file_path}`, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error(String(response.status));
      let size = 0;
      const limit = this.limits.downloadBytes;
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), async function* (source) {
        for await (const chunk of source) {
          size += (chunk as Buffer).length;
          if (size > limit) throw new ChannelSendError("no", "too_large", "getFile: the file grew larger than a bot may fetch");
          yield chunk;
        }
      }, createWriteStream(toPath, { mode: 0o600 }));
    } catch (error) {
      rmSync(toPath, { force: true });
      if (error instanceof ChannelSendError) throw error;
      throw new ChannelSendError("no", "file_unavailable", "getFile: the file could not be fetched");
    }
  }
}
