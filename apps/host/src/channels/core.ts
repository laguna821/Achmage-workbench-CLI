import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { ACCESS_LABEL, PROVIDER_LABEL, isOfficeFormat, type Artifact, type Schedule, type Attachment, type AttentionEvent, type ChannelAuditRow, type ChannelKind, type ChannelPairing, type Provider, type RequestOrigin, type SearchPage, type Session, type TranscriptItem, type Work } from "@workbench/contracts";
import type { EventBus } from "../bus.ts";
import { HttpError } from "../errors.ts";
import { MAX_ATTACHMENT, attachmentsDir } from "../attachments.ts";
import type { Projects } from "../project.ts";
import type { SessionManager } from "../sessions.ts";
import type { Store } from "../store.ts";
import { ChannelComfort, engineFacts, engineSentence, footerOn, footerWords, renameConversation, statusWords } from "./comfort.ts";
import { needlesOf, withheld, type HoldReason } from "./file-scan.ts";
import { blockedReason, mimeOf, previewed, turnFiles, type BlockRules, type OutFile } from "./files.ts";
import { answerFile, closeFence, formatted } from "./format.ts";
import { hangulPicture, pictureCode, pictureSvg, type PictureResult } from "./hangul-picture-run.ts";
import type { ChannelLog } from "./log.ts";
import { ChannelMenu, MODE_LABEL, noteSentence, planSentence, type MenuAct, type MenuButton, type Screen } from "./menu.ts";
import { PREAMBLE_VERSION, phonePreamble } from "./preamble.ts";
import { choiceLabel, clock, cutAt, parseCommand, shapeAnswer, takeChoices } from "./shape.ts";
import type { Binding, ButtonRow, ChannelStore, OutboxRow } from "./store.ts";
import { ChannelSendError, type Button, type ChannelAdapter, type ChannelStatus, type ChatRef, type InFile, type Inbound, type Out } from "./types.ts";
import { everyday } from "./words.ts";

// The part of the channel that is the same for every messenger: who is paired, who is refused,
// which conversation a line goes to, what runs once and is answered once, and the record of it.
//
// The channel runs what the paired person writes in the engines' full-access mode, without asking
// (the owner's decision for their own machine). So the gates here are the only gates: pairing
// approved at the PC, everyone else refused, direct chats only, pause and lock, an instant stop,
// and the audit trail. Each is checked where a message arrives and again right before a request is
// handed to the engine.

export type CoreDeps = {
  store: Store;
  manager: SessionManager;
  bus: EventBus;
  log: ChannelLog;
  now?: () => number;
  /** Waits before a message that certainly did not go is tried again. */
  retryMs?: number[];
  /** The project notes (project.ts), for the menu's 프로젝트 노트; absent where the gateway has none. */
  projects?: () => Projects | null;
  /** "찾기": the desktop's search (SessionManager.search) unless a test gives another. */
  search?: (query: string) => Promise<SearchPage>;
  /** The gateway's data folder: files on their way to and from the chat wait in `channels/` there; nothing else of it is ever sent. */
  dataDir?: string;
  /** The footer under finished answers where a chat has not chosen (on; tests of earlier units turn it off). */
  footer?: boolean;
};

/** At most this many files go with one answer. */
const MAX_FILES = 10;
const names = (list: string[]) => list.map((name) => `「${name}」`).join(", ");
/** What could not be opened, named five at most, then "외 N개", in at most 600 characters (round 4, NEW-M-b). */
export function unopened(list: string[]): string {
  const cut = (name: string) => ([...name].length > 100 ? `…${[...name].slice(-99).join("")}` : name);
  const shown = list.slice(0, 5).map(cut);
  const more = list.length > shown.length ? ` 외 ${list.length - shown.length}개` : "";
  const line = `내용을 확인하지 못한 파일: ${names(shown)}${more}`;
  return line.length <= 600 ? line : `${line.slice(0, 597)}…`;
}
/** Why a file was held back for what it holds (unit 9), in the chat's words. */
const HELD: Record<HoldReason, string> = {
  "secret-content": "비밀 값이 들어 있어",
  unreadable: "읽지 못해 비밀 값이 있는지 확인하지 못해",
};
/** A first page: a file (with why it is not the PNG it should be), a note for the chat, or nothing. */
/** What goes with an answer, what is said about it, what to remove after, and first pages that fell back to SVG (why). */
type Going = { files: OutFile[]; notes: string[]; temp: string[]; blocked: number; fallbacks: string[]; secret?: HoldReason[] };
type Preview = string | null | { path: string | null; fallback?: string; note?: string };

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const PAIRING_TTL = 10 * MINUTE;
const PAIRING_FAILURES = 5;
const PAIRING_LOCK = HOUR;
const BUTTON_TTL = DAY;
const TYPING_GAP = 5_000;
const RETRY_GAP = 30_000;
/** Tries of an answer that certainly did not go (a connection that was never made, a rate limit) before it is given up. */
const SEND_TRIES = 10;
const LONGEST_RETRY_GAP = 30 * MINUTE;
const GENERIC_ACTIVITY = new Set(["응답 중", "응답 준비 중"]);

const TEXT = {
  private: "이 봇은 개인용입니다.",
  paused: "지금은 PC에서 채널을 멈춰 두었습니다.",
  locked: "채널이 잠겨 있습니다. PC에서만 풀 수 있습니다.",
  paired: "연결되었습니다. 이제 하고 싶은 일을 그냥 적어 보내세요. 다른 기능은 '메뉴'라고 보내면 나옵니다.",
  archived: "이 대화는 보관되어 더 보낼 수 없습니다.",
  documentRemoved: "이 문서 AI의 문서를 지워 더 보낼 수 없습니다.",
  deadButton: "쓸 수 없는 버튼입니다",
  handled: "이미 처리됨",
  expired: "만료된 버튼입니다",
  contestedPc: "두 계정이 같은 연결 값을 냈습니다. 다른 사람이 화면의 QR을 보았을 수 있습니다. 화면을 가리고(화면 공유·프로젝터를 끄고) 다시 시작해 주세요.",
  contested: "이 연결은 취소되었습니다. 같은 연결 링크를 다른 계정도 열었습니다. PC에서 다시 시작해 주세요.",
};

/** What the chat is told when it is locked: from where, and whether work was stopped. */
const lockText = (from: "chat" | "pc", result: "stopped" | "idle" | "failed", schedules = 0) => {
  const who = from === "pc" ? "PC에서 " : "";
  const what = result === "stopped" ? `${who}채널을 잠갔고 하던 일을 멈췄습니다.` : result === "failed" ? `${who}채널을 잠갔지만 멈추지 못한 일이 있습니다. PC에서 멈춰 주세요.` : `${who}채널을 잠갔습니다.`;
  return `${what}${schedules ? ` 이 채팅에서 만든 예약 ${schedules}개도 껐습니다.` : ""} 푸는 것은 PC에서만 할 수 있습니다.`;
};

/** `declined`: refused because the PC declined its request (kept across a new window, unlike wrong values). */
type SenderRecord = { failures: number[]; until: number | null; displayName: string; handle: string | null; declined?: boolean };
type OtherAsker = { userId: string; displayName: string; handle: string | null };
type PairingState = {
  code: { hash: string; salt: string; expiresAt: number; additional: boolean } | null;
  request: { id: string; eventId: string; userId: string; chatId: string; displayName: string; handle: string | null; digits: string; at: number; expiresAt: number; byWord?: boolean; others?: OtherAsker[] } | null;
  /** Wrong values, per sender account: five in ten minutes refuse that account for an hour. */
  senders: Record<string, SenderRecord>;
  /** Why the last pairing ended without the PC, until a new one starts. */
  notice: string | null;
  /** Written by the first version (all pairing refused after five wrong values from anyone); read, never set. */
  failures: number[];
  lockedUntil: number | null;
};

/** `set`: buttons that go together (one press retires the others of its set); by default each kind is its own set. */
/** `itemId`: this button answers that question of the conversation (a plan's 진행 on the plan's answer). */
type ButtonSpec = { label: string; kind: string; data?: unknown; set?: string; itemId?: string; ttl?: number };
/** `group.itemId`: all buttons belong to this one question (an approval: 허용 and 거절 end together). */
/** `markdown`: the text is an engine's markdown (shown formatted); `tail`: the channel's own words under it, always plain. */
type Message = { text: string; buttons?: ButtonSpec[][]; group?: { sessionId: string; itemId?: string }; silent?: boolean; webApp?: Out["webApp"]; files?: OutFile[]; markdown?: boolean; tail?: string };
export type ChannelMessage = Message;

/**
 * A module that adds to the chat (the credential store, channels/vault-chat.ts) without changing
 * how lines, buttons and requests flow: it gets a line that is not a command, a press of its own
 * buttons, and a secret the messenger diverted; and it may say, answer, edit and continue a
 * conversation through the same gates and outbox as the core.
 */
export type ChannelExtension = {
  attach(reach: ChannelReach): void;
  /** A line of a paired, open chat that is not a command word: true when it was the module's. */
  message?(adapter: ChannelAdapter, binding: Binding, event: Extract<Inbound, { type: "message" }>, reply: (text: string, part?: string) => Promise<unknown>): Promise<boolean>;
  /**
   * A command or everyday word from a paired chat, before the core acts on it (`word`: the command,
   * e.g. "status", "menu", "stop", "new", "lock", or the everyday word, e.g. "help", "retry"). A
   * one-line input of the module is over; a human-only input closes only for a word that starts
   * something else (round 3, ruling A).
   */
  command?(binding: Binding, word: string, how?: "word" | "button"): void | Promise<void>;
  /** What a human-only input of this chat still waits for, in one short line (said after the app answered its word, `word`), or null. */
  awaiting?(binding: Binding, word?: string): string | null;
  /** The chat's gate closed (paused, locked, disconnected): a human-only input of it ends (fix round 4, P1). */
  gateClosed?(binding: Binding): void;
  /** A press of a button of a kind the core does not know, already checked (owner, chat, gate, one press, not expired). */
  button?(adapter: ChannelAdapter, binding: Binding, event: Extract<Inbound, { type: "button" }>, row: ButtonRow): Promise<boolean>;
  /** A value the messenger took out before its inbox (design §6.3); `binding` null for anyone not paired. */
  secret?(adapter: ChannelAdapter, binding: Binding | null, event: Extract<Inbound, { type: "secret" }>): Promise<void>;
  /** The chat's gate opened again (resumed, unlocked): what waited for it may go now. */
  reopened?(binding: Binding): Promise<void>;
  /** A chat was paired (again): what waited for an earlier, disconnected pairing of the same person may go to it. */
  paired?(binding: Binding): Promise<void>;
  /** The menu's [비밀 보관함]: the module's list, under a key made from the press. */
  vault?(binding: Binding, eventId: string): Promise<void>;
};
export type ChannelReach = {
  readonly running: boolean;
  binding(id: string): Binding | null;
  adapterOf(binding: Binding): ChannelAdapter | null;
  /** Something of the chat's work, once under its key (held while paused or locked, never to a disconnected chat). */
  say(bindingId: string, key: string, message: Message): Promise<string | null>;
  /** Where a message said under `key` stands: sent, unknown (may have gone), pending, undeliverable (refused for good), or null (none). */
  sent(key: string): OutboxRow["state"] | null;
  /** An answer to what the person just did (also to a paused or locked chat), once under its key. */
  reply(bindingId: string, key: string, text: string): Promise<string | null>;
  edit(bindingId: string, messageId: string, text: string): Promise<void>;
  /** A line of the record (what happened, never what was said). */
  audit(binding: Binding, action: string, extra?: { sessionId?: string | null; target?: string | null; result?: string | null }): void;
  /** A request of the chat into a conversation, in queued mode, through every gate a line passes. */
  continueWith(bindingId: string, sessionId: string, requestId: string, text: string): Promise<void>;
  /** A line the person wrote and the module held ([그대로 보내기]): now their ordinary request, as a line of the chat goes. */
  /** [그대로 보내기]: a caught line goes as the person's own, with the files it carried (Q2). */
  forward(bindingId: string, requestId: string, text: string, files?: InFile[]): Promise<void>;
};
/** `turn`: what the turn made, for the files that go with its answer; `long`: the whole answer when it was cut. */
type Final = { endId: string; label: string; message: Message; turn?: { items: TranscriptItem[]; answer: string; startedAt: number; long: string | null } };
type Progress = { bindingId: string; sessionId: string; startedAt: number; lastEditAt: number; lastTypingAt: number; messageId: string | null; ready: Promise<unknown> };
/**
 * Whose gate a send passes, read again right before every send and retry. `work`: something of
 * the chat's work (an answer, a status line, a question), held while the chat is paused or locked.
 * `reply`: the answer to what the person just wrote (also "the channel is paused"), sent to a
 * paused or locked chat. Neither is sent to a disconnected chat.
 */
type Gate = { bindingId: string; kind: "work" | "reply" } | null;
type Disposition = "done" | "parked";
/** A hand-off that runs behind the others of its chat. Wrapped, so that awaiting who started it does not wait for it. */
type Later = { settled: Promise<Disposition> };

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
const adapterKey = (kind: ChannelKind, botId: string) => `${kind}:${botId}`;
const finalKey = (sessionId: string, requestId: string) => `final:${sessionId}:${requestId}`;
const busy = (session: Session | undefined) => Boolean(session && session.status !== "idle" && session.status !== "error");

export class ChannelCore {
  private readonly store: Store;
  private readonly channels: ChannelStore;
  private readonly manager: SessionManager;
  private readonly bus: EventBus;
  private readonly log: ChannelLog;
  private readonly now: () => number;
  private readonly retryMs: number[];
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly aborts = new Map<string, AbortController>();
  /** Events being handled now (the same event delivered again meanwhile is not handled twice). */
  private readonly active = new Set<string>();
  /** One hand-off to the engine at a time per paired chat, in the order the lines came. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly progress = new Map<string, Progress>();
  /** Buttons made for a message that has not gone yet, by its outbox key. */
  private readonly issued = new Map<string, { rows: Button[][]; tokens: string[] }>();
  private readonly handing = new Map<string, number>();
  private readonly stopAfter = new Set<string>();
  private readonly stoppedAt = new Map<string, number>();
  private readonly settling = new Set<string>();
  /** Answers that certainly did not go: how often they failed, and not to be tried again before `next`. */
  private readonly tries = new Map<string, { count: number; next: number }>();
  private order = 0;
  private closed = true;
  private extension: ChannelExtension | null = null;
  private release: (() => void) | null = null;
  private releaseDelivery: (() => void) | null = null;
  private readonly menu: ChannelMenu;
  private readonly comfort: ChannelComfort;
  private readonly footer: boolean;
  private readonly projects: () => Projects | null;
  private readonly search: (query: string) => Promise<SearchPage>;
  private readonly dataDir: string | null;
  /** Files that did not go with a message that did (by its outbox key), for the line that names them. */
  private readonly unsent = new Map<string, { name: string; delivered: "no" | "unknown" }[]>();
  private scratch: string | null = null;
  /**
   * A picture of a document's first page (a file path), or null when it has none; throws when it
   * cannot be drawn on this PC. Word, PowerPoint and Excel through IeumOffice, HWPX through kordoc.
   */
  preview: (artifact: Artifact, revision: number) => Promise<Preview> = (artifact, revision) => this.firstPage(artifact, revision);
  /** Makes a Hangul document's first page a PNG (a child process); tests give another. */
  rasterize: (path: string, format: string, out: string) => Promise<PictureResult> = (path, format, out) => hangulPicture(path, format, out);
  /** Above this size a Hangul document gets no first-page picture (the original still goes). */
  previewLimitBytes = 20 * 1024 * 1024;
  private timer: NodeJS.Timeout | null = null;
  private prunedAt = 0;

