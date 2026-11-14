import { createHmac, randomBytes } from "node:crypto";
import type { Store } from "../store.ts";
import { parseCommand } from "./shape.ts";
import type { ChatRef, Inbound, InFile, Sender } from "./types.ts";
import { everyday } from "./words.ts";

// The secret input of a chat (design §6.3 (i), unit 8; fix round 1, ruling R4). A value the app
// asked for never reaches the AI, whatever the person does next:
// - the input opens together with the hand-over message (no button press needed), for one person,
//   one hand-over, one field per message, for ten minutes;
// - a reply to a hand-over message is the value of that hand-over, whether its input is open or not;
// - a button press that opens an input counts at once, so a value sent right after it in the same
//   batch is taken (`press`);
// - an input ends in ONE way (fix round 4, ruling P1): `SecretWindows.end`, for one of the reasons
//   of `EndReason` (its value taken, 취소 or its button, it ran out, a word or a button that starts
//   something else, a closed gate, its step over on the AI's side, a restart found it open). The
//   module whose input it is says so in one line (`hooks.ended`) for every reason but `taken`. The
//   app's words (상태, 메뉴, 도움말 …) go to the app and leave it open;
// - after it ended, for LATE_MS (AGAIN_MS after its value was taken) its late catch (ruling P2) takes
//   out only a line with the SHAPE of what it awaited (a code, a link; the shapes of ruling Q3),
//   whatever carries the words (typed, forwarded, a caption, an edit: Q2); each ended input keeps its
//   own catch for its own time (Q4). A caught line is answered once with why and [그대로 보내기],
//   which forwards it as an ordinary line (its words and its files' references are kept in memory
//   for HOLD_MS, never on disk). Unit 8's secret input awaits no recognisable shape: nothing is
//   caught after it, the ending line is the protection;
// - a line that finds its input ended before the person was told (it ran out, or the gateway
//   restarted, or its step is over) is caught whatever it is, and answered the same way.
// A message taken here is recorded by the adapter only as a `secret` event without its value; the
// value stays in memory until the credential store has it. Whether a message was taken is written
// here, by its event id, before the adapter writes its inbox and offset: one delivered again is
// taken again the same way and never falls into the normal path.

export const WINDOW_MS = 10 * 60_000;
/** After an input ended without its value, how long its late catch lasts (ruling P2). */
export const LATE_MS = 30 * 60_000;
/** After its value was taken, how long the same shape is still caught (an SMS often comes twice). */
export const AGAIN_MS = 2 * 60_000;
/** How long the text of a caught or held line is kept (memory only) for [그대로 보내기]. */
export const HOLD_MS = 5 * 60_000;
/** Ruling Q3: digits are made plain before anything is judged (full-width and other compatibility forms → ASCII). */
export const plainText = (text: string) => text.normalize("NFKC");
/** A line shaped like a one-time code: 4–10 letters or digits once spaces and hyphens are taken out. */
export const codeLike = (text: string) => /^[A-Za-z0-9]{4,10}$/.test(plainText(text).replace(/[\s-]+/g, ""));

/**
 * Ruling Q3: what follows a run of digits that makes it an amount, a date, a time, a count or a
 * version, not a code. Joined to the run ("1430호에서", "1500자로") whatever follows; after a space
 * only as a word of its own ("2024 년", but "482913 일회용" and "2024 자료" are not units).
 */
const UNITS = "원|년|월|일|시|분|초|호|층|명|개|건|회|권|편|쪽|장|자|번째|번|페이지|버전|만|천|억|달러|%|px|kg|km|cm|mm|mb|gb|kb|krw|usd|won";
const UNIT_JOINED = new RegExp(`^(?:${UNITS})`, "i");
const UNIT_SPACED = new RegExp(`^\\s+(?:${UNITS})(?![가-힣A-Za-z])`, "i");
/** A currency sign in front of a run makes it an amount. */
const CURRENCY = /[$₩￦€£¥]\s*$/;

/**
 * Ruling Q3: ONE list of what marks a line as carrying a one-time code, used everywhere (the late
 * catch, the Slack hold, the open input's mixed tokens): the words, and a leading sender tag in
 * brackets ("[국민은행]", "[Web발신]").
 */
const MARKERS = "인증\\s*번호|인증\\s*코드|보안\\s*코드|확인\\s*코드|확인\\s*번호|본인\\s*확인|일회용|코드|web\\s*발신|\\botp\\b|\\bpin\\b|\\bcode\\b|verification|passcode";
export const CODE_MARKER = new RegExp(`${MARKERS}|^\\s*\\[[^\\][\\n]{1,20}\\]`, "i");

