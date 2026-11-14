import { rmSync } from "node:fs";
import type { HostQuestion, LoginChatSide, LoginFiller, LoginStep } from "../credentials/fill.ts";
import { PC_ONLY } from "../credentials/fill.ts";
import type { Handoff } from "../credentials/store.ts";
import type { ButtonRow, Binding } from "./store.ts";
import type { ChannelAdapter, ChatRef, Inbound } from "./types.ts";
import { codeTake, LATE_MS, linkTake, waitTake, type EndReason, type SecretWindow, type TakeJudgement } from "./secret-window.ts";
import { particle, VaultChat, type VaultChatOptions } from "./vault-chat.ts";

// A site login handed over in the chat (unit 9, design §6.4 and transcript A). The hand-over of a
// login carries a picture of the login page, taken by the gateway, as its OWN message before the
// hand-over message: the hand-over's buttons stay bound to the text message whatever the adapter
// answers for a message with files. Second factors (`workbench-credential step`): a code and a mail
// link come through the chat's secret input (unit 8; the message is deleted at once) and are typed
// or opened by the gateway in the agent browser, never stored; an approval in another app is one
// button ([했어요]); what only the PC can do says so and waits for '이어서'. Each ends in one
// continuation request of the conversation, as a hand-over does.

const NOTICE = "이 값은 텔레그램을 거쳐 옵니다. 받는 즉시 지웁니다.";
const UNDELETED = "보낸 메시지를 지우지 못했습니다. 텔레그램에서 직접 지워 주세요.";
/** A picture not taken because part of the page could not be checked while a typed value is on it (I9). */
const NO_PICTURE = "PC 화면에 넣은 값이 보일 수 있어 화면 사진은 보내지 않았습니다.";
/** Why a code or a link was not used, in the chat's words. */
const NOT_USED: Record<string, string> = {
  wrong_site: "저장한 사이트가 아닌 곳이라 넣지 않았습니다.",
  insecure: "암호화되지 않은 주소(http)라 넣지 않았습니다.",
  stale_ref: "그 사이 화면이 바뀌어 넣지 못했습니다.",
  no_page: "PC의 브라우저 창이 닫혀 있어 넣지 못했습니다.",
  needs_chromium: "PC의 에이전트 브라우저가 Chromium이 아니라 넣지 못했습니다.",
  paused: "PC에서 이 대화의 브라우저가 멈춰 있어 넣지 못했습니다.",
};

/** What an open step's input waits for, said with a held line (each is answered, with [그대로 보내기]). */
const HELD: Record<string, string> = {
  code: "지금은 인증번호를 기다리고 있습니다. 번호만 보내 주세요. 그만두려면 '취소'라고 보내 주세요.",
  link: "지금은 메일로 온 로그인 링크를 기다리고 있습니다. 링크 주소만 보내 주세요. 그만두려면 '취소'라고 보내 주세요.",
  approve: "지금은 휴대폰 앱의 승인을 기다리고 있습니다. 승인했으면 [했어요]를 누르세요. 그만두려면 '취소'라고 보내 주세요.",
};

/** What a step's input still waits for, in one line (said after the app answered its own word, ruling A). */
const AWAITED: Record<string, string> = {
  link: "메일로 온 로그인 링크를 기다리고 있습니다.",
  approve: "휴대폰 앱의 승인을 기다리고 있습니다. 승인했으면 [했어요]를 누르세요.",
};

/** A host as the chat shows it: not a link (Telegram would make one of a bare host). */
const shownHost = (host: string) => host.replace(/\./g, "․").slice(0, 80);

/** What the input takes for a step, by name. */
const fieldOf = (step: LoginStep) => (step.kind === "link" ? "로그인 링크" : step.label ?? "인증번호");

export class LoginChat extends VaultChat implements LoginChatSide {
  private readonly logins: LoginFiller;
  /** Link steps that already had a link of another site (the next one ends the step). */
  private readonly wrongLinks = new Set<string>();

  constructor(options: VaultChatOptions & { logins: LoginFiller }) {
    super(options);
    this.logins = options.logins;
    this.logins.chat = this;
  }

