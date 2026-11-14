import type { IncomingMessage, ServerResponse } from "node:http";
import QRCode from "qrcode";
import type { ChannelBinding, ChannelBot, ChannelKind, ChannelPairingLink, ChannelsState } from "@workbench/contracts";
import type { EventBus } from "../bus.ts";
import { HttpError } from "../errors.ts";
import { readBody, sendJson } from "../http.ts";
import { OfficeVault } from "../office-vault.ts";
import type { Projects } from "../project.ts";
import type { SessionManager } from "../sessions.ts";
import type { Store } from "../store.ts";
import { ChannelCore } from "./core.ts";
import { ChannelLog, fileLog } from "./log.ts";
import { Redactor } from "./redact.ts";
import { ChannelSecrets } from "./secrets.ts";
import type { Binding } from "./store.ts";
import { SLACK_API, SlackAdapter, identifySlack, type SlackOptions } from "./slack.ts";
import type { CredentialService } from "../credentials/service.ts";
import { VaultChat, VaultRedactor } from "./vault-chat.ts";
import { LoginChat } from "./login-chat.ts";
import type { LoginFiller } from "../credentials/fill.ts";
import { TELEGRAM_API, TelegramAdapter, identifyTelegram, type TelegramOptions } from "./telegram.ts";

// The channel as the gateway runs it and as the PC screen reaches it: the registered bot, its
// sealed token, its connection, and the routes under /api/channels. The gateway starts it after
// its other services and closes it with them (see `start` / `close`).

/** Slack: `id` is the bot id, `username` the bot user's name, `name` the workspace; `userId` the bot's own user, `teamId`/`appId` for the link that opens its DM. */
type BotRecord = { kind: ChannelKind; id: string; username: string; name: string; createdAt: number; teamId?: string; userId?: string; appId?: string | null; appName?: string };

const BOTS = "channel.bots";
/** Slack apps are kept apart from the bots: an older gateway reads `channel.bots` as Telegram bots only, and never sees these. */
const SLACK_BOTS = "channel.slack";
const NO_TOKEN = "토큰을 다시 넣어 주세요.";
const DESCRIPTION = "이 봇은 PC가 켜져 있을 때 답합니다.";

export type ChannelServiceOptions = {
  dataDir: string;
  store: Store;
  manager: SessionManager;
  bus: EventBus;
  /** The existing vault (the OS keyring holds its key). Tests pass a stand-in. */
  vault?: OfficeVault;
  /** The project notes (project.ts): the menu's 프로젝트 노트 writes through them. */
  projects?: Projects;
  /** The Bot API address. The real one by default; tests point it at a stand-in on 127.0.0.1. */
  telegramUrl?: string;
  /** The credential store ("비밀 보관함"): its routes are under /api/channels/credentials. */
  credentials?: CredentialService;
  /** The sealed Mini App form's address (HTTPS). None by default: values typed in the chat are taken and deleted at once. */
  sealPage?: string | null;
  /** Unit 9: stored logins typed by the gateway (credentials/fill.ts); its hand-overs and second factors in the chat. */
  logins?: LoginFiller;
  /** Where log lines go; `<data>/channels/channel.log` by default. */
  log?: (line: string) => void;
  /** Timing of the Telegram adapter (tests shorten it). */
  telegram?: Pick<TelegramOptions, "pollSeconds" | "minSendGapMs" | "sleep" | "random">;
  /** Slack's Web API address. The real one by default; tests point it at a stand-in on 127.0.0.1. */
  slackUrl?: string;
  /** Timing of the Slack adapter (tests shorten it). */
  slack?: Pick<SlackOptions, "minSendGapMs" | "pingMs" | "sleep" | "random">;
  /** How the PC's waking is noticed: the wall clock is read every `everyMs` (tests pass their own clock). */
  wake?: { everyMs: number; now: () => number };
};

/** A tick that came this much later than due means the PC slept (timers stand still while it does). */
const WAKE_SLACK = 30_000;