/**
 * Round 2's spaced forms of one code, joined before candidates are counted: two groups of three
 * digits ("482 913", "482-913") or single digits with single spaces ("4 8 2 9 1 3"). A phone number,
 * a date or an amount ("1588-1234", "2026-11-14") is not joined.
 */
function joined(text: string): string {
  return text
    .replace(/(?<![\d.,\-/:])(\d{3})[ -](\d{3})(?![\d]|[.,\-/:]\d|[ -]\d)/g, "$1$2")
    .replace(/(?<![\d.,\-/:])\d(?: \d){3,7}(?![\d]|[ -]\d)/g, (run) => run.replace(/ /g, ""));
}

/** The candidates of a line (made plain and joined first): `line` is the text they were found in. */
function candidates(text: string): { line: string; found: Set<string> } {
  const line = joined(plainText(text));
  const found = new Set<string>();
  for (const match of line.matchAll(/(?<![A-Za-z0-9])\d+(?:[.,\-/:]\d+)*(?![A-Za-z0-9])/g)) {
    const run = match[0], after = line.slice(match.index! + run.length);
    if (!/^\d{4,8}$/.test(run) || UNIT_JOINED.test(after) || UNIT_SPACED.test(after) || CURRENCY.test(line.slice(0, match.index!))) continue;
    found.add(run);
  }
  const mixed = (token: string | undefined) => { if (token && /\d/.test(token) && /[A-Za-z]/.test(token)) found.add(token); };
  for (const match of line.matchAll(/[[(【<「]\s*([A-Za-z0-9]{4,10})\s*[\])】>」]/g)) mixed(match[1]);
  for (const match of line.matchAll(new RegExp(`(?:${MARKERS})\\s*(?:는|은|:|：|is)?\\s*([A-Za-z0-9]{4,10})(?![A-Za-z0-9])`, "gi"))) mixed(match[1]);
  return { line, found };
}

/**
 * Unit 9 (round 2, widened by Q3): the one code a longer line holds, or null when it holds none or
 * more than one. A candidate is a run of 4–8 digits standing alone (digit groups joined by `.`, `,`,
 * `-`, `/` or `:` are one token: a phone number, a date, an amount or a time is never a candidate,
 * nor a run with a unit such as 원, 호 or 자, or after a currency sign), the spaced forms of one
 * code, or a 4–10 letter/digit token with both letters and digits inside brackets or after a code
 * marker (a bracketed sender name like [NAVER] is not one). Full-width digits count as digits.
 */
export function codeIn(text: string): string | null {
  const { found } = candidates(text);
  return found.size === 1 ? [...found][0]! : null;
}

/**
 * What an open human-only input does with a plain line: `true` takes the line as it is, `{ value }`
 * takes that part of it, "app" lets the app's own words go their way (never to the AI while the
 * input is open: the core answers them), "hold" keeps the line from the AI (deleted, said once),
 * `false` is an ordinary line (the vault's inputs never say so; kept for older hooks).
 */
export type TakeJudgement = boolean | "app" | "hold" | { value: string };

/** Words that start something else and cannot run beside an open human-only input: they end it (ruling A). */
export const STARTING: ReadonlySet<string> = new Set(["stop", "new", "lock", "retry"]);

/** A date written with separators: never a code. */
const DATE = /^\d{4}[-./]\d{1,2}[-./]\d{1,2}\.?$/;
/**
 * Ruling P2: a bare code-shaped line: 4–8 digits (spaces or hyphens between digit groups allowed,
 * a date is not one), or 4–10 capital letters and digits with both in it. "room101", "2026-11-14"
 * and a line with words are not. Full-width digits count (Q3).
 */