  private chatRef(binding: Binding): ChatRef {
    return { kind: binding.kind, botId: binding.botId, chatId: binding.chatId, chatType: "dm" };
  }

  private purpose(sessionId: string) {
    return this.manager.view.sessions.get(sessionId)?.purpose ?? "대화";
  }

  /** A step that waits for a value is "pending" for the chat's input; everything else is the vault's. */
  protected override pending(id: string): { fields: string[]; next: number } | null {
    if (!id.startsWith("s_")) return super.pending(id);
    const step = this.logins.stepOf(id);
    // A step this run does not know (lost with a restart) still takes what its input catches: it is
    // deleted and said to be over, never passed to the AI (R4). A step that ended closes its input itself.
    if (!step) return { fields: ["인증번호"], next: 0 };
    // Its conversation archived or removed at the PC: the step is over on the AI's side (P1).
    const session = this.manager.view.sessions.get(step.sessionId);
    if (!session || session.archivedAt) return null;
    // An approval in another app waits for its button; its input only holds lines from the AI.
    if (step.kind === "approve") return { fields: ["승인"], next: 0 };
    return step.kind === "code" || step.kind === "link" ? { fields: [fieldOf(step)], next: 0 } : null;
  }

  /**
   * While a step's input is open nothing the person writes reaches the AI (round 2, NEW-I1): the
   * app's own words act; a code input takes a code, or the one code a pasted SMS holds; a link input
   * the one link of a line; an approval takes nothing; everything else is held.
   */
  protected override takes(id: string, text: string): TakeJudgement {
    if (!id.startsWith("s_")) return super.takes(id, text);
    const step = this.logins.stepOf(id);
    return step?.kind === "link" ? linkTake(text) : step?.kind === "approve" ? waitTake(text) : codeTake(text);
  }

  /**
   * A step's input ended (the one way, P1): the step ends with it unless the person can still give
   * its value (취소 or its time ran out: [다시 넣기]); the line names it and what happens now.
   */
  protected override inputEnded(chat: ChatRef, input: SecretWindow, reason: EndReason, how?: string) {
    if (!input.handoffId.startsWith("s_")) return super.inputEnded(chat, input, reason, how);
    const step = this.logins.stepOf(input.handoffId);
    // Its value taken: the module types it and ends the step itself (stepValue); replaced: another input of the chat took its place.
    const keeps = reason === "taken" || reason === "replaced" || (!input.atPc && (reason === "cancel" || reason === "timeout"));
    if (step && !keeps) this.logins.endStep(step.id);
    const binding = this.store?.channels.activeBinding(chat.kind, chat.botId, chat.chatId, input.userId);
    if (binding && reason !== "taken") this.reach?.audit(binding, "login.step", { sessionId: step?.sessionId ?? null, target: step?.name ?? input.name ?? null, result: `${step?.kind ?? "code"}:ended:${reason}` });
    super.inputEnded(chat, input, reason, how);
  }

  /** A step's line: "'도서관' 인증번호 입력을 닫았습니다. 지금부터 보내는 글은 AI에게 갑니다. …" */
  protected override endedLine(binding: Binding, input: SecretWindow, reason: EndReason, how?: string) {
    if (!input.handoffId.startsWith("s_")) return super.endedLine(binding, input, reason, how);
    const step = this.logins.stepOf(input.handoffId);
    const name = input.name ?? step?.name ?? "로그인";
    const field = input.fields[0] ?? "인증번호";
    const deletes = this.inChat(binding);
    const caught = input.catches === "link" ? "로그인 링크" : "인증번호";
    const late = input.catches && input.catches !== "none" ? ` 30분 동안은 ${caught}처럼 보이는 글만 ${deletes ? "AI에게 보내지 않고 지웁니다" : "AI에게 보내지 않습니다"}.` : "";
    const why = this.why(binding, reason, input.atPc ? 30 : 10);
    // Q1: what a sent line does NOW (the gate's sentence while it is closed; then nothing is offered).
    const open = !this.gateNow(binding, how);
    const now = this.nowLine(binding, how, late);
    if (input.atPc) return { text: `${why}PC에서 '${name}' ${field}${particle(field, "을/를")} 넣기를 기다리던 것을 그만두었습니다.${now}` };
    if (step?.kind === "approve" || field === "승인") return { text: `${why}'${name}' 승인 기다리기를 닫았습니다.${now}${step && open ? " 승인했으면 위의 [했어요]를 누르세요." : ""}` };
    const again = step && deletes && (reason === "cancel" || reason === "timeout") ? { label: "다시 넣기", kind: "cred-login-give", data: { s: step.id } } : undefined;
    return { text: `${why}'${name}' ${field} 입력을 닫았습니다.${now}${again && open ? " 다시 넣으려면 아래 [다시 넣기]를 누르세요." : ""}`, ...(again ? { again } : {}) };
  }