export class ChannelService {
  readonly core: ChannelCore;
  private readonly options: ChannelServiceOptions;
  private readonly secrets: ChannelSecrets;
  private readonly log: ChannelLog;
  /** The credential store in the chat; its secret input is asked about every received message. */
  private vault: VaultChat | null = null;
  /** The Bot API address this service talks to. */
  readonly telegramApi: string;
  readonly slackApi: string;
  private wakeTimer: NodeJS.Timeout | null = null;
  /** Between `start` and `close` of the gateway. The core itself runs only while a bot is registered. */
  private started = false;
  /** Raised by `close`: a start still under way stops at its next step. */
  private generation = 0;
  /**
   * A Slack app's open pairing window: its one-time value, in memory only (never written), so that a
   * bare "연결" in the app's DM can present it for the person (ruling of unit 12, fix round 1).
   */
  private readonly windows = new Map<string, { code: string; expiresAt: number }>();

  constructor(options: ChannelServiceOptions) {
    this.options = options;
    // Stored credential values are hidden in the log and in what is sent, as the bot token is.
    const redactor = options.credentials ? new VaultRedactor(options.credentials.scrubber) : new Redactor();
    this.secrets = new ChannelSecrets(options.dataDir, options.vault ?? new OfficeVault(options.dataDir), redactor);
    this.log = new ChannelLog(redactor, options.log ?? fileLog(options.dataDir));
    this.telegramApi = (options.telegramUrl ?? TELEGRAM_API).replace(/\/+$/, "");
    this.slackApi = (options.slackUrl ?? SLACK_API).replace(/\/+$/, "");
    this.core = new ChannelCore({ store: options.store, manager: options.manager, bus: options.bus, log: this.log, projects: () => options.projects ?? null, dataDir: options.dataDir });
    if (options.credentials) {
      const vault = { service: options.credentials, manager: options.manager, store: options.store, sealPage: options.sealPage ?? null };
      this.vault = options.logins ? new LoginChat({ ...vault, logins: options.logins }) : new VaultChat(vault);
      this.core.use(this.vault);
    }
  }

  private bots(): BotRecord[] {
    return [...JSON.parse(this.options.store.getMeta(BOTS) ?? "[]") as BotRecord[], ...JSON.parse(this.options.store.getMeta(SLACK_BOTS) ?? "[]") as BotRecord[]];
  }

  private saveBots(bots: BotRecord[]) {
    this.options.store.setMeta(BOTS, JSON.stringify(bots.filter((bot) => bot.kind === "telegram")));
    const slack = bots.filter((bot) => bot.kind === "slack");
    // Written only once Slack was ever registered: a Telegram-only PC gets no new key.
    if (slack.length || this.options.store.getMeta(SLACK_BOTS) !== null) this.options.store.setMeta(SLACK_BOTS, JSON.stringify(slack));
  }

  private secretId(bot: Pick<BotRecord, "kind" | "id">) {
    return `${bot.kind}:${bot.id}`;
  }

  /** Every sealed value of a bot: Telegram's one token, Slack's bot token and app-level token. */
  private secretIds(bot: Pick<BotRecord, "kind" | "id">) {
    return bot.kind === "slack" ? [`slack:${bot.id}:bot`, `slack:${bot.id}:app`] : [this.secretId(bot)];
  }

  /** How a bot's tokens are held: all of them, or it has none to run with. */
  private held(bot: Pick<BotRecord, "kind" | "id">): "sealed" | "memory" | "none" {
    const holds = this.secretIds(bot).map((id) => this.secrets.held(id));
    return holds.includes("none") ? "none" : holds.includes("memory") ? "memory" : "sealed";
  }

  private requireBot(kind: string, botId: string): BotRecord {
    const bot = this.bots().find((entry) => entry.kind === kind && entry.id === botId);
    if (!bot) throw new HttpError(404, "channel_bot_missing", "등록한 봇이 없습니다.");
    return bot;
  }

  private changed() {
    this.options.bus.publish({ type: "channels.changed" });
  }

