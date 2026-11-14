import type { CredentialKind, Session } from "@workbench/contracts";
import { HttpError } from "../errors.ts";
import type { CredentialChat, CredentialService } from "../credentials/service.ts";
import { continuationId, continuationText } from "../credentials/service.ts";
import type { Handoff } from "../credentials/store.ts";
import type { SessionManager } from "../sessions.ts";
import type { Store } from "../store.ts";
import type { ChannelExtension, ChannelReach } from "./core.ts";
import { Redactor } from "./redact.ts";
import { SealError, SealKeys } from "./seal.ts";
import { SecretWindows, SILENT, STARTING, type EndReason, type SecretWindow, type TakeJudgement } from "./secret-window.ts";
import { parseCommand } from "./shape.ts";
import { everyday } from "./words.ts";
import type { Binding, ButtonRow } from "./store.ts";
import type { ChannelAdapter, ChatRef, Inbound } from "./types.ts";

// The credential store in the paired chat (design §6.5–6.6): the hand-over message ("X가
// 필요합니다" and the one control to give it), 매번 묻기 (쓰기 / 안 쓰기), the continuation as a
// request of the chat, and "비밀 보관함" (list, rename, delete, 매번 묻기). Connected to the channel
// core at one place (`ChannelCore.use`); it sends only through the core's gates and outbox. No
// value is ever sent to the chat: only names, kinds and sites.
//
// A value given in the chat (unit 8, design §6.3): the control opens the chat's secret input
// (secret-window.ts) for one field at a time; the messenger's adapter takes the next message out
// before its inbox, this hands the value to the store, deletes the message, and asks for the next
// field or says it is kept. With a page address for the sealed form (seal-v1.html), the control
// opens that form instead; without one (the default), the value is sent and deleted at once.

const KIND_WORD: Record<CredentialKind, string> = { login: "로그인 정보", "api-key": "API 키", card: "카드 정보", other: "값" };
const GIVE_LABEL: Record<CredentialKind, string> = { login: "로그인 정보 넣기", "api-key": "키 넣기", card: "카드 넣기", other: "값 넣기" };
const KIND_LABEL: Record<CredentialKind, string> = { login: "로그인", "api-key": "API 키", card: "카드", other: "기타" };
const RENAME_MS = 2 * 60_000;
/** A host as shown in the chat: its dots are one-dot leaders, so the messenger does not make it a link. */
const shownSite = (site: string) => site.replace(/\./g, "\u2024");
const NOTICE = "이 값은 텔레그램을 거쳐 옵니다. 받는 즉시 지웁니다.";
const UNDELETED = "보낸 메시지를 지우지 못했습니다. 텔레그램에서 직접 지워 주세요.";
/** Where the messenger has no in-chat input (ChannelAdapter.secretInput false): the value is entered on the PC. */
const AT_PC = "이 값은 PC의 휴대폰 메신저 → 비밀 보관함에서 넣어 주세요. 넣으면 이어서 합니다.";
const LISTED = 10;
/** After an app word while unit 8's input is open (M-e): why a value equal to it cannot be given in the chat. */
const APP_WORD = "값이 앱의 명령어와 같다면 채팅으로는 받을 수 없으니 PC의 비밀 보관함에서 넣어 주세요.";
/** An app word sent as the reply to a hand-over (M-e). */
const APP_WORD_VALUE = "이 값은 앱의 명령어와 같아 채팅으로 받을 수 없습니다. PC의 비밀 보관함에서 넣어 주세요.";