  override awaiting(binding: Binding, word?: string): string | null {
    const window = this.windows?.current(this.chatRef(binding));
    if (!window || window.userId !== binding.userId || !window.handoffId.startsWith("s_")) return super.awaiting(binding, word);
    const step = this.logins.stepOf(window.handoffId);
    if (window.atPc) return `PC에서 '${window.name ?? step?.name ?? "로그인"}' ${window.fields[0] ?? "인증번호"}${particle(window.fields[0] ?? "인증번호", "을/를")} 넣고 '이어서'라고 보내 주세요.`;
    if (step && AWAITED[step.kind]) return AWAITED[step.kind]!;
    const field = step ? fieldOf(step) : "인증번호";
    return `${field}${particle(field, "을/를")} 기다리고 있습니다.`;
  }

  /** The chat's tick: inputs that ran out (VaultChat), and login pictures whose send never happened (M11). */
  override async expire() {
    await super.expire();
    this.logins.sweepPictures();
  }

  // The filler's side

  reaches(sessionId: string): boolean {
    return Boolean(this.reach?.running && this.bindingFor(sessionId));
  }

  used(sessionId: string, name: string, host: string, result: string) {
    const bindingId = this.bindingFor(sessionId);
    const binding = bindingId ? this.reach?.binding(bindingId) : null;
    if (binding) this.reach!.audit(binding, "credential.used", { sessionId, target: `${name} · ${host}`, result });
  }

  /**
   * The login page as its own message, when the agent page is on the site and shows no secret in
   * clear (LoginFiller.picture). Only to an open chat: a held message would be sent later, from a
   * file that is gone. The file goes once it was sent; one whose send is still owed is left to the
   * filler's sweep.
   */
  private async picture(binding: Binding, sessionId: string, site: string, key: string, caption: string): Promise<"withheld" | null> {
    if (!site || binding.pausedAt || binding.lockedAt || binding.revokedAt) return null;
    const path = await this.logins.picture(sessionId, site).catch(() => null);
    if (!path || path === "withheld") return path === "withheld" ? "withheld" : null;
    const sent = await this.reach!.say(binding.id, key, { text: "", files: [{ path, name: "login.png", mime: "image/png", caption }] });
    if (sent) rmSync(path, { force: true });
    return null;
  }

  /** A login's hand-over: the page's picture first (its own message), then the hand-over as built. */
  override async ask(handoff: Handoff): Promise<"asked" | "refused" | "held"> {
    if (handoff.mode === "give" && handoff.kind === "login" && handoff.bindingId && this.reach) {
      const binding = this.reach.binding(handoff.bindingId);
      const shot = binding ? await this.picture(binding, handoff.sessionId, handoff.origin ?? handoff.site, `cred-shot:${handoff.id}${handoff.askRound ? `:${handoff.askRound}` : ""}`, `'${handoff.name}' 로그인 화면`) : null;
      if (binding && shot === "withheld") await this.reach.say(binding.id, `cred-shot-withheld:${handoff.id}${handoff.askRound ? `:${handoff.askRound}` : ""}`, { text: NO_PICTURE });
    }
    return super.ask(handoff);
  }