  /** (Re)connect a bot with the token it holds; a bot without one stays off until the token is entered again. */
  private async connect(bot: BotRecord) {
    await this.core.detach(bot.kind, bot.id);
    if (this.held(bot) === "none") return null;
    if (bot.kind === "slack") {
      const [botSecret, appSecret] = this.secretIds(bot) as [string, string];
      const slack = new SlackAdapter({
        botId: bot.id,
        ...(bot.teamId ? { teamId: bot.teamId } : {}),
        pairing: () => this.pairingWindow(bot),
        botUserId: bot.userId ?? "",
        tokens: async () => ({ bot: await this.secrets.reveal(botSecret), app: await this.secrets.reveal(appSecret) }),
        baseUrl: this.slackApi,
        journal: this.options.store.channels,
        log: this.log,
        onStatus: () => this.changed(),
        ...this.options.slack,
      });
      this.core.attach(slack);
      return slack;
    }
    const adapter = new TelegramAdapter({
      botId: bot.id,
      token: () => this.secrets.reveal(this.secretId(bot)),
      baseUrl: this.telegramApi,
      journal: this.options.store.channels,
      log: this.log,
      onStatus: () => this.changed(),
      ...(this.vault?.windows ? { divert: this.vault.windows.divert, press: this.vault.windows.press } : {}),
      ...this.options.telegram,
    });
    this.core.attach(adapter);
    return adapter;
  }

  /**
   * With the gateway: every registered bot that holds a token starts receiving. With no bot
   * registered nothing happens at all (no file, no listener, no hook, no timer): the core starts
   * with the first registration and stops when the last bot is removed.
   */
  async start() {
    this.started = true;
    if (this.bots().length) await this.run(this.generation);
  }

  /**
   * Stops receiving at once. A start still under way (connecting, handing over answers owed from
   * before, each a network send) is not waited for: it notices at its next step and stops there.
   */
  async close() {
    this.started = false;
    this.generation += 1;
    this.stopWake();
    await this.core.close();
  }

  private async run(generation: number) {
    const cancelled = () => generation !== this.generation;
    this.log.note("channel_started");
    for (const bot of this.bots()) {
      if (cancelled()) return;
      await this.connect(bot);
    }
    if (cancelled()) return;
    await this.core.start();
    // Closed while the core was starting: what that start armed is undone.
    if (cancelled()) return void (await this.core.close());
    this.watchWake();
  }

  private stopWake() {
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.wakeTimer = null;
  }

  /**
   * After the PC slept, the long poll that was open may hang on a dead connection until its own
   * timeout (and the timers did not run during the sleep). When the wall clock shows a jump, every
   * bot that was connected or reconnecting starts a fresh poll at once. Armed only while the core runs.
   */
  private watchWake() {
    if (this.wakeTimer) return;
    const { everyMs, now } = this.options.wake ?? { everyMs: 10_000, now: Date.now };
    let last = now();
    this.wakeTimer = setInterval(() => {
      const at = now(), slept = at - last > everyMs + WAKE_SLACK;
      last = at;
      if (!slept) return;
      this.log.note("woke");
      void (async () => {
        for (const bot of this.bots()) {
          const state = this.core.status(bot.kind, bot.id).state;
          if (state === "connected" || state === "retrying") await this.connect(bot);
        }
        this.changed();
      })().catch((error: unknown) => this.log.note("wake_failed", error));
    }, everyMs);
    this.wakeTimer.unref();
  }

  private toBinding(binding: Binding): ChannelBinding {
    const { prefs: _prefs, ...shown } = binding;
    return { ...shown, pointerLabel: this.core.pointerLabel(binding), undelivered: this.core.undelivered(binding.id), uncertain: this.core.uncertain(binding.id) };
  }

  state(): ChannelsState {
    const bindings = this.core.bindings();
    const bots: ChannelBot[] = this.bots().map((bot) => {
      const token = this.held(bot);
      return {
        ...bot,
        token,
        status: token === "none" ? { state: "stopped", detail: NO_TOKEN } : this.core.status(bot.kind, bot.id),
        pairing: this.core.pairing(bot.kind, bot.id),
        bindings: bindings.filter((binding) => binding.kind === bot.kind && binding.botId === bot.id && !binding.revokedAt).map((binding) => this.toBinding(binding)),
      };
    });
    return { bots };
  }