  constructor(deps: CoreDeps) {
    this.store = deps.store;
    this.channels = deps.store.channels;
    this.manager = deps.manager;
    this.bus = deps.bus;
    this.log = deps.log;
    this.now = deps.now ?? Date.now;
    this.retryMs = deps.retryMs ?? [1_000, 3_000];
    // A schedule made from a chat runs only while that chat is open and the channel runs (its answer
    // has somewhere to go). Installed here, before anything ticks, and never taken away.
    this.manager.channelGate = (origin: RequestOrigin, schedule?: Schedule) => {
      const binding = this.channels.binding(origin.bindingId);
      if (!binding || binding.revokedAt) return "연결을 끊은 휴대폰 채팅에서 만든 예약이라 보내지 않았습니다.";
      if (binding.lockedAt) return "잠근 휴대폰 채팅에서 만든 예약이라 보내지 않았습니다.";
      if (binding.pausedAt) {
        // Not run while paused, and not forgotten: named at resume with [지금 실행].
        if (schedule) this.skipped(binding, schedule.id);
        return "멈춰 둔 휴대폰 채팅에서 만든 예약이라 보내지 않았습니다.";
      }
      if (this.closed) return "휴대폰 채널이 아직 켜지지 않아 휴대폰에서 만든 예약을 보내지 않았습니다.";
      return null;
    };
    // An open chat's schedule that comes due before the channel runs waits for it (it is not consumed).
    this.manager.channelDefer = (origin: RequestOrigin) => {
      const binding = this.channels.binding(origin.bindingId);
      return Boolean(binding && !binding.revokedAt && !binding.lockedAt && !binding.pausedAt && this.closed);
    };
    this.manager.channelEnable = (origin: RequestOrigin) => {
      const binding = this.channels.binding(origin.bindingId);
      if (!binding || binding.revokedAt) return "연결을 끊은 휴대폰 채팅에서 만든 예약이라 켤 수 없습니다.";
      if (binding.lockedAt) return "이 휴대폰 채팅이 잠겨 있어 켤 수 없습니다. 잠금을 푼 뒤 켜 주세요.";
      return null;
    };
    this.projects = deps.projects ?? (() => null);
    this.dataDir = deps.dataDir ?? null;
    this.footer = deps.footer ?? true;
    this.search = deps.search ?? ((query) => this.manager.search(query, { limit: 4, per: 3 }));
    const owner = this;
    this.menu = new ChannelMenu({
      manager: this.manager,
      channels: this.channels,
      projects: () => this.projects(),
      search: (query) => this.search(query),
      now: () => this.now(),
      show: (adapter, binding, messageId, screen) => this.showScreen(adapter, binding, messageId, screen),
      send: (adapter, binding, key, screen) => this.say(adapter, this.channels.binding(binding.id) ?? binding, key, this.message(screen)),
      label: (session) => this.label(session),
      where: (binding) => this.where(binding),
      hidden: (work) => this.hidden(work),
      recentWork: () => this.recentWork(),
      newConversation: (binding) => this.newConversation(binding),
      conversationIn: (binding, work, provider) => this.conversationIn(binding, work, provider),
      setPointer: (bindingId, sessionId) => this.setPointer(bindingId, sessionId),
      target: (binding) => { const place = this.place(this.channels.binding(binding.id) ?? binding); return "session" in place ? place.session : null; },
      strictNote: (binding, session) => this.strictNote(binding, session),
      strictSaid: (binding, sessionId) => this.strictSaid(binding, sessionId),
      enableSchedules: (binding) => this.enableSchedules(binding),
      scrub: (text) => this.log.scrub(text),
      get vault() { return owner.extension?.vault ? (binding: Binding, eventId: string) => owner.extension!.vault!(binding, eventId) : null; },
      runNow: (adapter, binding, chat, eventId, sessionId, text) => {
        const reply = (line: string, part = "0") => this.post(adapter, chat, `ack:${chat.kind}:${chat.botId}:${eventId}:run:${part}`, binding.id, { text: line });
        const requestId = `ch:${chat.kind}:${chat.botId}:run:${eventId}`;
        this.track(this.enqueue(binding.id, (order) => this.handoff(adapter, binding.id, order, { text, requestId, eventId: null, sessionId, reply })).settled);
      },
      statusText: (binding) => this.statusText(binding),
      admitted: () => this.admitted(),
      lock: (binding, chat, eventId) => this.onLock(this.channels.binding(binding.id) ?? binding, (text, part = "0") => this.post(this.adapters.get(adapterKey(chat.kind, chat.botId))!, chat, `ack:${chat.kind}:${chat.botId}:${eventId}:lock:${part}`, binding.id, { text })),
      moveParked: (adapter, binding, chat, eventId, sessionId) => this.moveParked(adapter, binding, chat, eventId, sessionId),
      audit: (binding, action, extra = {}) => this.audit(binding, binding.kind, action, extra),
      clean: (error) => this.log.clean(error),
      setFooter: (binding, on) => this.comfort.setFooter(binding, on),
      footerOn: (binding) => footerOn(binding, this.footer),
      compact: (binding) => this.comfort.compact(binding),
      rename: (sessionId, name) => renameConversation(this.manager, (work) => this.hidden(work), sessionId, name),
    });
    this.comfort = new ChannelComfort({
      manager: this.manager, channels: this.channels, menu: this.menu,
      hidden: (work) => this.hidden(work), admitted: () => this.admitted(),
      resend: (adapter, binding, sessionId, request, requestId, reply) => this.enqueue(binding.id, (order) => this.handoff(adapter, binding.id, order, { ...request, requestId, eventId: null, sessionId, reply })),
      audit: (binding, action, extra = {}) => this.audit(binding, binding.kind, action, extra),
      clean: (error) => this.log.clean(error),
    });
  }

  // Life cycle

  /** A messenger connection the core receives from and sends through. Started with the core, or at once when it runs. */
  attach(adapter: ChannelAdapter) {
    this.adapters.set(adapterKey(adapter.kind, adapter.botId), adapter);
    if (!this.closed) this.track(this.resume(adapter).then(() => this.listen(adapter)));
  }

  async detach(kind: ChannelKind, botId: string) {
    const key = adapterKey(kind, botId);
    this.aborts.get(key)?.abort();
    this.aborts.delete(key);
    this.adapters.delete(key);
  }

  /** Whether the core runs (between `start` and `close`). */
  /** Counts closes, so that a start under way can tell it was closed (and perhaps started again) meanwhile. */
  private runs = 0;
  get running() { return !this.closed; }