  async askStep(step: LoginStep): Promise<"asked" | "refused" | "held"> {
    const bindingId = this.bindingFor(step.sessionId);
    const binding = bindingId ? this.reach?.binding(bindingId) : null;
    if (!this.reach || !binding) return "refused";
    // Nothing is said to a paused or locked chat: an input nobody sees would take the next line (N4).
    if (binding.pausedAt || binding.lockedAt) return "held";
    const where = `「${this.purpose(step.sessionId)}」에서 '${step.name}' 로그인`;
    const entry = this.service.store.find(step.name);
    const site = entry ? entry.origin ?? entry.site : step.site;
    const shot = step.kind !== "link" ? await this.picture(binding, step.sessionId, site, `login-shot:${step.id}`, `'${step.name}' 로그인 화면`) : null;
    const noPicture = shot === "withheld" ? `\n${NO_PICTURE}` : "";
    const key = `login-step:${step.id}`;
    if (step.kind === "approve" || step.kind === "pc") {
      const text = step.kind === "approve"
        ? `${where}: 휴대폰 ${step.app} 앱에서 승인해 주세요. 승인했으면 아래 [했어요]를 누르세요.${noPicture}`
        : `${where}: ${PC_ONLY[step.why!]}\n여기까지 해 두었습니다. 이 단계는 PC 앞에서만 됩니다. PC에서 끝내고 '이어서'라고 보내 주세요.${noPicture}`;
      const sent = await this.reach.say(binding.id, key, { text, ...(step.kind === "approve" ? { buttons: [[{ label: "했어요", kind: "cred-login-done", data: { s: step.id } }]] } : {}) });
      if (step.kind === "pc") this.logins.endStep(step.id);
      const result = this.outcome(binding, key, sent);
      // While the approval waits, the chat's lines are held from the AI (its app words still act).
      if (step.kind === "approve" && result === "asked" && this.windows) this.windows.open(this.chatRef(binding), { userId: binding.userId, handoffId: step.id, fields: ["승인"], from: 0, mode: "text", catches: "code", name: step.name });
      return result;
    }
    const field = fieldOf(step);
    if (!this.inChat(binding)) {
      // A messenger without an in-chat input (Slack): nothing is taken from the chat; the person does
      // this step in the PC's browser window and says '이어서' (as a PC-only step).
      const atPc = step.kind === "code"
        ? `${where}: 휴대폰에 온 ${field}${particle(field, "을/를")} PC의 브라우저 창에 직접 넣어 주세요. 이 메신저로는 받지 않습니다.`
        : `${where}: 메일로 온 로그인 링크를 PC에서 열어 주세요(링크 주소를 PC 브라우저 창의 주소 칸에 붙여 넣기). 이 메신저로는 받지 않습니다.`;
      const sent = await this.reach.say(binding.id, key, { text: `${atPc}\n여기까지 해 두었습니다. PC에서 끝내고 '이어서'라고 보내 주세요.${noPicture}` });
      // While it waits at the PC (until '이어서', or LATE_MS), only its shapes are held from the AI (P2); it ends the one way (P1).
      this.windows?.open(this.chatRef(binding), { userId: binding.userId, handoffId: step.id, fields: [field], from: 0, mode: "text", catches: step.kind, name: step.name, atPc: true, ms: LATE_MS });
      this.reach.audit(binding, "secret.asked", { sessionId: step.sessionId, target: step.name, result: "pc" });
      return this.outcome(binding, key, sent);
    }
    const asked = step.kind === "code"
      ? `${where}에 ${field}${particle(field, "을/를")} 묻습니다. 휴대폰에 온 ${field}${particle(field, "을/를")} 보내 주세요. PC 브라우저에 넣고 저장하지 않습니다.`
      : `${where}: 메일로 온 로그인 링크는 이 PC 브라우저에서 열려야 합니다. 링크 주소를 복사해 보내 주세요.`;
    const sent = await this.reach.say(binding.id, key, {
      text: `${asked}${noPicture}\n다음에 보내는 메시지를 ${field}${particle(field, "으로/로")} 받습니다.\n${NOTICE}`,
      buttons: [[{ label: step.kind === "code" ? "인증번호 넣기" : "링크 넣기", kind: "cred-login-give", data: { s: step.id } }]],
    });
    const result = this.outcome(binding, key, sent);
    if (result !== "asked" || !this.windows) return result;
    // The input opens unless the message is known not to have gone (N6); a reply to it is its value.
    const chat = this.chatRef(binding);
    this.windows.open(chat, { userId: binding.userId, handoffId: step.id, fields: [field], from: 0, mode: "text", catches: step.kind, name: step.name });
    if (sent) this.windows.asked(chat, sent, step.id, binding.userId);
    this.reach.audit(binding, "secret.asked", { sessionId: step.sessionId, target: step.name, result: `login-${step.kind}` });
    return "asked";
  }