  /**
   * Register a Telegram bot by its token, or give a registered bot a new token ("토큰 바꾸기"). The
   * token is checked with getMe, then sealed; without an OS keyring nothing is stored (the vault's
   * 503) unless `memoryOnly` keeps it for this run. The token is never returned.
   */
  async registerTelegram(token: unknown, options: { memoryOnly?: boolean } = {}): Promise<ChannelsState> {
    if (typeof token !== "string") throw new HttpError(400, "channel_token_invalid", "봇 토큰을 넣어 주세요.");
    const me = await identifyTelegram(token, this.telegramApi);
    const bots = this.bots();
    if (bots.some((bot) => bot.id !== me.id)) throw new HttpError(409, "channel_bot_exists", "이미 등록한 봇이 있습니다. 다른 봇을 쓰려면 먼저 지금 봇을 지워 주세요.");
    const known = bots.find((bot) => bot.id === me.id);
    const record: BotRecord = { kind: "telegram", id: me.id, username: me.username, name: me.name, createdAt: known?.createdAt ?? Date.now() };
    await this.secrets.keep(this.secretId(record), token.trim(), options);
    this.saveBots([...bots.filter((bot) => bot.id !== me.id), record]);
    this.options.store.channels.audit({ at: Date.now(), bindingId: null, kind: "telegram", action: known ? "token.replaced" : "bot.registered", target: `bot:${me.id}`, result: options.memoryOnly ? "memory" : "sealed" });
    this.log.note(known ? "token_replaced" : "bot_registered");
    const adapter = await this.connect(record);
    // The first bot: the channel starts now (it was not started with the gateway).
    if (this.started && !this.core.running) {
      this.log.note("channel_started");
      const generation = this.generation;
      await this.core.start();
      if (generation !== this.generation || !this.bots().length) await this.core.close();
      else this.watchWake();
    }
    // Shown before a person starts the bot. Not worth failing a registration over.
    if (adapter instanceof TelegramAdapter) void adapter.describe(DESCRIPTION).catch((error: unknown) => this.log.note("describe_failed", error));
    this.changed();
    return this.state();
  }

  /**
   * Register a Slack app by its two tokens, or give a registered one new tokens ("토큰 바꾸기"). Both
   * are checked (auth.test; a Socket Mode address for the app token), then sealed apart; without an
   * OS keyring nothing is stored unless `memoryOnly` keeps them for this run. Neither is returned.
   * One messenger at a time: refused while a Telegram bot (or another Slack app) is registered.
   */
  async registerSlack(botToken: unknown, appToken: unknown, options: { memoryOnly?: boolean; appName?: unknown } = {}): Promise<ChannelsState> {
    if (typeof botToken !== "string" || typeof appToken !== "string" || !botToken.trim() || !appToken.trim()) throw new HttpError(400, "channel_token_invalid", "봇 토큰과 앱 토큰을 모두 넣어 주세요.");
    const me = await identifySlack(botToken, appToken, this.slackApi);
    const bots = this.bots();
    if (bots.some((bot) => bot.kind !== "slack" || bot.id !== me.id)) throw new HttpError(409, "channel_bot_exists", "이미 등록한 메신저가 있습니다. 메신저는 한 번에 하나만 연결합니다. 바꾸려면 먼저 지금 등록을 지워 주세요.");
    const known = bots.find((bot) => bot.kind === "slack" && bot.id === me.id);
    // The name typed in the wizard (shown only on the PC: what to search for in Slack); new tokens keep the old one.
    const typed = typeof options.appName === "string" ? options.appName.replace(/[\p{Cc}\p{Cf}]+/gu, "").replace(/\s+/gu, " ").trim().slice(0, 35) : "";
    const appName = typed || known?.appName;
    const record: BotRecord = { kind: "slack", id: me.id, username: me.username, name: me.name, createdAt: known?.createdAt ?? Date.now(), teamId: me.teamId, userId: me.userId, appId: me.appId, ...(appName ? { appName } : {}) };
    const [botSecret, appSecret] = this.secretIds(record) as [string, string];
    try {
      await this.secrets.keep(botSecret, botToken.trim(), options);
      await this.secrets.keep(appSecret, appToken.trim(), options);
    } catch (error) {
      // Not half kept: a new app keeps neither token when the second could not be sealed.
      if (!known) for (const id of [botSecret, appSecret]) this.secrets.forget(id);
      throw error;
    }
    this.saveBots([...bots.filter((bot) => !(bot.kind === "slack" && bot.id === me.id)), record]);
    this.options.store.channels.audit({ at: Date.now(), bindingId: null, kind: "slack", action: known ? "token.replaced" : "bot.registered", target: `bot:${me.id}`, result: options.memoryOnly ? "memory" : "sealed" });
    this.log.note(known ? "token_replaced" : "bot_registered");
    await this.connect(record);
    if (this.started && !this.core.running) {
      this.log.note("channel_started");
      const generation = this.generation;
      await this.core.start();
      if (generation !== this.generation || !this.bots().length) await this.core.close();
      else this.watchWake();
    }
    this.changed();
    return this.state();
  }

