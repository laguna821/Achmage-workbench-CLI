import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

// For tests and the smoke only: a stand-in for Slack on 127.0.0.1. It answers the few Web API
// methods the adapter calls and runs a Socket Mode WebSocket that sends envelopes and expects
// acknowledgements. It can misbehave on request: fail the n-th call of a method, rate-limit, cut a
// connection before or after the work, drop the socket in the middle of an event, deliver an
// envelope again, refresh or disable the connection, report other connections. Nothing here
// contacts Slack.

type Json = Record<string, unknown>;
export type SlackCall = { method: string; params: Json; token: "bot" | "app" | null; at: number };
/** How one call answers: `refuse` ok:false with `error`, `limit` 429 with Retry-After, `busy` 500, `cut-before` / `cut-after` drop the connection before / after doing the work. */
export type SlackFault = { kind: "refuse"; error: string } | { kind: "limit" } | { kind: "busy" } | { kind: "cut-before" } | { kind: "cut-after" };
export type SlackMessage = { ts: string; channel: string; user?: string; bot_id?: string; text: string; blocks?: Json[]; files?: Json[]; subtype?: string; edited?: boolean };

/** Made-up tokens in the shapes Slack uses; they were never issued. */
export const FAKE_BOT_TOKEN = "xoxb-7000000001-7000000002-" + "Fk".repeat(6) + "LoopbackOnly01";
export const FAKE_APP_TOKEN = "xapp-1-A0FAKEAPP01-7000000003-" + "f0".repeat(16);

export class FakeSlack {
  readonly botToken: string;
  readonly appToken: string;
  readonly botId = "B0FAKEBOT01";
  readonly botUserId = "U0FAKEBOT01";
  readonly appId = "A0FAKEAPP01";
  readonly teamId = "T0FAKETEAM1";
  readonly team = "연구실";
  readonly calls: SlackCall[] = [];
  /** Every message in every conversation, as the conversation shows it now (edits applied), oldest first. */
  readonly messages: SlackMessage[] = [];
  /** Ephemeral lines (only the presser sees them). */
  readonly ephemeral: { channel: string; user: string; text: string }[] = [];
  /** Envelopes sent, and the ids acknowledged, in order. */
  readonly envelopes: { id: string; type: string; sentAt: number; ackedAt: number | null; body: Json }[] = [];
  /** What happened at the socket, in order (opened, hello, envelope, ack, closed), for tests of ordering. */
  readonly trail: string[] = [];
  /** Faults by method, first in first out: null lets that call through. `failAt(method, n, fault)` fails the n-th call from now. */
  readonly faults = new Map<string, (SlackFault | null)[]>();
  /** Retry-After of a 429, in seconds (not 1, so a test tells it from a fallback). */
  retryAfter = 7;
  /** Every call answers ok:false invalid_auth while set (the token was revoked). */
  revoked = false;
  /** apps.connections.open answers ok:false with this while set. */
  openRefusal: string | null = null;
  /** Reported in `hello` beside this stand-in's own sockets: connections of another program with the same app token. */
  others = 0;
  /** Envelopes not acknowledged when a socket closed are sent again on the next one (Slack's retry). */
  redeliverUnacked = true;
  /** The scopes auth.test reports in its header. */
  scopes = ["chat:write", "im:history", "files:read", "files:write", "users:read"];
  /** users.info answers after this long (a slow name lookup). */
  userDelayMs = 0;
  /** bots.info answers this app id (another app's bot token when changed). */
  botApp = "A0FAKEAPP01";
  url = "";
  /** Most sockets ever open at once. */
  maxOpen = 0;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly sockets = new Set<WebSocket>();
  private readonly tickets = new Set<string>();
  private nextTicket = 1;
  private lastSecond = 0;
  private nextSerial = 1;
  private nextEnvelope = 1;
  private nextFile = 1;
  private readonly files = new Map<string, { id: string; name: string; mimetype: string; bytes: Buffer; size: number; url?: string; external?: boolean }>();
  private readonly uploads = new Map<string, { name: string; length: number; bytes: Buffer | null }>();
  readonly shared: { id: string; name: string; title: string; channel: string; comment: string | null; bytes: number }[] = [];
  readonly users = new Map<string, Json>([
    ["U0HONG", { id: "U0HONG", team_id: "T0FAKETEAM1", name: "hong", real_name: "홍길동", profile: { display_name: "길동", real_name: "홍길동" } }],
    ["U0KIM", { id: "U0KIM", team_id: "T0FAKETEAM1", name: "kim", real_name: "김철수", profile: { display_name: "", real_name: "김철수" } }],
    // A person of another organisation who can reach the app through Slack Connect.
    ["U0EXT", { id: "U0EXT", team_id: "T0OTHERORG", name: "ext", real_name: "외부인", is_stranger: true, profile: { display_name: "외부", real_name: "외부인" } }],
  ]);