  /** A fill on another real host: the one question only the person can answer. */
  async askHost(question: HostQuestion): Promise<"asked" | "refused" | "held"> {
    const bindingId = this.bindingFor(question.sessionId);
    const binding = bindingId ? this.reach?.binding(bindingId) : null;
    if (!this.reach || !binding) return "refused";
    if (binding.pausedAt || binding.lockedAt) return "held";
    const key = `login-host:${question.id}`;
    const sent = await this.reach.say(binding.id, key, {
      text: `'${question.name}' 로그인은 ${shownHost(question.own)}에 저장되어 있습니다. ${shownHost(question.host)}에서도 쓰게 할까요?`,
      buttons: [[
        { label: "이 주소도 허용", kind: "cred-login-host", data: { h: question.id, a: 1 } },
        { label: "안 함", kind: "cred-login-host", data: { h: question.id, a: 0 } },
      ]],
    });
    return this.outcome(binding, key, sent);
  }

  private outcome(binding: Binding, key: string, messageId: string | null): "asked" | "refused" | "held" {
    const now = this.reach!.binding(binding.id);
    if (!now || now.pausedAt || now.lockedAt || now.revokedAt) return "held";
    if (messageId) return "asked";
    const state = this.reach!.sent(key);
    return state === "sent" || state === "unknown" ? "asked" : state === "undeliverable" ? "refused" : "held";
  }

  /** The step is over: its input, and replies to its message, end; the same code coming again is caught for a while (M1). */
  private endStep(binding: Binding, step: LoginStep, code?: string) {
    this.logins.endStep(step.id);
    if (code) this.windows?.typed(this.chatRef(binding), code);
    this.windows?.end(this.chatRef(binding), { handoffId: step.id }, "taken");
    this.windows?.forget(this.chatRef(binding), step.id);
  }

  private async goOn(binding: Binding, step: Pick<LoginStep, "id" | "sessionId" | "name">, line: string) {
    await this.reach!.continueWith(binding.id, step.sessionId, `cont:${step.id}`, `[자동 이어 하기] '${step.name}' 로그인: ${line} 새 스냅숏을 찍고 멈춘 곳에서 이어 하세요.`);
  }

  // From the chat