  async start() {
    if (!this.closed) return;
    this.closed = false;
    this.manager.channelHook = (origin: RequestOrigin, run) => phonePreamble(origin.context ?? PREAMBLE_VERSION, run ? engineSentence(engineFacts(this.manager, run.settings, run.session.engineModel)) : null);
    // What the desktop's own work says when it ends, for the projects a chat asked to hear about.
    this.releaseDelivery = this.manager.notifications.subscribeDelivery((row) => {
      if (!this.closed) queueMicrotask(() => { if (!this.closed) this.track(this.onAttention(row)); });
    });
    // Files left on their way by a stop in the middle (a download, an answer's .md) are removed.
    if (this.dataDir) for (const what of ["incoming", "outgoing"]) {
      const dir = join(this.dataDir, "channels", what);
      try { for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true }); } catch { /* Not there yet. */ }
    }
    // What was on its way to the messenger when the gateway stopped may or may not have arrived.
    const unsure = this.channels.interrupted();
    if (unsure.length) this.log.note("outbox_unknown", `${unsure.length}`);
    this.release = this.bus.subscribe((event) => {
      if (event.type !== "item.upserted" || this.closed) return;
      const { sessionId, item } = event;
      // Not inside the publish: what this sends must come after the event that caused it.
      queueMicrotask(() => { if (!this.closed) this.track(this.onItem(sessionId, item)); });
    });
    // A close that lands while this start awaits wins: nothing more is sent, handled or armed.
    const run = this.runs, gone = () => this.closed || run !== this.runs;
    // Answers owed for turns that ended while nothing could be sent (a restart ends every turn).
    for (const row of this.channels.owed()) {
      if (gone()) return;
      if (row.key.startsWith("final:")) await this.settleOwed(row);
    }
    // Events received and written down, but not handled before the gateway stopped.
    for (const adapter of this.adapters.values()) {
      if (gone()) return;
      await this.resume(adapter);
    }
    if (gone()) return;
    for (const adapter of this.adapters.values()) this.listen(adapter);
    this.timer = setInterval(() => { this.track(this.pulse()); }, 1_000);
    this.timer.unref();
    // Schedules of open chats that came due before the channel ran go now (once, as any missed time).
    this.track(this.manager.schedules.tick());
  }

  async close() {
    this.runs += 1;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.release?.();
    this.release = null;
    this.releaseDelivery?.();
    this.releaseDelivery = null;
    for (const abort of this.aborts.values()) abort.abort();
    this.aborts.clear();
    this.manager.channelHook = null;
  }

  /** Connect a module that adds to the chat (one: the credential store's). */
  use(extension: ChannelExtension) {
    this.extension = extension;
    const binding = (id: string) => this.channels.binding(id);
    const adapterOf = (found: Binding) => this.adapters.get(adapterKey(found.kind, found.botId)) ?? null;
    const core = this;
    extension.attach({
      get running() { return !core.closed; },
      binding,
      adapterOf,
      say: async (bindingId, key, message) => {
        const found = binding(bindingId), adapter = found ? adapterOf(found) : null;
        return found && adapter ? this.say(adapter, found, key, message) : null;
      },
      sent: (key) => this.channels.outbox(key)?.state ?? null,
      reply: async (bindingId, key, text) => {
        const found = binding(bindingId), adapter = found ? adapterOf(found) : null;
        return found && adapter ? this.post(adapter, this.chatOf(found), key, found.id, { text }) : null;
      },
      audit: (found, action, extra = {}) => this.audit(found, found.kind, action, extra),
      edit: async (bindingId, messageId, text) => {
        const found = binding(bindingId), adapter = found ? adapterOf(found) : null;
        if (found && adapter) await this.edit(adapter, found.id, this.chatOf(found), messageId, { text });
      },
      continueWith: async (bindingId, sessionId, requestId, text) => {
        const found = binding(bindingId), adapter = found ? adapterOf(found) : null;
        if (!found || !adapter || this.closed) return;
        const reply = (line: string, part = "0") => this.post(adapter, this.chatOf(found), `ack:${requestId}:${part}`, found.id, { text: line });
        await this.enqueue(found.id, (order) => this.handoff(adapter, found.id, order, { text, requestId, eventId: null, sessionId, mode: "queue", reply })).settled;
      },
      forward: async (bindingId, requestId, text, files = []) => {
        const found = binding(bindingId), adapter = found ? adapterOf(found) : null;
        if (!found || !adapter || this.closed) return;
        const reply = (line: string, part = "0") => this.post(adapter, this.chatOf(found), `ack:${requestId}:${part}`, found.id, { text: line });
        const planned = planSentence(text);
        // As a line with files is taken (handle): voice is said, not taken; the files are fetched behind the chat's other lines.
        const taken = files.filter((file) => file.kind !== "voice");
        if (taken.length < files.length) await reply("음성 메시지는 아직 받지 못합니다. 글로 적어 보내 주세요.", "voice");
        await this.enqueue(found.id, async (order) => {
          const attachments = taken.length ? await this.receiveFiles(adapter, found, requestId, taken, reply) : [];
          if (!text.trim() && !attachments.length) return "done";
          return this.handoff(adapter, found.id, order, { text: planned ?? text, requestId, eventId: null, reply, attachments, ...(planned ? { plan: true } : {}) });
        }).settled;
      },
    });
  }

  private listen(adapter: ChannelAdapter) {
    const key = adapterKey(adapter.kind, adapter.botId);
    if (this.closed || this.aborts.has(key)) return;
    const abort = new AbortController();
    this.aborts.set(key, abort);
    void adapter.start((event) => this.receive(adapter, event), abort.signal).catch((error: unknown) => this.log.note("adapter_stopped", error));
  }

  private async resume(adapter: ChannelAdapter) {
    for (const row of this.channels.pending(adapter.kind, adapter.botId)) {
      try {
        await this.receive(adapter, JSON.parse(row.payload) as Inbound);
      } catch (error) {
        this.log.note("event_unreadable", error);
        this.channels.done(adapter.kind, adapter.botId, row.eventId);
      }
    }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    const guarded = work.catch((error: unknown) => { if (!this.closed) this.log.note("background_failed", error); return undefined as T; });
    this.background.add(guarded);
    void guarded.finally(() => this.background.delete(guarded));
    return guarded;
  }

  /** Everything started in the background has ended (tests wait on this). */
  async idle() {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  status(kind: ChannelKind, botId: string): ChannelStatus {
    return this.adapters.get(adapterKey(kind, botId))?.status() ?? { state: "stopped", detail: null };
  }

  private changed() {
    this.bus.publish({ type: "channels.changed" });
  }

  private audit(binding: Binding | null, kind: ChannelKind, action: string, extra: { sessionId?: string | null; requestId?: string | null; target?: string | null; result?: string | null } = {}) {
    this.channels.audit({ at: this.now(), bindingId: binding?.id ?? null, kind, action, ...extra });
  }

  auditList(filter: { bindingId?: string; since?: number; until?: number; before?: number; limit?: number } = {}): ChannelAuditRow[] {
    return this.channels.auditList(filter);
  }

  // The PC's side: pairing, pause, unlock, disconnect

  private pairingKey(kind: ChannelKind, botId: string) { return `channel.pairing:${kind}:${botId}`; }

  private pairingState(kind: ChannelKind, botId: string): PairingState {
    const raw = this.store.getMeta(this.pairingKey(kind, botId));
    const state = raw ? (JSON.parse(raw) as Partial<PairingState>) : {};
    return { code: state.code ?? null, request: state.request ?? null, senders: state.senders ?? {}, notice: state.notice ?? null, failures: state.failures ?? [], lockedUntil: state.lockedUntil ?? null };
  }

  private savePairing(kind: ChannelKind, botId: string, state: PairingState) {
    this.store.setMeta(this.pairingKey(kind, botId), JSON.stringify(state));
  }

  private owner(kind: ChannelKind, botId: string) {
    return this.channels.bindings().find((binding) => binding.kind === kind && binding.botId === botId && !binding.revokedAt) ?? null;
  }

  /**
   * The PC makes a one-time value for the link the phone opens (128 bits; ten minutes; only its
   * hash is kept). It is returned here once and never stored or logged. One owner per bot: refused
   * while someone is connected, unless the PC asks to add a person.
   */
  beginPairing(kind: ChannelKind, botId: string, options: { additional?: boolean } = {}): { code: string; expiresAt: number } {
    const now = this.now(), state = this.pairingState(kind, botId);
    if (state.lockedUntil && state.lockedUntil > now) throw new HttpError(429, "channel_pairing_locked", "잘못된 연결 시도가 여러 번 있어 한 시간 동안 연결을 받지 않습니다.");
    if (this.owner(kind, botId) && !options.additional) throw new HttpError(409, "channel_owner_exists", "이 봇에는 이미 연결된 사람이 있습니다. 먼저 연결을 끊거나, 사람 추가를 켜 주세요.");
    const code = randomBytes(16).toString("base64url"), salt = randomBytes(8).toString("hex");
    const expiresAt = now + PAIRING_TTL;
    // Wrong values are forgotten with the old window; a refusal by the PC is not (else the declined person takes the next one).
    const declined = Object.fromEntries(Object.entries(state.senders).filter(([, sender]) => sender.declined && sender.until && sender.until > now));
    this.savePairing(kind, botId, { code: { hash: hashCode(salt, code), salt, expiresAt, additional: options.additional === true }, request: null, senders: declined, notice: null, failures: [], lockedUntil: null });
    this.audit(null, kind, "pairing.started", { target: `bot:${botId}` });
    this.changed();
    return { code, expiresAt };
  }

  pairing(kind: ChannelKind, botId: string): ChannelPairing {
    const now = this.now(), state = this.pairingState(kind, botId);
    const request = state.request && state.request.expiresAt > now ? state.request : null;
    return {
      expiresAt: state.code && !state.request && state.code.expiresAt > now ? state.code.expiresAt : null,
      request: request ? { id: request.id, userId: request.userId, displayName: request.displayName, handle: request.handle, digits: request.digits, at: request.at, expiresAt: request.expiresAt, ...(request.others?.length ? { others: request.others } : {}) } : null,
      lockedUntil: state.lockedUntil && state.lockedUntil > now ? state.lockedUntil : null,
      notice: state.notice,
      refusedSenders: Object.entries(state.senders).flatMap(([userId, sender]) => (sender.until && sender.until > now ? [{ userId, displayName: sender.displayName, handle: sender.handle, until: sender.until, ...(sender.declined ? { declined: true } : {}) }] : [])),
    };
  }

  /** Sender records still worth keeping: a refusal that has not ended, or wrong values of the last ten minutes. */
  private liveSenders(state: PairingState, now: number): Record<string, SenderRecord> {
    const live: Record<string, SenderRecord> = {};
    for (const [userId, sender] of Object.entries(state.senders)) {
      const failures = sender.failures.filter((at) => now - at < PAIRING_TTL);
      if (failures.length || (sender.until && sender.until > now)) live[userId] = { ...sender, failures };
    }
    return live;
  }

  /**
   * The PC no longer shows the QR (the dialog closed) and no phone has opened it: its one-time value
   * is cancelled, so a link left in a browser's history or on a photo pairs nobody. A phone's
   * waiting request is left alone (false).
   */
  cancelPairing(kind: ChannelKind, botId: string): boolean {
    const now = this.now(), state = this.pairingState(kind, botId);
    if (state.request && state.request.expiresAt > now) return false;
    if (!state.code) return false;
    this.savePairing(kind, botId, { ...state, code: null, request: null });
    this.audit(null, kind, "pairing.cancelled", { target: `bot:${botId}` });
    this.changed();
    return true;
  }

  /** The bot is removed: nothing of its pairing stays usable. */
  resetPairing(kind: ChannelKind, botId: string) {
    this.store.setMeta(this.pairingKey(kind, botId), JSON.stringify({ code: null, request: null, senders: {}, notice: null, failures: [], lockedUntil: null }));
  }

  /** "연결" at the PC, after the person compared the four digits on both screens. */
  async approvePairing(kind: ChannelKind, botId: string, requestId: string): Promise<Binding> {
    const now = this.now(), state = this.pairingState(kind, botId), request = state.request;
    if (!request || request.id !== requestId) throw new HttpError(404, "channel_pairing_missing", "연결 요청이 없습니다.");
    if (request.expiresAt <= now) {
      this.savePairing(kind, botId, { ...state, code: null, request: null });
      throw new HttpError(409, "channel_pairing_expired", "연결 요청이 만료되었습니다. 다시 시작해 주세요.");
    }
    if (this.owner(kind, botId) && !state.code?.additional) throw new HttpError(409, "channel_owner_exists", "이 봇에는 이미 연결된 사람이 있습니다.");
    const binding = this.channels.activeBinding(kind, botId, request.chatId, request.userId)
      ?? this.channels.addBinding({ kind, botId, chatId: request.chatId, userId: request.userId, displayName: request.displayName, handle: request.handle, createdAt: now });
    this.savePairing(kind, botId, { code: null, request: null, senders: this.liveSenders(state, now), notice: null, failures: [], lockedUntil: null });
    this.audit(binding, kind, "paired", { target: `user:${request.userId}`, result: "ok" });
    this.changed();
    const adapter = this.adapters.get(adapterKey(kind, botId));
    if (adapter) await this.post(adapter, this.chatOf(binding), `paired:${binding.id}`, binding.id, { text: TEXT.paired });
    // Schedules this chat made under an earlier connection were turned off with it and stay off.
    const earlier = this.channels.bindings().filter((entry) => entry.id !== binding.id && entry.revokedAt && entry.kind === kind && entry.botId === botId && entry.chatId === binding.chatId && entry.userId === binding.userId);
    const off = earlier.reduce((count, entry) => count + this.schedulesOff(entry).length, 0);
    if (adapter && off) await this.post(adapter, this.chatOf(binding), `paired:${binding.id}:schedules`, binding.id, { text: `이전 연결에서 만든 예약 ${off}개는 꺼진 채로 두었습니다. 필요하면 메뉴의 [예약]에서 새로 만들어 주세요.` });
    if (this.extension?.paired) this.track(this.extension.paired(binding));
    return binding;
  }

  /** "아니요" at the PC. */
  async declinePairing(kind: ChannelKind, botId: string, requestId: string): Promise<void> {
    const state = this.pairingState(kind, botId), request = state.request;
    if (!request || request.id !== requestId) throw new HttpError(404, "channel_pairing_missing", "연결 요청이 없습니다.");
    const now = this.now();
    // Where a bare word pairs, the declined person would take every next window: refused for the lock time.
    const senders = request.byWord
      ? { ...this.liveSenders(state, now), [request.userId]: { failures: [], until: now + PAIRING_LOCK, displayName: request.displayName, handle: request.handle, declined: true } }
      : state.senders;
    this.savePairing(kind, botId, { ...state, code: null, request: null, senders });
    this.audit(null, kind, "pairing.declined", { target: `user:${request.userId}`, ...(request.byWord ? { result: "refused for an hour" } : {}) });
    this.changed();
    const adapter = this.adapters.get(adapterKey(kind, botId));
    if (adapter) await this.post(adapter, { kind, botId, chatId: request.chatId, chatType: "dm" }, `declined:${request.id}`, `chat:${request.chatId}`, { text: "PC에서 연결을 받지 않았습니다." });
  }

  bindings(): Binding[] {
    return this.channels.bindings();
  }

  private requireBinding(bindingId: string): Binding {
    const binding = this.channels.binding(bindingId);
    if (!binding) throw new HttpError(404, "channel_binding_missing", "연결이 없습니다.");
    return binding;
  }

  /**
   * "연결 끊기": at once. A turn the chat started goes on at the PC; nothing of it is sent to the
   * chat, and answers it was owed (held while paused or locked, or still to come) are discarded.
   */
  revoke(bindingId: string): Binding {
    const binding = this.requireBinding(bindingId);
    if (binding.revokedAt) return binding;
    const next = this.channels.updateBinding(bindingId, { revokedAt: this.now() });
    this.closeGate(next);
    this.disableSchedules(next, "disconnected");
    this.audit(next, next.kind, "revoked");
    for (const row of this.channels.owed(bindingId)) this.discard(row, next);
    this.changed();
    return next;
  }

  /**
   * "멈춤" at the PC: lines from the chat are answered only with that it is paused, and nothing
   * runs. Answers of turns that end meanwhile are held, and sent once when it is resumed.
   */
  pause(bindingId: string, paused: boolean): Binding {
    const binding = this.requireBinding(bindingId);
    if (Boolean(binding.pausedAt) === paused) return binding;
    const next = this.channels.updateBinding(bindingId, { pausedAt: paused ? this.now() : null });
    if (paused) this.closeGate(next);
    this.audit(next, next.kind, paused ? "pause" : "resume");
    this.changed();
    if (!paused) this.track(this.releaseHeld(bindingId).then(() => this.offerSkipped(bindingId)).then(() => this.extension?.reopened?.(next)));
    return next;
  }

  /** Undo a lock. Only the PC can. Answers held while it was locked are sent then, and what a pause skipped is named as at resume. */
  unlock(bindingId: string): Binding {
    const binding = this.requireBinding(bindingId);
    if (!binding.lockedAt) return binding;
    const next = this.channels.updateBinding(bindingId, { lockedAt: null });
    this.audit(next, next.kind, "unlock");
    this.changed();
    this.track(this.releaseHeld(bindingId).then(() => this.offerSchedules(bindingId, "lock")).then(() => this.offerSkipped(bindingId)).then(() => this.extension?.reopened?.(next)));
    return next;
  }

  /**
   * "잠금" at the PC: the same as from the chat. Everything the chat runs is stopped as `멈춰`
   * stops it, its waiting requests are held, and the chat is told.
   */
  lock(bindingId: string): Binding {
    const binding = this.requireBinding(bindingId);
    if (binding.lockedAt || binding.revokedAt) return binding;
    const next = this.channels.updateBinding(bindingId, { lockedAt: this.now() });
    this.closeGate(next);
    const schedules = this.disableSchedules(next, "locked");
    this.changed();
    const adapter = this.adapters.get(adapterKey(next.kind, next.botId));
    const at = this.now();
    this.track(this.stopForLock(next, "pc", schedules, (text) => (adapter ? this.post(adapter, this.chatOf(next), `lock:${next.id}:${at}`, next.id, { text }) : Promise.resolve(null))));
    return next;
  }

  /** The lock's stop, its record, and the line that says what it did. */
  private async stopForLock(binding: Binding, from: "chat" | "pc", schedules: number, reply: (text: string) => Promise<unknown>) {
    const result = await this.stopWork(binding);
    this.audit(binding, binding.kind, "lock", { target: from, result });
    await reply(lockText(from, result, schedules));
  }

  /**
   * The gate opened again (resumed, unlocked): the answers held meanwhile are sent, oldest first,
   * after one line that says they were held. Each is sent once.
   */
  private async releaseHeld(bindingId: string) {
    const binding = this.channels.binding(bindingId);
    if (!binding || this.gateOf(bindingId) !== "open") return;
    const adapter = this.adapters.get(adapterKey(binding.kind, binding.botId));
    if (!adapter) return;
    const ready = new Map<string, OutboxRow>();
    for (const row of this.channels.owed(bindingId)) {
      if (!row.key.startsWith("final:") || !row.sessionId || !row.requestId || this.settling.has(row.key)) continue;
      const session = this.manager.view.sessions.get(row.sessionId);
      const final = session ? this.compose(session, row.requestId) : null;
      // One answer per turn, however many requests went into it.
      if (final && final !== "gone" && !ready.has(`${row.sessionId}:${final.endId}`)) ready.set(`${row.sessionId}:${final.endId}`, row);
    }
    if (ready.size) {
      // Keyed by the oldest held answer: a quick pause and resume again does not say it twice.
      await this.say(adapter, binding, `held:${bindingId}:${[...ready.values()][0]!.key}`, { text: `채널을 멈춰 둔 동안 끝난 답 ${ready.size}개를 이제 보냅니다.` });
      for (const row of ready.values()) await this.settleOwed(row);
    }
    await this.askAgain(binding);
  }

  /**
   * Questions asked while the chat was closed, in the conversations it waits on: sent now, each once
   * (the same key as when asked; a question already sent is not sent again).
   */
  private async askAgain(binding: Binding) {
    const sessions = new Set(this.channels.owed(binding.id).filter((row) => row.key.startsWith("final:") && row.sessionId).map((row) => row.sessionId!));
    for (const sessionId of sessions) {
      for (const item of this.manager.items(sessionId).items) {
        if (item.kind === "approval" && item.decision === null) await this.onQuestion(sessionId, item);
      }
    }
  }

  /**
   * The chat's schedules that are on are stored off, so that nothing it planted runs while it is
   * closed, on this build or an older one. Turning them on again is the person's own act.
   */
  private disableSchedules(binding: Binding, reason: "locked" | "disconnected"): number {
    const mine = this.manager.schedules.all().filter((schedule) => schedule.origin?.bindingId === binding.id && schedule.enabled);
    const off: string[] = [];
    for (const schedule of mine) {
      try {
        this.manager.schedules.update(schedule.id, { enabled: false, offReason: reason });
        off.push(schedule.id);
      } catch (error) {
        this.log.note("schedule_disable_failed", error);
      }
    }
    if (!off.length) return 0;
    const fresh = this.channels.binding(binding.id) ?? binding;
    const kept = Array.isArray(fresh.prefs.schedulesOff) ? (fresh.prefs.schedulesOff as string[]) : [];
    this.channels.updateBinding(binding.id, { prefs: { ...fresh.prefs, schedulesOff: [...new Set([...kept, ...off])] } });
    this.audit(fresh, fresh.kind, "schedule.disabled", { result: String(off.length) });
    return off.length;
  }

  /** Schedules of the chat that are still there and off. */
  private schedulesOff(binding: Binding): string[] {
    const kept = Array.isArray(binding.prefs.schedulesOff) ? (binding.prefs.schedulesOff as string[]) : [];
    return kept.filter((id) => this.manager.schedules.all().some((schedule) => schedule.id === id && !schedule.enabled));
  }

  /** A schedule of the chat that came due while it was paused (named at resume). */
  private skipped(binding: Binding, scheduleId: string) {
    const fresh = this.channels.binding(binding.id) ?? binding;
    const list = Array.isArray(fresh.prefs.skipped) ? (fresh.prefs.skipped as string[]) : [];
    if (!list.includes(scheduleId)) this.channels.updateBinding(binding.id, { prefs: { ...fresh.prefs, skipped: [...list, scheduleId] } });
  }

  /** Resumed: what came due while paused is named, each with [지금 실행]; a repeating one goes on by itself. */
  private async offerSkipped(bindingId: string) {
    const binding = this.channels.binding(bindingId);
    const adapter = binding ? this.adapters.get(adapterKey(binding.kind, binding.botId)) : undefined;
    if (!binding || !adapter || this.gateOf(bindingId) !== "open") return;
    const ids = Array.isArray(binding.prefs.skipped) ? (binding.prefs.skipped as string[]) : [];
    if (!ids.length) return;
    const { skipped: _gone, ...rest } = binding.prefs;
    this.channels.updateBinding(binding.id, { prefs: rest });
    await this.menu.offerSkipped(adapter, binding, ids, `skipped:${binding.id}:${this.now()}`);
  }

  /** Reopened: what was turned off is said, with one button to turn it on again. Never on by itself. */
  private async offerSchedules(bindingId: string, why: "lock" | "pause") {
    const binding = this.channels.binding(bindingId);
    if (!binding || this.gateOf(bindingId) !== "open") return;
    const off = this.schedulesOff(binding);
    const adapter = this.adapters.get(adapterKey(binding.kind, binding.botId));
    if (!off.length || !adapter) return;
    await this.say(adapter, binding, `schedules-off:${binding.id}:${this.now()}`, {
      text: `${why === "lock" ? "잠근" : "멈춘"} 동안 이 채팅에서 만든 예약 ${off.length}개를 꺼 두었습니다. 다시 켜려면 누르세요.`,
      buttons: [[{ label: "예약 다시 켜기", kind: "menu", data: { a: "schedules-on" } satisfies MenuAct }]],
    });
  }

  /** "예약 다시 켜기": the person turns on again what a lock or pause turned off. */
  private enableSchedules(binding: Binding): number {
    const off = this.schedulesOff(binding);
    let on = 0;
    for (const id of off) {
      try {
        this.manager.schedules.update(id, { enabled: true });
        on += 1;
      } catch (error) {
        this.log.note("schedule_enable_failed", error);
      }
    }
    const fresh = this.channels.binding(binding.id) ?? binding;
    const { schedulesOff: _gone, ...rest } = fresh.prefs;
    this.channels.updateBinding(binding.id, { prefs: rest });
    if (on) this.audit(fresh, fresh.kind, "schedule.enabled", { result: String(on) });
    return on;
  }

  /** Whether something of the chat's work may be sent to it now: open, held (paused or locked), or closed for good. */
  private gateOf(bindingId: string): "open" | "held" | "closed" {
    const binding = this.channels.binding(bindingId);
    if (!binding || binding.revokedAt) return "closed";
    return binding.lockedAt || binding.pausedAt ? "held" : "open";
  }

  /** An answer owed to a chat that was disconnected: never sent, and recorded. */
  private discard(row: OutboxRow, binding: Binding | null) {
    if (!row.key.startsWith("final:")) return void this.channels.dropOwed(row.key);
    if (this.channels.dropOwed(row.key) && binding) this.audit(binding, binding.kind, "answer.discarded", { sessionId: row.sessionId, requestId: row.requestId });
    this.tries.delete(row.key);
  }

  /** Point the chat at another live conversation. The desktop's own current conversation is not touched. */
  setPointer(bindingId: string, sessionId: string): Binding {
    this.requireBinding(bindingId);
    const session = this.manager.view.sessions.get(sessionId);
    const work = session ? this.manager.view.works.get(session.workId) : undefined;
    if (!session || !work) throw new HttpError(404, "session_not_found", "대화를 찾지 못했습니다.");
    if (session.archivedAt || this.hidden(work)) throw new HttpError(409, "archived", "보관한 대화로는 옮길 수 없습니다.");
    const next = this.channels.updateBinding(bindingId, { pointerWorkId: work.id, pointerSessionId: session.id });
    this.changed();
    return next;
  }

  /** The chat is closed (paused, locked or disconnected): what it had waiting stays waiting, and its progress line stops. */
  private closeGate(binding: Binding) {
    this.manager.holdQueuedOf(binding.id);
    // A human-only input of the chat ends with its gate, and says so (fix round 4, P1).
    this.extension?.gateClosed?.(binding);
    // A one-line input the menu opened is over too: after the gate opens again a line is a line.
    this.menu.clear(binding);
    for (const [key, entry] of this.progress) if (entry.bindingId === binding.id) this.progress.delete(key);
  }

  // Receiving

  /** The adapters' sink: an event is written down first, handled once, and its message forgotten when handled. */
  async receive(adapter: ChannelAdapter, event: Inbound): Promise<void> {
    if (this.closed) return;
    const { kind, botId } = event.chat;
    const key = `${kind}:${botId}:${event.eventId}`;
    const fresh = this.channels.record(kind, botId, [{ eventId: event.eventId, payload: JSON.stringify(event) }]).length > 0;
    if (!fresh && (this.active.has(key) || this.channels.seen(kind, botId, event.eventId) !== "received")) return;
    this.active.add(key);
    const finish = (disposition: Disposition) => {
      this.active.delete(key);
      if (this.closed) return;
      if (disposition === "parked") this.channels.park(kind, botId, event.eventId);
      else this.channels.done(kind, botId, event.eventId);
    };
    let later: Later | null = null;
    try {
      later = await this.handle(adapter, event);
    } catch (error) {
      this.log.note("event_failed", error);
      // A paired person is told, so the line is not lost without a word (strangers are told nothing).
      const known = event.chat.chatType === "dm" && this.channels.activeBinding(kind, botId, event.chat.chatId, event.from.userId);
      if (known && event.type === "message") await this.post(adapter, event.chat, `ack:${key}:error`, known.id, { text: "요청을 처리하지 못했습니다. 다시 보내 주세요." }).catch(() => null);
    }
    if (!later) return finish("done");
    // A request on its way to the engine: the messenger is not kept waiting for it.
    this.track(later.settled.then(finish, (error: unknown) => { this.log.note("handoff_failed", error); finish("done"); }));
  }

  /** Returns the hand-off when the event became a request for the engine (it runs behind the others of its chat). */
  private async handle(adapter: ChannelAdapter, event: Inbound): Promise<Later | null> {
    const { chat, from } = event;
    // Direct chats only.
    if (chat.chatType !== "dm") {
      if (event.type === "button") await this.ack(adapter, event.ackHandle, TEXT.deadButton);
      await this.refuseGroup(adapter, chat);
      return null;
    }
    const binding = this.channels.activeBinding(chat.kind, chat.botId, chat.chatId, from.userId);
    if (event.type === "button") return this.onButton(adapter, event, binding);
    if (event.type === "secret") {
      await this.extension?.secret?.(adapter, binding, event);
      return null;
    }
    if (event.type !== "message") return null;
    const command = parseCommand(event.text);
    const reply = (text: string, part = "0") => this.post(adapter, chat, `ack:${chat.kind}:${chat.botId}:${event.eventId}:${part}`, binding?.id ?? `chat:${chat.chatId}`, { text });
    if (!binding) {
      // Default deny: nothing runs for anyone who is not paired.
      if (command?.command === "start" && command.value) await this.onStart(adapter, event, command.value);
      else await this.refuseStranger(adapter, event);
      return null;
    }
    // Any command, 멈춰 included, closes the one-line input a menu opened (and one the credential module waited for).
    if (command) {
      this.menu.clear(binding);
      await this.extension?.command?.(binding, command.command);
    }
    // A stop is heard in every state, ahead of everything else.
    if (command?.command === "stop") {
      await this.onStop(binding, reply);
      return null;
    }
    // What waited at the messenger and is not run is recorded whatever the chat's state (said only to an open one, below).
    if (event.skipped) this.audit(binding, chat.kind, "history.skipped", { result: `${event.skipped.count}${event.skipped.more ? "+" : ""}` });
    if (binding.lockedAt) {
      this.audit(binding, chat.kind, "refused", { result: "locked" });
      await reply(TEXT.locked);
      return null;
    }
    if (binding.pausedAt) {
      this.audit(binding, chat.kind, "refused", { result: "paused" });
      await reply(TEXT.paused);
      return null;
    }
    await this.mentionUnsure(adapter, binding);
    if (event.backlog) await reply(`PC가 꺼져 있거나 잠들어 있던 동안 온 요청 ${event.backlog}개를 지금 실행합니다.`, "backlog");
    // What waited at the messenger and is not run (too old, or too many at once): said once. With `more`,
    // the oldest were never read, so the time is where reading began, not where the gap began.
    if (event.skipped) {
      const { count, since, more } = event.skipped, at = new Date(since);
      const when = `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
      await reply(`PC가 꺼져 있던 동안 온 요청 중 ${count}개${more ? " 이상은" : "는"} 실행하지 않았습니다 (${when}${more ? " 이전부터" : "부터"}, 하루가 지났거나 한 번에 실행하는 수를 넘었습니다). 필요하면 다시 보내 주세요.`, "skipped");
      if (!event.text.trim() && !event.files.length) return null;
    }
    const key = (what: string) => `${what}:${chat.kind}:${chat.botId}:${event.eventId}`;
    switch (command?.command) {
      case "start":
        await reply("이미 연결되어 있습니다.");
        return null;
      case "menu":
        await this.menu.open(adapter, binding, key("menu"));
        await this.awaited(binding, reply);
        return null;
      case "status":
        await this.menu.status(adapter, binding, key("status"));
        await this.awaited(binding, reply);
        return null;
      case "new": {
        const session = this.newConversation(binding);
        await reply(`새 대화를 만들었습니다: ${this.label(session)}`);
        return null;
      }
      case "lock":
        await this.onLock(binding, reply);
        return null;
      default:
    }
    // The everyday words and slash commands (comfort.ts); a line with files is for the AI. Ahead of
    // the inputs a menu or the credential module opened, and they close them ("도움말" never becomes
    // an entry's name). A secret input never gets here: the adapter took its line out before (secret-window.ts).
    const word = event.files.length ? null : everyday(event.text);
    if (word) {
      this.menu.clear(binding);
      await this.extension?.command?.(binding, word);
      const later = await this.comfort.take(adapter, binding, chat, event, word, reply, key);
      await this.awaited(binding, reply, word);
      return later;
    }
    // A line the credential module waited for (a new name for an entry).
    if (this.extension?.message && await this.extension.message(adapter, binding, event, reply)) return null;
    // The line a menu asked for (a search, a schedule's text, a name, a note entry).
    if (await this.menu.take(adapter, binding, event)) return null;
    // "결정으로 적어 줘: …": for the project note, through its own guarded write.
    const entry = event.files.length ? null : noteSentence(event.text);
    if (entry) {
      await this.menu.sentence(adapter, binding, key("note"), entry);
      return null;
    }
    // "계획 먼저: …": a plan first, then one [진행].
    const planned = planSentence(event.text);
    // Voice is not taken yet (it needs a decoder); said, not dropped silently.
    const files = event.files.filter((file) => file.kind !== "voice");
    if (files.length < event.files.length) await reply("음성 메시지는 아직 받지 못합니다. 글로 적어 보내 주세요.", "voice");
    if (!files.length && !event.text.trim()) return null;
    const requestId = `ch:${chat.kind}:${chat.botId}:${event.eventId}`;
    // Files are fetched behind the chat's other lines (not while the messenger waits), then go with the request.
    return this.enqueue(binding.id, async (order) => {
      const attachments = files.length ? await this.receiveFiles(adapter, binding, requestId, files, reply) : [];
      if (!event.text.trim() && !attachments.length) return "done";
      return this.handoff(adapter, binding.id, order, { text: planned ?? event.text, requestId, eventId: event.eventId, reply, attachments, ...(planned ? { plan: true } : {}) });
    });
  }

  /** After the app answered its own word: what an input that stayed open still waits for, in one line. */
  private async awaited(binding: Binding, reply: (text: string, part?: string) => Promise<unknown>, word?: string) {
    const line = this.extension?.awaiting?.(this.channels.binding(binding.id) ?? binding, word);
    if (line) await reply(line, "awaiting");
  }

  private async refuseGroup(adapter: ChannelAdapter, chat: ChatRef) {
    const target = `chat:${chat.chatId}`, last = this.channels.lastAudit("refused", target);
    if (!last || this.now() - last.at >= DAY) this.audit(null, chat.kind, "refused", { target, result: "group" });
    try {
      await adapter.leave?.(chat);
    } catch (error) {
      this.log.note("leave_failed", error);
    }
  }

  /** No answer, except once a day that the bot is private. Recorded once a day too. */
  private async refuseStranger(adapter: ChannelAdapter, event: Extract<Inbound, { type: "message" }>) {
    const { chat, from } = event;
    const target = `user:${from.userId}`, last = this.channels.lastAudit("refused", target);
    if (last && this.now() - last.at < DAY) return;
    this.audit(null, chat.kind, "refused", { target, result: "stranger" });
    await this.post(adapter, chat, `private:${chat.kind}:${chat.botId}:${from.userId}:${this.now()}`, `chat:${chat.chatId}`, { text: chat.kind === "slack" ? "이 앱은 개인용입니다." : TEXT.private });
  }

  /** The phone opened the PC's link: `/start <one-time value>`. */
  private async onStart(adapter: ChannelAdapter, event: Extract<Inbound, { type: "message" }>, value: string) {
    const { chat, from } = event, now = this.now();
    const state = this.pairingState(chat.kind, chat.botId);
    const sender = state.senders[from.userId];
    if ((state.lockedUntil && state.lockedUntil > now) || (sender?.until && sender.until > now)) return this.refuseStranger(adapter, event);
    const matches = state.code !== null && sameHash(hashCode(state.code.salt, value), state.code.hash);
    const digitsLine = (digits: string) => `PC 화면에 같은 숫자가 보이면 PC에서 [연결]을 눌러 주세요: ${digits.split("").join(" ")}`;
    const say = (text: string) => this.post(adapter, chat, `ack:${chat.kind}:${chat.botId}:${event.eventId}:0`, `chat:${chat.chatId}`, { text });
    if (matches) {
      const request = state.request && state.request.expiresAt > now ? state.request : null;
      // The same phone again (a re-sent update, a second tap): the same digits.
      if (request && request.userId === from.userId && request.chatId === chat.chatId) return void (await say(digitsLine(request.digits)));
      // Where a bare word pairs, the right value proves nothing: the second account waits, the PC is shown it.
      if (request && adapter.pairingByWord) return this.alsoAsked(event, state, request, say);
      // A second account with the right value: someone else saw the QR. Nobody is paired.
      if (request) return this.contested(adapter, event, state, request);
      if (!state.request && state.code!.expiresAt > now) {
        const created = {
          id: randomBytes(12).toString("base64url"), eventId: event.eventId, userId: from.userId, chatId: chat.chatId,
          displayName: cutAt(from.displayName, 80), handle: from.handle ? cutAt(from.handle, 64) : null,
          digits: String(randomInt(0, 10_000)).padStart(4, "0"), at: now, expiresAt: now + PAIRING_TTL,
          ...(adapter.pairingByWord ? { byWord: true } : {}),
        };
        this.savePairing(chat.kind, chat.botId, { ...state, request: created });
        this.audit(null, chat.kind, "pairing.requested", { target: `user:${from.userId}` });
        this.changed();
        return void (await say(digitsLine(created.digits)));
      }
      // The right value, too late: not an attack, so it is said and not counted.
      return void (await say(adapter.pairingByWord ? "연결 시간이 지났습니다. PC에서 연결을 다시 시작한 뒤 보내 주세요." : "연결 링크가 만료되었습니다. PC에서 QR을 다시 만들어 주세요."));
    }
    // A wrong value while a pairing is under way counts against its sender, and only its sender.
    const underWay = state.code !== null && (state.request ? state.request.expiresAt > now : state.code.expiresAt > now);
    if (underWay) {
      const senders = this.liveSenders(state, now);
      const record: SenderRecord = { failures: [...(senders[from.userId]?.failures ?? []), now], until: null, displayName: cutAt(from.displayName, 80), handle: from.handle ? cutAt(from.handle, 64) : null };
      if (record.failures.length >= PAIRING_FAILURES) {
        record.failures = [];
        record.until = now + PAIRING_LOCK;
        this.audit(null, chat.kind, "pairing.sender_locked", { target: `user:${from.userId}`, result: `${PAIRING_FAILURES} wrong values` });
        this.log.note("pairing_sender_locked");
      }
      this.savePairing(chat.kind, chat.botId, { ...state, senders: { ...senders, [from.userId]: record } });
      if (record.until) this.changed();
    }
    await this.refuseStranger(adapter, event);
  }

  /** A second account asked while one request waits (a bare word pairs): named on the PC's card, told to wait; nothing is cancelled or counted. */
  private async alsoAsked(event: Extract<Inbound, { type: "message" }>, state: PairingState, request: NonNullable<PairingState["request"]>, say: (text: string) => Promise<unknown>) {
    const { chat, from } = event;
    const others = request.others ?? [];
    if (!others.some((other) => other.userId === from.userId) && others.length < 5) {
      const asker: OtherAsker = { userId: from.userId, displayName: cutAt(from.displayName, 80), handle: from.handle ? cutAt(from.handle, 64) : null };
      this.savePairing(chat.kind, chat.botId, { ...state, request: { ...request, others: [...others, asker] } });
      this.audit(null, chat.kind, "pairing.also_requested", { target: `user:${from.userId}`, result: `first user:${request.userId}` });
      this.changed();
    }
    await say("다른 사람이 먼저 요청했습니다. PC에서 그 요청을 거절한 뒤 다시 보내 주세요.");
  }

  /**
   * Two accounts presented the same one-time value: the pairing is cancelled, the PC is told, and
   * each chat gets one line. Not a wrong value against either of them.
   */
  private async contested(adapter: ChannelAdapter, event: Extract<Inbound, { type: "message" }>, state: PairingState, request: NonNullable<PairingState["request"]>) {
    const { chat, from } = event;
    this.savePairing(chat.kind, chat.botId, { ...state, code: null, request: null, notice: TEXT.contestedPc });
    this.audit(null, chat.kind, "pairing.contested", { target: `user:${from.userId}`, result: `first user:${request.userId}` });
    this.log.note("pairing_contested");
    this.changed();
    const first: ChatRef = { kind: chat.kind, botId: chat.botId, chatId: request.chatId, chatType: "dm" };
    await this.post(adapter, chat, `contested:${request.id}:${from.userId}`, `chat:${chat.chatId}`, { text: TEXT.contested });
    await this.post(adapter, first, `contested:${request.id}:${request.userId}`, `chat:${request.chatId}`, { text: TEXT.contested });
  }

  // The paired person's words

  /**
   * Stop everything the chat runs: the turn of the chat's conversation, every other turn that runs
   * a request of this chat (a conversation it has moved on from), the one being handed to the
   * engine right now (stopped as soon as it has started), and lines not handed over yet. Called at
   * once, behind nothing. (It also stops a turn the PC started in the chat's own conversation:
   * that is what "stop" means to the person writing there.)
   */
  private async stopWork(binding: Binding): Promise<"stopped" | "idle" | "failed"> {
    const ids = new Set<string>(binding.pointerSessionId ? [binding.pointerSessionId] : []);
    for (const row of this.channels.owed(binding.id)) if (row.sessionId && row.key.startsWith("final:")) ids.add(row.sessionId);
    const running = [...ids].flatMap((id) => { const session = this.manager.view.sessions.get(id); return session && busy(session) ? [session] : []; });
    const handing = (this.handing.get(binding.id) ?? 0) > 0;
    // Lines of this chat that have not reached the engine yet are not handed over after a stop.
    this.stoppedAt.set(binding.id, ++this.order);
    if (!running.length && !handing) return "idle";
    if (handing) this.stopAfter.add(binding.id);
    let failed = false;
    for (const session of running) {
      try {
        await this.manager.interrupt(session.id);
      } catch (error) {
        this.log.note("stop_failed", error);
        failed = true;
      }
    }
    return failed ? "failed" : "stopped";
  }

  /** "멈춰". */
  private async onStop(binding: Binding, reply: (text: string, part?: string) => Promise<unknown>) {
    const result = await this.stopWork(binding);
    this.audit(binding, binding.kind, "stop", { sessionId: binding.pointerSessionId, result: result === "idle" ? "idle" : "stopped" });
    if (result === "idle") return void (await reply("지금 멈출 일이 없습니다."));
    if (result === "failed") return void (await reply("멈추지 못한 일이 있습니다. PC에서 멈춰 주세요."));
    // The stopped turn's own end is what says "멈췄습니다."; a paused or locked chat gets it later, so it is said here.
    if (binding.lockedAt || binding.pausedAt) await reply("멈췄습니다.");
  }

  /** "잠금" from the chat: closed at once, everything it runs stopped, and said. Undone only at the PC. */
  private async onLock(binding: Binding, reply: (text: string, part?: string) => Promise<unknown>) {
    const next = this.channels.updateBinding(binding.id, { lockedAt: this.now() });
    this.closeGate(next);
    const schedules = this.disableSchedules(next, "locked");
    this.changed();
    await this.stopForLock(next, "chat", schedules, reply);
  }

  private hidden(work: Work): boolean {
    if (work.archivedAt) return true;
    const folders = this.manager.view.folders;
    for (let at = work.folderId; at; at = folders.get(at)?.parentId ?? null) if (folders.get(at)?.archivedAt) return true;
    return false;
  }

  private label(session: Session): string {
    const work = this.manager.view.works.get(session.workId);
    const parts = [PROVIDER_LABEL[session.provider], session.model, ACCESS_LABEL[this.manager.accessOf(session)]].filter(Boolean);
    return `「${work?.title ?? "?"}」 › 「${session.purpose}」 (${parts.join(" · ")})`;
  }

  /** The chat's conversation by name, for the PC screen (null when it has none yet, or it is gone). */
  pointerLabel(binding: Binding): string | null {
    const session = binding.pointerSessionId ? this.manager.view.sessions.get(binding.pointerSessionId) : undefined;
    return session ? this.label(session) : null;
  }

  private where(binding: Binding): string {
    const session = binding.pointerSessionId ? this.manager.view.sessions.get(binding.pointerSessionId) : undefined;
    return session ? this.label(session) : "아직 대화가 없습니다(적어 보내면 새 대화가 생깁니다)";
  }

  private statusText(binding: Binding): string {
    const session = binding.pointerSessionId ? this.manager.view.sessions.get(binding.pointerSessionId) : undefined;
    return statusWords(this.manager, session, this.where(binding), session ? this.progress.get(`${binding.id}:${session.id}`)?.startedAt ?? null : null, this.now());
  }

  /** The project used last at the PC (not archived, not in an archived folder). */
  private recentWork(): Work | null {
    return [...this.manager.view.works.values()].filter((work) => !this.hidden(work)).sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0] ?? null;
  }

  private providerFor(work: Work): Provider {
    const sessions = [...this.manager.view.sessions.values()].filter((session) => session.workId === work.id && !session.archivedAt && !session.documentAgent && !session.pageAgent);
    const current = sessions.find((session) => session.id === work.activeSessionId) ?? sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (current) return current.provider;
    const installed = this.manager.snapshot().providers.filter((status) => status.installed).map((status) => status.provider);
    return installed.includes("claude") || !installed.length ? "claude" : installed[0]!;
  }

  /**
   * A conversation the channel makes: in the engine's full-access mode (the channel asks nothing),
   * with the agent browser on (web work is asked for in plain words; in full access it shows no
   * approval card, browse-policy.ts `browserDecision`), named "휴대폰 · 월/일", and not made the one
   * the desktop shows.
   */
  private createConversation(work: Work, like: Session | null, provider?: Provider): Session {
    const date = new Date(this.now());
    return this.manager.createSession(work.id, {
      provider: provider ?? like?.provider ?? this.providerFor(work),
      access: "full",
      browser: true,
      purpose: `휴대폰 · ${date.getMonth() + 1}/${date.getDate()}`,
      ...(like?.workspaceId && like.workId === work.id ? { workspaceId: like.workspaceId } : {}),
      ...(like?.model ? { model: like.model } : {}),
      ...(like?.effort ? { effort: like.effort } : {}),
    }, false);
  }

  /** A new conversation in the chat's project (the project used last when it has none, a new "휴대폰" project when there is none), and the chat moves to it. */
  private newConversation(binding: Binding): Session {
    const old = binding.pointerSessionId ? this.manager.view.sessions.get(binding.pointerSessionId) ?? null : null;
    const oldWork = old ? this.manager.view.works.get(old.workId) : undefined;
    const work = (oldWork && !this.hidden(oldWork) ? oldWork : null) ?? this.recentWork() ?? this.manager.createWork({ title: "휴대폰", titleSource: "user" });
    const session = this.createConversation(work, old && !old.documentAgent && !old.pageAgent ? old : null);
    this.channels.updateBinding(binding.id, { pointerWorkId: work.id, pointerSessionId: session.id });
    this.changed();
    return session;
  }

  /** A new conversation the channel makes in a chosen project (with another engine, when asked), and the chat moves to it. */
  private conversationIn(binding: Binding, work: Work, provider?: Provider): Session {
    const session = this.createConversation(work, null, provider);
    this.channels.updateBinding(binding.id, { pointerWorkId: work.id, pointerSessionId: session.id });
    this.changed();
    return session;
  }

  /**
   * The stricter-mode notice (§7.2) for a conversation the chat just moved to, said inside the
   * message that says so: its button, once per conversation (the hand-off does not say it again).
   */
  private strictNote(binding: Binding, session: Session): MenuButton[][] | null {
    if (this.manager.accessOf(session) === "full") return null;
    if (this.channels.outbox(`strict:${binding.id}:${session.id}`)) return null;
    return [[{ label: "전체 접근으로 바꾸기", kind: "full-access" }]];
  }

  /** The notice went out inside the message that showed it: the hand-off does not say it again. */
  private strictSaid(binding: Binding, sessionId: string) {
    this.channels.said(`strict:${binding.id}:${sessionId}`, binding.id);
  }

  /** A line parked for its archived conversation goes to the conversation the person picked, under its own request id. */
  private async moveParked(adapter: ChannelAdapter, binding: Binding, chat: ChatRef, eventId: string, sessionId: string) {
    const payload = this.channels.parked(chat.kind, chat.botId, eventId);
    const original = payload ? (JSON.parse(payload) as Inbound) : null;
    if (original?.type !== "message") return;
    const reply = (text: string, part = "0") => this.post(adapter, chat, `ack:${chat.kind}:${chat.botId}:${eventId}:moved:${part}`, binding.id, { text });
    const requestId = `ch:${chat.kind}:${chat.botId}:${eventId}`;
    const moved = this.enqueue(binding.id, (order) => this.handoff(adapter, binding.id, order, { text: original.text, requestId, eventId: null, sessionId, reply }));
    this.track(moved.settled.then((disposition) => { if (!this.closed) this.channels.done(chat.kind, chat.botId, eventId); return disposition; }));
  }

  /** Where a line of this chat goes. An archived conversation is not left by itself and never brought back. */
  private place(binding: Binding): { session: Session } | { refused: "archived" } {
    const session = binding.pointerSessionId ? this.manager.view.sessions.get(binding.pointerSessionId) : undefined;
    if (!session) return { session: this.newConversation(binding) };
    const work = this.manager.view.works.get(session.workId);
    if (session.archivedAt || !work || this.hidden(work)) return { refused: "archived" };
    return { session };
  }

  private enqueue(bindingId: string, job: (order: number) => Promise<Disposition>): Later {
    const order = ++this.order;
    const before = this.chains.get(bindingId) ?? Promise.resolve();
    const run = before.then(() => job(order));
    const tail = run.then(() => undefined, () => undefined);
    this.chains.set(bindingId, tail);
    void tail.then(() => { if (this.chains.get(bindingId) === tail) this.chains.delete(bindingId); });
    return { settled: run };
  }

  /**
   * Hand a line to the engine as a request of the chat's conversation. The channel keeps no queue:
   * a busy conversation takes it into its turn or into its own queue (`SessionManager.send`).
   */
  private async handoff(
    adapter: ChannelAdapter, bindingId: string, order: number,
    request: { text: string; requestId: string; eventId: string | null; sessionId?: string; mode?: "auto" | "queue"; plan?: boolean; attachments?: Attachment[]; reply: (text: string, part?: string) => Promise<unknown> },
  ): Promise<Disposition> {
    // The gates again, right before the engine gets it: the chat may have been closed meanwhile.
    const binding = this.channels.binding(bindingId);
    if (!binding || binding.revokedAt) return "done";
    if (binding.lockedAt || binding.pausedAt) {
      this.audit(binding, binding.kind, "refused", { requestId: request.requestId, result: binding.lockedAt ? "locked" : "paused" });
      await request.reply(binding.lockedAt ? TEXT.locked : TEXT.paused, "gate");
      return "done";
    }
    if (order < (this.stoppedAt.get(bindingId) ?? 0)) {
      await request.reply("멈추기 전에 보낸 요청은 실행하지 않았습니다. 필요하면 다시 보내 주세요.", "stopped");
      return "done";
    }
    // The gateway is draining for an update or stopping: no new work starts, from the phone either.
    // Looked at here (before a conversation is made for it) and again with nothing awaited before the call.
    const admitted = () => this.admitted();
    const refuseDraining = async (): Promise<Disposition> => {
      this.audit(binding, binding.kind, "refused", { requestId: request.requestId, result: "updating" });
      await request.reply("PC가 업데이트를 준비하고 있어 지금은 새 일을 시작하지 않습니다. 업데이트가 끝나면 다시 보내 주세요.", "updating");
      return "done";
    };
    if (!admitted()) return refuseDraining();
    const refuse = async (text: string): Promise<Disposition> => {
      this.audit(binding, binding.kind, "refused", { sessionId: binding.pointerSessionId, requestId: request.requestId, result: text === TEXT.archived ? "archived" : "document_removed" });
      // A line can be taken to a new conversation; a button's request is said only.
      if (!request.eventId) {
        await request.reply(`${text} '새 대화'라고 보내면 새 대화로 옮깁니다.`, "refused");
        return "done";
      }
      await this.say(adapter, binding, `refused:${request.requestId}`, { text, buttons: [[
        { label: "새 대화에서 하기", kind: "move", data: { eventId: request.eventId }, set: "refused" },
        { label: "대화 바꾸기", kind: "menu", data: { a: "sessions", move: request.eventId } satisfies MenuAct, set: "refused" },
      ]] });
      return "parked";
    };
    let session: Session;
    if (request.sessionId) {
      const target = this.manager.view.sessions.get(request.sessionId);
      if (!target || target.archivedAt) return refuse(TEXT.archived);
      session = target;
    } else {
      const place = this.place(binding);
      if ("refused" in place) return refuse(TEXT.archived);
      session = place.session;
    }
    const access = this.manager.accessOf(session);
    if (access !== "full") {
      // Said once per conversation; the request goes on as it is, in the conversation's own mode.
      await this.say(adapter, binding, `strict:${binding.id}:${session.id}`, {
        text: `이 대화는 '${MODE_LABEL[access]}' 모드라 중간에 확인 요청이 올 수 있습니다.`,
        buttons: [[{ label: "전체 접근으로 바꾸기", kind: "full-access" }]], group: { sessionId: session.id },
      });
    }
    const origin: RequestOrigin = { channel: binding.kind, bindingId: binding.id, context: PREAMBLE_VERSION };
    // A request that waits for the keyring (the credential store's warm-up) waits here, before the last look at the gate.
    if (this.manager.engineGate) await this.manager.engineGate;
    // Once more, with nothing awaited between this look and the call below.
    const still = this.channels.binding(bindingId);
    if (!still || still.revokedAt) return "done";
    if (still.lockedAt || still.pausedAt) {
      this.audit(still, still.kind, "refused", { requestId: request.requestId, result: still.lockedAt ? "locked" : "paused" });
      await request.reply(still.lockedAt ? TEXT.locked : TEXT.paused, "gate");
      return "done";
    }
    // Synchronous: nothing can come between this look and the hand-off below.
    if (!admitted()) return refuseDraining();
    this.handing.set(bindingId, (this.handing.get(bindingId) ?? 0) + 1);
    let result;
    try {
      result = await this.manager.send(session.id, request.requestId, request.text, [], null, null, request.mode ?? "auto", { origin, activate: false, ...(request.plan ? { plan: true } : {}), ...(request.attachments?.length ? { attachments: request.attachments } : {}) });
    } catch (error) {
      if (error instanceof HttpError && error.code === "archived") return refuse(TEXT.archived);
      if (error instanceof HttpError && error.code === "document_removed") return refuse(TEXT.documentRemoved);
      this.log.note("send_refused", error);
      this.audit(binding, binding.kind, "request", { sessionId: session.id, requestId: request.requestId, result: error instanceof HttpError ? error.code : "failed" });
      await request.reply(`보내지 못했습니다: ${this.log.clean(error)}`, "failed");
      return "done";
    } finally {
      const left = (this.handing.get(bindingId) ?? 1) - 1;
      if (left > 0) this.handing.set(bindingId, left);
      else this.handing.delete(bindingId);
    }
    // A stop came while the engine was taking it.
    if (!this.handing.has(bindingId) && this.stopAfter.delete(bindingId)) await this.manager.interrupt(session.id).catch((error: unknown) => this.log.note("stop_failed", error));
    if (result.duplicate) return "done";
    this.audit(binding, binding.kind, "request", { sessionId: session.id, requestId: request.requestId, result: result.delivery });
    if (result.delivery === "steered") await request.reply("(덧붙인 말을 지금 일에 넣었습니다)", "delivery");
    if (result.delivery === "queued") {
      const position = (this.manager.view.sessions.get(session.id)?.queued.findIndex((entry) => entry.id === request.requestId) ?? 0) + 1;
      await request.reply(`대기열에 넣었습니다(${Math.max(1, position)}번째)`, "delivery");
    }
    return "done";
  }

  // Files

  /** A folder of the channel's own for files on their way (`channels/<what>` in the data folder), 0700. */
  private folder(what: "incoming" | "outgoing"): string {
    this.scratch ??= this.dataDir ? join(this.dataDir, "channels") : mkdtempSync(join(tmpdir(), "workbench-channel-"));
    const dir = join(this.scratch, what);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private rules(): BlockRules {
    return { dataDir: this.dataDir, allowed: this.dataDir ? [join(this.dataDir, "works"), attachmentsDir(this.dataDir)] : [] };
  }

  /**
   * Files the person sent, fetched and kept as the desktop keeps a pasted or dropped file (by
   * content, in the attachment store); never read for anything else, logged or echoed. What is over
   * the size the bot may take is said by name.
   */
  private async receiveFiles(adapter: ChannelAdapter, binding: Binding, requestId: string, files: InFile[], reply: (text: string, part?: string) => Promise<unknown>): Promise<Attachment[]> {
    const limit = Math.min(adapter.limits.downloadBytes, MAX_ATTACHMENT);
    const megabytes = Math.floor(limit / 1024 / 1024);
    const kept: Attachment[] = [], large: string[] = [], failed: string[] = [], empty: string[] = [];
    for (const file of files) {
      if (file.size > limit) { large.push(file.name); continue; }
      const temp = join(this.folder("incoming"), randomBytes(12).toString("hex"));
      try {
        await adapter.download(file, temp);
        const data = readFileSync(temp);
        if (data.length > limit) large.push(file.name);
        else if (!data.length) empty.push(file.name);
        else kept.push(this.manager.attachments.save(data, file.name, file.mime));
      } catch (error) {
        if ((error as { code?: unknown }).code === "too_large") large.push(file.name);
        else { failed.push(file.name); this.log.note("file_unavailable", error); }
      } finally {
        rmSync(temp, { force: true });
      }
    }
    if (large.length) await reply(`${names(large)}은(는) ${megabytes}MB가 넘어 받지 못했습니다. ${adapter.kind === "telegram" ? "텔레그램 봇이" : "이 PC가 Slack에서"} 받을 수 있는 파일은 ${megabytes}MB까지입니다.`, "files-large");
    if (empty.length) await reply(`${names(empty)}은(는) 빈 파일이라 받지 않았습니다.`, "files-empty");
    if (failed.length) await reply(`${names(failed)}을(를) 받지 못했습니다. 다시 보내 주세요.`, "files-failed");
    if (kept.length) this.audit(binding, binding.kind, "file.received", { requestId, result: String(kept.length) });
    return kept;
  }

  /** The first page of a document as a picture: Office through IeumOffice (PNG), HWPX through kordoc (SVG). */
  private async firstPage(artifact: Artifact, revision: number): Promise<Preview> {
    if (isOfficeFormat(artifact.format)) return this.manager.documents.officePagePath(artifact.id, revision, 1);
    if (artifact.format !== "hwpx" && artifact.format !== "hwp") return null;
    // .hwp and .hwpx: page 1 only, by the gateway's own Hangul engine (rhwp), as a PNG the phone
    // shows; never all pages, never into the page view's cache.
    const source = this.manager.documents.revisionPath(artifact.id, revision);
    if (statSync(source).size > this.previewLimitBytes) {
      const limit = Math.max(1, Math.round(this.previewLimitBytes / 1024 / 1024));
      return { path: null, note: `「${artifact.name}」은(는) ${limit}MB가 넘어 1쪽 미리보기를 만들지 않았습니다. 원본은 함께 보냅니다.` };
    }
    const out = join(this.folder("outgoing"), `${randomBytes(9).toString("hex")}.png`);
    const svg = pictureSvg(out);
    // The gateway never draws the page itself: only what the child left is sent.
    const made = await this.rasterize(source, artifact.format, out).catch((): PictureResult => ({ ok: false, code: "failed" }));
    if (made.ok && existsSync(out)) { rmSync(svg, { force: true }); return out; }
    rmSync(out, { force: true });
    rmSync(`${svg}.part`, { force: true });
    // The record has a short code, never the child's words.
    const fallback = made.ok ? "missing" : pictureCode(made.code);
    // The child drew the page but could not rasterize it (or was stopped after): its SVG goes.
    if (existsSync(svg)) return { path: svg, fallback };
    // Nothing was written: no picture; the original still goes.
    return { path: null, fallback };
  }

  /** A document's first page as a file for the chat, or why there is none. */
  private async pageOf(artifact: Artifact, revision: number): Promise<{ file: OutFile | null; temp: string | null; note: string | null; fallback?: string }> {
    try {
      const made = await this.preview(artifact, revision);
      const preview = typeof made === "string" || made === null ? { path: made } : made;
      const path = preview.path;
      const extra = { ...(preview.fallback ? { fallback: preview.fallback } : {}) };
      if (!path) return { file: null, temp: null, note: preview.note ?? null, ...extra };
      const stem = artifact.name.replace(/\.[^.]+$/, "");
      const name = `${stem} 1쪽${extname(path) || ".png"}`;
      const temp = this.scratch && path.startsWith(join(this.scratch, "outgoing")) ? path : null;
      return { file: { path, name, mime: mimeOf(name), caption: `1쪽 미리보기 · ${artifact.name}` }, temp, note: preview.note ?? null, ...extra };
    } catch (error) {
      this.log.note("preview_failed", error);
      return { file: null, temp: null, note: `「${artifact.name}」의 1쪽 미리보기는 이 PC에서 만들지 못했습니다.` };
    }
  }

  /**
   * The files that go with an answer: what the turn made (each real file once, never one on the
   * block list, never one outside the conversation's folder it only named), first-page pictures of
   * Office and Hangul documents, and a long answer as a .md file (its secrets hidden). Notes say
   * what was kept back and why. `temp`: files made for this send, removed after it.
   */
  private async outgoing(adapter: ChannelAdapter, session: Session, final: Final, result: Going = { files: [], notes: [], temp: [], blocked: 0, fallbacks: [] }, stopped: () => boolean = () => false): Promise<Going> {
    if (!final.turn) return result;
    let cwd: string;
    try {
      cwd = session.workspaceId ? this.manager.workspaces.get(session.workspaceId).cwd : this.manager.workCwd(session.workId);
    } catch {
      cwd = this.manager.workCwd(session.workId);
    }
    // Unit 9 (N11): a file a stored value is in does not go, whatever its name. Nothing stored: nothing read.
    const stored = this.log.stored();
    const made = turnFiles(final.turn.items, final.turn.answer, cwd, final.turn.startedAt, {
      artifact: (id) => this.manager.documents.list().find((entry) => entry.id === id) ?? null,
      revisionPath: (id, revision) => this.manager.documents.revisionPath(id, revision),
      attachmentPath: (id) => { try { return this.manager.attachments.path(id); } catch { return null; } },
    }, this.rules());
    // A file over what the chat can send is not read at all (round 3, M-1): it does not go, and that is said.
    const large: string[] = [];
    made.files = made.files.filter((file) => {
      let size = 0;
      try { size = statSync(file.path).size; } catch { return true; }
      if (size <= adapter.limits.uploadBytes) return true;
      large.push(file.name);
      return false;
    });
    const found = await withheld(made, stored.length ? needlesOf(stored) : null, stopped);
    if (final.turn.long !== null) {
      const dir = mkdtempSync(join(this.folder("outgoing"), "answer-"));
      const name = `${cutAt(this.log.scrub(session.purpose).replace(/[\\/:*?"<>|]/g, "-"), 60)} 답.md`;
      writeFileSync(join(dir, "answer.md"), answerFile(final.turn.long, (text) => this.log.scrub(text)), { mode: 0o600 });
      result.files.push({ path: join(dir, "answer.md"), name, mime: "text/markdown" });
      result.temp.push(dir);
    }
    let count = 0;
    count = result.files.length;
    for (const file of found.files) {
      // Every upload counts: first-page pictures and the .md too.
      if (count >= MAX_FILES) { result.notes.push(`파일이 많아 ${MAX_FILES}개만 보냈습니다. 나머지는 PC에서 보세요.`); break; }
      let size = 0;
      try { size = statSync(file.path).size; } catch { continue; }
      if (size > adapter.limits.uploadBytes) { large.push(file.name); continue; }
      result.files.push({ path: file.path, name: file.name, mime: file.mime });
      count += 1;
      if (file.artifact && file.revision !== undefined && previewed(file.artifact) && count < MAX_FILES) {
        const page = await this.pageOf(file.artifact, file.revision);
        if (page.file) { result.files.push(page.file); count += 1; }
        if (page.fallback) result.fallbacks.push(page.fallback);
        if (page.temp) result.temp.push(page.temp);
        if (page.note) result.notes.push(page.note);
      }
    }
    if (found.blocked.length) result.notes.push(`${names(found.blocked)}은(는) 비밀이 들어 있을 수 있어 보내지 않았습니다.`);
    if (found.outside.length) result.notes.push(`${names(found.outside)}은(는) 대화의 작업 폴더 밖에 있어 보내지 않았습니다.`);
    if (large.length) result.notes.push(`${names(large)}은(는) ${Math.floor(adapter.limits.uploadBytes / 1024 / 1024)}MB가 넘어 보내지 못했습니다. PC에서 열어 보세요.`);
    for (const [reason, why] of Object.entries(HELD) as [HoldReason, string][]) {
      const held = found.held.filter((file) => file.reason === reason).map((file) => file.name);
      if (held.length) result.notes.push(`${names(held)}은(는) ${why} 보내지 않았습니다.`);
    }
    // Sent, but part of it could not be opened (7z, rar, PDF, an encrypted zip, …): always said.
    if (found.opaque.length) result.notes.push(unopened(found.opaque));
    if (found.stopped) result.notes.push("멈춰서 파일은 보내지 않았습니다. PC에서 보세요.");
    result.blocked = found.blocked.length;
    result.secret = found.held.map((file) => file.reason);
    return result;
  }

  /** Files held back for what they hold (unit 9): one record row per reason, with its count. */
  private auditHeld(binding: Binding, sessionId: string, requestId: string | null, reasons: HoldReason[] | undefined) {
    for (const reason of new Set(reasons ?? [])) this.audit(binding, binding.kind, "file.blocked", { sessionId, requestId, result: `${reason}:${reasons!.filter((one) => one === reason).length}` });
  }

  /** One line for the files that did not go with an answer that did: the answer is not sent again. */
  private async sayUnsent(adapter: ChannelAdapter, binding: Binding, key: string, unsent: { name: string; delivered: "no" | "unknown" }[]) {
    const failed = unsent.filter((file) => file.delivered === "no").map((file) => file.name), unsure = unsent.filter((file) => file.delivered === "unknown").map((file) => file.name);
    const lines = [...(failed.length ? [`${names(failed)}은(는) 보내지 못했습니다. PC에서 열어 보세요.`] : []), ...(unsure.length ? [`${names(unsure)}은(는) 전달되지 않았을 수 있습니다. PC에서 확인해 주세요.`] : [])];
    this.audit(binding, binding.kind, "file.unsent", { result: String(unsent.length) });
    await this.say(adapter, binding, `unsent:${key}`, { text: lines.join("\n") });
  }

  /** "받기" / "1쪽 보기" on a recent file: the document itself, or its first page, under the block list. */
  private async sendDocument(adapter: ChannelAdapter, binding: Binding, key: string, artifact: Artifact, page: boolean, reply: (text: string, part?: string) => Promise<unknown>) {
    if (blockedReason(artifact.path, artifact.name, this.rules())) {
      this.audit(binding, binding.kind, "file.blocked", { result: "1" });
      return void (await reply(`「${artifact.name}」은(는) 비밀이 들어 있을 수 있어 보내지 않았습니다.`, "blocked"));
    }
    if (page) {
      const shown = previewed(artifact) ? await this.pageOf(artifact, artifact.revision) : { file: null, temp: null, note: `「${artifact.name}」은(는) 쪽 미리보기가 없는 형식입니다.` };
      if ("fallback" in shown && shown.fallback) this.audit(binding, binding.kind, "preview.fallback", { result: shown.fallback });
      try {
        if (!shown.file) return void (await reply(shown.note ?? "미리보기를 만들지 못했습니다.", "page"));
        const sent = await this.say(adapter, binding, key, { text: "", files: [shown.file] });
        if (sent) this.audit(binding, binding.kind, "file.sent", { result: "1" });
      } finally {
        if (shown.temp) rmSync(shown.temp, { force: true });
      }
      return;
    }
    const path = this.manager.documents.revisionPath(artifact.id, artifact.revision);
    let size = 0;
    try { size = statSync(path).size; } catch { return void (await reply("그 파일을 읽지 못했습니다.")); }
    if (size > adapter.limits.uploadBytes) return void (await reply(`「${artifact.name}」은(는) ${Math.floor(adapter.limits.uploadBytes / 1024 / 1024)}MB가 넘어 보내지 못했습니다. PC에서 열어 보세요.`));
    const sent = await this.say(adapter, binding, key, { text: "", files: [{ path, name: artifact.name, mime: mimeOf(artifact.name) }] });
    if (sent) this.audit(binding, binding.kind, "file.sent", { result: "1" });
  }

  /** Whether the gateway takes new work now (not while it drains for an update or stops). */
  private admitted(): boolean {
    try {
      this.manager.tasks.admitNewWork?.();
      return true;
    } catch {
      return false;
    }
  }

  // Sending

  private chatOf(binding: Binding): ChatRef {
    return { kind: binding.kind, botId: binding.botId, chatId: binding.chatId, chatType: "dm" };
  }

  private async ack(adapter: ChannelAdapter, handle: string, note?: string) {
    try {
      await adapter.ackButton(handle, note);
    } catch (error) {
      this.log.note("ack_failed", error);
    }
  }

  /** A menu screen as the core sends it: menu buttons are the kind "menu", their action in the button's row. */
  private message(screen: Screen): Message {
    const spec = (button: MenuButton): ButtonSpec => ("act" in button ? { label: button.label, kind: "menu", data: button.act, ...(button.ttl ? { ttl: button.ttl } : {}), ...(button.set ? { set: button.set } : {}) } : { label: button.label, kind: button.kind, ...(button.data === undefined ? {} : { data: button.data }) });
    return { text: screen.text, ...(screen.buttons?.length ? { buttons: screen.buttons.map((row) => row.map(spec)) } : {}) };
  }

  /** A screen shown on a message the chat already has: the buttons it showed are over, new ones are bound to it. */
  private async showScreen(adapter: ChannelAdapter, binding: Binding, messageId: string, screen: Screen): Promise<boolean> {
    const fresh = this.channels.binding(binding.id) ?? binding;
    this.channels.retireMessage(fresh.id, messageId, this.now());
    const { rows, tokens } = this.makeButtons(fresh, this.message(screen));
    if (tokens.length) this.channels.setButtonMessage(tokens, messageId);
    return this.edit(adapter, fresh.id, this.chatOf(fresh), messageId, { text: screen.text, buttons: rows });
  }

  /** Buttons as the messenger gets them: a random token each; what a token does is written in the table. */
  private buttons(binding: Binding, message: Message, key?: string): { rows: Button[][]; tokens: string[] } {
    // A message tried again keeps the buttons made for its first try (no second set of rows).
    const made = key ? this.issued.get(key) : undefined;
    if (made) return made;
    const issued = this.makeButtons(binding, message);
    if (key && issued.tokens.length) this.issued.set(key, issued);
    return issued;
  }

  private makeButtons(binding: Binding, message: Message): { rows: Button[][]; tokens: string[] } {
    const sessionId = message.group?.sessionId ?? binding.pointerSessionId ?? "-";
    const base = `set:${randomBytes(9).toString("base64url")}`;
    const tokens: string[] = [];
    const rows = (message.buttons ?? []).map((row) => row.map((spec) => {
      const token = randomBytes(16).toString("base64url");
      tokens.push(token);
      this.channels.addButton({ token, bindingId: binding.id, chatId: binding.chatId, userId: binding.userId, sessionId, itemId: spec.itemId ?? message.group?.itemId ?? `${base}:${spec.set ?? spec.kind}`, kind: spec.kind, data: spec.data === undefined ? null : JSON.stringify(spec.data), createdAt: this.now(), expiresAt: this.now() + (spec.ttl ?? BUTTON_TTL) });
      return { label: spec.label, token };
    }));
    return { rows, tokens };
  }

  /**
   * Say something of the chat's work to a paired chat, once under its key. Nothing is said to a
   * disconnected chat, nor to a paused or locked one (an answer is held until the gate opens).
   */
  private async say(adapter: ChannelAdapter, binding: Binding, key: string, message: Message, owner: { sessionId?: string | null; requestId?: string | null } = {}): Promise<string | null> {
    if (this.gateOf(binding.id) !== "open") return null;
    if (!this.channels.owe(key, { bindingId: binding.id, ...owner }) && this.channels.outbox(key)?.state !== "pending") return null;
    const { rows, tokens } = this.buttons(binding, message, key);
    const messageId = await this.attempt(adapter, this.chatOf(binding), key, { text: message.text, ...(rows.length ? { buttons: rows } : {}), ...(message.silent ? { silent: true } : {}), ...(message.webApp ? { webApp: message.webApp } : {}), ...(message.files?.length ? { files: message.files } : {}), ...(message.markdown ? { markdown: true } : {}), ...(message.tail ? { tail: message.tail } : {}) }, { bindingId: binding.id, kind: "work" });
    if (messageId && tokens.length) this.channels.setButtonMessage(tokens, messageId);
    return messageId;
  }

  /**
   * Say something to a chat that may not be paired (a stranger, a phone that is pairing), or answer
   * what a paired person just wrote, once under its key. `owner` is the binding (its gate is read
   * again before every try) or `chat:<id>`.
   */
  private async post(adapter: ChannelAdapter, chat: ChatRef, key: string, owner: string, out: Out): Promise<string | null> {
    if (!this.channels.owe(key, { bindingId: owner }) && this.channels.outbox(key)?.state !== "pending") return null;
    return this.attempt(adapter, chat, key, out, owner.startsWith("chat:") ? null : { bindingId: owner, kind: "reply" });
  }

  /** What leaves the PC: text and button labels with the secrets hidden. */
  private scrubbed(out: Out): Out {
    const { markdown, tail = "", ...rest } = out;
    // Redacted first, then made readable; formatted() reads the readable text again (comfort of unit 14).
    // The channel's own lines go after it as plain text: never inside the answer's code block.
    const body = markdown ? formatted(this.log.scrub(out.text), (value) => this.log.scrub(value)) : { text: this.log.scrub(`${out.text}${tail}`) };
    return {
      ...rest, ...body, ...(markdown && tail ? { text: `${body.text}${this.log.scrub(tail)}` } : {}),
      ...(out.buttons ? { buttons: out.buttons.map((row) => row.map((button) => ({ ...button, label: this.log.scrub(button.label) }))) } : {}),
      ...(out.files ? { files: out.files.map((file) => ({ ...file, name: this.log.scrub(file.name), ...(file.caption ? { caption: this.log.scrub(file.caption) } : {}) })) } : {}),
    };
  }

  /** The "입력 중" mark, only while the chat's gate is open (read right before the call). */
  private async typing(adapter: ChannelAdapter, binding: Binding) {
    if (this.gateOf(binding.id) !== "open") return;
    await adapter.typing(this.chatOf(binding)).catch((error: unknown) => this.log.note("typing_failed", error));
  }

  /** Edit a message of a chat, if its gate is open now (read right before the call), with the secrets hidden. */
  private async edit(adapter: ChannelAdapter, bindingId: string, chat: ChatRef, messageId: string, out: Out): Promise<boolean> {
    if (this.gateOf(bindingId) !== "open") return false;
    try {
      await adapter.edit(chat, messageId, this.scrubbed(out));
      return true;
    } catch (error) {
      this.log.note("edit_failed", error);
      return false;
    }
  }

  /**
   * One send under an outbox key. The chat's gate is read again right before every try: nothing is
   * sent to a disconnected chat, and an answer for a paused or locked one is held. What certainly
   * did not go is tried again (at once a few times, then with a growing wait, at most `SEND_TRIES`
   * times, never sooner than the messenger asked); what the messenger refused for good is not; what
   * may have gone is marked unknown and never sent a second time.
   */
  private async attempt(adapter: ChannelAdapter, chat: ChatRef, key: string, out: Out, gate: Gate): Promise<string | null> {
    if (this.closed) return null;
    const final = key.startsWith("final:");
    if (gate) {
      const state = this.gateOf(gate.bindingId);
      if (state === "closed" || (state === "held" && gate.kind === "work")) {
        const row = this.channels.outbox(key);
        // Held: an answer stays owed until the gate opens; a passing remark is not worth saying late.
        if (row && (state === "closed" || !final)) this.discard(row, this.channels.binding(gate.bindingId));
        return null;
      }
    }
    if (!this.channels.begin(key)) return null;
    // Asked again by the messenger right before the message leaves (it may wait in a send line first).
    const stillWanted = gate ? () => { const state = this.gateOf(gate.bindingId); return state === "open" || (state === "held" && gate.kind === "reply"); } : undefined;
    try {
      const { messageId, unsent } = await adapter.send(chat, this.scrubbed(out), stillWanted ? { stillWanted } : {});
      if (unsent?.length) this.unsent.set(key, unsent);
      if (this.closed) return null;
      this.channels.settle(key, "sent", messageId);
      this.tries.delete(key);
      this.issued.delete(key);
      return messageId;
    } catch (error) {
      if (this.closed) return null;
      const certain = error instanceof ChannelSendError && error.delivered === "no";
      if (certain && error.code === "withdrawn") {
        // The chat was closed while this waited to leave: held or discarded as if it had been closed before.
        this.channels.settle(key, "pending");
        return this.attempt(adapter, chat, key, out, gate);
      }
      if (!certain) {
        this.channels.settle(key, "unknown");
        this.issued.delete(key);
        this.log.note("send_unknown", error);
        return null;
      }
      const count = (this.tries.get(key)?.count ?? 0) + 1;
      if (error.permanent || (final && count >= SEND_TRIES)) {
        this.channels.settle(key, "undeliverable");
        this.tries.delete(key);
        this.issued.delete(key);
        this.log.note("send_refused", error);
        this.refused(adapter.kind, key, error.permanent ? error.code : "gave_up");
        return null;
      }
      this.channels.settle(key, "pending");
      this.log.note("send_not_gone", error);
      const asked = error.retryAfterMs ?? 0;
      if (count <= this.retryMs.length && asked <= this.retryMs[count - 1]!) {
        this.tries.set(key, { count, next: 0 });
        await delay(this.retryMs[count - 1]!);
        return this.attempt(adapter, chat, key, out, gate);
      }
      // A passing remark is not worth saying late; an answer is tried again after a growing wait.
      if (!final) {
        this.tries.delete(key);
        this.channels.dropOwed(key);
        return null;
      }
      const gap = Math.min(LONGEST_RETRY_GAP, RETRY_GAP * 2 ** Math.max(0, count - this.retryMs.length - 1));
      this.tries.set(key, { count, next: this.now() + Math.max(gap, asked) });
      return null;
    }
  }

  /** The messenger refused a message for good (or it failed too often): recorded, and the PC is told. */
  private refused(kind: ChannelKind, key: string, code: string) {
    const row = this.channels.outbox(key);
    const binding = row ? this.channels.binding(row.bindingId) : null;
    this.audit(binding, kind, "send.refused", { sessionId: row?.sessionId ?? null, requestId: row?.requestId ?? null, target: key.split(":")[0] ?? null, result: code });
    if (key.startsWith("final:")) this.changed();
  }

  /** For the PC: answers to this chat the messenger refused for good since something last reached it, and why. */
  undelivered(bindingId: string): { count: number; at: number; reason: string } | null {
    const binding = this.channels.binding(bindingId);
    const found = this.channels.undeliverable(bindingId);
    if (!binding || !found) return null;
    const code = this.channels.auditList({ bindingId, limit: 500 }).find((row) => row.action === "send.refused" && row.target === "final")?.result ?? "";
    const messenger = binding.kind === "telegram" ? "텔레그램" : "Slack";
    const reason = code === "gave_up" ? `${messenger}에 여러 번 보내지 못해 그만두었습니다.`
      : code.endsWith("403") || code === "blocked" ? `${messenger}이 답을 받지 않았습니다(봇을 차단했을 수 있습니다).`
        : code.endsWith("404") ? `${messenger}에서 이 대화를 찾지 못했습니다.`
          : `${messenger}이 답을 받지 않았습니다.`;
    return { ...found, reason };
  }

  /**
   * For the PC: answers that may or may not have reached this chat (the messenger did not answer
   * after the request went) since something certainly reached it. They are not sent again.
   */
  uncertain(bindingId: string): { count: number; at: number } | null {
    return this.channels.binding(bindingId) ? this.channels.unconfirmed(bindingId) : null;
  }

  /** With the next line the person writes: an answer that may not have arrived, said once. */
  private async mentionUnsure(adapter: ChannelAdapter, binding: Binding) {
    const rows = this.channels.untold(binding.id);
    if (!rows.length) return;
    this.channels.told(rows.map((row) => row.key));
    const last = rows.findLast((row) => row.key.startsWith("final:"));
    if (!last) return;
    await this.say(adapter, binding, `unsure:${last.key}`, { text: "앞의 답이 전달되지 않았을 수 있습니다.", buttons: [[{ label: "마지막 답 보기", kind: "last-answer", data: { key: last.key } }]] });
  }

  // What the conversations do: requests of the chat, turn ends, questions

  private async onItem(sessionId: string, item: TranscriptItem) {
    if (item.kind === "user" && item.origin) return this.onRequest(sessionId, item.id.slice(5), item.origin);
    if (item.kind === "turnEnd" || (item.kind === "notice" && item.level === "error" && item.id.startsWith("error:"))) return this.onEnd(sessionId);
    if (item.kind === "approval") return this.onQuestion(sessionId, item);
  }

  /** A request of a paired chat is in the conversation now (sent at once, or from the queue later): its answer is owed to the chat. */
  private async onRequest(sessionId: string, requestId: string, origin: RequestOrigin) {
    const binding = this.channels.binding(origin.bindingId);
    if (!binding || binding.revokedAt) return;
    if (!this.channels.owe(finalKey(sessionId, requestId), { bindingId: binding.id, sessionId, requestId })) return;
    // Paused or locked: no status line; the answer is owed, and held until the gate opens.
    if (binding.lockedAt || binding.pausedAt) return;
    const adapter = this.adapters.get(adapterKey(binding.kind, binding.botId));
    const key = `${binding.id}:${sessionId}`;
    if (!adapter || this.progress.has(key)) return;
    const now = this.now();
    // One quiet status line per turn, rewritten as the work goes on; the answer comes as a new message.
    const entry: Progress = { bindingId: binding.id, sessionId, startedAt: now, lastEditAt: now, lastTypingAt: now, messageId: null, ready: Promise.resolve() };
    entry.ready = this.say(adapter, binding, `status:${sessionId}:${requestId}`, { text: "작업 중 · 0:00", silent: true }).then((messageId) => { entry.messageId = messageId; });
    this.progress.set(key, entry);
    await entry.ready;
    await this.typing(adapter, binding);
  }

  private async onEnd(sessionId: string) {
    for (const row of this.channels.owed()) if (row.sessionId === sessionId && row.key.startsWith("final:")) await this.settleOwed(row);
  }

  /**
   * What the chat is told for a request, from the conversation's record: null while its turn has
   * not ended, "gone" when the request is no longer there.
   */
  private compose(session: Session, requestId: string): Final | "gone" | null {
    const items = this.manager.items(session.id).items;
    const at = items.findIndex((item) => item.id === `user:${requestId}`);
    if (at < 0) return "gone";
    const endAt = items.findIndex((item, index) => index > at && item.kind === "turnEnd");
    const retry: ButtonSpec[][] = [[{ label: "다시 시도", kind: "retry", data: { requestId } }]];
    const group = { sessionId: session.id };
    if (endAt < 0) {
      // The engine never took it (it could not be started): said on the request, without a turn end.
      const failure = items.find((item, index) => index > at && item.kind === "notice" && item.id === `error:${requestId}`);
      if (failure?.kind !== "notice") return null;
      return { endId: failure.id, label: "실패", message: { text: `실패: ${shapeAnswer(this.log.scrub(failure.text)).text}`, buttons: retry, group } };
    }
    const end = items[endAt] as Extract<TranscriptItem, { kind: "turnEnd" }>;
    const startAt = items.slice(0, endAt).findLastIndex((item) => item.kind === "turnEnd") + 1;
    const reply = items.slice(startAt, endAt).findLast((item) => item.kind === "assistant" && item.text.trim());
    const answer = reply?.kind === "assistant" ? reply.text : "";
    if (end.status === "completed") {
      const shaped = shapeAnswer(this.log.scrub(answer));
      const buttons: ButtonSpec[][] = [];
      for (let index = 0; index < shaped.choices.length; index += 2) buttons.push(shaped.choices.slice(index, index + 2).map((choice) => ({ label: choiceLabel(choice), kind: "choice", data: { text: choice } })));
      // A plan asked for with "계획 먼저": its one 진행 goes on the plan itself.
      const plan = items.find((item, index) => index > endAt && item.kind === "approval" && item.id === `plan:${requestId}`);
      if (plan?.kind === "approval" && plan.decision === null) buttons.push([{ label: "진행", kind: "approve", itemId: plan.id }]);
      // A long answer: its opening here, the whole of it as a .md file with the message.
      const turn = { items: items.slice(startAt, endAt), answer, startedAt: items[at]!.at, long: shaped.more ? takeChoices(answer).text.trim() : null };
      // A cut inside a code block closes it, so nothing after the cut reads as code.
      const message: Message = shaped.more
        ? { text: closeFence(shaped.text), tail: "\n\n(답이 길어 앞부분만 보냈습니다. 전체는 첨부한 파일에 있습니다.)", markdown: true }
        : { text: shaped.text, markdown: true };
      return { endId: end.id, label: "끝남", message: { ...message, ...(buttons.length ? { buttons } : {}), group }, turn };
    }
    if (end.status === "interrupted") {
      const text = end.cause === "restart" ? "앱이 다시 시작되어 하던 일이 멈췄습니다." : end.cause === "crash" ? "엔진이 멈춰 하던 일이 끊겼습니다." : "멈췄습니다.";
      return { endId: end.id, label: "멈춤", message: { text, buttons: [[{ label: "이어서 하기", kind: "continue", set: "stopped" }, { label: "그대로 두기", kind: "leave", set: "stopped" }]], group } };
    }
    const reason = answer.trim() ? shapeAnswer(this.log.scrub(answer)).text : (session.lastError ?? "응답이 끝나지 못했습니다.");
    return { endId: end.id, label: "실패", message: { text: `실패: ${reason}`, buttons: retry, group } };
  }

  /**
   * Send the answer owed for a request, once its turn has ended. One answer per turn and chat.
   * Held while the chat is paused or locked (sent by `releaseHeld`); discarded, and recorded, when
   * it was disconnected.
   */
  private async settleOwed(row: OutboxRow) {
    if (this.closed || this.settling.has(row.key) || !row.sessionId || !row.requestId) return;
    this.settling.add(row.key);
    try {
      // Still owed? Another request of the same turn may have answered for it meanwhile.
      if (this.channels.outbox(row.key)?.state !== "pending") return;
      const binding = this.channels.binding(row.bindingId);
      if (!binding || binding.revokedAt) return this.discard(row, binding);
      const session = this.manager.view.sessions.get(row.sessionId);
      if (!session) return void this.channels.dropOwed(row.key);
      const final = this.compose(session, row.requestId);
      if (final === "gone") return void this.channels.dropOwed(row.key);
      if (!final) return;
      if (binding.lockedAt || binding.pausedAt) return;
      const progress = this.progress.get(`${binding.id}:${session.id}`);
      this.progress.delete(`${binding.id}:${session.id}`);
      // Requests put into the same turn are answered by the same message.
      for (const other of this.channels.owed(binding.id)) {
        if (other.key === row.key || other.sessionId !== session.id || !other.requestId) continue;
        const same = this.compose(session, other.requestId);
        if (same && same !== "gone" && same.endId === final.endId) this.channels.dropOwed(other.key);
      }
      const adapter = this.adapters.get(adapterKey(binding.kind, binding.botId));
      if (!adapter) return;
      await progress?.ready.catch(() => undefined);
      // The chat may have been closed while the status line was still on its way.
      if (progress?.messageId) await this.edit(adapter, binding.id, this.chatOf(binding), progress.messageId, { text: `${final.label} · ${clock(this.now() - progress.startedAt)}` });
      const { rows, tokens } = this.buttons(binding, final.message, row.key);
      let going: Awaited<ReturnType<ChannelCore["outgoing"]>> = { files: [], notes: [], temp: [], blocked: 0, fallbacks: [] };
      let messageId: string | null;
      try {
        // Made inside the try: what it writes for this send is removed whatever happens.
        const since = this.order;
        going = await this.outgoing(adapter, session, final, going, () => (this.stoppedAt.get(binding.id) ?? 0) > since);
        const footer = final.label === "끝남" && final.turn && footerOn(binding, this.footer) ? footerWords(this.manager, session, final.endId, final.turn.startedAt) : "";
        const lines = [...going.notes, ...(footer ? (going.notes.length ? ["", footer] : [footer]) : [])];
        const tail = `${final.message.tail ?? ""}${lines.length ? `\n\n${lines.join("\n")}` : ""}`;
        messageId = await this.attempt(adapter, this.chatOf(binding), row.key, { text: final.message.text, ...(tail ? { tail } : {}), ...(rows.length ? { buttons: rows } : {}), ...(going.files.length ? { files: going.files } : {}), ...(final.message.markdown ? { markdown: true } : {}) }, { bindingId: binding.id, kind: "work" });
      } finally {
        for (const path of going.temp) rmSync(path, { recursive: true, force: true });
      }
      if (messageId && tokens.length) this.channels.setButtonMessage(tokens, messageId);
      const unsent = this.unsent.get(row.key) ?? [];
      this.unsent.delete(row.key);
      if (messageId && going.files.length > unsent.length) this.audit(binding, binding.kind, "file.sent", { sessionId: session.id, requestId: row.requestId, result: String(going.files.length - unsent.length) });
      if (messageId && unsent.length) await this.sayUnsent(adapter, binding, row.key, unsent);
      if (messageId && going.blocked) this.audit(binding, binding.kind, "file.blocked", { sessionId: session.id, requestId: row.requestId, result: String(going.blocked) });
      if (messageId) this.auditHeld(binding, session.id, row.requestId, going.secret);
      for (const reason of going.fallbacks) this.audit(binding, binding.kind, "preview.fallback", { sessionId: session.id, requestId: row.requestId, result: reason });
    } finally {
      this.settling.delete(row.key);
    }
  }

  private questionText(session: Session, item: Extract<TranscriptItem, { kind: "approval" }>): { text: string; markdown?: boolean; tail?: string } {
    // A plan's 진행 sits on the plan's own answer: that answer stays what the message says.
    if (item.plan && item.id.startsWith("plan:")) {
      const final = this.compose(session, item.id.slice(5));
      if (final && final !== "gone") return { text: final.message.text, ...(final.message.markdown ? { markdown: true } : {}), ...(final.message.tail ? { tail: final.message.tail } : {}) };
    }
    const detail = item.detail?.trim() ? `\n${cutAt(this.log.scrub(item.detail.trim()), 600)}` : "";
    return { text: `「${session.purpose}」 · ${item.title}${detail}` };
  }

  /** The question's message again with a line under it (plain, after the answer's own text). */
  private questionWith(session: Session, item: Extract<TranscriptItem, { kind: "approval" }>, line: string): Out {
    const question = this.questionText(session, item);
    return { ...question, tail: `${question.tail ?? ""}\n${line}` };
  }

  /** A conversation asks before a step (a stricter mode, or a plan to go ahead with): sent with bound buttons to the chat whose request runs there. */
  private async onQuestion(sessionId: string, item: Extract<TranscriptItem, { kind: "approval" }>) {
    const session = this.manager.view.sessions.get(sessionId);
    if (!session) return;
    if (item.decision !== null) {
      // Answered elsewhere (at the PC), or expired: the chat's buttons for it are over.
      const live = this.channels.liveButtons(sessionId, item.id);
      const outcome = item.decision === "accept" ? (item.plan ? "진행함" : "허용함") : item.decision === "decline" ? "거절함" : "만료됨";
      for (const bindingId of new Set(live.map((button) => button.bindingId))) {
        const retired = this.channels.retireButtons(bindingId, sessionId, item.id, this.now());
        const binding = this.channels.binding(bindingId), adapter = binding ? this.adapters.get(adapterKey(binding.kind, binding.botId)) : undefined;
        const messageId = retired.find((button) => button.messageId)?.messageId;
        if (binding && adapter && messageId) await this.edit(adapter, binding.id, this.chatOf(binding), messageId, this.questionWith(session, item, `PC에서 ${outcome}`));
      }
      return;
    }
    const asking = new Set(this.channels.owed().filter((row) => row.sessionId === sessionId && row.key.startsWith("final:")).map((row) => row.bindingId));
    // A plan that waits after its turn ended: the chat that asked for it has its 진행 on the plan's answer.
    const askedFor = item.plan && item.id.startsWith("plan:") ? this.channels.outbox(finalKey(sessionId, item.id.slice(5)))?.bindingId : undefined;
    if (askedFor) asking.delete(askedFor);
    // The desktop's own questions, for chats that asked to hear about this project (not of a conversation muted at the PC).
    if (!session.muted) for (const binding of this.channels.bindings()) if (!binding.revokedAt && this.menu.notified(binding).includes(session.workId)) asking.add(binding.id);
    for (const bindingId of asking) {
      const binding = this.channels.binding(bindingId);
      if (!binding || binding.revokedAt || binding.lockedAt || binding.pausedAt) continue;
      const adapter = this.adapters.get(adapterKey(binding.kind, binding.botId));
      if (!adapter) continue;
      const key = `question:${sessionId}:${item.id}:${binding.id}`;
      if (item.officeInteraction) {
        await this.say(adapter, binding, key, { text: `「${session.purpose}」에서 문서 편집기의 질문이 기다립니다. 이 질문은 PC에서만 답할 수 있습니다.` });
        continue;
      }
      const buttons: ButtonSpec[][] = item.plan ? [[{ label: "진행", kind: "approve" }]] : [[{ label: "허용", kind: "approve" }, { label: "거절", kind: "decline" }]];
      await this.say(adapter, binding, key, { ...this.questionText(session, item), buttons, group: { sessionId, itemId: item.id } });
    }
  }

  /**
   * The desktop's own work ended (the PC's notification filters already applied: not muted, not on
   * a screen, notifications on): told to each chat that asked to hear about its project. A request
   * of a chat is answered as such, never also as a notice.
   */
  private async onAttention(row: AttentionEvent) {
    if (row.kind !== "completed" && row.kind !== "failed") return;
    const session = this.manager.view.sessions.get(row.taskRef.sessionId);
    if (!session) return;
    const items = this.manager.items(session.id).items;
    const at = items.findIndex((item) => item.id === row.itemId);
    const request = items.slice(0, at < 0 ? items.length : at).findLast((item) => item.kind === "user" && !item.steered);
    if (request?.kind === "user" && request.origin) return;
    const work = this.manager.view.works.get(session.workId);
    for (const binding of this.channels.bindings()) {
      if (binding.revokedAt || !this.menu.notified(binding).includes(session.workId)) continue;
      const adapter = this.adapters.get(adapterKey(binding.kind, binding.botId));
      if (!adapter) continue;
      const preview = session.preview?.trim() ? `\n${cutAt(this.log.scrub(session.preview.trim()).replace(/\s+/g, " "), 200)}` : "";
      await this.say(adapter, binding, `notice:${row.id}:${binding.id}`, { text: `PC에서 시킨 일이 ${row.kind === "completed" ? "끝났습니다" : "실패했습니다"} · 「${work?.title ?? "?"}」 › 「${session.purpose}」${preview}` });
    }
  }

  // Buttons

  private async onButton(adapter: ChannelAdapter, event: Extract<Inbound, { type: "button" }>, binding: Binding | null): Promise<Later | null> {
    const { chat, from } = event;
    const row = this.channels.button(event.token);
    // Only the person a button was sent to, in the chat it was sent to. Anyone else changes nothing.
    // …and on the message it was sent on (a button copied onto another message does nothing).
    const elsewhere = Boolean(row?.messageId && event.messageId && row.messageId !== event.messageId);
    if (!binding || !row || row.bindingId !== binding.id || row.chatId !== chat.chatId || row.userId !== from.userId || elsewhere) {
      if (binding) this.audit(binding, chat.kind, "refused", { result: "button" });
      await this.ack(adapter, event.ackHandle, TEXT.deadButton);
      return null;
    }
    if (binding.lockedAt || binding.pausedAt) {
      this.audit(binding, chat.kind, "refused", { result: binding.lockedAt ? "locked" : "paused" });
      await this.ack(adapter, event.ackHandle, binding.lockedAt ? "채널이 잠겨 있습니다" : "채널이 멈춰 있습니다");
      return null;
    }
    // One press, before it expires. Taken first, so two presses cannot both act.
    const now = this.now();
    if (!this.channels.useButton(event.token, now)) {
      await this.ack(adapter, event.ackHandle, row.usedAt !== null ? TEXT.handled : TEXT.expired);
      return null;
    }
    if (row.sessionId && row.itemId) this.channels.retireButtons(binding.id, row.sessionId, row.itemId, now);
    const data = row.data ? (JSON.parse(row.data) as Record<string, unknown>) : {};
    const reply = (text: string, part = "0") => this.post(adapter, chat, `ack:${chat.kind}:${chat.botId}:${event.eventId}:${part}`, binding.id, { text });
    const asRequest = (text: string, sessionId: string | undefined, note: string) => {
      const requestId = `ch:${chat.kind}:${chat.botId}:btn:${event.token}`;
      void this.ack(adapter, event.ackHandle, note);
      return this.enqueue(binding.id, (order) => this.handoff(adapter, binding.id, order, { text, requestId, eventId: null, ...(sessionId ? { sessionId } : {}), reply }));
    };
    switch (row.kind) {
      case "approve":
      case "decline":
        await this.answer(adapter, binding, event, row);
        return null;
      case "full-access": {
        const session = row.sessionId ? this.manager.view.sessions.get(row.sessionId) : undefined;
        if (!session || session.archivedAt) {
          await this.ack(adapter, event.ackHandle, "보관한 대화입니다");
          return null;
        }
        this.manager.updateSession(session.id, { access: "full" });
        this.audit(binding, chat.kind, "access", { sessionId: session.id, result: "full" });
        await this.ack(adapter, event.ackHandle, "전체 접근으로 바꿨습니다");
        if (row.messageId) await this.edit(adapter, binding.id, chat, row.messageId, { text: `「${session.purpose}」을(를) '${MODE_LABEL.full}'으로 바꿨습니다. 지금부터 적용합니다.` });
        return null;
      }
      case "choice": {
        if (typeof data.text !== "string") return null;
        // The button showed a shortened choice: the chat is shown the whole of what is sent as the person's words.
        if (choiceLabel(data.text) !== data.text) await reply(`보낸 말: ${data.text}`, "choice");
        return asRequest(data.text, row.sessionId ?? undefined, "보냈습니다");
      }
      case "continue":
        return asRequest("이어서 해 주세요.", row.sessionId ?? undefined, "이어서 합니다");
      case "leave":
        await this.ack(adapter, event.ackHandle, "그대로 두었습니다");
        return null;
      case "retry": {
        // A button that starts something else ends a human-only input as its word does (P1).
        await this.extension?.command?.(binding, "retry", "button");
        const original = row.sessionId && typeof data.requestId === "string" ? this.manager.items(row.sessionId).items.find((item) => item.id === `user:${data.requestId as string}`) : undefined;
        if (original?.kind !== "user") {
          await this.ack(adapter, event.ackHandle, "다시 보낼 요청을 찾지 못했습니다");
          return null;
        }
        return asRequest(original.text, row.sessionId ?? undefined, "다시 시도합니다");
      }
      case "full-answer":
      case "last-answer": {
        await this.ack(adapter, event.ackHandle);
        const owed = row.kind === "last-answer" && typeof data.key === "string" ? this.channels.outbox(data.key) : null;
        const sessionId = owed?.sessionId ?? row.sessionId, requestId = owed?.requestId ?? (typeof data.requestId === "string" ? data.requestId : null);
        const session = sessionId ? this.manager.view.sessions.get(sessionId) : undefined;
        const final = session && requestId ? this.compose(session, requestId) : null;
        if (!session || !requestId || !final || final === "gone") {
          await reply("그 답을 찾지 못했습니다.");
          return null;
        }
        if (row.kind === "last-answer") {
          // The answer again as it was meant to go: with its files.
          let going: Awaited<ReturnType<ChannelCore["outgoing"]>> = { files: [], notes: [], temp: [], blocked: 0, fallbacks: [] };
          try {
            const since = this.order;
            going = await this.outgoing(adapter, session, final, going, () => (this.stoppedAt.get(binding.id) ?? 0) > since);
            const key = `resend:${event.token}`;
            const tail = `${final.message.tail ?? ""}${going.notes.length ? `\n\n${going.notes.join("\n")}` : ""}`;
            const sent = await this.say(adapter, binding, key, { ...final.message, ...(tail ? { tail } : {}), ...(going.files.length ? { files: going.files } : {}) });
            const unsent = this.unsent.get(key) ?? [];
            this.unsent.delete(key);
            if (sent && unsent.length) await this.sayUnsent(adapter, binding, key, unsent);
            if (sent && going.blocked) this.audit(binding, binding.kind, "file.blocked", { sessionId: session.id, requestId, result: String(going.blocked) });
            if (sent) this.auditHeld(binding, session.id, requestId, going.secret);
          } finally {
            for (const path of going.temp) rmSync(path, { recursive: true, force: true });
          }
        }
        else await this.say(adapter, binding, `full:${event.token}`, { text: this.wholeAnswer(session, requestId), markdown: true });
        return null;
      }
      case "file-get":
      case "file-page": {
        await this.ack(adapter, event.ackHandle);
        const artifact = typeof data.artifactId === "string" ? this.manager.documents.list().find((entry) => entry.id === data.artifactId && !entry.removed) : undefined;
        if (!artifact) {
          await reply("그 파일을 찾지 못했습니다.");
          return null;
        }
        await this.sendDocument(adapter, binding, `file:${event.token}`, artifact, row.kind === "file-page", reply);
        return null;
      }
      case "menu": {
        if (data.a === "new" || data.a === "lock") await this.extension?.command?.(binding, data.a, "button");
        await this.ack(adapter, event.ackHandle);
        await this.menu.press(adapter, binding, chat, event.eventId, row.messageId, data as unknown as MenuAct);
        return null;
      }
      case "move": {
        // The line that could not go to its archived conversation goes to a new one, under its own request id.
        const eventId = typeof data.eventId === "string" ? data.eventId : "";
        const payload = this.channels.parked(chat.kind, chat.botId, eventId);
        const original = payload ? (JSON.parse(payload) as Inbound) : null;
        if (original?.type !== "message") {
          await this.ack(adapter, event.ackHandle, "보낼 내용을 찾지 못했습니다. 다시 적어 보내 주세요.");
          return null;
        }
        const session = this.newConversation(binding);
        await this.ack(adapter, event.ackHandle, "새 대화에서 합니다");
        const requestId = `ch:${chat.kind}:${chat.botId}:${eventId}`;
        const moved = this.enqueue(binding.id, (order) => this.handoff(adapter, binding.id, order, { text: original.text, requestId, eventId: null, sessionId: session.id, reply }));
        return { settled: moved.settled.then((disposition) => { if (!this.closed) this.channels.done(chat.kind, chat.botId, eventId); return disposition; }) };
      }
      default:
        if (this.extension?.button && await this.extension.button(adapter, binding, event, row)) return null;
        await this.ack(adapter, event.ackHandle, TEXT.deadButton);
        return null;
    }
  }

  private wholeAnswer(session: Session, requestId: string): string {
    const items = this.manager.items(session.id).items;
    const at = items.findIndex((item) => item.id === `user:${requestId}`);
    const endAt = items.findIndex((item, index) => index > at && item.kind === "turnEnd");
    const startAt = items.slice(0, endAt < 0 ? items.length : endAt).findLastIndex((item) => item.kind === "turnEnd") + 1;
    const reply = items.slice(startAt, endAt < 0 ? items.length : endAt).findLast((item) => item.kind === "assistant" && item.text.trim());
    return reply?.kind === "assistant" ? takeChoices(reply.text).text.trim() : "답이 없습니다.";
  }

  /** 허용 / 거절 / 진행 from the chat: the conversation's own gate answers (it refuses an archived conversation and a question already answered). */
  private async answer(adapter: ChannelAdapter, binding: Binding, event: Extract<Inbound, { type: "button" }>, row: ButtonRow) {
    const session = row.sessionId ? this.manager.view.sessions.get(row.sessionId) : undefined;
    const item = session && row.itemId ? this.manager.items(session.id).items.find((entry) => entry.id === row.itemId) : undefined;
    const decision = row.kind === "approve" ? "accept" : "decline";
    const show = async (line: string) => {
      // A plan's answer is the engine's markdown: drawn again as it was sent.
      if (session && item?.kind === "approval" && row.messageId) await this.edit(adapter, binding.id, event.chat, row.messageId, this.questionWith(session, item, line));
    };
    if (!session || !row.itemId || item?.kind !== "approval") return this.ack(adapter, event.ackHandle, TEXT.handled);
    try {
      await this.manager.answerApproval(session.id, row.itemId, decision);
    } catch (error) {
      const code = error instanceof HttpError ? error.code : "failed";
      const note = code === "archived" ? "보관한 대화라 답할 수 없습니다" : code === "approval_not_pending" ? TEXT.handled : "답하지 못했습니다";
      if (code === "failed") this.log.note("approval_failed", error);
      this.audit(binding, binding.kind, "refused", { sessionId: session.id, target: row.itemId, result: code });
      // Answer first, draw after.
      await this.ack(adapter, event.ackHandle, note);
      await show(note);
      return;
    }
    const label = decision === "accept" ? (item.plan ? "진행함" : "허용함") : "거절함";
    this.audit(binding, binding.kind, "approval", { sessionId: session.id, target: row.itemId, result: decision });
    await this.ack(adapter, event.ackHandle, label);
    const at = new Date(this.now());
    await show(`${label} · ${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")} · 휴대폰`);
  }

  // Time

  /** Once a second: the status lines, the typing mark, answers still owed, old rows. */
  async pulse() {
    if (this.closed) return;
    const now = this.now();
    for (const [key, entry] of this.progress) {
      const binding = this.channels.binding(entry.bindingId), session = this.manager.view.sessions.get(entry.sessionId);
      if (!binding || binding.revokedAt || binding.lockedAt || binding.pausedAt || !session) {
        this.progress.delete(key);
        continue;
      }
      const adapter = this.adapters.get(adapterKey(binding.kind, binding.botId));
      if (!adapter || !busy(session)) continue;
      const chat = this.chatOf(binding);
      if (now - entry.lastTypingAt >= TYPING_GAP) {
        entry.lastTypingAt = now;
        void this.typing(adapter, binding);
      }
      if (entry.messageId && now - entry.lastEditAt >= adapter.limits.minEditGapMs) {
        entry.lastEditAt = now;
        const activity = session.activity && !GENERIC_ACTIVITY.has(session.activity) ? ` · 지금: ${cutAt(this.log.scrub(session.activity), 60)}` : "";
        void this.edit(adapter, binding.id, chat, entry.messageId, { text: `작업 중 · ${clock(now - entry.startedAt)}${activity}` });
      }
    }
    // An answer that certainly did not go is tried again when its wait is over.
    for (const row of this.channels.owed()) {
      const tried = this.tries.get(row.key);
      if (!row.key.startsWith("final:") || !tried || tried.next > now) continue;
      await this.settleOwed(row);
    }
    if (now - this.prunedAt >= HOUR) {
      this.prunedAt = now;
      this.channels.pruneInbox(now - 7 * DAY, now - DAY);
      this.channels.pruneButtons(now - DAY);
      this.channels.pruneOutbox(now - 30 * DAY, now - DAY);
      for (const key of this.tries.keys()) if (!this.channels.outbox(key)) this.tries.delete(key);
    }
  }
}

function hashCode(salt: string, value: string) {
  return createHash("sha256").update(`${salt}:${value}`).digest("hex");
}

function sameHash(a: string, b: string) {
  const left = Buffer.from(a, "hex"), right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