  /**
   * The window a bare "연결" may use: open while the core's one-time value is live (no phone yet) or a
   * phone's request waits; closed once approved, declined, cancelled or expired.
   */
  private pairingWindow(bot: BotRecord): { value: string } | null {
    const window = this.windows.get(this.secretId(bot));
    if (!window || window.expiresAt <= Date.now()) return null;
    const pairing = this.core.pairing(bot.kind, bot.id);
    if (!pairing.expiresAt && !pairing.request) return null;
    return { value: window.code };
  }

  /** Remove a bot: its chats are disconnected, its token forgotten, its connection closed. */
  async removeBot(kind: string, botId: string): Promise<ChannelsState> {
    const bot = this.requireBot(kind, botId);
    for (const binding of this.core.bindings()) if (binding.kind === bot.kind && binding.botId === bot.id && !binding.revokedAt) this.core.revoke(binding.id);
    await this.core.detach(bot.kind, bot.id);
    this.core.resetPairing(bot.kind, bot.id);
    for (const id of this.secretIds(bot)) this.secrets.forget(id);
    this.windows.delete(this.secretId(bot));
    this.saveBots(this.bots().filter((entry) => !(entry.kind === bot.kind && entry.id === bot.id)));
    this.options.store.channels.audit({ at: Date.now(), bindingId: null, kind: bot.kind, action: "bot.removed", target: `bot:${bot.id}` });
    // The last bot gone: the channel stops listening, hooking and ticking.
    if (!this.bots().length) {
      this.stopWake();
      await this.core.close();
    }
    this.changed();
    return this.state();
  }

  /** "다시 연결": after a conflict went away, or the keyring was unlocked. */
  async reconnect(kind: string, botId: string): Promise<ChannelsState> {
    await this.connect(this.requireBot(kind, botId));
    this.changed();
    return this.state();
  }