  override async button(adapter: ChannelAdapter, binding: Binding, event: Extract<Inbound, { type: "button" }>, row: ButtonRow): Promise<boolean> {
    if (row.kind !== "cred-login-give" && row.kind !== "cred-login-done" && row.kind !== "cred-login-host") return super.button(adapter, binding, event, row);
    const data = row.data ? (JSON.parse(row.data) as { s?: unknown; h?: unknown; a?: unknown }) : {};
    const ack = async (note?: string) => { try { await adapter.ackButton(event.ackHandle, note); } catch { /* The phone stops waiting by itself. */ } };
    if (row.kind === "cred-login-host") {
      const stale = row.messageId && event.messageId && row.messageId !== event.messageId;
      const question = !stale && typeof data.h === "string" ? this.logins.answerHost(data.h, data.a === 1) : null;
      if (!question) { await ack("이미 끝난 요청입니다"); return true; }
      const allowed = data.a === 1;
      await ack(allowed ? "허용했습니다" : "쓰지 않습니다");
      this.used(question.sessionId, question.name, question.host, allowed ? "allow_host" : "deny_host");
      await this.reach!.say(binding.id, `login-host-done:${question.id}`, { text: allowed ? `'${question.name}' 로그인을 ${shownHost(question.host)}에서도 씁니다. 이어서 합니다.` : `'${question.name}' 로그인을 ${shownHost(question.host)}에서는 쓰지 않습니다. 이어서 합니다.` });
      await this.goOn(binding, question, allowed ? `${question.host}에서도 쓰도록 허용되었습니다. fill을 다시 하세요.` : `${question.host}에서는 쓰지 않기로 했습니다(fail:wrong_site).`);
      return true;
    }
    const step = typeof data.s === "string" ? this.logins.stepOf(data.s) : null;
    const stale = row.messageId && event.messageId && row.messageId !== event.messageId;
    // Q5: [다시 넣기] (or [인증번호 넣기]) after its step is over says ONE true line: it is over, and what to do instead. Nothing opens.
    if (!stale && row.kind === "cred-login-give" && (!step || !this.pending(step.id))) {
      await ack();
      await this.reach!.say(binding.id, `login-over:${event.eventId}`, { text: `${step ? `'${step.name}'` : "이"} 로그인 단계는 이미 끝났습니다. 필요하면 AI에게 로그인을 다시 시켜 주세요.` });
      return true;
    }
    if (!step || stale) { await ack("이미 끝난 요청입니다"); return true; }
    if (row.kind === "cred-login-done") {
      await ack("이어서 합니다");
      this.endStep(binding, step);
      this.reach!.audit(binding, "login.step", { sessionId: step.sessionId, target: step.name, result: "approved" });
      await this.goOn(binding, step, `휴대폰 ${step.app} 앱에서 승인했다고 합니다.`);
      return true;
    }
    await ack();
    const field = fieldOf(step);
    if (!this.inChat(binding) || (step.kind !== "code" && step.kind !== "link")) {
      // No in-chat input here (Slack), or a step that takes no value: nothing opens.
      await this.reach!.say(binding.id, `login-give:${step.id}:${event.eventId}`, { text: `${field}${particle(field, "은/는")} PC의 브라우저 창에서 직접 넣어 주세요. 이 메신저로는 받지 않습니다. 끝나면 '이어서'라고 보내 주세요.` });
      return true;
    }
    this.windows?.open(this.chatRef(binding), { userId: binding.userId, handoffId: step.id, fields: [field], from: 0, mode: "text", catches: step.kind, name: step.name });
    await this.reach!.say(binding.id, `login-give:${step.id}:${event.eventId}`, { text: `다음에 보내는 메시지를 ${field}${particle(field, "으로/로")} 받습니다.\n${NOTICE}\n그만두려면 '취소'라고 보내 주세요.` });
    return true;
  }

  override async secret(adapter: ChannelAdapter, binding: Binding | null, event: Extract<Inbound, { type: "secret" }>) {
    if (!event.handoffId.startsWith("s_") || !this.windows || !this.reach) return super.secret(adapter, binding, event);
    const windows = this.windows, chat = event.chat;
    const value = windows.take(chat, event.eventId);
    const remove = async () => {
      if (windows.deleted(chat, event.eventId)) return true;
      const gone = await adapter.remove(chat, event.messageId).catch(() => false);
      if (gone) windows.markDeleted(chat, event.eventId);
      return gone;
    };
    try {
      await this.stepValue(binding, event, value, remove);
    } finally {
      windows.markHandled(chat, event.eventId);
    }
  }

