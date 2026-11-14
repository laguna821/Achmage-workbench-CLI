import { randomBytes } from "node:crypto";
import { createWriteStream, readFileSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import WebSocket from "ws";
import { MAX_ATTACHMENT } from "../attachments.ts";
import { HttpError } from "../errors.ts";
import type { ChannelLog } from "./log.ts";
import { cutAt } from "./shape.ts";
import type { ChannelStore } from "./store.ts";
import { plain } from "./format.ts";
import { splitText } from "./telegram.ts";
import { ChannelSendError, type ChannelAdapter, type ChannelStatus, type ChatRef, type InFile, type Inbound, type Out, type SendOptions, type Sender } from "./types.ts";

// Slack by Socket Mode: the PC opens a WebSocket to Slack (apps.connections.open with the app-level
// token) and receives events and button presses over it, so no public address and no inbound port
// are needed. Everything it sends goes through the Web API with the bot token. The same core as
// Telegram's decides who may speak and what runs; this file only speaks Slack.
//
// Neither token, nor a file address, nor the socket address (it carries a one-time ticket), nor any
// message text is ever put into an error or a log line here: errors carry the method name, the HTTP
// status and Slack's own error code.

export const SLACK_API = "https://slack.com/api";
/** What a section block's text holds (Block Kit: 3,000 characters). Every part sent stays within it after escaping. */
const TEXT_LIMIT = 3000;
/** A button's label (Block Kit plain_text in a button: 75 characters). */
const LABEL_LIMIT = 75;
/** Buttons in one actions block (Block Kit: 25). */
const ROW_LIMIT = 25;
/** A message older than this when it arrives waited at Slack (the PC was off or asleep). */
const LATE_MS = 2 * 60_000;
/** What the history fill runs after a reconnect: at most a day back (as long as Telegram holds what waits), at most this many. */
const HISTORY_MS = 24 * 60 * 60_000;
const HISTORY_MAX = 200;
/** Read per page (the method recommends at most 200; internal apps keep Tier 3), and at most this many in all. */
const HISTORY_PAGE = 200;
const HISTORY_READ_MAX = 1000;
/** Codes after which opening a connection will never succeed with these tokens: stop and say so. */
const TOKEN_DEAD = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "not_allowed_token_type", "missing_scope", "access_denied", "team_access_not_granted", "invalid_token"]);
/** Slack's only host for a file of its own (a remote file's address is another app's: no token goes there). */
const FILE_HOST = "files.slack.com";
/** The longest wait for a 429 sat through inside a send; a longer one goes back to the core with the wait. */
const LONGEST_WAIT_S = 30;
/** Slack's own codes for a refusal that trying again cannot change. */
const PERMANENT = new Set([
  "channel_not_found", "not_in_channel", "is_archived", "msg_too_long", "no_text", "invalid_blocks", "invalid_blocks_format",
  "invalid_arguments", "invalid_attachments", "too_many_attachments", "cannot_dm_bot", "user_disabled", "account_inactive",
  "token_revoked", "invalid_auth", "not_authed", "missing_scope", "restricted_action", "ekm_access_denied", "messages_tab_disabled",
]);
/** Codes after which the message may have been posted all the same. */
const MAYBE_DONE = new Set(["internal_error", "fatal_error", "service_unavailable", "request_timeout"]);
const BAD_TOKEN = "Slack이 이 토큰을 받지 않습니다. [토큰 바꾸기]를 눌러 두 토큰을 다시 넣어 주세요.";
const LINK_DISABLED = "Slack 앱 설정에서 Socket Mode가 꺼졌습니다. 앱 설정에서 다시 켠 뒤 [다시 연결]을 눌러 주세요.";
/** Several connections are normal (Slack allows up to 10, and keeps one a sleeping PC left for a while): only a note, and only if it stays. */
const CROWDED_NOTE = "다른 곳에서도 이 Slack 앱에 연결해 있습니다. PC가 잠들었다 깨어난 뒤라면 곧 사라집니다. 오래 남으면 다른 PC에서 같은 앱을 켜 두지 않았는지 확인해 주세요.";
/** The scopes the app needs (the manifest asks for exactly these). */
export const SLACK_SCOPES = ["chat:write", "im:history", "files:read", "files:write", "users:read"] as const;

type Json = Record<string, unknown>;

/** What the Web API answered when it refused a call. */
class SlackRefusal extends Error {
  readonly status: number;
  readonly error: string;
  readonly retryAfter: number | null;
  constructor(method: string, status: number, error: string, retryAfter: number | null) {
    super(cutAt(`${method}: ${status} ${error}`, 300));
    this.status = status;
    this.error = error;
    this.retryAfter = retryAfter;
  }
}

/** Why a request did not complete: `before` the connection was made (nothing was sent), or at some later point. */
class SlackUnreached extends Error {
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
    at = (at as { cause?: unknown }).cause;
  }
  return error instanceof Error && error.name === "AbortError" ? "timeout" : "failed";
}

/** Values as Slack takes them in a form: nested ones as JSON text. */
function form(params: Json): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  return body;
}

type Answer = { ok?: boolean; error?: string } & Json;

async function call(baseUrl: string, token: string, method: string, params: Json, signal: AbortSignal): Promise<{ body: Answer; headers: Headers }> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" }, body: form(params), signal });
  } catch (error) {
    const code = failureCode(error);
    throw new SlackUnreached(method, NOT_CONNECTED.has(code), code);
  }
  const retry = Number(response.headers.get("retry-after"));
  if (response.status === 429) throw new SlackRefusal(method, 429, "ratelimited", Number.isFinite(retry) && retry > 0 ? retry : null);
  // Not Slack's own answer (a proxy's error page) is judged by its status alone.
  const body = await (response.json() as Promise<Answer>).catch((): Answer => ({}));
  if (response.ok && body.ok === true) return { body, headers: response.headers };
  throw new SlackRefusal(method, response.status, typeof body.error === "string" ? body.error : "no_error_code", null);
}