  /** The link the phone opens to pair. It carries the one-time value: returned once, for the QR, and never kept. */
  async beginPairing(kind: string, botId: string, options: { additional?: boolean } = {}): Promise<ChannelPairingLink> {
    const bot = this.requireBot(kind, botId);
    const { code, expiresAt } = this.core.beginPairing(bot.kind, bot.id, options);
    // Slack has no start value in a link: the person sends "연결" (or this whole line) in the app's DM. No
    // picture. `open`: the workspace in the browser, where the app is found by searching its name.
    if (bot.kind === "slack") {
      this.windows.set(this.secretId(bot), { code, expiresAt });
      return { link: "", qr: "", say: `연결 ${code}`, open: bot.teamId ? `https://app.slack.com/client/${encodeURIComponent(bot.teamId)}` : null, expiresAt };
    }
    const link = `https://t.me/${bot.username}?start=${code}`;
    // Drawn here, with the gateway's QR library, so the screen needs none.
    const svg = await QRCode.toString(link, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
    return { link, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, expiresAt };
  }

  /**
   * The routes of the "휴대폰 메신저" screen, behind the gateway's local token like its other
   * management routes. Returns false for a path that is not the channel's.
   */
  async handleManagement(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    if (parts[0] !== "api" || parts[1] !== "channels") return false;
    if (parts[2] === "credentials" && this.options.credentials) {
      await this.options.credentials.handle(req, res, parts);
      return true;
    }
    const method = req.method ?? "GET";
    const body = async (): Promise<Record<string, unknown>> => {
      const raw = (await readBody(req, 16_384)).toString("utf8");
      let parsed: unknown;
      try { parsed = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, "channel_input", "요청 형식이 올바르지 않습니다."); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "channel_input", "요청 형식이 올바르지 않습니다.");
      return parsed as Record<string, unknown>;
    };
    const missing = () => new HttpError(404, "channel_route", "채널 경로가 없습니다.");
    const kind = (value: string | undefined): ChannelKind => {
      if (value !== "telegram" && value !== "slack") throw missing();
      return value;
    };
    let value: unknown;
    if (parts.length === 2 && method === "GET") value = this.state();
    else if (parts.length === 3 && parts[2] === "audit" && method === "GET") {
      const number = (name: string) => { const raw = url.searchParams.get(name); return raw !== null && Number.isFinite(Number(raw)) ? Number(raw) : undefined; };
      const bindingId = url.searchParams.get("bindingId");
      const rows = this.core.auditList({ ...(bindingId ? { bindingId } : {}), since: number("since"), until: number("until"), before: number("before"), limit: number("limit") });
      // The names of the chats in these rows, disconnected ones too: the record says who, also after a disconnect.
      const named = new Set(rows.flatMap((row) => (row.bindingId ? [row.bindingId] : [])));
      const names = Object.fromEntries(this.core.bindings().filter((binding) => named.has(binding.id)).map((binding) => [binding.id, binding.displayName]));
      value = { rows, names };
    } else if (parts.length === 4 && parts[3] === "bots" && method === "POST") {
      const which = kind(parts[2]);
      const input = await body();
      value = which === "slack"
        ? await this.registerSlack(input.botToken, input.appToken, { memoryOnly: input.memoryOnly === true, appName: input.appName })
        : await this.registerTelegram(input.token, { memoryOnly: input.memoryOnly === true });
    } else if (parts.length === 5 && parts[3] === "bots" && method === "DELETE") value = await this.removeBot(kind(parts[2]), parts[4]!);
    else if (parts.length === 6 && parts[3] === "bots" && parts[5] === "reconnect" && method === "POST") value = await this.reconnect(kind(parts[2]), parts[4]!);
    else if (parts.length === 6 && parts[3] === "bots" && parts[5] === "pairing" && method === "DELETE") {
      const bot = this.requireBot(kind(parts[2]), parts[4]!);
      value = { cancelled: this.core.cancelPairing(bot.kind, bot.id) };
    } else if (parts.length === 6 && parts[3] === "bots" && parts[5] === "pairing" && method === "POST") value = await this.beginPairing(kind(parts[2]), parts[4]!, { additional: (await body()).additional === true });
    else if (parts.length === 7 && parts[3] === "bots" && parts[5] === "pairing" && method === "POST") {
      const bot = this.requireBot(kind(parts[2]), parts[4]!), input = await body();
      if (typeof input.approve !== "boolean") throw new HttpError(400, "channel_input", "approve는 true 또는 false여야 합니다.");
      if (input.approve) await this.core.approvePairing(bot.kind, bot.id, parts[6]!);
      else await this.core.declinePairing(bot.kind, bot.id, parts[6]!);
      value = this.state();
    } else if (parts.length === 4 && parts[2] === "bindings" && method === "PATCH") {
      const input = await body(), id = parts[3]!;
      // Locked from the chat or here; unlocked only here.
      if (input.locked !== undefined && typeof input.locked !== "boolean") throw new HttpError(400, "channel_input", "locked는 true 또는 false여야 합니다.");
      if (input.revoked !== undefined && input.revoked !== true) throw new HttpError(400, "channel_input", "끊은 연결은 되돌릴 수 없습니다. 다시 연결해 주세요.");
      if (input.paused !== undefined && typeof input.paused !== "boolean") throw new HttpError(400, "channel_input", "paused는 true 또는 false여야 합니다.");
      if (typeof input.paused === "boolean") this.core.pause(id, input.paused);
      if (input.locked === true) this.core.lock(id);
      if (input.locked === false) this.core.unlock(id);
      if (input.revoked === true) this.core.revoke(id);
      if (input.paused === undefined && input.locked === undefined && input.revoked === undefined) throw new HttpError(400, "channel_input", "바꿀 것이 없습니다.");
      value = this.state();
    } else throw missing();
    sendJson(res, 200, value);
    return true;
  }
}