  private async stepValue(binding: Binding | null, event: Extract<Inbound, { type: "secret" }>, value: string | undefined, remove: () => Promise<boolean>) {
    if (!binding) return void (await remove());
    const step = this.logins.stepOf(event.handoffId);
    const tell = (part: string, text: string, again = false) => this.reach!.say(binding.id, `login-in:${event.eventId}:${part}`, {
      text, ...(again && step ? { buttons: [[{ label: step.kind === "code" ? "인증번호 넣기" : "링크 넣기", kind: "cred-login-give", data: { s: step.id } }]] } : {}),
    });
    if (event.outcome === "caught") return this.caught(binding, event, remove);
    if (event.outcome === "held") {
      // Held from the AI while the input is open: what it waits for, and [그대로 보내기] (P2).
      return this.caught(binding, event, remove, `${HELD[step?.kind ?? "code"] ?? HELD.code!}\n`);
    }
    const gone = await remove();
    const deleted = gone ? "" : ` ${UNDELETED}`;
    // 취소: the input it ended said so in one line (P1).
    if (event.outcome === "cancel" && event.field !== -2) return;
    if (event.outcome === "cancel") return void (await tell("cancel", "취소했습니다. 받은 값은 없습니다. 지금부터 보내는 글은 AI에게 갑니다. 다시 하려면 아래 버튼을 누르세요.", true));
    if (binding.lockedAt || binding.pausedAt) {
      // The step cannot go on from a closed chat: it ends (said), and a code coming later is still caught.
      this.windows?.end(event.chat, { handoffId: event.handoffId }, "gate");
      return void (await tell("gate", `채널이 ${binding.lockedAt ? "잠겨" : "멈춰"} 있어 받지 않았습니다.${gone ? " 보낸 것은 지웠습니다." : deleted}`));
    }
    if (!step) {
      await tell("over", `이 요청은 이미 끝나 받은 것을 쓰지 않았습니다.${gone ? " 보낸 것은 지웠습니다." : deleted}`);
      // Lost with a restart: the conversation waiting for it hears so once (M12), never what was sent.
      if (binding.pointerSessionId) await this.reach!.continueWith(binding.id, binding.pointerSessionId, `cont:${event.handoffId}:lost`, "[자동 이어 하기] '로그인' 단계가 PC 재시작으로 끊겼습니다(fail:step_lost). 새 스냅숏을 찍고 필요하면 그 단계를 다시 요청하세요.");
      return;
    }
    if (event.outcome !== "value") return void (await tell("refused", `글로만 받습니다. 보낸 것은 쓰지 않았습니다.${gone ? " 메시지는 지웠습니다." : deleted}`, true));
    if (value === undefined) return void (await tell("lost", `PC가 다시 시작되어 보낸 것을 받지 못했습니다.${deleted} 다시 넣으려면 아래 버튼을 누르세요.`, true));
    const field = fieldOf(step);
    if (step.kind === "approve") return void (await tell("held", `${HELD.approve}${deleted}`));
    const code = value.replace(/[\s-]+/g, "");
    const result = step.kind === "link" ? await this.logins.openLink(step, value) : await this.logins.typeOnce(step, code);
    this.reach!.audit(binding, "login.step", { sessionId: step.sessionId, target: step.name, result: `${step.kind}:${result}` });
    if (result !== "ok" && step.kind === "link" && (result === "wrong_site" || result === "insecure") && !this.wrongLinks.has(step.id)) {
      // Most likely another link was copied: the input opens again, once (M9: a second one ends the step).
      this.wrongLinks.add(step.id);
      this.windows!.open(event.chat, { userId: binding.userId, handoffId: step.id, fields: [field], from: 0, mode: "text", catches: step.kind, name: step.name });
      return void (await tell("again", `그 링크는 '${step.name}' 사이트의 주소가 아니라 열지 않았습니다.${deleted} 메일의 로그인 링크를 다시 보내 주세요(그만두려면 '취소').`));
    }
    this.endStep(binding, step, step.kind === "code" ? code : undefined);
    if (result === "ok") {
      await tell("done", `${field}${particle(field, "을/를")} ${step.kind === "link" ? "PC 브라우저에서 열었습니다" : "넣었습니다"}(메시지는 지웠고 저장하지 않았습니다).${deleted} 이어서 합니다.`);
      await this.goOn(binding, step, `${field}${particle(field, "을/를")} ${step.kind === "link" ? "열었습니다." : "넣었습니다."}`);
      return;
    }
    await tell("failed", `${NOT_USED[result] ?? "넣지 못했습니다."}${deleted} AI가 화면을 다시 보고 이어 합니다.`);
    await this.goOn(binding, step, `${field}${particle(field, "을/를")} 넣지 못했습니다(fail:${result}).`);
  }
}