/** `&`, `<` and `>` as Slack's text needs them: a line can never become a mention (`<!channel>`), a link or a user tag. */
/**
 * The text as it goes to Slack. The core's formatting marks (unit 14) are Telegram's way and are
 * not sent: the readable text goes plain and whole, each link's address written after its words.
 */
const plainText = (out: Out) => (out.marks?.length ? plain({ text: out.text, marks: out.marks }) : out.text);

export const escapeSlack = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What a person wrote, as plain text: Slack's escapes undone, a link `<url|label>` as its address. */
export function plainSlack(text: string): string {
  return text.replace(/<((?:https?|mailto):[^|>\s]+)(?:\|[^>]*)?>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * Text in parts that each fit `limit` once escaped: cut where `splitText` cuts (a paragraph, a
 * line, a space, else a character end), smaller where escaping made a part grow.
 */
export function slackParts(text: string, limit = TEXT_LIMIT): string[] {
  const out: string[] = [];
  const queue = splitText(text, limit);
  while (queue.length) {
    const part = queue.shift()!;
    const escaped = escapeSlack(part);
    if (escaped.length <= limit) { out.push(escaped); continue; }
    queue.unshift(...splitText(part, Math.max(1, Math.floor((limit * part.length) / escaped.length) - 1)));
  }
  return out;
}

/** A name as anyone may set it, made safe to show: no control or formatting characters, one space between words, at most 64 characters. */
const shown = (value: unknown) => typeof value === "string" ? cutAt(value.replace(/[\p{Cc}\p{Cf}]+/gu, "").replace(/\s+/gu, " ").trim(), 64).trim() : "";

/**
 * "연결 <value>" from the PC's pairing screen, read as Telegram's `/start <value>` (Slack keeps `/`
 * for its own commands): also with backticks, quotes or a full stop around it, as a hand copy gives it.
 */
const QUOTES = "`'\"“”‘’";
const PAIRING_LINE = new RegExp(`^[${QUOTES}\\s]*연결\\s+[${QUOTES}]*([A-Za-z0-9_-]{16,64})[${QUOTES}]*[.。]?[${QUOTES}\\s]*$`);
/** Just the word, while the PC's pairing window is open: the window's own value is used (the person need not type it). */
const PAIRING_WORD = /^(?:연결|연결하기|connect)[.。!]?$/i;

const chatTypeOf = (channel: string, type?: unknown): ChatRef["chatType"] =>
  type === "im" ? "dm" : type === "channel" ? "channel" : type === "mpim" || type === "group" ? "group"
    : channel.startsWith("D") ? "dm" : channel.startsWith("C") ? "channel" : "group";

export type SlackIdentity = { id: string; username: string; name: string; teamId: string; userId: string; appId: string | null };

/**
 * Check both tokens of a Slack app at registration: the bot token with auth.test (and its scopes),
 * the app-level token by asking for a Socket Mode address, which is not used. Neither token is
 * repeated in any refusal.
 */
export async function identifySlack(botToken: string, appToken: string, baseUrl = SLACK_API): Promise<SlackIdentity> {
  const bot = botToken.trim(), app = appToken.trim();
  if (bot.startsWith("xapp-") && app.startsWith("xoxb-")) throw new HttpError(400, "channel_token_swapped", "두 칸이 바뀌었습니다. xoxb-로 시작하는 것은 위 칸(봇 토큰), xapp-로 시작하는 것은 아래 칸(앱 토큰)에 넣어 주세요.");
  if (!/^xoxb-[A-Za-z0-9-]{20,}$/.test(bot)) throw new HttpError(400, "channel_token_invalid", "봇 토큰이 맞지 않습니다. OAuth & Permissions의 Bot User OAuth Token(xoxb-로 시작)을 그대로 붙여 넣어 주세요.");
  if (!/^xapp-[A-Za-z0-9-]{20,}$/.test(app)) throw new HttpError(400, "channel_app_token_invalid", "앱 토큰이 맞지 않습니다. Basic Information의 App-Level Token(xapp-로 시작)을 그대로 붙여 넣어 주세요.");
  const unreachable = () => new HttpError(502, "channel_unreachable", "Slack에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 해 주세요.");
  const signal = () => AbortSignal.timeout(15_000);
  let me: Answer, scopes: string | null;
  try {
    const answer = await call(baseUrl, bot, "auth.test", {}, signal());
    me = answer.body;
    scopes = answer.headers.get("x-oauth-scopes");
  } catch (error) {
    if (error instanceof SlackRefusal && error.status !== 429 && error.status < 500) throw new HttpError(400, "channel_token_invalid", "Slack이 이 봇 토큰을 받지 않습니다. 앱을 워크스페이스에 설치한 뒤 Bot User OAuth Token(xoxb-)을 다시 복사해 주세요.");
    throw unreachable();
  }
  if (typeof me.bot_id !== "string" || typeof me.user_id !== "string") throw new HttpError(400, "channel_token_invalid", "봇 토큰이 아닙니다. Bot User OAuth Token(xoxb-로 시작)을 넣어 주세요.");
  if (scopes !== null) {
    const held = new Set(scopes.split(",").map((scope) => scope.trim()));
    const missing = SLACK_SCOPES.filter((scope) => !held.has(scope));
    if (missing.length) throw new HttpError(400, "channel_scopes_missing", `앱에 권한이 빠져 있습니다: ${missing.join(", ")}. Workbench가 준 매니페스트로 앱을 만들고 다시 설치해 주세요.`);
  }
  let socketApp: string | null = null;
  try {
    const opened = (await call(baseUrl, app, "apps.connections.open", {}, signal())).body;
    // The address carries a one-time ticket; it is not used, and only its app id is read.
    try { socketApp = new URL(String(opened.url)).searchParams.get("app_id"); } catch { socketApp = null; }
  } catch (error) {
    if (error instanceof SlackRefusal && error.status !== 429 && error.status < 500) throw new HttpError(400, "channel_app_token_invalid", "Slack이 이 앱 토큰을 받지 않습니다. App-Level Token(xapp-)을 connections:write 권한으로 만들어 다시 붙여 넣어 주세요.");
    throw unreachable();
  }
  // Which app the bot belongs to (bots.info, scope users:read). Not worth failing over when it cannot be read.
  let appId: string | null = null;
  try {
    const info = (await call(baseUrl, bot, "bots.info", { bot: me.bot_id }, signal())).body.bot as Json | undefined;
    appId = typeof info?.app_id === "string" ? info.app_id : null;
  } catch { appId = null; }
  if (appId && socketApp && appId !== socketApp) throw new HttpError(400, "channel_tokens_mismatch", "두 토큰이 서로 다른 Slack 앱의 것입니다. 같은 앱의 봇 토큰과 앱 토큰을 넣어 주세요.");
  return { id: me.bot_id, username: shown(me.user) || "workbench", name: shown(me.team), teamId: String(me.team_id ?? ""), userId: me.user_id, appId: appId ?? socketApp };
}

export type SlackOptions = {
  botId: string;
  /** The workspace the app is installed in: an event or a press of any other is dropped. */
  teamId?: string;
  /**
   * The PC's open pairing window, if any: its one-time value (kept in memory by the service, never
   * written) and who already waits for the PC's approval. Lets a bare "연결" pair (see PAIRING_WORD).
   */
  pairing?: () => { value: string } | null;
  /** How long other connections must stay before the PC is told (a sleeping PC's old one goes by itself). */
  crowdedNoteMs?: number;
  /** The bot's own user: its messages in the DM are not the person's. */
  botUserId: string;
  /** Both tokens when they are needed (opened from the sealed store); kept in memory by the adapter while it runs. */
  tokens: () => Promise<{ bot: string; app: string }>;
  baseUrl?: string;
  /** Where received events are written down, with where each conversation was read up to. */
  journal: Pick<ChannelStore, "offset" | "record">;
  log: ChannelLog;
  /** The least time between two messages to one conversation (Slack: about one a second). */
  minSendGapMs?: number;
  /** How often the connection is checked with a ping; silent for twice this long, it is replaced. */
  pingMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  onStatus?: () => void;
};

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((done) => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
});

/** The key, beside the conversations' read marks, under which the marks of failed history reads are kept. */
const UNFILLED = "unfilled";
type Marks = { read: Record<string, string>; unfilled: Record<string, string> };

type Envelope = { envelope_id?: string; type?: string; payload?: Json; retry_attempt?: number };
/** How one socket ended. */
type Ending = { hello: boolean; reason: "refresh" | "closed" | "link_disabled" | "aborted" };

export class SlackAdapter implements ChannelAdapter {
  readonly kind = "slack" as const;
  /** Slack names the sender and a bare 연결 pairs (see ChannelAdapter.pairingByWord). */
  readonly pairingByWord = true;
  /** No in-chat secret input: nothing takes a line out before the inbox, and a bot cannot delete a person's message. */
  readonly secretInput = false;
  readonly botId: string;
  readonly limits = { text: TEXT_LIMIT, caption: TEXT_LIMIT, uploadBytes: 100 * 1024 * 1024, downloadBytes: MAX_ATTACHMENT, minEditGapMs: 15_000 };
  /**
   * Where a submitted modal goes (Slack's view_submission). Nothing is connected to it yet: the
   * human-only input belongs to the credential units. Its answer, when it gives one, is sent back
   * with the acknowledgement (a modal's `response_action`).
   */
  onViewSubmission: ((payload: Json) => Promise<Json | void>) | null = null;
  private readonly options: SlackOptions;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly gap: number;
  private secrets: { bot: string; app: string } | null = null;
  private state: ChannelStatus = { state: "stopped", detail: null };
  private readonly lanes = new Map<string, { tail: Promise<void>; lastAt: number }>();
  private readonly names = new Map<string, Sender>();
  /** Whose organisation is the app's own, as users.info said (a person not here is in doubt: never paired). */
  private readonly members = new Map<string, boolean>();
  /** The events handed to the core, in the order they were written down. */
  private chain: Promise<void> = Promise.resolve();
  /** Envelopes being read and written down, in the order they came. */
  private intake: Promise<void> = Promise.resolve();
  /** Since when Slack has reported other connections of this app (null: none at the last hello). */
  private crowdedSince: number | null = null;
  /** When the crowded note was put up (or last checked): while it shows, the count is asked again by a new connection. */
  private noteAt: number | null = null;
  /** A history read failed since the last try: read again at the next pulse of the open socket. */
  private refill = false;

  constructor(options: SlackOptions) {
    this.options = options;
    this.botId = options.botId;
    this.baseUrl = (options.baseUrl ?? SLACK_API).replace(/\/+$/, "");
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

  private async tokens() {
    this.secrets ??= await this.options.tokens();
    return this.secrets;
  }

  private async api(method: string, params: Json, signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<Answer> {
    return (await call(this.baseUrl, (await this.tokens()).bot, method, params, signal)).body;
  }

  /** The stand-in on this machine is the only `http:`/`ws:` peer allowed; everything else is Slack over TLS. */
  private local() {
    const url = new URL(this.baseUrl);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? url : null;
  }

  /** Whether an address Slack gave (a socket, a file, an upload) may be used: Slack's own hosts over TLS, or the local stand-in. */
  private trusted(address: string, socket = false): boolean {
    let url: URL;
    try { url = new URL(address); } catch { return false; }
    const local = this.local();
    if (local) return url.hostname === local.hostname && url.port === local.port && url.protocol === (socket ? "ws:" : "http:");
    // A socket is on one of Slack's own wss hosts; a file only on its file host, compared exactly.
    return socket ? url.protocol === "wss:" && url.hostname.endsWith(".slack.com") : url.protocol === "https:" && url.hostname === FILE_HOST;
  }

  // Receiving

  async start(sink: (event: Inbound) => Promise<void>, signal: AbortSignal): Promise<void> {
    this.setStatus("retrying", "연결하는 중");
    try {
      await this.tokens();
    } catch (error) {
      this.options.log.note("token_unavailable", error);
      return this.setStatus("stopped", "보안 저장소에서 Slack 토큰을 읽지 못했습니다. 저장소 잠금을 푼 뒤 [다시 연결]을 누르거나, 토큰을 다시 넣어 주세요.");
    }
    let failures = 0;
    while (!signal.aborted) {
      let address: string;
      try {
        const opened = (await call(this.baseUrl, this.secrets!.app, "apps.connections.open", {}, AbortSignal.any([signal, AbortSignal.timeout(30_000)]))).body;
        address = String(opened.url ?? "");
        if (!this.trusted(address, true)) throw new SlackRefusal("apps.connections.open", 200, "untrusted_address", null);
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof SlackRefusal && TOKEN_DEAD.has(error.error)) {
          this.options.log.note("socket_unauthorized", error.error);
          return this.setStatus("stopped", BAD_TOKEN);
        }
        failures += 1;
        this.setStatus("retrying", `다시 연결 중 (${failures}번째)`);
        this.options.log.note("socket_open_failed", error);
        await this.backoff(failures, error instanceof SlackRefusal ? error.retryAfter : null, signal);
        continue;
      }
      const ending = await this.session(address, sink, signal);
      if (ending.reason === "aborted" || signal.aborted) break;
      if (ending.reason === "link_disabled") {
        this.options.log.note("socket_link_disabled");
        return this.setStatus("stopped", LINK_DISABLED);
      }
      if (ending.hello) {
        failures = 0;
        // Slack asked for a new connection: at once. A cut: a short wait first.
        if (ending.reason === "refresh") continue;
        failures = 1;
      } else failures += 1;
      this.setStatus("retrying", `다시 연결 중 (${failures}번째)`);
      await this.backoff(failures, null, signal);
    }
    this.setStatus("stopped");
  }

  /** 1, 2, 4 … 60 seconds with jitter, or as long as Slack asked. */
  private async backoff(failures: number, retryAfter: number | null, signal: AbortSignal) {
    const ms = retryAfter ? retryAfter * 1000 : Math.min(60_000, Math.round(1_000 * 2 ** Math.min(failures - 1, 6) * (0.75 + this.random() * 0.5)));
    await this.sleep(ms, signal);
  }

  /** One WebSocket, from opening to closing. Only one is open at a time. */
  private session(address: string, sink: (event: Inbound) => Promise<void>, signal: AbortSignal): Promise<Ending> {
    return new Promise<Ending>((done) => {
      const ending: Ending = { hello: false, reason: "closed" };
      const pingMs = this.options.pingMs ?? 30_000;
      let lastHeard = Date.now(), finished = false;
      const socket = new WebSocket(address, { handshakeTimeout: 15_000, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024 });
      const finish = () => {
        if (finished) return;
        finished = true;
        clearInterval(pulse);
        signal.removeEventListener("abort", abort);
        done(ending);
      };
      const abort = () => { ending.reason = "aborted"; socket.terminate(); finish(); };
      signal.addEventListener("abort", abort, { once: true });
      // A connection that went silent (a PC that slept, a network that dropped) is replaced.
      const pulse = setInterval(() => {
        if (Date.now() - lastHeard > 2 * pingMs) {
          this.options.log.note("socket_silent");
          socket.terminate();
          return;
        }
        const noteMs = this.options.crowdedNoteMs ?? 10 * 60_000;
        // Only a hello says how many connections there are: while the note shows, a new connection asks again,
        // so the note goes soon after the others do (not hours later at Slack's next refresh).
        if (this.noteAt !== null && this.state.detail === CROWDED_NOTE && Date.now() - this.noteAt >= noteMs && ending.hello) {
          this.noteAt = Date.now();
          ending.reason = "refresh";
          socket.close();
          return;
        }
        if (this.crowdedSince !== null && this.state.detail !== CROWDED_NOTE && Date.now() - this.crowdedSince >= noteMs) {
          this.noteAt = Date.now();
          this.setStatus("connected", CROWDED_NOTE);
        }
        if (socket.readyState === WebSocket.OPEN) socket.ping();
        // A conversation whose history read failed is read again while this socket lives, not hours later.
        if (this.refill && ending.hello && socket.readyState === WebSocket.OPEN) {
          this.refill = false;
          this.enqueue(() => this.fill(sink, this.fillFrom(true)));
        }
      }, pingMs);
      pulse.unref();
      socket.on("ping", () => { lastHeard = Date.now(); });
      socket.on("pong", () => { lastHeard = Date.now(); });
      socket.on("error", (error) => this.options.log.note("socket_error", failureCode(error)));
      socket.on("close", () => finish());
      socket.on("message", (data) => {
        lastHeard = Date.now();
        let message: Envelope & Json;
        try { message = JSON.parse(String(data)) as Envelope & Json; } catch { return; }
        if (message.type === "hello") {
          ending.hello = true;
          // Not a reason to stop: Slack allows up to 10 connections and does not define this number.
          if (Number(message.num_connections ?? 1) > 1) {
            if (this.crowdedSince === null) this.options.log.note("socket_others", String(message.num_connections));
            this.crowdedSince ??= Date.now();
          } else {
            this.crowdedSince = null;
            this.noteAt = null;
          }
          if (this.crowdedSince === null || this.state.detail !== CROWDED_NOTE) this.setStatus("connected");
          // What came while no socket was open is read from the history, from where each DM was read up to
          // NOW: a live line of this socket that is written down before the fill runs must not move it.
          this.refill = false;
          const from = this.fillFrom(false);
          this.enqueue(() => this.fill(sink, from));
          return;
        }
        if (message.type === "disconnect") {
          if (message.reason === "link_disabled") ending.reason = "link_disabled";
          else ending.reason = "refresh";
          // "warning": Slack closes it in a few seconds; "refresh_requested": now. Either way a new one follows at once.
          if (message.reason !== "warning") socket.close();
          return;
        }
        // Read one after another, so the person's lines keep their order (a name lookup can take a moment).
        if (typeof message.envelope_id === "string") this.intake = this.intake.then(() => this.envelope(socket, message, sink));
      });
    });
  }

  /** In order, behind what was handed over before; never holds up the socket (whose acknowledgements must go within seconds). */
  private enqueue(work: () => Promise<void>) {
    this.chain = this.chain.then(work).catch((error: unknown) => this.options.log.note("sink_failed", error));
  }

  /**
   * One envelope: read, written down, acknowledged, then handed to the core. An envelope that cannot
   * be written down is not acknowledged, so Slack sends it again.
   */
  private async envelope(socket: WebSocket, envelope: Envelope, sink: (event: Inbound) => Promise<void>) {
    let events: Inbound[] = [];
    let answer: Json | void = undefined;
    try {
      if (envelope.type === "events_api") events = await this.fromEvent(envelope.payload ?? {});
      else if (envelope.type === "interactive") {
        const payload = envelope.payload ?? {};
        if (payload.type === "view_submission") answer = this.onViewSubmission ? await this.onViewSubmission(payload) : undefined;
        else events = this.fromAction(payload);
      }
      if (events.length) this.record(events);
    } catch (error) {
      this.options.log.note("envelope_unrecorded", error);
      return;
    }
    // Acknowledged only on the socket it came by; what was written down goes to the core either way
    // (the history read after a reconnect starts past it, so nothing else would hand it over).
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id, ...(answer ? { payload: answer } : {}) }));
    for (const event of events) this.enqueue(() => sink(event));
  }

  /**
   * Written down together with how far each conversation has been read. `filled`: the conversation
   * whose history was just read in full from its unfilled mark, which is dropped in the same write.
   */
  private record(events: Inbound[], filled?: string) {
    const marks = this.marks();
    for (const event of events) {
      if (event.type !== "message") continue;
      const ts = event.eventId.split(":")[2]!;
      if (!marks.read[event.chat.chatId] || Number(ts) > Number(marks.read[event.chat.chatId])) marks.read[event.chat.chatId] = ts;
    }
    if (filled !== undefined) delete marks.unfilled[filled];
    this.save(marks, events);
  }

  private save(marks: Marks, events: Inbound[] = []) {
    const stored = { ...marks.read, ...(Object.keys(marks.unfilled).length ? { [UNFILLED]: marks.unfilled } : {}) };
    this.options.journal.record("slack", this.botId, events.map((event) => ({ eventId: event.eventId, payload: JSON.stringify(event) })), JSON.stringify(stored));
  }

  /** Where each conversation was read up to, and where those whose last history read failed must be read from again. */
  private marks(): Marks {
    const strings = (value: unknown): Record<string, string> =>
      value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
    try {
      const parsed = JSON.parse(this.options.journal.offset("slack", this.botId) ?? "{}") as Record<string, unknown>;
      return { read: strings(parsed), unfilled: strings(parsed?.[UNFILLED]) };
    } catch {
      return { read: {}, unfilled: {} };
    }
  }

  /** Where the history fill starts per conversation: the older of its read mark and its unfilled mark (`onlyUnfilled`: just those that failed). */
  private fillFrom(onlyUnfilled: boolean): Record<string, string> {
    const { read, unfilled } = this.marks();
    const from: Record<string, string> = onlyUnfilled ? {} : { ...read };
    for (const [channel, mark] of Object.entries(unfilled)) if (!from[channel] || Number(mark) < Number(from[channel])) from[channel] = mark;
    return from;
  }

  /** Who wrote: from users.info once per person (it may be slow; the name waits at most briefly). */
  private async sender(userId: string): Promise<Sender> {
    const known = this.names.get(userId);
    if (known) return known;
    try {
      const user = (await this.api("users.info", { user: userId }, AbortSignal.timeout(1_500))).user as Json | undefined;
      const profile = (user?.profile ?? {}) as Json;
      const display = shown(profile.display_name), real = shown(profile.real_name) || shown(user?.real_name);
      // Both names when they differ: the PC's approval names the person as Slack knows them.
      const name = display && real && display !== real ? cutAt(`${display} (${real})`, 64) : display || real || shown(user?.name);
      const handle = shown(user?.name);
      const sender: Sender = { userId, displayName: name || userId, ...(handle ? { handle } : {}) };
      this.names.set(userId, sender);
      // Slack Connect: someone of another organisation can reach the app; its users.info says so
      // (`is_stranger`, or a `team_id` that is not the app's). To confirm on a real workspace (Enterprise Grid).
      const team = typeof user?.team_id === "string" ? user.team_id : null;
      this.members.set(userId, user?.is_stranger !== true && (!this.options.teamId || team === null || team === this.options.teamId));
      return sender;
    } catch (error) {
      this.options.log.note("user_unknown", error instanceof SlackRefusal ? error : "failed");
      return { userId, displayName: userId };
    }
  }

  /** A message of the person (a live event, or one read from the history). The bot's own and edited or deleted ones are not. */
  private async fromMessage(message: Json, channel: string, channelType?: unknown): Promise<Inbound | null> {
    const user = message.user;
    if (typeof user !== "string" || message.bot_id || user === this.options.botUserId) return null;
    // A shared conversation's event names the sender's own organisation (`user_team`, `source_team`): another one is not the owner's.
    if ([message.user_team, message.source_team].some((team) => typeof team === "string" && team && this.options.teamId && team !== this.options.teamId)) return this.outsider();
    if (message.subtype !== undefined && message.subtype !== "file_share" && message.subtype !== "thread_broadcast") return null;
    const ts = String(message.ts ?? "");
    if (!/^\d+\.\d+$/.test(ts)) return null;
    const files: InFile[] = ((message.files as Json[] | undefined) ?? []).filter((file) => typeof file.id === "string").map((file) => {
      const mime = String(file.mimetype ?? "application/octet-stream");
      return {
        fileRef: String(file.id), name: shown(file.name) || shown(file.title) || `file-${String(file.id)}`, mime, size: Number(file.size ?? 0),
        kind: file.subtype === "slack_audio" ? "voice" : mime.startsWith("image/") ? "photo" : mime.startsWith("audio/") ? "audio" : "file",
      };
    });
    const from = await this.sender(user);
    const member = this.members.get(user);
    if (member === false) return this.outsider();
    let text = plainSlack(String(message.text ?? ""));
    // Pairing only for a person known to be of the app's organisation; in doubt (no users.info) the line stays a line.
    const pairing = member ? PAIRING_LINE.exec(text.trim()) : null;
    if (pairing) text = `/start ${pairing[1]}`;
    else if (member && PAIRING_WORD.test(text.trim())) {
      // Whoever sends it while the window is open: the core keeps one request and tells a second person to wait.
      const window = this.options.pairing?.() ?? null;
      if (window) text = `/start ${window.value}`;
    }
    return { type: "message", eventId: `m:${channel}:${ts}`, chat: { kind: "slack", botId: this.botId, chatId: channel, chatType: chatTypeOf(channel, channelType) }, from, text, files, at: Math.round(Number(ts) * 1000) };
  }

  private outsider(): null {
    this.options.log.note("outsider_dropped");
    return null;
  }

  /** Only the workspace the app was registered in (Slack Connect and other workspaces are not the owner's). */
  private ours(team: unknown) {
    return !this.options.teamId || typeof team !== "string" || team === this.options.teamId;
  }

  private async fromEvent(payload: Json): Promise<Inbound[]> {
    if (!this.ours(payload.team_id)) return [];
    const event = payload.event as Json | undefined;
    if (!event || event.type !== "message" || typeof event.channel !== "string") return [];
    const inbound = await this.fromMessage(event, event.channel, event.channel_type);
    return inbound ? this.backlog([inbound]) : [];
  }

  /** A button press: bound by the core to the conversation, the person and the message it was on. */
  private fromAction(payload: Json): Inbound[] {
    if (payload.type !== "block_actions" || !this.ours((payload.team as Json | undefined)?.id) || !this.ours((payload.user as Json | undefined)?.team_id)) return [];
    const action = (payload.actions as Json[] | undefined)?.[0];
    const user = (payload.user as Json | undefined)?.id;
    const container = (payload.container ?? {}) as Json;
    const channel = String((payload.channel as Json | undefined)?.id ?? container.channel_id ?? "");
    if (!action || action.type !== "button" || typeof action.value !== "string" || typeof user !== "string" || !channel) return [];
    const messageId = container.message_ts ?? (payload.message as Json | undefined)?.ts;
    const known = this.names.get(user);
    return [{
      type: "button", eventId: `a:${channel}:${String(action.action_ts ?? "")}:${user}`, chat: { kind: "slack", botId: this.botId, chatId: channel, chatType: chatTypeOf(channel) },
      from: known ?? { userId: user, displayName: shown((payload.user as Json).username) || user }, token: action.value, ackHandle: `${channel} ${user}`, at: Date.now(),
      ...(typeof messageId === "string" ? { messageId } : {}),
    }];
  }

  /** Mark, per conversation, the first message that waited at Slack with how many waited. */
  private backlog(events: Inbound[]): Inbound[] {
    const now = Date.now();
    const late = (event: Inbound) => event.type === "message" && event.chat.chatType === "dm" && now - event.at > LATE_MS;
    const count = new Map<string, number>();
    for (const event of events) if (late(event)) count.set(event.chat.chatId, (count.get(event.chat.chatId) ?? 0) + 1);
    return events.map((event) => {
      const waiting = late(event) ? count.get(event.chat.chatId) : undefined;
      if (!waiting || event.type !== "message") return event;
      count.delete(event.chat.chatId);
      return { ...event, backlog: waiting };
    });
  }

  /**
   * After every new connection: each conversation this bot has heard from is read from where it had
   * been read up to when the socket said hello (`from`), oldest first. What is new runs the way of a
   * live event — at most a day back, at most HISTORY_MAX lines; what is not run is told to the
   * conversation once (a `skipped` event first), with the true counts. The same message received
   * live and read here has one id, so it is handled once.
   */
  private async fill(sink: (event: Inbound) => Promise<void>, from: Record<string, string>) {
    const since = Date.now() - HISTORY_MS;
    for (const [channel, asked] of Object.entries(from)) {
      // `from` was taken when the socket said hello; a read that failed since then (an earlier
      // connection's, still waiting its turn) may have left an older point. This read starts at the
      // older of the two, so a kept point is only ever dropped by a read that covered it.
      const kept = this.marks().unfilled[channel];
      const read = kept !== undefined && Number(kept) < Number(asked) ? kept : asked;
      const covered = () => {
        const now = this.marks().unfilled[channel];
        return now !== undefined && Number(read) <= Number(now);
      };
      const found: Json[] = [];
      let cursor: string | undefined;
      try {
        do {
          const page = await this.api("conversations.history", { channel, oldest: read, limit: HISTORY_PAGE, ...(cursor ? { cursor } : {}) });
          found.push(...((page.messages as Json[] | undefined) ?? []));
          cursor = page.has_more ? String((page.response_metadata as Json | undefined)?.next_cursor ?? "") || undefined : undefined;
        } while (cursor && found.length < HISTORY_READ_MAX);
      } catch (error) {
        // Kept (written down) where it must be read from again: a live line moves the read mark past
        // the gap, never this one. Read again at the next pulse or connection.
        this.options.log.note("history_failed", error);
        const marks = this.marks();
        if (!marks.unfilled[channel] || Number(read) < Number(marks.unfilled[channel])) marks.unfilled[channel] = read;
        this.save(marks);
        this.refill = true;
        continue;
      }
      const lines: Inbound[] = [];
      for (const message of found.reverse()) {
        const event = await this.fromMessage(message, channel);
        if (event) lines.push(event);
      }
      if (!lines.length) {
        if (covered()) this.record([], channel);
        continue;
      }
      const recent = lines.filter((event) => event.at >= since);
      const run = recent.slice(-HISTORY_MAX);
      const skipped = lines.filter((event) => !run.includes(event));
      const events: Inbound[] = [];
      if (skipped.length) {
        const last = skipped[skipped.length - 1]!;
        // More than could be read: the oldest were not even seen (they are older than all of these).
        events.push({ ...last, eventId: `s:${channel}:${last.eventId.split(":")[2]}`, text: "", files: [], skipped: { count: skipped.length, since: skipped[0]!.at, ...(cursor ? { more: true } : {}) } } as Inbound);
        this.options.log.note("history_skipped", String(skipped.length));
      }
      events.push(...this.backlog(run));
      this.record(events, covered() ? channel : undefined);
      for (const event of events) await sink(event).catch((error: unknown) => this.options.log.note("sink_failed", error));
    }
  }

  // Sending

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
  private async deliver(method: string, params: Json): Promise<Answer> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.api(method, params, AbortSignal.timeout(60_000));
      } catch (error) {
        if (error instanceof SlackRefusal && error.status === 429) {
          const wait = error.retryAfter ?? 1;
          if (wait <= LONGEST_WAIT_S && attempt < 3) {
            await this.sleep(wait * 1000);
            continue;
          }
          throw new ChannelSendError("no", "slack_429", error.message, { retryAfterMs: wait * 1000 });
        }
        if (error instanceof SlackRefusal && error.status < 500 && !MAYBE_DONE.has(error.error)) throw new ChannelSendError("no", `slack_${error.error}`, error.message, { permanent: PERMANENT.has(error.error) });
        if (error instanceof SlackUnreached && error.before) throw new ChannelSendError("no", "not_connected", error.message);
        throw new ChannelSendError("unknown", "no_answer", error instanceof Error ? error.message : `${method}: failed`);
      }
    }
  }

  /** A part as Block Kit: the text in a section, each row of buttons an actions block (labels cut to fit). */
  private blocks(text: string, buttons: Out["buttons"]): Json[] {
    const blocks: Json[] = [{ type: "section", text: { type: "mrkdwn", text, verbatim: true } }];
    const nonce = randomBytes(4).toString("hex");
    for (const [row, list] of (buttons ?? []).entries()) {
      if (!list.length) continue;
      blocks.push({
        // A new block id on every post and edit (Block Kit: "If a message is updated, use a new block_id").
        type: "actions", block_id: `r${row}-${nonce}`,
        elements: list.slice(0, ROW_LIMIT).map((button, column) => ({ type: "button", action_id: `b${row}_${column}`, value: button.token, text: { type: "plain_text", text: cutAt(button.label, LABEL_LIMIT) || "·", emoji: true } })),
      });
    }
    return blocks;
  }

  async send(chat: ChatRef, out: Out, options: SendOptions = {}): Promise<{ messageId: string; unsent?: { name: string; delivered: "no" | "unknown" }[] }> {
    return this.lane(chat.chatId, async () => {
      let messageId: string | null = null, buttonsAt: string | null = null;
      const stillWanted = () => {
        if (options.stillWanted && !options.stillWanted()) throw new ChannelSendError(messageId ? "unknown" : "no", "withdrawn", "chat.postMessage: no longer wanted");
      };
      const text = plainText(out);
      const parts = text.trim() ? slackParts(text) : [];
      for (const [index, part] of parts.entries()) {
        const last = index === parts.length - 1;
        stillWanted();
        try {
          const sent = await this.deliver("chat.postMessage", { channel: chat.chatId, text: part, blocks: this.blocks(part, last ? out.buttons : []), unfurl_links: false, unfurl_media: false });
          messageId = String(sent.ts);
          if (last && out.buttons?.length) buttonsAt = messageId;
        } catch (error) {
          // Part of it is already in the conversation: sending the whole again would repeat that part.
          if (index > 0 && error instanceof ChannelSendError) throw new ChannelSendError("unknown", error.code, error.message);
          throw error;
        }
        if (!last && this.gap > 0) await defaultSleep(this.gap);
      }
      const unsent: { name: string; delivered: "no" | "unknown" }[] = [];
      for (const [index, file] of (out.files ?? []).entries()) {
        try {
          stillWanted();
          messageId = await this.upload(chat, file);
        } catch (error) {
          if (!messageId) throw error;
          const withdrawn = error instanceof ChannelSendError && error.code === "withdrawn";
          const rest = withdrawn ? (out.files ?? []).slice(index) : [file];
          for (const left of rest) unsent.push({ name: left.name, delivered: withdrawn || (error instanceof ChannelSendError && error.delivered === "no") ? "no" : "unknown" });
          if (withdrawn) break;
        }
      }
      if (!messageId) throw new ChannelSendError("no", "empty", "chat.postMessage: nothing to send");
      // The message that carries the buttons is the one they are bound to.
      const id = buttonsAt ?? messageId;
      return unsent.length ? { messageId: id, unsent } : { messageId: id };
    });
  }

  /**
   * Slack's upload: ask for an upload address (files.getUploadURLExternal), send the bytes there
   * (no token: the address is for this file only), then share it to the conversation
   * (files.completeUploadExternal). Until the last step nothing shows in the conversation.
   */
  private async upload(chat: ChatRef, file: NonNullable<Out["files"]>[number]): Promise<string> {
    const bytes = readFileSync(file.path);
    if (bytes.length > this.limits.uploadBytes) throw new ChannelSendError("no", "too_large", "files.getUploadURLExternal: the file is larger than this PC sends");
    const target = await this.deliver("files.getUploadURLExternal", { filename: file.name, length: bytes.length });
    const address = String(target.upload_url ?? ""), id = String(target.file_id ?? "");
    if (!id || !this.trusted(address)) throw new ChannelSendError("no", "upload_unavailable", "files.getUploadURLExternal: no upload address");
    try {
      const response = await fetch(address, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes, signal: AbortSignal.timeout(120_000), redirect: "error" });
      if (!response.ok) throw new Error(String(response.status));
    } catch {
      // Not shared yet: nothing of it is in the conversation.
      throw new ChannelSendError("no", "upload_failed", "upload: the bytes did not arrive");
    }
    await this.deliver("files.completeUploadExternal", {
      files: [{ id, title: file.name }], channel_id: chat.chatId,
      ...(file.caption ? { initial_comment: escapeSlack(cutAt(file.caption, this.limits.caption - 200)) } : {}),
    });
    return `file:${id}`;
  }

  async edit(chat: ChatRef, messageId: string, out: Out): Promise<void> {
    // A shared file is not a message that can be rewritten.
    if (messageId.startsWith("file:")) return;
    const whole = plainText(out);
    let text = whole;
    for (let limit = TEXT_LIMIT - 1; escapeSlack(text).length > TEXT_LIMIT; limit -= 100) text = `${cutAt(whole, limit)}…`;
    const escaped = escapeSlack(text);
    await this.api("chat.update", { channel: chat.chatId, ts: messageId, text: escaped, blocks: this.blocks(escaped, out.buttons) });
  }

  /** Only the bot's own messages can be removed with the bot token; a person's message stays (false). */
  async remove(chat: ChatRef, messageId: string): Promise<boolean> {
    if (messageId.startsWith("file:")) return false;
    try {
      await this.api("chat.delete", { channel: chat.chatId, ts: messageId });
      return true;
    } catch {
      return false;
    }
  }

  /** The press was acknowledged on the socket already; a note is shown to the presser alone. */
  async ackButton(handle: string, note?: string): Promise<void> {
    if (!note) return;
    const [channel, user] = handle.split(" ");
    if (!channel || !user) return;
    await this.api("chat.postEphemeral", { channel, user, text: escapeSlack(cutAt(note, 200)) });
  }

  /** Slack's Web API has no "typing" for a bot: nothing to do. */
  async typing(_chat: ChatRef): Promise<void> {}

  /** Fetch a received file. The bot token goes only to Slack's own file host (or the local stand-in). */
  async download(file: InFile, toPath: string): Promise<void> {
    if (file.size > this.limits.downloadBytes) throw new ChannelSendError("no", "too_large", "files.info: the file is larger than this PC takes");
    const info = (await this.api("files.info", { file: file.fileRef }).catch((error: unknown) => {
      throw new ChannelSendError("no", "file_unavailable", error instanceof SlackRefusal ? error.message : "files.info: failed");
    })).file as Json | undefined;
    // A remote file (another app's address in it): the token must not go there.
    if (info?.is_external === true || info?.mode === "external") throw new ChannelSendError("no", "file_external", "files.info: a remote file");
    const address = String(info?.url_private_download ?? info?.url_private ?? "");
    if (!this.trusted(address)) throw new ChannelSendError("no", "file_unavailable", "files.info: no file address of Slack");
    if (Number(info?.size ?? 0) > this.limits.downloadBytes) throw new ChannelSendError("no", "too_large", "files.info: the file is larger than this PC takes");
    try {
      const response = await fetch(address, { headers: { authorization: `Bearer ${(await this.tokens()).bot}` }, signal: AbortSignal.timeout(120_000), redirect: "error" });
      // Slack answers a request it does not accept with its sign-in page, not an error.
      if (!response.ok || !response.body || /text\/html/i.test(response.headers.get("content-type") ?? "")) throw new Error(String(response.status));
      let size = 0;
      const limit = this.limits.downloadBytes;
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), async function* (source) {
        for await (const chunk of source) {
          size += (chunk as Buffer).length;
          if (size > limit) throw new ChannelSendError("no", "too_large", "download: the file grew larger than this PC takes");
          yield chunk;
        }
      }, createWriteStream(toPath, { mode: 0o600 }));
    } catch (error) {
      rmSync(toPath, { force: true });
      if (error instanceof ChannelSendError) throw error;
      throw new ChannelSendError("no", "file_unavailable", "download: the file could not be fetched");
    }
  }
}