/** 을/를 (or 이/가, 은/는) after a word as it is read: by the last syllable's final consonant. */
export function particle(word: string, pair: "을/를" | "이/가" | "은/는" | "으로/로"): string {
  const [withFinal, without] = pair.split("/") as [string, string];
  const last = [...word.replace(/['"」』)\]\s]+$/u, "")].at(-1) ?? "";
  const code = last.charCodeAt(0);
  let final: boolean | null = null;
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    final = pair === "으로/로" ? jong !== 0 && jong !== 8 : jong !== 0;
  } else if (/[0-9]/.test(last)) final = pair === "으로/로" ? "0136".includes(last) : "013678".includes(last);
  else if (/[lmnr]/i.test(last)) final = pair !== "으로/로" || !/l/i.test(last);
  else if (/[a-z]/i.test(last)) final = false;
  return final === null ? `${withFinal}(${without})` : final ? withFinal : without;
}
const quoted = (name: string, pair: "을/를" | "이/가" | "은/는" | "으로/로") => `'${name}'${particle(name, pair)}`;

export type VaultChatOptions = {
  service: CredentialService;
  manager: Pick<SessionManager, "view" | "items">;
  /** Where the chat's secret input keeps whether a message was taken (the gateway's meta table). Without it, values are given at the PC. */
  store?: Pick<Store, "getMeta" | "setMeta" | "channels">;
  /** The address of the sealed Mini App form (seal-v1.html on HTTPS). None by default: the chat's own send-and-delete input. */
  sealPage?: string | null;
  now?: () => number;
};

export class VaultChat implements ChannelExtension, CredentialChat {
  protected reach: ChannelReach | null = null;
  protected readonly service: CredentialService;
  protected readonly manager: VaultChatOptions["manager"];
  protected readonly now: () => number;
  /** A chat that was asked for a new name, and for which entry (until when). */
  private readonly renaming = new Map<string, { entryId: string; until: number }>();
  /** The chats' secret inputs; the adapter asks `windows.divert` about every message. */
  readonly windows: SecretWindows | null;
  private readonly seals: SealKeys;
  private readonly sealPage: string | null;
  private timer: NodeJS.Timeout | null = null;
  protected readonly store: VaultChatOptions["store"] | null;

  constructor(options: VaultChatOptions) {
    this.service = options.service;
    this.manager = options.manager;
    this.now = options.now ?? Date.now;
    const store = options.store;
    this.store = store ?? null;
    this.windows = store ? new SecretWindows(store, {
      pending: (handoffId) => this.pending(handoffId),
      takes: (handoffId, text) => this.takes(handoffId, text),
      // A press of 넣기 / 다시 넣기 opens the input before anything else of its batch is read.
      handoffOf: (chat, from, token, messageId) => {
        const row = store.channels.button(token);
        if (!row || row.chatId !== chat.chatId || row.userId !== from.userId || row.expiresAt <= this.now() || !row.kind.startsWith("cred-")) return null;
        // A button is bound to the message it was sent on (when that is known): pressed on any other, it names nothing.
        if (row.messageId && row.messageId !== messageId) return null;
        const data = row.data ? (JSON.parse(row.data) as { h?: unknown }) : {};
        const handoff = typeof data.h === "string" ? this.service.handoff(data.h) : null;
        return handoff && handoff.state === "waiting" ? handoff.id : null;
      },
      opens: (chat, from, token, messageId) => {
        const row = store.channels.button(token);
        if (!row || row.chatId !== chat.chatId || row.userId !== from.userId || row.usedAt !== null || row.expiresAt <= this.now()) return null;
        if (row.messageId && messageId && row.messageId !== messageId) return null;
        if (row.kind !== "cred-give" && row.kind !== "cred-redo") return null;
        const data = row.data ? (JSON.parse(row.data) as { h?: unknown; f?: unknown }) : {};
        const handoff = typeof data.h === "string" ? this.service.handoff(data.h) : null;
        if (!handoff || handoff.mode !== "give") return null;
        if (row.kind === "cred-give") { const pending = this.pending(handoff.id); return pending ? { handoffId: handoff.id, fields: pending.fields, field: pending.next, redo: false } : null; }
        const field = typeof data.f === "number" && handoff.fields[data.f] !== undefined ? data.f : -1;
        if (field < 0 || (handoff.state !== "waiting" && handoff.state !== "ready")) return null;
        return { handoffId: handoff.id, fields: handoff.fields, field, redo: handoff.state === "ready" };
      },
      // The menu's 새 대화 and 채널 잠금, and [다시 시도]: they start something else, so an open input ends at the press (P1).
      starts: (chat, from, token) => {
        const row = store.channels.button(token);
        if (!row || row.chatId !== chat.chatId || row.userId !== from.userId) return false;
        if (row.kind === "retry") return "retry";
        const act = row.kind === "menu" && row.data ? (JSON.parse(row.data) as { a?: unknown }).a : null;
        return act === "new" || act === "lock" ? act : false;
      },
      ended: (chat, input, reason, how) => this.inputEnded(chat, input, reason, how),
    }, this.now) : null;
    this.seals = new SealKeys(this.now);
    this.sealPage = options.sealPage ?? null;
  }

  attach(reach: ChannelReach) {
    this.reach = reach;
    this.service.chat = this;
    if (this.windows && !this.timer) {
      this.timer = setInterval(() => { void this.expire().catch(() => undefined); }, 15_000);
      this.timer.unref();
      // An input a restart found open ends at once, said (P1), not at the first tick.
      setTimeout(() => { void this.expire().catch(() => undefined); }, 1_000).unref();
    }
  }

  /** Whether a plain line is the value of this hand-over's open input (any line is, here; unit 9's code steps differ). */
  protected takes(_handoffId: string, text: string): TakeJudgement {
    // The app's own words are the app's (ruling A); a lone unknown slash word is taken as a value.
    const word = everyday(text);
    return word && word !== "unknown" ? "app" : true;
  }

  /** A hand-over still waiting, its fields, and the first one not given yet. */
  protected pending(handoffId: string): { fields: string[]; next: number } | null {
    const handoff = this.service.handoff(handoffId);
    if (!handoff || handoff.mode !== "give" || handoff.state !== "waiting") return null;
    // Its conversation archived or removed: it no longer waits (the service's tick ends it).
    const session = this.session(handoff.sessionId);
    if (!session || session.archivedAt) return null;
    const filled = this.service.store.filled(handoffId);
    return { fields: handoff.fields, next: Math.max(0, handoff.fields.findIndex((field) => !filled.includes(field))) };
  }

  /** The tick: every paired chat's input that ran out, was found open by a restart, or whose request is over ends (said, P1). */
  async expire() {
    this.seals.prune();
    if (!this.reach?.running || !this.windows || !this.store) return;
    for (const binding of this.store.channels.bindings()) {
      if (binding.revokedAt) continue;
      this.windows.sweep(this.chatOf(binding));
    }
    // The lines are said on their own (fire and forget); a tick waits for what it started.
    await Promise.allSettled([...this.saying]);
  }

  /** Lines being said about inputs that ended. */
  private readonly saying = new Set<Promise<unknown>>();

  /**
   * An input ended (SecretWindows.end, the one way): one plain line naming it and what happens now,
   * with [다시 넣기] where its request can still use it (P1). Not awaited by whoever ended it (a 멈춰
   * never waits on a send).
   */
  protected inputEnded(chat: ChatRef, input: SecretWindow, reason: EndReason, how?: string) {
    if (SILENT.has(reason) || !this.reach || !this.store) return;
    const binding = this.store.channels.activeBinding(chat.kind, chat.botId, chat.chatId, input.userId);
    if (!binding) return;
    const line = this.endedLine(binding, input, reason, how);
    if (!line) return;
    const key = `ended:${input.handoffId}:${input.expiresAt}`;
    const open = !this.gateNow(binding, how);
    const work = (open && line.again ? this.reach.say(binding.id, key, { text: line.text, buttons: [[line.again]] }) : this.reach.reply(binding.id, key, line.text)).catch(() => null);
    this.saying.add(work);
    void work.finally(() => this.saying.delete(work));
  }

  /** Why an input ended, in front of its line ("" for the person's own word or button). */
  protected why(binding: Binding, reason: EndReason, minutes = 10): string {
    switch (reason) {
      case "timeout": return `입력 시간(${minutes}분)이 지나 `;
      case "gate": return binding.lockedAt ? "채널이 잠겨 " : binding.pausedAt ? "채널이 멈춰 " : "";
      case "restart": return "PC가 다시 시작되어 ";
      case "over": return "요청이 끝나 ";
      default: return "";
    }
  }

  /**
   * Ruling Q1: the gate as it is when the line is said: "멈춰" (paused at the PC), "잠겨" (locked, also
   * by the 잠금 word or button that is ending the input right now, before the core locks it), or null (open).
   */
  protected gateNow(binding: Binding, how?: string): "멈춰" | "잠겨" | null {
    const word = how ? (how === "lock" ? "lock" : parseCommand(how)?.command ?? everyday(how)) : null;
    return binding.lockedAt || word === "lock" ? "잠겨" : binding.pausedAt ? "멈춰" : null;
  }

  /** Ruling Q1: what a sent line does now: to the AI (with `rest` after it), or nothing while the gate is closed (the app's words for it, one sentence). */
  protected nowLine(binding: Binding, how: string | undefined, rest: string): string {
    const gate = this.gateNow(binding, how);
    return gate ? ` 지금은 채널이 ${gate} 있어 보내는 글이 전달되지 않습니다.` : ` 지금부터 보내는 글은 AI에게 갑니다.${rest}`;
  }

  /** Unit 8's line: "'학교메일' 비밀번호 입력을 닫았습니다. 지금부터 보내는 글은 AI에게 갑니다. 값은 여기 적지 마세요." */
  protected endedLine(binding: Binding, input: SecretWindow, reason: EndReason, how?: string): { text: string; again?: { label: string; kind: string; data: unknown } } | null {
    const handoff = this.service.handoff(input.handoffId);
    const name = input.name ?? handoff?.name ?? "";
    const field = input.fields[input.next] ?? input.fields[0] ?? "값";
    const again = handoff?.mode === "give" && handoff.state === "waiting" && reason !== "over" ? { label: "다시 넣기", kind: "cred-give", data: { h: handoff.id } } : undefined;
    // After [나중에]: a reply to the hand-over message gives the value too, when its id is known (N8).
    const reply = how === "나중에" && this.windows?.known(this.chatOf(binding), input.handoffId) ? "위 메시지에 답장하거나 " : "";
    const offer = again && !this.gateNow(binding, how) ? ` ${how === "나중에" ? "나중에 넣으려면" : "넣으려면"} ${reply}아래 [다시 넣기]를 누르세요.` : "";
    return { text: `${this.why(binding, reason)}${name ? `'${name}' ` : ""}${field} 입력을 닫았습니다.${this.nowLine(binding, how, " 값은 여기 적지 마세요.")}${offer}`, ...(again ? { again } : {}) };
  }

  // For the credential service

  /** The chat whose request runs in this conversation now (the last request from a chat), if it is still paired. */
  bindingFor(sessionId: string): string | null {
    const last = this.manager.items(sessionId).items.findLast((item) => item.kind === "user" && item.origin);
    const bindingId = last?.kind === "user" ? last.origin?.bindingId : undefined;
    const binding = bindingId ? this.reach?.binding(bindingId) : null;
    return binding && !binding.revokedAt ? binding.id : null;
  }

  private session(sessionId: string): Session | undefined {
    return this.manager.view.sessions.get(sessionId);
  }

  async ask(handoff: Handoff): Promise<"asked" | "refused" | "held"> {
    if (!this.reach || !handoff.bindingId) return "held";
    const round = handoff.askRound ? `:${handoff.askRound}` : "";
    // Whether a message that came back without its id went (N6): only a send known not to have gone counts as not asked.
    const outcome = (key: string, messageId: string | null): "asked" | "refused" | "held" => {
      const now = this.reach!.binding(handoff.bindingId!);
      if (!now || now.pausedAt || now.lockedAt || now.revokedAt) return "held";
      if (messageId) return "asked";
      const state = this.reach!.sent(key);
      return state === "sent" || state === "unknown" ? "asked" : state === "undeliverable" ? "refused" : "held";
    };
    const where = `「${this.session(handoff.sessionId)?.purpose ?? "대화"}」에서 `;
    const site = handoff.site ? ` (${shownSite(handoff.site)})` : "";
    if (handoff.mode === "use") {
      const key = `cred-use:${handoff.id}${round}`;
      return outcome(key, await this.reach.say(handoff.bindingId, key, {
        text: `${where}${quoted(handoff.name, "을/를")} 쓰려고 합니다.${site}`,
        buttons: [[{ label: "쓰기", kind: "cred-use", data: { h: handoff.id }, set: `use:${handoff.id}` }, { label: "안 쓰기", kind: "cred-nouse", data: { h: handoff.id }, set: `use:${handoff.id}` }]],
      }));
    }
    const binding = this.reach.binding(handoff.bindingId);
    const needed = this.needed(handoff);
    // No in-chat input on this messenger: one line, no control, nothing that asks for the value here.
    if (binding && !this.inChat(binding)) {
      const key = `cred-need:${handoff.id}${round}`;
      const result = outcome(key, await this.reach.say(binding.id, key, { text: `${needed}\n${AT_PC}` }));
      if (result === "asked") this.reach.audit(binding, "secret.asked", { sessionId: handoff.sessionId, target: handoff.name, result: "pc" });
      return result;
    }
    if (!this.windows || !binding) {
      const key = `cred-need:${handoff.id}${round}`;
      return outcome(key, await this.reach.say(handoff.bindingId, key, { text: needed, buttons: [[{ label: GIVE_LABEL[handoff.kind], kind: "cred-give", data: { h: handoff.id } }]] }));
    }
    // The input opens with the message, and only when the message reached the chat (N4): a paused
    // or locked chat gets nothing now, and nothing it sends meanwhile is taken; it is asked when it opens.
    const chat = this.chatOf(binding);
    const before = this.windows.current(chat);
    const earlier = before && before.handoffId !== handoff.id ? this.service.handoff(before.handoffId) : null;
    // Two hand-overs in one chat: a plain line answers this (the latest) one; the earlier one by a reply to its message.
    const which = earlier && earlier.state === "waiting" ? `\n앞의 '${earlier.name}' 요청에는 그 메시지에 답장해서 넣어 주세요.` : "";
    const key = `cred-need:${handoff.id}${round}`;
    const messageId = await this.reach.say(binding.id, key, {
      text: `${needed}\n${this.ask_(handoff, 0)}${which}\n${NOTICE}\n지금 넣지 않으려면 [나중에]를 누르세요.`,
      buttons: [[{ label: "나중에", kind: "cred-later", data: { h: handoff.id } }]],
    });
    // Open unless the message is known not to have gone (N6): sent, or sent with its answer lost, opens.
    const result = outcome(key, messageId);
    if (result !== "asked") return result;
    this.windows.open(chat, { userId: binding.userId, handoffId: handoff.id, fields: handoff.fields, from: 0, mode: this.sealPage ? "sealed" : "text", name: handoff.name });
    if (messageId) this.windows.asked(chat, messageId, handoff.id, binding.userId);
    this.reach.audit(binding, "secret.asked", { sessionId: handoff.sessionId, target: handoff.name, result: this.sealPage ? "sealed-form" : "send-and-delete" });
    if (this.sealPage) await this.form(binding, handoff, `cred-form:${handoff.id}${round}`);
    return "asked";
  }

  /** Paired (again): a hand-over that waits for a disconnected pairing of the same person in this chat is asked here. */
  async paired(binding: Binding) {
    await this.service.rebind(binding.id, (earlier) => {
      const old = this.reach?.binding(earlier);
      return Boolean(old?.revokedAt && old.kind === binding.kind && old.botId === binding.botId && old.userId === binding.userId);
    });
  }

  /** The hand-over no longer waits (N3): its input ends (its values given: taken; else over, said), and replies to its message are over. */
  ended(handoff: Handoff) {
    const binding = handoff.bindingId ? this.reach?.binding(handoff.bindingId) : null;
    if (!binding || !this.windows) return;
    const chat = this.chatOf(binding);
    this.windows.end(chat, { handoffId: handoff.id }, handoff.state === "ready" ? "taken" : "over");
    this.windows.forget(chat, handoff.id);
  }

  /** The chat opened again: hand-overs that waited for it are asked now (once), and what expired meanwhile is said. */
  async reopened(binding: Binding) {
    await this.service.reopened(binding.id);
  }

  /** "「대화」에서 'X' API 키가 필요합니다. (site)" */
  private needed(handoff: Handoff): string {
    const where = `「${this.session(handoff.sessionId)?.purpose ?? "대화"}」에서 `;
    const site = handoff.site ? ` (${shownSite(handoff.site)})` : "";
    return `${where}'${handoff.name}' ${KIND_WORD[handoff.kind]}${particle(KIND_WORD[handoff.kind], "이/가")} 필요합니다.${site}`;
  }

  /** A line taken while the request may not have arrived: "'X'의 F로 받았습니다 · 요청: …" (what was asked, in one line). */
  private unsureLine(handoff: Handoff, took: string): string {
    return `'${handoff.name}'의 ${took}${particle(took, "으로/로")} 받았습니다 · 요청: ${this.needed(handoff)}`;
  }

  /** "다음에 보내는 메시지를 'X'의 F로 받습니다. (i/n)" */
  private ask_(handoff: Handoff, field: number): string {
    const name = handoff.fields[field]!;
    const count = handoff.fields.length > 1 ? ` (${field + 1}/${handoff.fields.length})` : "";
    return `다음에 보내는 메시지를 '${handoff.name}'의 ${name}${particle(name, "으로/로")} 받습니다.${count}`;
  }

  /** The sealed form's keyboard button (only with a page address). */
  private async form(binding: Binding, handoff: Handoff, key: string) {
    if (!this.sealPage || !this.windows) return;
    const request = this.seals.create({ userId: binding.userId, handoffId: handoff.id, fields: handoff.fields });
    const window = this.windows.current(this.chatOf(binding));
    if (window?.handoffId === handoff.id) this.windows.open(this.chatOf(binding), { userId: binding.userId, handoffId: handoff.id, fields: handoff.fields, from: window.next, mode: "sealed", nonce: request.nonce, name: handoff.name });
    await this.reach!.say(binding.id, key, {
      text: `'${handoff.name}' ${KIND_WORD[handoff.kind]} 입력 양식을 아래 [입력 양식 열기]로 열 수도 있습니다. 값은 휴대폰에서 봉인되어 PC로만 갑니다.`,
      webApp: { label: "입력 양식 열기", url: SealKeys.address(this.sealPage, request, handoff.name, handoff.fields) },
    });
  }

  async told(handoff: Handoff, what: "given-at-pc" | "expired" | "declined"): Promise<boolean> {
    if (!this.reach || !handoff.bindingId) return false;
    const text = what === "given-at-pc" ? `PC에서 ${quoted(handoff.name, "을/를")} 넣었습니다. 이어서 합니다.`
      : what === "expired" ? `'${handoff.name}' 넘겨받기 시간이 지났습니다(하루). 필요하면 다시 시켜 주세요.`
        : `${quoted(handoff.name, "을/를")} 쓰지 않았습니다.`;
    return Boolean(await this.reach.say(handoff.bindingId, `cred-told:${handoff.id}:${what}`, { text }));
  }

  async notice(sessionId: string, key: string, text: string) {
    const bindingId = this.bindingFor(sessionId);
    if (bindingId) await this.reach?.say(bindingId, key, { text });
  }

  async continueWith(handoff: Handoff): Promise<"queued" | "refused" | "pc" | "held"> {
    const binding = handoff.bindingId ? this.reach?.binding(handoff.bindingId) : null;
    // No chat to go through (the channel does not run, the chat was disconnected): the PC's way.
    if (!this.reach?.running || !binding || binding.revokedAt) return "pc";
    // Paused or locked: it goes when the chat opens again (the service's tick tries again).
    if (binding.pausedAt || binding.lockedAt) return "held";
    const id = continuationId(handoff.id);
    await this.reach.continueWith(binding.id, handoff.sessionId, id, continuationText(handoff.name));
    const session = this.session(handoff.sessionId);
    const went = this.manager.items(handoff.sessionId).items.some((item) => item.id === `user:${id}`) || Boolean(session?.queued.some((entry) => entry.id === id));
    return went ? "queued" : "refused";
  }

  // From the chat

  async message(_adapter: ChannelAdapter, binding: Binding, event: Extract<Inbound, { type: "message" }>): Promise<boolean> {
    const text = event.text.trim();
    // A messenger without an in-chat input (Slack): a step's shapes are held from the AI while it
    // waits and for a while after it ended (P2), answered with [그대로 보내기]; 취소 ends it.
    // Q2: a message with files is judged by its words too (they are kept with the files for [그대로 보내기]).
    if (this.windows && !this.inChat(binding)) {
      const held = this.windows.judge(this.chatOf(binding), binding.userId, event.eventId, event.text, event.files);
      if (held === "cancelled") return true;
      if (held) {
        this.reach!.audit(binding, "secret.refused", { result: `${held.held}:held` });
        await this.answerCaught(binding, event.eventId, held.held, false, false);
        return true;
      }
    }
    const renaming = this.renaming.get(binding.id);
    if (renaming) this.renaming.delete(binding.id);
    // A new name is a short single line; anything else ends the rename and goes its way.
    if (renaming && renaming.until > this.now() && (event.files.length || text.length > 40 || /\n/.test(text))) {
      await this.reply(binding, event, "이름 바꾸기를 그만두었습니다.");
      return false;
    }
    if (renaming && renaming.until > this.now() && text) {
      if (text === "취소") {
        await this.reply(binding, event, "이름을 바꾸지 않았습니다.");
        return true;
      }
      try {
        const entry = this.service.store.rename(renaming.entryId, text);
        await this.reply(binding, event, `이름을 ${quoted(entry.name, "으로/로")} 바꿨습니다.`);
      } catch (error) {
        await this.reply(binding, event, error instanceof HttpError ? error.message : "이름을 바꾸지 못했습니다.");
      }
      return true;
    }
    if (text === "비밀 보관함") {
      await this.list(binding, `cred-list:${binding.id}:${event.eventId}`);
      return true;
    }
    return false;
  }

  /** The menu's [비밀 보관함]. */
  async vault(binding: Binding, eventId: string) {
    await this.list(binding, `cred-list:${binding.id}:${eventId}`);
  }

  /**
   * A command or everyday word was sent: a rename that waited for a name is over. A hand-over's input
   * stays open for the app's words (ruling A); a word that starts something else closes it (the
   * hand-over still waits: a reply to its message or [다시 넣기] gives its value).
   */
  command(binding: Binding, word: string, how: "word" | "button" = "word"): void {
    this.renaming.delete(binding.id);
    // A word or button that starts something else ends the open input (P1); said by its module, not awaited here.
    if (STARTING.has(word)) this.windows?.end(this.chatOf(binding), { userId: binding.userId }, how, word);
  }

  /** The chat's gate closed (paused, locked, disconnected): its open input ends (P1). */
  gateClosed(binding: Binding) {
    this.windows?.end(this.chatOf(binding), { userId: binding.userId }, "gate");
  }

  /**
   * What the chat's open input still waits for, in one line ("'노션 키'의 키를 기다리고 있습니다."), or
   * null. After an everyday word (`word`) it also says why a value equal to it cannot be given here (M-e).
   */
  awaiting(binding: Binding, word?: string): string | null {
    const window = this.windows?.current(this.chatOf(binding));
    if (!window || window.userId !== binding.userId) return null;
    const handoff = this.service.handoff(window.handoffId);
    const field = window.fields[window.next] ?? window.fields[0];
    if (!handoff || !field) return null;
    return `'${handoff.name}'의 ${field}${particle(field, "을/를")} 기다리고 있습니다.${word && word !== "menu" && word !== "status" ? ` ${APP_WORD}` : ""}`;
  }

  private reply(binding: Binding, event: { eventId: string }, text: string) {
    return this.reach!.reply(binding.id, `cred-ack:${binding.id}:${event.eventId}`, text);
  }

  private async list(binding: Binding, key: string) {
    const entries = this.service.store.summaries();
    if (!entries.length) return void (await this.reach!.say(binding.id, key, { text: `비밀 보관함이 비어 있습니다. AI가 로그인이나 키가 필요하면 ${this.inChat(binding) ? "이 채팅에서" : "PC의 휴대폰 메신저 → 비밀 보관함에서"} 넣게 됩니다.` }));
    const date = (at: number) => { const day = new Date(at); return `${day.getMonth() + 1}/${day.getDate()}`; };
    const lines = entries.slice(0, LISTED).map((entry) => `· ${entry.name} · ${KIND_LABEL[entry.kind]}${entry.site ? ` · ${shownSite(entry.site)}` : ""} · ${entry.lastUsedAt ? `마지막 사용 ${date(entry.lastUsedAt)}` : "쓰지 않음"}${entry.askEachTime ? " · 매번 묻기" : ""}`);
    if (entries.length > LISTED) lines.push(`그 밖에 ${entries.length - LISTED}개는 PC의 '휴대폰 메신저 → 비밀 보관함'에서 볼 수 있습니다.`);
    const buttons = entries.slice(0, LISTED).map((entry) => ({ label: entry.name, kind: "cred-entry", data: { id: entry.id } }));
    await this.reach!.say(binding.id, key, {
      text: `비밀 보관함 · ${entries.length}개\n${lines.join("\n")}\n값은 이 채팅에 보여 주지 않습니다.`,
      buttons: Array.from({ length: Math.ceil(buttons.length / 2) }, (_, row) => buttons.slice(row * 2, row * 2 + 2)),
    });
  }

  async button(adapter: ChannelAdapter, binding: Binding, event: Extract<Inbound, { type: "button" }>, row: ButtonRow): Promise<boolean> {
    if (!row.kind.startsWith("cred-")) return false;
    const data = row.data ? (JSON.parse(row.data) as Record<string, unknown>) : {};
    const ack = async (note?: string) => { try { await adapter.ackButton(event.ackHandle, note); } catch { /* The phone stops waiting by itself. */ } };
    const key = (part: string) => `cred-${part}:${binding.id}:${event.eventId}`;
    const say = (part: string, text: string, buttons?: { label: string; kind: string; data?: unknown; set?: string }[][]) => this.reach!.say(binding.id, key(part), { text, ...(buttons ? { buttons } : {}) });
    const handoff = typeof data.h === "string" ? this.service.handoff(data.h) : null;
    const entryId = typeof data.id === "string" ? data.id : "";
    const entry = entryId ? this.service.store.summaries().find((candidate) => candidate.id === entryId) ?? null : null;
    switch (row.kind) {
      case "cred-vault":
        await ack();
        await this.list(binding, key("list"));
        return true;
      case "cred-give":
        // Q5: after its request is over (also when its conversation was archived), ONE true line; nothing opens.
        if (!handoff || !this.pending(handoff.id)) {
          await ack();
          await say("over", `${handoff ? `'${handoff.name}' ` : "이 "}요청은 이미 끝났습니다. 필요하면 AI에게 다시 시켜 주세요.`);
          return true;
        }
        await ack();
        await this.give(adapter, binding, event, handoff);
        return true;
      case "cred-later": {
        if (!handoff || handoff.state !== "waiting") { await ack("이미 끝난 요청입니다"); return true; }
        await ack("나중에 넣습니다");
        // Its input ends (cancelled by its button): the one line says so, with [다시 넣기] (P1).
        if (this.windows?.end(this.chatOf(binding), { handoffId: handoff.id }, "cancel", "나중에")) return true;
        // A reply is offered only when a reply can be matched to the hand-over (its message's id is known, N8).
        const reply = this.windows?.known(this.chatOf(binding), handoff.id) ? "위 메시지에 답장하거나 " : "";
        await say("later", `나중에 넣으려면 ${reply}아래 버튼을 누르세요. 그 전까지 보내는 글은 AI에게 갑니다.`, [[{ label: GIVE_LABEL[handoff.kind], kind: "cred-give", data: { h: handoff.id } }]]);
        return true;
      }
      case "cred-send": {
        // [그대로 보내기] (P2): the caught line, kept in memory, goes to the AI as the person's ordinary line.
        const eventId = typeof data.e === "string" ? data.e : "";
        const kept = eventId && this.windows ? this.windows.release(this.chatOf(binding), eventId) : undefined;
        if (kept === undefined) {
          await ack();
          await say(`send-gone:${eventId}`, "보낸 글이 PC에 남아 있지 않습니다(PC가 다시 시작되었거나 5분이 지났습니다). 다시 적어 보내 주세요.");
          return true;
        }
        await ack("보냈습니다");
        this.reach!.audit(binding, "secret.released", {});
        await this.reach!.forward(binding.id, `ch:${binding.kind}:${binding.botId}:${eventId}`, kept.text, kept.files);
        return true;
      }
      case "cred-notvalue": {
        // "값이 아니었어요": the line taken was not a value. It is not kept and not passed on; Telegram cannot bring it back.
        const field = typeof data.f === "number" ? data.f : -1;
        const fieldName = handoff?.fields[field];
        if (!handoff || !fieldName) { await ack("이미 끝난 요청입니다"); return true; }
        const result = this.service.discardField(handoff.id, fieldName);
        if (result === "over") { await ack("이미 끝난 요청입니다"); return true; }
        await ack();
        this.windows?.end(this.chatOf(binding), { handoffId: handoff.id }, "discarded");
        this.reach!.audit(binding, "secret.discarded", { sessionId: handoff.sessionId, target: handoff.name, result });
        await say(`notvalue:${field}:${event.eventId}`, "그 줄은 값으로 쓰지 않고 버렸습니다. AI에게도 넘기지 않았습니다. 텔레그램에서 이미 지운 메시지는 되살릴 수 없으니, 요청이었다면 다시 보내 주세요."
          + (result === "dropped" ? ` '${handoff.name}'의 ${fieldName}${particle(fieldName, "은/는")} 아래 버튼으로 넣어 주세요.`
            : result === "cleared" ? ` '${handoff.name}'의 ${fieldName}만 비웠고 다른 칸은 그대로입니다. 아래 버튼으로 다시 넣어 주세요.`
              : " 값이 필요하면 AI가 다시 요청합니다."),
          result === "dropped" ? [[{ label: GIVE_LABEL[handoff.kind], kind: "cred-give", data: { h: handoff.id } }]]
            : result === "cleared" ? [[{ label: "다시 넣기", kind: "cred-redo", data: { h: handoff.id, f: field } }]] : undefined);
        return true;
      }
      case "cred-redo": {
        const field = typeof data.f === "number" ? data.f : -1;
        if (!handoff || handoff.mode !== "give" || !handoff.fields[field] || (handoff.state !== "waiting" && handoff.state !== "ready")) { await ack("이미 끝난 요청입니다"); return true; }
        await ack();
        // prompt() points to the PC where the messenger has no in-chat input.
        await this.prompt(binding, handoff, field, `cred-redo:${handoff.id}:${field}:${event.eventId}`, handoff.state === "ready");
        return true;
      }
      case "cred-use":
      case "cred-nouse": {
        if (!handoff || handoff.mode !== "use" || handoff.state !== "waiting") { await ack("이미 처리됨"); return true; }
        const use = row.kind === "cred-use";
        await ack(use ? "쓰기로 했습니다" : "쓰지 않기로 했습니다");
        if (row.messageId) await this.reach!.edit(binding.id, row.messageId, `「${this.session(handoff.sessionId)?.purpose ?? "대화"}」에서 ${quoted(handoff.name, "을/를")} 쓰려고 합니다.\n${use ? "쓰기로 함" : "쓰지 않기로 함"} · 휴대폰`);
        await this.service.allow(handoff.id, use);
        return true;
      }
      case "cred-entry":
        if (!entry) { await ack("보관함에 없는 항목입니다"); return true; }
        await ack();
        await say("entry", `「${entry.name}」 · ${KIND_LABEL[entry.kind]}${entry.site ? ` · ${shownSite(entry.site)}` : ""}\n매번 묻기: ${entry.askEachTime ? "켜짐" : "꺼짐"}`, [[
          { label: "이름 바꾸기", kind: "cred-rename", data: { id: entry.id } },
          { label: "지우기", kind: "cred-delete", data: { id: entry.id } },
          { label: entry.askEachTime ? "매번 묻기 끄기" : "매번 묻기 켜기", kind: "cred-ask", data: { id: entry.id, on: !entry.askEachTime } },
        ]]);
        return true;
      case "cred-rename":
        if (!entry) { await ack("보관함에 없는 항목입니다"); return true; }
        await ack();
        this.renaming.set(binding.id, { entryId: entry.id, until: this.now() + RENAME_MS });
        await say("rename", `'${entry.name}'의 새 이름을 보내 주세요(2분 안에, 한 줄로). 그만두려면 '취소'라고 보내 주세요.`);
        return true;
      case "cred-delete":
        if (!entry) { await ack("보관함에 없는 항목입니다"); return true; }
        this.service.removeEntry(entry.id);
        await ack("지웠습니다");
        await say("deleted", `「${entry.name}」${particle(entry.name, "을/를")} 지웠습니다.${entry.held === "sealed" ? " 10분 안에는 되살릴 수 있습니다." : ""}`, entry.held === "sealed" ? [[{ label: "되살리기", kind: "cred-restore", data: { id: entry.id } }]] : undefined);
        return true;
      case "cred-restore":
        try {
          const restored = this.service.store.restore(entryId);
          await ack("되살렸습니다");
          await say("restored", `「${restored.name}」${particle(restored.name, "을/를")} 되살렸습니다.`);
        } catch (error) {
          await ack(error instanceof HttpError ? error.message.slice(0, 180) : "되살리지 못했습니다");
        }
        return true;
      case "cred-ask": {
        if (!entry) { await ack("보관함에 없는 항목입니다"); return true; }
        const on = data.on === true;
        this.service.store.setAsk(entry.id, on);
        await ack(on ? "매번 묻기를 켰습니다" : "매번 묻기를 껐습니다");
        await say("ask", on ? `「${entry.name}」${particle(entry.name, "은/는")} 쓰기 전에 이 채팅에서 한 번씩 묻습니다.` : `「${entry.name}」${particle(entry.name, "은/는")} 묻지 않고 씁니다.`);
        return true;
      }
      default:
        await ack("쓸 수 없는 버튼입니다");
        return true;
    }
  }

  /**
   * Whether this chat's messenger can have an in-chat secret input (ChannelAdapter.secretInput). Not
   * known (its adapter is not running) counts as no: nothing would be sent then anyway.
   */
  protected inChat(binding: Binding): boolean {
    const adapter = this.reach?.adapterOf(binding);
    return Boolean(adapter && adapter.secretInput !== false);
  }

  private atPc(binding: Binding, handoff: Handoff, key: string) {
    return this.reach!.reply(binding.id, key, `${quoted(handoff.name, "은/는")} PC의 '휴대폰 메신저 → 비밀 보관함'에서 넣어 주세요. 넣으면 이 대화가 이어집니다.`);
  }

  private chatOf(binding: Binding): ChatRef {
    return { kind: binding.kind, botId: binding.botId, chatId: binding.chatId, chatType: "dm" };
  }

  /**
   * The line that asks for one field. The input is open at that field before it is said (R4): a
   * prompt never asks for a value the chat would not take.
   */
  private async prompt(binding: Binding, handoff: Handoff, field: number, key: string, redo = false) {
    if (!this.inChat(binding)) return void (await this.atPc(binding, handoff, key));
    const chat = this.chatOf(binding);
    const window = this.windows?.current(chat);
    if (!window || window.handoffId !== handoff.id || window.next !== field || Boolean(window.redo) !== redo) {
      this.windows?.open(chat, { userId: binding.userId, handoffId: handoff.id, fields: handoff.fields, from: field, mode: "text", name: handoff.name, ...(redo ? { redo: true } : {}) });
    }
    await this.reach!.say(binding.id, key, { text: `${this.ask_(handoff, field)}\n${NOTICE}\n그만두려면 '취소'라고 보내 주세요.` });
  }

  /** 넣기 (after 나중에, or after the input ran out): the input opens at the first field still missing. */
  protected async give(_adapter: ChannelAdapter, binding: Binding, event: Extract<Inbound, { type: "button" }>, handoff: Handoff) {
    if (!this.windows || !this.inChat(binding)) {
      await this.atPc(binding, handoff, `cred-give:${handoff.id}:${event.eventId}`);
      return;
    }
    // Opened already when the press arrived (a value may have come right behind it): asked where it stands.
    const window = this.windows.current(this.chatOf(binding));
    const pending = this.pending(handoff.id);
    const field = window?.handoffId === handoff.id ? window.next : pending?.next ?? 0;
    if (field >= handoff.fields.length) return;
    await this.prompt(binding, handoff, field, `cred-ask:${handoff.id}:${field}:${event.eventId}`);
    if (this.sealPage) await this.form(binding, handoff, `cred-form:${handoff.id}:${event.eventId}`);
  }

  /**
   * A message the adapter took out of the inbox. The value (in memory only) goes to the store, the
   * message is deleted, and the person hears one line. Handled once per message, also when it comes
   * again after a crash: a field already kept is not kept again, a message already deleted is not
   * deleted again, and a value lost with the process is asked for again.
   */
  async secret(adapter: ChannelAdapter, binding: Binding | null, event: Extract<Inbound, { type: "secret" }>) {
    const windows = this.windows;
    if (!windows || !this.reach || adapter.secretInput === false) return;
    const chat = event.chat;
    const value = windows.take(chat, event.eventId);
    const remove = async () => {
      if (windows.deleted(chat, event.eventId)) return true;
      const gone = await adapter.remove(chat, event.messageId).catch(() => false);
      if (gone) windows.markDeleted(chat, event.eventId);
      return gone;
    };
    try {
      await this.handleSecret(binding, event, value, remove);
    } finally {
      // Done with it: a delivery of the same update again does not keep its value in memory.
      windows.markHandled(chat, event.eventId);
    }
  }

  private async handleSecret(binding: Binding | null, event: Extract<Inbound, { type: "secret" }>, value: string | undefined, remove: () => Promise<boolean>) {
    const windows = this.windows!, chat = event.chat;
    // Someone not (or no longer) paired: the message goes, and nothing is said.
    if (!binding) return void (await remove());
    const tell = (part: string, text: string) => this.reach!.reply(binding.id, `cred-in:${event.eventId}:${part}`, text);
    const say = (part: string, text: string, buttons?: { label: string; kind: string; data?: unknown }[][]) => this.reach!.say(binding.id, `cred-in:${event.eventId}:${part}`, { text, ...(buttons ? { buttons } : {}) });
    const handoff = event.handoffId ? this.service.handoff(event.handoffId) : null;
    const redoButton = (field: number) => (handoff ? [[{ label: "다시 넣기", kind: "cred-redo", data: { h: handoff.id, f: field } }]] : undefined);
    if (event.outcome === "caught" || event.outcome === "held") return this.caught(binding, event, remove);
    if (event.outcome === "word") {
      // An app word sent as the reply to a hand-over (M-e): it was meant as the value, and cannot be given here.
      const gone = await remove();
      this.reach!.audit(binding, "secret.refused", { target: handoff?.name ?? null, result: "app_word" });
      await tell("word", `${APP_WORD_VALUE}${gone ? "" : ` ${UNDELETED}`}`);
      return;
    }
    if (event.outcome === "cancel") {
      this.reach!.audit(binding, "secret.cancelled", { target: handoff?.name ?? null });
      // The input it ended said so in one line (P1); a reply's 취소 with no input open is answered here.
      await remove();
      if (event.field !== -2) return;
      if (handoff?.state === "waiting") await say("cancel", "취소했습니다. 받은 값은 없습니다. 지금부터 보내는 글은 AI에게 갑니다. 다시 하려면 아래 버튼을 누르세요.", [[{ label: "다시 넣기", kind: "cred-give", data: { h: handoff.id } }]]);
      else await tell("cancel", "취소했습니다.");
      return;
    }
    const first = event.outcome === "sealed" ? `${event.eventId}#0` : event.eventId;
    // Kept before the gateway stopped: only what was left undone is done (the deletion, the end).
    if (handoff && this.service.store.taken(handoff.id, first)) {
      await remove();
      if (handoff.state === "waiting" && this.service.complete(handoff.id)) await this.finish(binding, handoff, event, true);
      return;
    }
    if (binding.lockedAt || binding.pausedAt) {
      windows.end(chat, { handoffId: event.handoffId }, "gate");
      const gone = await remove();
      this.reach!.audit(binding, "secret.refused", { target: handoff?.name ?? null, result: binding.lockedAt ? "locked" : "paused" });
      await tell("gate", `채널이 ${binding.lockedAt ? "잠겨" : "멈춰"} 있어 받지 않았습니다. ${gone ? "보낸 것은 지웠습니다." : UNDELETED}`);
      return;
    }
    if (event.outcome === "stray") {
      const gone = await remove();
      this.reach!.audit(binding, "secret.refused", { result: "stray" });
      await tell("stray", `받을 준비가 된 입력이 없습니다.${gone ? "" : ` ${UNDELETED}`}`);
      return;
    }
    const redo = windows.redo(chat, event.eventId);
    // Taken while the request may not have reached the chat (its message's id never came back): the
    // confirmation repeats what was asked, and offers [값이 아니었어요].
    const unsure = event.outcome === "value" && !redo && Boolean(handoff) && !windows.known(chat, handoff!.id);
    if (!handoff || (handoff.state !== "waiting" && !(redo && handoff.state === "ready"))) {
      windows.end(chat, { handoffId: event.handoffId }, "over");
      const gone = await remove();
      await tell("over", `이 넘겨받기는 이미 끝나 받은 값을 저장하지 않았습니다. ${gone ? "보낸 것은 지웠습니다." : UNDELETED}`);
      return;
    }
    const field = Math.max(0, event.field), fieldName = handoff.fields[field]!;
    if (event.outcome === "refused") {
      const gone = await remove();
      this.reach!.audit(binding, "secret.refused", { target: handoff.name, result: "not_text" });
      await tell("refused", gone ? "글로만 받습니다. 보낸 것은 저장하지 않았고 지웠습니다." : `글로만 받습니다. 보낸 것은 저장하지 않았습니다. ${UNDELETED}`);
      return;
    }
    if (value === undefined) {
      // The value was in memory only when the gateway stopped: nothing was kept; the input reopens at that field.
      const gone = await remove();
      await tell("lost", `PC가 다시 시작되어 보낸 값을 받지 못했습니다(저장하지 않았습니다${gone ? ", 메시지는 지웠습니다" : ""}).${gone ? "" : ` ${UNDELETED}`}`);
      await this.prompt(binding, handoff, field, `cred-ask:${handoff.id}:${field}:${event.eventId}`, redo);
      return;
    }
    try {
      if (event.outcome === "sealed") {
        const opened = this.seals.open(value, event.from.userId);
        if (opened.handoffId !== handoff.id) throw new SealError("fields");
        for (const [index, name] of handoff.fields.entries()) await this.service.receive(handoff.id, name, opened.values[name]!, `${event.eventId}#${index}`);
      } else if (redo) await this.service.replaceField(handoff.id, fieldName, value, event.eventId);
      else await this.service.receive(handoff.id, fieldName, value, event.eventId);
    } catch (error) {
      // The input is open again at that field before anything is said (C3).
      if (event.outcome === "sealed") windows.end(chat, { handoffId: handoff.id }, "discarded");
      else windows.open(chat, { userId: binding.userId, handoffId: handoff.id, fields: handoff.fields, from: field, mode: "text", name: handoff.name, ...(redo ? { redo: true } : {}) });
      const gone = await remove();
      this.reach!.audit(binding, "secret.refused", { target: handoff.name, result: error instanceof SealError ? error.code : error instanceof HttpError ? error.code : "failed" });
      await tell("failed", `받은 값을 저장하지 못했습니다. ${gone ? "보낸 것은 지웠습니다." : UNDELETED} ${event.outcome === "sealed" ? "다시 해 주세요." : this.ask_(handoff, field)}`);
      return;
    }
    const gone = await remove();
    if (!gone) await tell("undeleted", UNDELETED);
    const took = event.outcome === "sealed" ? handoff.fields.join("·") : fieldName;
    if (redo) {
      this.reach!.audit(binding, "secret.received", { sessionId: handoff.sessionId, target: handoff.name, result: "again" });
      await say("again", `'${handoff.name}'의 ${took}${particle(took, "을/를")} 다시 받았습니다.`, redoButton(field));
      // The AI already went on with the earlier value: it is told once, in a queued line (no value).
      if (this.service.handoff(handoff.id)?.continued === "queued") {
        await this.reach!.continueWith(binding.id, handoff.sessionId, `cont:${handoff.id}:again:${event.eventId}`, `[자동 이어 하기] '${handoff.name}'의 ${took}${particle(took, "을/를")} 다시 넣었습니다. 앞에서 쓴 값 대신 이것을 쓰세요.`);
      }
      return;
    }
    if (this.service.complete(handoff.id)) return this.finish(binding, handoff, event, false, took, field, unsure);
    const filled = this.service.store.filled(handoff.id);
    const next = handoff.fields.findIndex((name) => !filled.includes(name));
    if (next < 0) return;
    // Confirmed by name, with 다시 넣기, and the input already at the next field.
    const window = windows.current(chat);
    if (!window || window.handoffId !== handoff.id || window.next !== next) windows.open(chat, { userId: binding.userId, handoffId: handoff.id, fields: handoff.fields, from: next, mode: "text", name: handoff.name });
    if (unsure) await say("took", `${this.unsureLine(handoff, took)}\n${this.ask_(handoff, next)}`, [[...redoButton(field)![0]!, notValue(field, handoff.id)]]);
    else await say("took", `'${handoff.name}'의 ${took}${particle(took, "을/를")} 받았습니다(메시지는 지웠습니다).\n${this.ask_(handoff, next)}`, redoButton(field));
  }

  /**
   * A line caught after an input ended, or held while one was open (P2): deleted where the
   * messenger can, never passed on, and answered once with why and [그대로 보내기].
   */
  protected async caught(binding: Binding, event: Extract<Inbound, { type: "secret" }>, remove: () => Promise<boolean>, lead = "") {
    const gone = await remove();
    this.reach!.audit(binding, "secret.refused", { result: event.outcome === "held" ? "held" : `caught:${event.shape ?? "found"}` });
    await this.answerCaught(binding, event.eventId, event.outcome === "held" ? "held" : event.field === 1 ? "found" : event.shape ?? "code", gone, true, lead);
  }

  /** The one answer to a caught line (P2), with [그대로 보내기] while the chat's gate is open (a closed one is told why only). */
  protected async answerCaught(binding: Binding, eventId: string, what: "code" | "link" | "found" | "held", gone: boolean, deletes: boolean, lead = "") {
    const fresh = this.reach!.binding(binding.id) ?? binding;
    const open = !fresh.pausedAt && !fresh.lockedAt;
    const kept = deletes ? (gone ? "AI에게 보내지 않고 지웠습니다." : `AI에게 보내지 않았습니다. ${UNDELETED}`) : "AI에게 보내지 않았습니다. 이 메시지는 직접 지워 주세요.";
    const noun = what === "link" ? "로그인 링크" : what === "code" ? "인증번호" : "값";
    const release = !open ? "" : what === "held" ? " AI에게 보낼 글이었다면 [그대로 보내기]를 눌러 주세요." : ` ${noun}${particle(noun, "이/가")} 아니었다면 [그대로 보내기]를 눌러 주세요.`;
    const text = lead + (what === "found" ? `입력이 닫힌 것을 알리기 전에 온 글이라 ${kept}${release}`
      : what === "held" ? `방금 보낸 글은 ${kept}${release}`
        : `방금 보낸 글은 ${noun}처럼 보여 ${kept}${release}`);
    const key = `caught:${binding.id}:${eventId}`;
    if (!open) await this.reach!.reply(binding.id, key, text);
    else await this.reach!.say(binding.id, key, { text, buttons: [[{ label: "그대로 보내기", kind: "cred-send", data: { e: eventId } }]] });
  }

  /** Every field is in: kept (sealed, or for one use), said by name, and the conversation goes on. */
  private async finish(binding: Binding, handoff: Handoff, event: { eventId: string; chat: ChatRef }, again: boolean, took?: string, field?: number, unsure = false) {
    this.windows?.end(event.chat, { handoffId: handoff.id }, "taken");
    const held = this.service.store.filledHeld(handoff.id);
    this.reach!.audit(binding, "secret.received", { sessionId: handoff.sessionId, target: handoff.name, result: held });
    const named = took ? (unsure ? `${this.unsureLine(handoff, took)}\n` : `'${handoff.name}'의 ${took}${particle(took, "을/를")} 받았습니다.`) : "받았습니다.";
    const row = [...(held === "sealed" && field !== undefined ? [{ label: "다시 넣기", kind: "cred-redo", data: { h: handoff.id, f: field } }] : []), ...(unsure && field !== undefined ? [notValue(field, handoff.id)] : [])];
    if (!again) await this.reach!.say(binding.id, `cred-done:${handoff.id}`, {
      text: held === "memory" ? `${named} 이 PC에는 보안 저장소가 없어 저장하지 않았습니다. 이번 한 번만 쓰고 버립니다. 이어서 합니다.` : `${named} 보관함에 봉인해 두었고 이 채팅에서는 지웠습니다. 이어서 합니다.`,
      ...(row.length ? { buttons: [row] } : {}),
    });
    await this.service.finish(handoff.id);
  }
}

/** "값이 아니었어요": the line taken as this field was not a value (see `cred-notvalue`). */
const notValue = (field: number, handoffId: string) => ({ label: "값이 아니었어요", kind: "cred-notvalue", data: { h: handoffId, f: field } });

/** The channel's redactor (logs, errors, everything sent to a chat) with the stored values hidden too, under their names. */
export class VaultRedactor extends Redactor {
  private readonly scrub: { text(text: string): string; needles(): string[] };
  constructor(scrub: { text(text: string): string; needles(): string[] }) {
    super();
    this.scrub = scrub;
  }
  override apply(text: string): string {
    return super.apply(this.scrub.text(text));
  }
  override stored(): string[] {
    return this.scrub.needles();
  }
}