export function bareCode(text: string): boolean {
  const line = plainText(text).trim();
  if (DATE.test(line)) return false;
  if (/^\d+(?:[\s-]\d+)*$/.test(line) && /^\d{4,8}$/.test(line.replace(/[\s-]+/g, ""))) return true;
  return /^(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,10}$/.test(line);
}
/** Ruling Q3: what a SHORT line may hold besides its one candidate or link (spaces, brackets and quotes not counted). */
export const SHORT = 20;
const others = (line: string, part: string) => line.replace(part, "").replace(/[\s()<>[\]{}"'`「」『』“”‘’]/g, "").length;
/**
 * Ruling Q3: a code's shape: a bare code; or exactly one candidate with a code marker; or exactly
 * one candidate in a short line ("482913 입력해줘", "Your code is 482913"). "회의는 1430호에서 해요",
 * "문서 1500자로 써 줘" and "2026-11-14" are not.
 */
export function codeShaped(text: string): boolean {
  if (bareCode(text)) return true;
  const { line, found } = candidates(text);
  if (found.size !== 1) return false;
  return CODE_MARKER.test(line) || others(line, [...found][0]!) <= SHORT;
}
/** What marks a line as carrying a login link. */
const LINK_MARKER = /로그인|인증|sign\s*-?\s*in|verify|magic\s*link/i;
const LINKS = /https?:\/\/[^\s<>"'`]+/gi;
/** The web addresses of a line, without the punctuation that closes a sentence or a bracket around them. */
export const linksIn = (text: string) => [...text.matchAll(LINKS)].map((match) => match[0].replace(/[.,;:!?)\]」』>]+$/, ""));
/**
 * Ruling Q3: a login link's shape: a line whose only link is one http(s) link, with at most SHORT
 * other characters (brackets, angle brackets and quotes around it not counted: "(link)", "<link>",
 * "메일 왔어요 <link>", "<link> 열어 줘"), or with a login marker (round 4). A link inside a longer
 * request, or two links, pass.
 */
export function linkShaped(text: string): boolean {
  const links = linksIn(text);
  if (links.length !== 1) return false;
  return others(text, links[0]!) <= SHORT || LINK_MARKER.test(text.replace(links[0]!, ""));
}
/** A line that is nothing but one link (brackets, angle brackets and quotes around it not counted). */
export function bareLink(text: string): boolean {
  const links = linksIn(text);
  return links.length === 1 && others(text, links[0]!) === 0;
}
/** What an input catches after it ended: a code's shape, a link's shape, or nothing (unit 8). */
export type Catches = "code" | "link" | "none";
/**
 * What an input whose value WAS taken still catches (its two minutes): a bare code or a code with a
 * marker; a bare link or a link with a login marker — never the short-line rule. A step that
 * succeeded says no closing line, so a rule that also holds ordinary short lines ("2025 보고서
 * 열어 줘", "이거 봐줘 <link>") would swallow her next request unannounced (re-review 5, I-1).
 */
export function marked(kind: Catches, text: string): boolean {
  if (kind === "code") {
    if (bareCode(text)) return true;
    const { line, found } = candidates(text);
    return found.size === 1 && CODE_MARKER.test(line);
  }
  if (kind !== "link") return false;
  const links = linksIn(text);
  return links.length === 1 && (bareLink(text) || LINK_MARKER.test(text.replace(links[0]!, "")));
}
/** Whether a line has the shape an ended input of this kind catches. */
export const shaped = (kind: Catches, text: string) => (kind === "code" ? codeShaped(text) : kind === "link" ? linkShaped(text) : false);

/** A code input: the app's words, then a code-shaped line, then the one code a longer line holds; anything else is held. */
export function codeTake(text: string): TakeJudgement {
  if (everyday(text)) return "app";
  // Full-width digits are typed as ASCII digits (Q3).
  if (codeLike(text)) return plainText(text) === text ? true : { value: plainText(text).trim() };
  const code = codeIn(text);
  return code ? { value: code } : "hold";
}

/** A mail-link input: the app's words, then the one web address a line holds; anything else is held. */
export function linkTake(text: string): TakeJudgement {
  if (everyday(text)) return "app";
  const links = new Set(linksIn(text));
  if (links.size !== 1) return "hold";
  const link = [...links][0]!;
  return link === text.trim() ? true : { value: link };
}

/** A step that waits for a button (an approval in another app): only the app's words; anything else is held. */
export function waitTake(text: string): TakeJudgement {
  return everyday(text) ? "app" : "hold";
}
/** How long the ids of taken messages and the hand-over messages are remembered. */
const KEEP_MS = 24 * 60 * 60_000;

/**
 * Why an input ended (ruling P1). `taken`: its value came (nothing said here: the module says what it
 * did with it); `replaced`: another input opened in its place (that one's own line says what comes
 * next); `discarded`: the module ended it and says so in its own line ([값이 아니었어요], a sealed
 * form refused). Every other reason is said in one plain line by `hooks.ended`.
 */
export type EndReason = "taken" | "cancel" | "timeout" | "word" | "button" | "gate" | "over" | "restart" | "replaced" | "discarded";
/** Reasons the module says nothing for (it says what happened in its own words). */
export const SILENT: ReadonlySet<EndReason> = new Set(["taken", "replaced", "discarded"]);

export type SecretOutcome = "value" | "sealed" | "cancel" | "refused" | "stray" | "held" | "caught" | "word";
export type SecretWindow = {
  userId: string; handoffId: string; fields: string[]; next: number; expiresAt: number; mode: "text" | "sealed"; nonce?: string;
  /** For a hand-over already finished: take this one field again into its entry. */
  redo?: boolean;
  /** Lines held from the AI while this input was open. */
  held?: number;
  /** The run of the gateway that opened it: one of an earlier run was ended by the restart (P1). */
  run?: string;
  /** What it catches after it ended (P2). */
  catches?: Catches;
  /** Its name, for the line that says it ended ("'도서관' 인증번호"). */
  name?: string;
  /** Slack: a step that waits at the PC (nothing is taken from the chat; its shapes are held). */
  atPc?: boolean;
};
type Taken = { handoffId: string; field: number; outcome: SecretOutcome; at: number; messageId: string; deleted?: boolean; handled?: boolean; redo?: boolean; shape?: "code" | "link" };
/** The late catch after an input ended (P2): its shape, until when; `taken`: the same code again is caught too. */
type Late = { handoffId: string; userId: string; kind: "code" | "link"; until: number; taken?: boolean };
/** `lates`: one late catch per ended input, each for its own time (Q4: they never cancel each other). */
type ChatState = { window: SecretWindow | null; taken: Record<string, Taken>; asks: Record<string, { handoffId: string; userId: string; at: number }>; lates: Late[] };
/** What a caught or held line is kept as for [그대로 보내기] (memory only, HOLD_MS): its words and the files it carried. */
export type Kept = { text: string; files: InFile[] };
type Json = Record<string, unknown>;

/** What a message is besides plain text: anything here is refused in an open input (and deleted). */
const NOT_PLAIN = ["photo", "sticker", "document", "video", "voice", "audio", "animation", "video_note", "contact", "location", "venue", "poll", "dice", "game", "invoice", "story",
  "forward_origin", "forward_from", "forward_from_chat", "forward_date", "is_automatic_forward", "via_bot", "web_app_data"];

export type SecretWindowHooks = {
  /** A hand-over still waiting, with the fields still to give (null: it is over). */
  pending(handoffId: string): { fields: string[]; next: number } | null;
  /** A button press that opens an input: its hand-over and field, if it is a live button of this person in this chat. */
  opens?(chat: ChatRef, from: Sender, token: string, messageId?: string): { handoffId: string; fields: string[]; field: number; redo: boolean } | null;
  /** Whether a plain line is the open input's value (unit 9: a code input takes only a code); otherwise it is an ordinary line and the input stays. */
  takes?(handoffId: string, text: string): TakeJudgement;
  /** A live button of this person in this chat that belongs to a hand-over still waiting: that hand-over. */
  handoffOf?(chat: ChatRef, from: Sender, token: string, messageId: string): string | null;
  /** A button that starts something else (the menu's 새 대화 or 채널 잠금, 다시 시도): an open input ends at its press. */
  starts?(chat: ChatRef, from: Sender, token: string): boolean | string;
  /** An input ended (the one way, P1): the module ends its step where the reason means it, and says so. */
  ended?(chat: ChatRef, input: SecretWindow, reason: EndReason, how?: string): void;
};

export class SecretWindows {
  private readonly store: Pick<Store, "getMeta" | "setMeta">;
  private readonly now: () => number;
  private readonly hooks: SecretWindowHooks;
  /** Values taken from messages, by event, until the store has them. Memory only. */
  private readonly drop = new Map<string, string>();
  /** The text of caught and held lines, by event, for [그대로 보내기] (memory only, HOLD_MS). */
  private readonly kept = new Map<string, Kept & { until: number }>();
  /** The code a step just typed, per chat, as a keyed hash (never the value; memory only, the key is this run's). */
  private readonly typedCodes = new Map<string, { hash: string; until: number }>();
  private readonly hashKey = randomBytes(32);
  /** This run of the gateway (an input of another run was ended by the restart). */
  readonly run = randomBytes(6).toString("hex");
  private codeHash(code: string) { return createHmac("sha256", this.hashKey).update(code.replace(/[\s-]+/g, "")).digest("hex"); }

  constructor(store: Pick<Store, "getMeta" | "setMeta">, hooks: SecretWindowHooks, now: () => number = Date.now) {
    this.store = store;
    this.hooks = hooks;
    this.now = now;
  }

  private key(chat: Pick<ChatRef, "kind" | "botId" | "chatId">) { return `channel.secret:${chat.kind}:${chat.botId}:${chat.chatId}`; }
  private dropKey(chat: Pick<ChatRef, "kind" | "botId">, eventId: string) { return `${chat.kind}:${chat.botId}:${eventId}`; }

  private read(chat: ChatRef): ChatState {
    const raw = this.store.getMeta(this.key(chat));
    const state = raw ? (JSON.parse(raw) as Partial<ChatState> & { late?: Late }) : {};
    const since = this.now() - KEEP_MS;
    const window = state.window && state.window.expiresAt + KEEP_MS > this.now() ? state.window : null;
    return {
      window,
      taken: Object.fromEntries(Object.entries(state.taken ?? {}).filter(([, taken]) => taken.at >= since)),
      asks: Object.fromEntries(Object.entries(state.asks ?? {}).filter(([, ask]) => ask.at >= since)),
      // A state written by round 4 holds one `late`.
      lates: [...(state.lates ?? []), ...(state.late ? [state.late] : [])].filter((late) => late.until > this.now()),
    };
  }

  private write(chat: ChatRef, state: ChatState) {
    this.store.setMeta(this.key(chat), JSON.stringify(state));
  }

  /**
   * THE one way an input ends (ruling P1): its state goes, its late catch is armed (for its shape;
   * AGAIN_MS after its value, LATE_MS otherwise), and its module hears of it once the state is
   * written (it says so for every reason but the silent ones). Nothing else in the gateway clears an
   * input (input-end-matrix.test.ts checks).
   */
  private finish(chat: ChatRef, state: ChatState, reason: EndReason, how?: string): SecretWindow | null {
    const input = state.window;
    if (!input) return null;
    state.window = null;
    const kind = input.catches ?? "none";
    // Q4: its own late catch, for its own time; the catches of other inputs stay (one of the same input is renewed).
    state.lates = state.lates.filter((late) => late.handoffId !== input.handoffId);
    if (kind !== "none") state.lates.push({ handoffId: input.handoffId, userId: input.userId, kind, until: this.now() + (reason === "taken" ? AGAIN_MS : LATE_MS), ...(reason === "taken" ? { taken: true } : {}) });
    if (reason !== "taken") this.typedCodes.delete(this.key(chat));
    // After the caller wrote the state (all callers write before they return).
    queueMicrotask(() => this.hooks.ended?.(chat, input, reason, how));
    return input;
  }

  /** End the chat's open input (of this hand-over, when given; of this person, when given). Whether one ended. */
  end(chat: ChatRef, which: { handoffId?: string; userId?: string }, reason: EndReason, how?: string): boolean {
    const state = this.read(chat);
    const input = state.window;
    if (!input || (which.handoffId !== undefined && input.handoffId !== which.handoffId) || (which.userId !== undefined && input.userId !== which.userId)) return false;
    this.finish(chat, state, reason, how);
    this.write(chat, state);
    return true;
  }

  /** The tick (and the start): an input that ran out, one of an earlier run, or one whose hand-over is over ends now, and is said. */
  sweep(chat: ChatRef) {
    const window = this.read(chat).window;
    if (!window) return;
    const reason = this.found(window);
    if (reason) this.end(chat, { handoffId: window.handoffId }, reason);
  }

  /** Why an input still stored as open is in fact over, or null. */
  private found(window: SecretWindow): EndReason | null {
    if (window.run !== this.run) return "restart";
    if (!window.redo && !this.hooks.pending(window.handoffId)) return "over";
    return window.expiresAt <= this.now() ? "timeout" : null;
  }

  /** Open (or move) the chat's input: the next message is field `from` of this hand-over. Another input open in its place ends (replaced). */
  open(chat: ChatRef, spec: { userId: string; handoffId: string; fields: string[]; from: number; mode: "text" | "sealed"; nonce?: string; redo?: boolean; catches?: Catches; name?: string; atPc?: boolean; ms?: number }) {
    const state = this.read(chat);
    if (state.window && state.window.handoffId !== spec.handoffId) this.finish(chat, state, "replaced");
    state.window = {
      userId: spec.userId, handoffId: spec.handoffId, fields: [...spec.fields], next: spec.from, expiresAt: this.now() + (spec.ms ?? WINDOW_MS), mode: spec.mode, run: this.run,
      ...(spec.nonce ? { nonce: spec.nonce } : {}), ...(spec.redo ? { redo: true } : {}), ...(spec.catches ? { catches: spec.catches } : {}), ...(spec.name ? { name: spec.name } : {}), ...(spec.atPc ? { atPc: true } : {}),
    };
    this.write(chat, state);
  }

  /** A hand-over message sent to the chat: a reply to it is that hand-over's value. */
  asked(chat: ChatRef, messageId: string, handoffId: string, userId: string) {
    const state = this.read(chat);
    state.asks[messageId] = { handoffId, userId, at: this.now() };
    this.write(chat, state);
  }

  /** Whether a reply in this chat can answer this hand-over (the id of one of its messages is known). */
  known(chat: ChatRef, handoffId: string): boolean {
    return Object.values(this.read(chat).asks).some((ask) => ask.handoffId === handoffId);
  }

  /** Its hand-over no longer waits: replies to its message are over (its input is ended by `end`). */
  forget(chat: ChatRef, handoffId: string) {
    const state = this.read(chat);
    const asks = Object.entries(state.asks).filter(([, ask]) => ask.handoffId !== handoffId);
    if (asks.length === Object.keys(state.asks).length) return;
    state.asks = Object.fromEntries(asks);
    this.write(chat, state);
  }

  /** The chat's open input, if it has not run out (and is of this run). */
  current(chat: ChatRef): SecretWindow | null {
    const window = this.read(chat).window;
    return window && window.expiresAt > this.now() && window.run === this.run ? window : null;
  }

  /** The value of a taken message, once (memory only; gone after a restart). */
  take(chat: ChatRef, eventId: string): string | undefined {
    const key = this.dropKey(chat, eventId);
    const value = this.drop.get(key);
    this.drop.delete(key);
    return value;
  }

  /** Keep the words of a caught or held line, and the files it carried (their messenger references), for [그대로 보내기] (memory only, HOLD_MS). */
  keep(chat: ChatRef, eventId: string, text: string, files: InFile[] = []) {
    for (const [key, entry] of this.kept) if (entry.until <= this.now()) this.kept.delete(key);
    this.kept.set(this.dropKey(chat, eventId), { text, files, until: this.now() + HOLD_MS });
  }

  /** [그대로 보내기]: what was kept, once; undefined when it is gone (a restart, HOLD_MS, pressed already). */
  release(chat: ChatRef, eventId: string): Kept | undefined {
    const key = this.dropKey(chat, eventId);
    const entry = this.kept.get(key);
    this.kept.delete(key);
    return entry && entry.until > this.now() ? { text: entry.text, files: entry.files } : undefined;
  }

  /** Q4: the first late catch of this person that takes this line (its shape, or just after its value the same code again). */
  private lateFor(chat: ChatRef, state: ChatState, userId: string, text: string): { late: Late; same: boolean } | null {
    for (const late of state.lates) {
      if (late.userId !== userId || late.until <= this.now()) continue;
      const typed = this.typedCodes.get(this.key(chat));
      const same = Boolean(late.taken && typed && typed.until > this.now() && [text, codeIn(text)].some((code) => code && this.codeHash(code) === typed.hash));
      if (same || (late.taken ? marked(late.kind, text) : shaped(late.kind, text))) return { late, same };
    }
    return null;
  }

  private mark(chat: ChatRef, eventId: string, patch: Partial<Taken>) {
    const state = this.read(chat);
    const taken = state.taken[eventId];
    if (!taken) return;
    Object.assign(taken, patch);
    this.write(chat, state);
  }

  deleted(chat: ChatRef, eventId: string): boolean { return this.read(chat).taken[eventId]?.deleted === true; }
  markDeleted(chat: ChatRef, eventId: string) { this.mark(chat, eventId, { deleted: true }); }
  /** The core is done with this message: delivered again, its value is not kept in memory again. */
  markHandled(chat: ChatRef, eventId: string) { this.mark(chat, eventId, { handled: true }); }

  /**
   * A button press, before anything is written: a press that opens an input opens it now, so a
   * value right behind it in the same batch is taken; a press that starts something else ends the
   * open input now, so a code right behind it is judged by the late catch.
   */
  press = (update: { chat: ChatRef; from: Sender; token: string; messageId?: string }) => {
    // A press names the message its button is on: a reply to that message answers its hand-over
    // from now on, also when the answer to sending it was lost (N8).
    const owner = update.messageId ? this.hooks.handoffOf?.(update.chat, update.from, update.token, update.messageId) : null;
    if (owner && update.messageId && !this.read(update.chat).asks[update.messageId]) this.asked(update.chat, update.messageId, owner, update.from.userId);
    // What it starts ("lock", "new", "retry") goes with the reason: the line says what is true after it (Q1).
    const starts = this.hooks.starts?.(update.chat, update.from, update.token);
    if (starts) this.end(update.chat, { userId: update.from.userId }, "button", typeof starts === "string" ? starts : undefined);
    const opening = this.hooks.opens?.(update.chat, update.from, update.token, update.messageId);
    if (!opening) return;
    this.open(update.chat, { userId: update.from.userId, handoffId: opening.handoffId, fields: opening.fields, from: opening.field, mode: "text", ...(opening.redo ? { redo: true } : {}) });
  };

  /**
   * A line of a messenger without `divert` (Slack): whether the open input or the late catch holds
   * it (P2: only by its shape; nothing is deleted there). An input found over first ends (and is
   * said). A line beginning with 이어서 ends a step that waited at the PC (it was done there) and goes
   * on; 취소 ends the open input.
   */
  judge(chat: ChatRef, userId: string, eventId: string, text: string, files: InFile[] = []): { held: "code" | "link" } | "cancelled" | null {
    const window = this.read(chat).window;
    if (window && window.userId === userId) {
      const reason = this.found(window);
      if (reason) this.end(chat, { handoffId: window.handoffId }, reason);
      else if (window.atPc && !files.length && /^\s*이어서/.test(text)) return void this.end(chat, { handoffId: window.handoffId }, "taken"), null;
      else if (!files.length && text.trim() === "취소") return void this.end(chat, { handoffId: window.handoffId }, "cancel", "취소"), "cancelled";
      else {
        const kind = window.catches ?? "none";
        if (kind !== "none" && shaped(kind, text)) { this.keep(chat, eventId, text, files); return { held: kind }; }
      }
    }
    // Q4: the late catches of inputs that ended before (also while another one waits).
    const hit = this.lateFor(chat, this.read(chat), userId, text);
    if (hit) { this.keep(chat, eventId, text, files); return { held: hit.late.kind }; }
    return null;
  }

  /**
   * The adapter's question for every received message, before it writes anything: is this a
   * secret? Then the event it records instead, without the value. Null: an ordinary message.
   */
  divert = (update: { eventId: string; chat: ChatRef; from: Sender; message: Json; edited: boolean; files?: InFile[] }): Inbound | null => {
    const { eventId, chat, from, message, edited } = update;
    if (chat.chatType !== "dm") return null;
    const state = this.read(chat);
    const messageId = String(message.message_id ?? "");
    const text = typeof message.text === "string" ? message.text : null;
    // Ruling Q2: what the person SENT, whatever carries it: the text, a forwarded message's text, a caption.
    const words = text ?? (typeof message.caption === "string" ? message.caption : null);
    const event = (taken: Taken): Inbound => ({
      type: "secret", eventId, chat, from, handoffId: taken.handoffId, field: taken.field, messageId: taken.messageId, outcome: taken.outcome, at: Number(message.date ?? 0) * 1000, ...(taken.shape ? { shape: taken.shape } : {}),
    });
    const keep = (outcome: SecretOutcome, part?: string) => {
      if (outcome === "value" && typeof message.text === "string") this.drop.set(this.dropKey(chat, eventId), part ?? message.text);
      // Q2: the words of a forward or a caption are kept with the files the message carried.
      if ((outcome === "caught" || outcome === "held") && words !== null) this.keep(chat, eventId, words, update.files ?? []);
      const data = (message.web_app_data as Json | undefined)?.data;
      if (outcome === "sealed" && typeof data === "string") this.drop.set(this.dropKey(chat, eventId), data);
    };
    const record = (taken: Taken, part?: string): Inbound => {
      state.taken[eventId] = taken;
      // Written before the adapter writes its inbox and offset (see the top of this file).
      this.write(chat, state);
      keep(taken.outcome, part);
      return event(taken);
    };
    /** A plain line for an open input: taken (whole or the part the input finds), the app's word, or held. */
    const judge = (input: SecretWindow): Inbound | null => {
      const judged = this.hooks.takes ? this.hooks.takes(input.handoffId, text!) : true;
      // The app's own words go their way; the input stays open.
      if (judged === false || judged === "app") return null;
      // Anything else an input of this kind cannot take is held: never to the AI, deleted, answered with [그대로 보내기].
      if (judged === "hold") {
        const count = input.held ?? 0;
        input.held = count + 1;
        return record({ handoffId: input.handoffId, field: count, outcome: "held", at: this.now(), messageId });
      }
      return this.take_(chat, state, messageId, record, input, typeof judged === "object" ? judged.value : undefined);
    };
    // Delivered again: taken again the same way, never as an ordinary message (its value only if not handled yet).
    const before = state.taken[eventId];
    if (before) {
      if (!before.handled) {
        // The part of a line an input took is found again the same way.
        const judged = before.outcome === "value" && typeof message.text === "string" ? this.hooks.takes?.(before.handoffId, message.text) : undefined;
        keep(before.outcome, judged && typeof judged === "object" ? judged.value : undefined);
      }
      return event(before);
    }
    const plain = !edited && text !== null && !NOT_PLAIN.some((key) => message[key] !== undefined);
    const command = plain ? parseCommand(text!) : null;
    const word = command ? command.command : plain ? everyday(text!) : null;
    const window = state.window && state.window.userId === from.userId ? state.window : null;
    // An input stored as open that is in fact over (it ran out, the gateway restarted, its hand-over
    // stopped waiting) ends now, said; this line found it so before the person was told: a word goes
    // its way, anything else is caught (answered, with [그대로 보내기]).
    const over = window ? this.found(window) : null;
    if (window && over) {
      this.finish(chat, state, over);
      // Long after it ran out (the person was told by the tick, or nobody was there) a line is a line.
      // Q2: a forward or a caption is judged as a line is (a photo without words cannot be, and an edit never reaches the AI).
      if (word || words === null || edited || this.now() >= window.expiresAt + LATE_MS) { this.write(chat, state); return null; }
      return record({ handoffId: window.handoffId, field: 1, outcome: "caught", at: this.now(), messageId });
    }
    const open = window;
    // A word that starts something else (멈춰, 새 대화, 다시 시도, 잠금) ends the input here, before
    // the core has it: a code right behind it in the same batch is judged by the late catch (P1, P2).
    if (word && open && STARTING.has(word)) {
      this.finish(chat, state, "word", text!.trim());
      this.write(chat, state);
      return null;
    }
    // The app's words go their way; the input stays open.
    if (command) return null;
    // An edit: refused only when it is an edit of a message this chat's input took (that one is gone).
    if (edited) {
      const ofTaken = Object.values(state.taken).some((taken) => taken.messageId === messageId);
      if (ofTaken) return record({ handoffId: open?.handoffId ?? "", field: -1, outcome: "refused", at: this.now(), messageId });
      // Q2: an edit that now has an ended input's shape is caught as a new line would be (deleted, answered).
      const hit = !open && words !== null ? this.lateFor(chat, state, from.userId, words) : null;
      return hit ? record({ handoffId: hit.late.handoffId, field: hit.same ? 2 : 0, outcome: "caught", at: this.now(), messageId, shape: hit.late.kind }) : null;
    }
    // A reply to a hand-over message is that hand-over's value, open input or not.
    const repliedTo = String((message.reply_to_message as Json | undefined)?.message_id ?? "");
    const ask = repliedTo ? state.asks[repliedTo] : undefined;
    // An everyday word as a reply to a hand-over was meant as its value: it cannot be taken in the chat (M-e).
    if (ask && ask.userId === from.userId && plain && word && word !== "unknown" && !ask.handoffId.startsWith("s_") && this.hooks.pending(ask.handoffId)) {
      return record({ handoffId: ask.handoffId, field: -1, outcome: "word", at: this.now(), messageId });
    }
    if (ask && ask.userId === from.userId && plain && (!open || open.handoffId !== ask.handoffId)) {
      const pending = this.hooks.pending(ask.handoffId);
      if (pending) {
        // 취소 as a reply, with no input of that hand-over open: nothing ends; its module answers (field -2).
        if (text!.trim() === "취소") return record({ handoffId: ask.handoffId, field: -2, outcome: "cancel", at: this.now(), messageId });
        if (open) this.finish(chat, state, "replaced");
        state.window = { userId: from.userId, handoffId: ask.handoffId, fields: pending.fields, next: pending.next, expiresAt: this.now() + WINDOW_MS, mode: "text", run: this.run };
        return judge(state.window);
      }
    }
    if (!open) {
      // The late catch (P2): only a line with the shape of what the ended input awaited (or, just
      // after its value, the same code again). Words and everything else go on.
      // Q2: a forward and a caption are judged by their words as a typed line is; Q4: every ended input's catch.
      const hit = words !== null && !(plain && word) ? this.lateFor(chat, state, from.userId, words) : null;
      if (hit) return record({ handoffId: hit.late.handoffId, field: hit.same ? 2 : 0, outcome: "caught", at: this.now(), messageId, shape: hit.late.kind });
      // A Mini App's answer nobody asked for is never a request to the AI either.
      if (message.web_app_data !== undefined) return record({ handoffId: "", field: -1, outcome: "stray", at: this.now(), messageId });
      return null;
    }
    if (message.web_app_data !== undefined && open.mode === "sealed") {
      this.finish(chat, state, "taken");
      return record({ handoffId: open.handoffId, field: 0, outcome: "sealed", at: this.now(), messageId });
    }
    if (!plain) return record({ handoffId: open.handoffId, field: open.next, outcome: "refused", at: this.now(), messageId });
    if (text!.trim() === "취소") {
      this.finish(chat, state, "cancel", "취소");
      return record({ handoffId: open.handoffId, field: open.next, outcome: "cancel", at: this.now(), messageId });
    }
    return judge(open);
  };

  /** A plain message is the value of the input's next field; the input moves on (or ends, taken, after the last). */
  private take_(chat: ChatRef, state: ChatState, messageId: string, record: (taken: Taken, part?: string) => Inbound, window: SecretWindow, part?: string): Inbound {
    const field = window.next;
    window.next += 1;
    if (window.redo || window.next >= window.fields.length) this.finish(chat, state, "taken");
    return record({ handoffId: window.handoffId, field, outcome: "value", at: this.now(), messageId, ...(window.redo ? { redo: true } : {}) }, part);
  }

  /** A step typed this code: for AGAIN_MS the same code again (compared by a keyed hash kept in memory, never the value) is caught too. */
  typed(chat: ChatRef, code: string) {
    this.typedCodes.set(this.key(chat), { hash: this.codeHash(code), until: this.now() + AGAIN_MS });
  }

  /** Whether a taken message asked to take a field of a finished hand-over again. */
  redo(chat: ChatRef, eventId: string): boolean {
    return this.read(chat).taken[eventId]?.redo === true;
  }
}