  constructor(botToken = FAKE_BOT_TOKEN, appToken = FAKE_APP_TOKEN) {
    this.botToken = botToken;
    this.appToken = appToken;
  }

  async start() {
    this.server = createServer((req, res) => { void this.handle(req, res).catch(() => { res.destroy(); }); });
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head));
    await new Promise<void>((done) => this.server!.listen(0, "127.0.0.1", done));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    this.wss?.close();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }

  get api() { return `${this.url}/api`; }

  // What a test makes happen at Slack

  /** The person writes in a conversation (a DM with the bot by default). Delivered over the socket when one is open; kept in the history either way. */
  /** `userTeam`: the sender's own organisation as a shared conversation's event carries it (Slack's `user_team`; absent by default). */
  message(text: string, options: { user?: string; channel?: string; channelType?: string; files?: Json[]; subtype?: string; ts?: string; deliver?: boolean; team?: string; userTeam?: string } = {}): SlackMessage & { envelopeId: string | null } {
    const user = options.user ?? "U0HONG", channel = options.channel ?? `D${user.slice(1)}`;
    const message: SlackMessage = { ts: options.ts ?? this.ts(), channel, user, text, ...(options.files ? { files: options.files } : {}), ...(options.subtype ? { subtype: options.subtype } : {}) };
    this.messages.push(message);
    const event = { type: "message", channel, user, text, ts: message.ts, channel_type: options.channelType ?? (channel.startsWith("D") ? "im" : "channel"), ...(options.files ? { files: options.files } : {}), ...(options.subtype ? { subtype: options.subtype } : {}), ...(options.userTeam ? { user_team: options.userTeam } : {}) };
    const envelopeId = options.deliver === false ? null : this.send("events_api", { type: "event_callback", team_id: options.team ?? this.teamId, api_app_id: this.appId, event, event_id: `Ev${message.ts.replace(".", "")}`, event_time: Math.floor(Number(message.ts)) });
    return { ...message, envelopeId };
  }

  /** A file at Slack that a message can carry; `reported`: the size files.info says; `url`: where files.info says it is. */
  file(name: string, bytes: Buffer, options: { mimetype?: string; reported?: number; url?: string; external?: boolean } = {}): Json {
    const id = `F0FILE${this.nextFile++}`;
    this.files.set(id, { id, name, mimetype: options.mimetype ?? "application/octet-stream", bytes, size: options.reported ?? bytes.length, ...(options.url ? { url: options.url } : {}), ...(options.external ? { external: true } : {}) });
    return { id, name, title: name, mimetype: options.mimetype ?? "application/octet-stream", size: options.reported ?? bytes.length, url_private_download: `${this.url}/files-pri/${id}/${encodeURIComponent(name)}` };
  }

  /** The person presses a button (by its value) on a message. */
  /**
   * The person presses a button (by its value) on a message. The payload has Slack's shape: `user` is
   * who pressed, `message` is the message the button sits on — the bot's own (its `user` is the bot).
   */
  press(value: string, options: { user?: string; channel?: string; messageTs?: string; actionId?: string; team?: string } = {}) {
    const user = options.user ?? "U0HONG", channel = options.channel ?? `D${user.slice(1)}`, team = options.team ?? this.teamId;
    const shown = this.messages.find((entry) => entry.ts === options.messageTs);
    return this.send("interactive", {
      type: "block_actions", user: { id: user, username: String(this.users.get(user)?.name ?? user), team_id: String(this.users.get(user)?.team_id ?? team) }, team: { id: team }, api_app_id: this.appId,
      channel: { id: channel, name: "directmessage" }, container: { type: "message", message_ts: options.messageTs ?? "0", channel_id: channel, is_ephemeral: false },
      message: { type: "message", ts: options.messageTs ?? "0", user: this.botUserId, bot_id: this.botId, text: shown?.text ?? "", blocks: shown?.blocks ?? [] },
      trigger_id: `trig-${this.nextEnvelope}`, response_url: `${this.url}/respond`,
      actions: [{ type: "button", action_id: options.actionId ?? "b0_0", block_id: "r0", value, action_ts: this.ts() }],
    });
  }

  /** A modal is submitted (the slot for units 7–8). */
  submitView(values: Json, user = "U0HONG") {
    return this.send("interactive", { type: "view_submission", user: { id: user }, view: { id: "V0VIEW", callback_id: "secret", private_metadata: "", state: { values } } });
  }

  /** An envelope of any type (an event the adapter ignores, a slash command). */
  raw(type: string, payload: Json) { return this.send(type, payload); }

  /** The same envelope again (an acknowledgement Slack did not see in time). */
  redeliver(envelopeId: string) {
    const sent = this.envelopes.find((entry) => entry.id === envelopeId);
    if (!sent) throw new Error("no such envelope");
    const body = { ...sent.body, retry_attempt: Number(sent.body.retry_attempt ?? 0) + 1, retry_reason: "timeout" };
    this.envelopes.push({ id: envelopeId, type: sent.type, sentAt: Date.now(), ackedAt: null, body });
    for (const socket of this.sockets) socket.send(JSON.stringify(body));
    this.trail.push(`envelope ${envelopeId}`);
  }

  /** The socket closes right after this envelope went out, before its acknowledgement can come back. */
  dropAfter(envelopeId: string) {
    this.trail.push(`drop ${envelopeId}`);
    for (const socket of this.sockets) socket.terminate();
  }

  /** "refresh_requested": Slack wants this connection replaced, and closes it soon after. */
  refresh() { this.disconnect("refresh_requested"); }
  /** About ten seconds before Slack closes the connection. */
  warn() { for (const socket of this.sockets) socket.send(JSON.stringify({ type: "disconnect", reason: "warning", debug_info: { host: "stand-in" } })); }
  /** Socket Mode was turned off for the app. */
  linkDisabled() { this.disconnect("link_disabled"); }
  /** The connection goes silent: pings are not answered, nothing is sent. */
  freeze() { for (const socket of this.sockets) (socket as unknown as { _socket: Duplex })._socket.pause(); }
  /** Close every socket without a word (a network cut). */
  cut() { for (const socket of this.sockets) socket.terminate(); }
  open() { return this.sockets.size; }

  /** Fail the n-th call (1 = the next) of a method from now. */
  failAt(method: string, n: number, fault: SlackFault) {
    const list = this.faults.get(method) ?? [];
    while (list.length < n - 1) list.push(null);
    list[n - 1] = fault;
    this.faults.set(method, list);
  }

  // What a test reads back

  of(method: string) { return this.calls.filter((call) => call.method === method); }
  /** What the bot posted to a conversation, as each message reads now. */
  posted(channel = "D0HONG") { return this.messages.filter((message) => message.channel === channel && message.bot_id).map((message) => message.text); }
  /** The bot's messages' texts in the order they were first posted (raw mrkdwn). */
  texts(channel = "D0HONG") { return this.of("chat.postMessage").filter((call) => call.params.channel === channel).map((call) => String(call.params.text)); }
  /** A button with this label as the conversation shows it now, and the message it sits on. */
  button(label: string, channel = "D0HONG"): { value: string; ts: string; actionId: string } {
    for (const message of [...this.messages].reverse()) {
      if (message.channel !== channel || !message.bot_id) continue;
      for (const block of message.blocks ?? []) {
        if (block.type !== "actions") continue;
        for (const element of block.elements as Json[]) {
          if ((element.text as Json).text === label) return { value: String(element.value), ts: message.ts, actionId: String(element.action_id) };
        }
      }
    }
    throw new Error(`no button labelled ${label}`);
  }
  /** Every button label a message shows now. */
  labels(ts: string): string[] {
    const message = this.messages.find((entry) => entry.ts === ts);
    return (message?.blocks ?? []).filter((block) => block.type === "actions").flatMap((block) => (block.elements as Json[]).map((element) => String((element.text as Json).text)));
  }
  /** What a message shows now. */
  shown(ts: string): string | null { return this.messages.find((message) => message.ts === ts)?.text ?? null; }
  acked(envelopeId: string) { return this.envelopes.filter((entry) => entry.id === envelopeId).some((entry) => entry.ackedAt !== null); }

  // Inside

  /** A message time as Slack writes it (seconds.serial), now, and always later than the one before. */
  private ts() {
    this.lastSecond = Math.max(Math.floor(Date.now() / 1000), this.lastSecond);
    return `${this.lastSecond}.${String(this.nextSerial++).padStart(6, "0")}`;
  }

  private send(type: string, payload: Json): string {
    const id = `env-${this.nextEnvelope++}`;
    const body: Json = { envelope_id: id, type, payload, accepts_response_payload: type !== "events_api", retry_attempt: 0, retry_reason: "" };
    this.envelopes.push({ id, type, sentAt: Date.now(), ackedAt: null, body });
    for (const socket of this.sockets) socket.send(JSON.stringify(body));
    this.trail.push(`envelope ${id}`);
    return id;
  }

  private disconnect(reason: string) {
    for (const socket of this.sockets) {
      socket.send(JSON.stringify({ type: "disconnect", reason, debug_info: { host: "stand-in" } }));
      setTimeout(() => socket.close(), 30);
    }
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const ticket = url.searchParams.get("ticket") ?? "";
    if (url.pathname !== "/link" || !this.tickets.delete(ticket)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return void socket.destroy();
    }
    this.wss!.handleUpgrade(req, socket, head, (ws) => {
      this.sockets.add(ws);
      this.maxOpen = Math.max(this.maxOpen, this.sockets.size);
      this.trail.push("opened");
      ws.on("message", (data) => {
        let parsed: Json;
        try { parsed = JSON.parse(String(data)) as Json; } catch { return; }
        const id = String(parsed.envelope_id ?? "");
        const sent = [...this.envelopes].reverse().find((entry) => entry.id === id && entry.ackedAt === null) ?? this.envelopes.find((entry) => entry.id === id);
        if (sent && sent.ackedAt === null) sent.ackedAt = Date.now();
        this.trail.push(`ack ${id}`);
      });
      ws.on("close", () => { this.sockets.delete(ws); this.trail.push("closed"); });
      ws.send(JSON.stringify({ type: "hello", num_connections: this.sockets.size + this.others, debug_info: { host: "stand-in", approximate_connection_time: 18_060 }, connection_info: { app_id: this.appId } }));
      this.trail.push("hello");
      if (this.redeliverUnacked) {
        const waiting = new Map<string, Json>();
        for (const entry of this.envelopes) if (!this.acked(entry.id)) waiting.set(entry.id, entry.body);
        for (const [id, body] of waiting) {
          const again = { ...body, retry_attempt: Number(body.retry_attempt ?? 0) + 1, retry_reason: "timeout" };
          this.envelopes.push({ id, type: String(body.type), sentAt: Date.now(), ackedAt: null, body: again });
          ws.send(JSON.stringify(again));
          this.trail.push(`envelope ${id}`);
        }
      }
    });
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  private reply(res: ServerResponse, status: number, body: Json, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? null;
    const download = /^\/files-pri\/([^/]+)\/.+$/.exec(url.pathname);
    if (download) {
      this.calls.push({ method: "download", params: { id: download[1] }, token: auth === this.botToken ? "bot" : null, at: Date.now() });
      const entry = this.files.get(download[1]!);
      // Without the bot token Slack answers with its sign-in page, not the file.
      if (auth !== this.botToken || !entry) {
        res.writeHead(200, { "content-type": "text/html" });
        return void res.end("<html>sign in</html>");
      }
      res.writeHead(200, { "content-type": entry.mimetype, "content-length": String(entry.bytes.length) });
      return void res.end(entry.bytes);
    }
    const upload = /^\/upload\/([^/]+)$/.exec(url.pathname);
    if (upload) {
      const raw = await this.body(req);
      const fault = this.fault("upload");
      this.calls.push({ method: "upload", params: { id: upload[1], bytes: raw.length, authorization: auth !== null }, token: null, at: Date.now() });
      const entry = this.uploads.get(upload[1]!);
      if (fault?.kind === "busy" || !entry) { res.writeHead(500); return void res.end("error"); }
      // The bytes as they are (Slack also takes a multipart form; this stand-in only the raw body).
      if (fault?.kind === "cut-before" || fault?.kind === "cut-after") return void req.socket.destroy();
      entry.bytes = raw;
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end(`OK - ${raw.length}`);
    }
    const method = /^\/api\/([A-Za-z.]+)$/.exec(url.pathname)?.[1];
    if (!method) { res.writeHead(404); return void res.end(); }
    const raw = (await this.body(req)).toString("utf8");
    const params: Json = Object.fromEntries(new URLSearchParams(String(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded") ? raw : url.search));
    const token = auth === this.botToken ? "bot" : auth === this.appToken ? "app" : null;
    this.calls.push({ method, params, token, at: Date.now() });
    const fault = this.fault(method);
    if (fault?.kind === "cut-before") { this.calls.pop(); return void req.socket.destroy(); }
    if (fault?.kind === "busy") { this.calls.pop(); res.writeHead(500, { "content-type": "text/html" }); return void res.end("<html>server error</html>"); }
    if (fault?.kind === "limit") { this.calls.pop(); return this.reply(res, 429, { ok: false, error: "ratelimited" }, { "retry-after": String(this.retryAfter) }); }
    if (fault?.kind === "refuse") { this.calls.pop(); return this.reply(res, 200, { ok: false, error: fault.error }); }
    const ok = (body: Json, headers: Record<string, string> = {}) => {
      if (fault?.kind === "cut-after") return void req.socket.destroy();
      this.reply(res, 200, { ok: true, ...body }, headers);
    };
    const refuse = (error: string) => this.reply(res, 200, { ok: false, error });
    if (method === "apps.connections.open") {
      if (token !== "app") return refuse(token === "bot" ? "not_allowed_token_type" : "invalid_auth");
      if (this.revoked) return refuse("invalid_auth");
      if (this.openRefusal) return refuse(this.openRefusal);
      const ticket = `t${this.nextTicket++}`;
      this.tickets.add(ticket);
      return ok({ url: `${this.url.replace(/^http/, "ws")}/link?ticket=${ticket}&app_id=${this.appId}` });
    }
    if (token !== "bot" || this.revoked) return refuse(token === "app" ? "not_allowed_token_type" : "invalid_auth");
    switch (method) {
      case "auth.test":
        return ok({ url: "https://stand-in.slack.invalid/", team: this.team, user: "workbench", team_id: this.teamId, user_id: this.botUserId, bot_id: this.botId, is_enterprise_install: false }, { "x-oauth-scopes": this.scopes.join(",") });
      case "bots.info":
        return ok({ bot: { id: params.bot, app_id: this.botApp, user_id: this.botUserId, name: "workbench" } });
      case "users.info": {
        if (this.userDelayMs) await new Promise((done) => setTimeout(done, this.userDelayMs));
        const user = this.users.get(String(params.user));
        return user ? ok({ user }) : refuse("user_not_found");
      }
      case "chat.postMessage": {
        const message: SlackMessage = { ts: this.ts(), channel: String(params.channel), bot_id: this.botId, text: String(params.text ?? ""), ...(params.blocks ? { blocks: JSON.parse(String(params.blocks)) as Json[] } : {}) };
        if (!message.channel.startsWith("D") && !message.channel.startsWith("C")) return refuse("channel_not_found");
        this.messages.push(message);
        return ok({ channel: message.channel, ts: message.ts, message: { text: message.text } });
      }
      case "chat.update": {
        const message = this.messages.find((entry) => entry.ts === params.ts && entry.channel === params.channel);
        if (!message || !message.bot_id) return refuse(message ? "cant_update_message" : "message_not_found");
        message.text = String(params.text ?? "");
        message.blocks = params.blocks ? (JSON.parse(String(params.blocks)) as Json[]) : [];
        message.edited = true;
        return ok({ channel: message.channel, ts: message.ts });
      }
      case "chat.delete": {
        const at = this.messages.findIndex((entry) => entry.ts === params.ts && entry.channel === params.channel);
        if (at < 0) return refuse("message_not_found");
        if (!this.messages[at]!.bot_id) return refuse("cant_delete_message");
        this.messages.splice(at, 1);
        return ok({ channel: params.channel, ts: params.ts });
      }
      case "chat.postEphemeral":
        this.ephemeral.push({ channel: String(params.channel), user: String(params.user), text: String(params.text) });
        return ok({ message_ts: this.ts() });
      case "conversations.history": {
        const oldest = Number(params.oldest ?? 0), limit = Number(params.limit ?? 100);
        const all = this.messages.filter((message) => message.channel === params.channel && Number(message.ts) > oldest).reverse();
        const from = Number(params.cursor ?? 0);
        const page = all.slice(from, from + limit).map((message) => ({ type: "message", ...message, channel: undefined }));
        const more = from + limit < all.length;
        return ok({ messages: page, has_more: more, ...(more ? { response_metadata: { next_cursor: String(from + limit) } } : {}) });
      }
      case "files.info": {
        const entry = this.files.get(String(params.file));
        return entry ? ok({ file: { id: entry.id, name: entry.name, mimetype: entry.mimetype, size: entry.size, ...(entry.external ? { mode: "external", is_external: true } : {}), url_private_download: entry.url ?? `${this.url}/files-pri/${entry.id}/${encodeURIComponent(entry.name)}` } }) : refuse("file_not_found");
      }
      case "files.getUploadURLExternal": {
        const id = `F0UP${this.nextFile++}`;
        this.uploads.set(id, { name: String(params.filename), length: Number(params.length), bytes: null });
        return ok({ upload_url: `${this.url}/upload/${id}`, file_id: id });
      }
      case "files.completeUploadExternal": {
        const list = JSON.parse(String(params.files ?? "[]")) as { id: string; title?: string }[];
        for (const item of list) {
          const entry = this.uploads.get(item.id);
          if (!entry?.bytes) return refuse("file_not_found");
        }
        for (const item of list) {
          const entry = this.uploads.get(item.id)!;
          this.shared.push({ id: item.id, name: entry.name, title: item.title ?? entry.name, channel: String(params.channel_id), comment: params.initial_comment === undefined ? null : String(params.initial_comment), bytes: entry.bytes!.length });
          this.messages.push({ ts: this.ts(), channel: String(params.channel_id), bot_id: this.botId, text: String(params.initial_comment ?? ""), files: [{ id: item.id, name: entry.name }] });
        }
        return ok({ files: list.map((item) => ({ id: item.id, title: item.title })) });
      }
      default:
        return refuse("unknown_method");
    }
  }

  private fault(method: string): SlackFault | null {
    const list = this.faults.get(method);
    if (!list?.length) return null;
    return list.shift() ?? null;
  }
}
