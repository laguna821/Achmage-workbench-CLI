import { EFFORT_LABEL, PROVIDER_LABEL, type Attachment, type ContextUsage, type Provider, type Session, type TranscriptItem, type Work } from "@workbench/contracts";
import { HttpError } from "../errors.ts";
import type { SessionManager } from "../sessions.ts";
import { MODE_LABEL, ago, type ChannelMenu } from "./menu.ts";
import { clock, cutAt } from "./shape.ts";
import type { Binding, ChannelStore } from "./store.ts";
import type { ChannelAdapter, ChatRef, Inbound } from "./types.ts";
import type { Everyday } from "./words.ts";

// What the app itself knows, said by the app: the engine, model and effort a conversation runs
// with, how full its context is, the help line, and the everyday words beyond the first five
// (다시 시도, 이름 바꾸기, 맥락 줄이기, 꼬리말, and the slash commands of the command button).
// Every action here goes through the desktop's own functions and the core's guarded send.

type Settings = { provider: Provider; model: string | null; effort: string | null };

/** The engine, model and effort as the gateway knows them: chosen, else the engine's default from its own model list. */
export function engineFacts(manager: SessionManager, settings: Settings, engineModel: string | null = null) {
  const status = manager.snapshot().providers.find((entry) => entry.provider === settings.provider);
  const models = status?.models ?? [];
  const option = settings.model ? models.find((entry) => entry.id === settings.model) : (models.find((entry) => entry.isDefault) ?? models[0]);
  const model = settings.model ?? option?.id ?? null;
  const resolved = option?.resolvedModel && option.resolvedModel !== model ? option.resolvedModel : null;
  const effort = settings.effort ?? option?.defaultEffort ?? null;
  const answered = engineModel && engineModel !== model && engineModel !== resolved ? engineModel : null;
  return { engine: PROVIDER_LABEL[settings.provider], model, resolved, modelByDefault: !settings.model, effort, effortByDefault: !settings.effort, answered };
}
type Facts = ReturnType<typeof engineFacts>;

const modelWords = (facts: Facts) => facts.model
  ? `${facts.model}${facts.resolved ? ` (${facts.resolved})` : ""}${facts.modelByDefault ? " · 엔진 기본값" : ""}`
  : "엔진 기본값(엔진이 이름을 아직 알려 주지 않았습니다)";
const effortWords = (facts: Facts) => facts.effort ? `${EFFORT_LABEL[facts.effort] ?? facts.effort} (${facts.effort})${facts.effortByDefault ? " · 기본값" : ""}` : "엔진 기본값";

/** The preamble's line (the engine reads it with each request from the phone). */
export function engineSentence(facts: Facts): string {
  return `이 대화는 Workbench에서 ${facts.engine}로 실행됩니다. 모델: ${modelWords(facts)}. 노력: ${effortWords(facts)}.${facts.answered ? ` 지난 답에서 엔진이 알린 모델: ${facts.answered}.` : ""}`;
}

const tokens = (count: number) => (count >= 10_000 ? `${Math.round(count / 1000)}k` : count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));
/** The share of the context window used, when the engine reported the window; never estimated. */
const share = (context: ContextUsage | null) => (context?.window ? Math.round((context.used / context.window) * 100) : null);

/** How full the context is, as the engine last reported it (null: it has reported nothing yet). */
export function contextWords(context: ContextUsage | null, now: number): string | null {
  if (!context) return null;
  const when = now - context.at >= 5 * 60_000 ? ` · ${ago(context.at, now)} 기준` : "";
  const percent = share(context);
  if (percent === null) return `맥락: ${tokens(context.used)} 토큰 사용 (엔진이 맥락 크기를 알리지 않았습니다)${when}`;
  const compact = context.compactAt ? ` · ${tokens(context.compactAt)}에서 스스로 줄임` : "";
  return `맥락: ${percent}% 사용 (${tokens(context.used)} / ${tokens(context.window!)} 토큰${compact})${when}`;
}

/** "상태": where the chat writes, the engine, model, effort and access it runs with, its context, the provider's limits, what runs and waits. */
export function statusWords(manager: SessionManager, session: Session | undefined, where: string, startedAt: number | null, now: number): string {
  if (!session) return `지금: ${where}`;
  const work = manager.view.works.get(session.workId);
  const lines = [`지금: 「${work?.title ?? "?"}」 › 「${session.purpose}」`];
  if (session.archivedAt) {
    lines.push("보관한 대화입니다. '새 대화'라고 보내면 새 대화로 옮깁니다.");
    return lines.join("\n");
  }
  const settings = manager.profiles.resolve(session, manager.accessOf(session));
  const facts = engineFacts(manager, settings, session.engineModel);
  lines.push(`엔진: ${facts.engine} · 모델 ${modelWords(facts)}`, `노력: ${effortWords(facts)}`);
  if (facts.answered) lines.push(`지난 답의 모델: ${facts.answered}`);
  lines.push(`접근: ${MODE_LABEL[manager.accessOf(session)]}`);
  const context = contextWords(session.context, now);
  if (context) lines.push(context);
  const status = manager.snapshot().providers.find((entry) => entry.provider === session.provider);
  const usage = (status?.usage ?? []).filter((window) => window.usedPercent !== null).map((window) => `${window.label} ${Math.round(window.usedPercent!)}%`);
  if (usage.length) lines.push(`사용량: ${usage.join(" · ")}`);
  const busy = session.status !== "idle" && session.status !== "error";
  lines.push(busy ? `일하는 중 · ${clock(startedAt ? now - startedAt : 0)}` : "쉬는 중");
  if (session.queued.length) lines.push(`기다리는 요청 ${session.queued.length}개`);
  return lines.join("\n");
}

/**
 * The line under a finished answer: `Codex · gpt-5 · 0:46 · 맥락 34%`, only the parts that are
 * known. The context share only when the engine reported it during this turn (an older figure is
 * not this answer's).
 */
export function footerWords(manager: SessionManager, session: Session, endId: string, requestAt: number): string {
  const end = manager.items(session.id).items.find((item): item is Extract<TranscriptItem, { kind: "turnEnd" }> => item.kind === "turnEnd" && item.id === endId);
  const settings = manager.profiles.resolve(session, manager.accessOf(session));
  const facts = engineFacts(manager, settings);
  // The turn's own figures: the model its end recorded, a context reported during it (an answer held and sent later keeps them).
  const model = end?.model ?? session.engineModel ?? facts.model;
  const elapsed = end ? (typeof end.durationMs === "number" && end.durationMs > 0 ? end.durationMs : end.at - requestAt) : null;
  const percent = session.context && session.context.at >= requestAt && (!end || session.context.at <= end.at) ? share(session.context) : null;
  return cutAt([facts.engine, model, elapsed !== null && elapsed >= 0 ? clock(elapsed) : null, percent !== null ? `맥락 ${percent}%` : null].filter(Boolean).join(" · "), 120);
}

/** Whether a chat wants the footer (on unless turned off). */
export const footerOn = (binding: Binding, otherwise = true) => (typeof binding.prefs.footer === "boolean" ? binding.prefs.footer : otherwise);

const HELP_WORDS = [
  "그냥 적어 보내면 지금 대화의 AI에게 갑니다. 사진·파일도 그대로 보내면 됩니다. 일하는 중에 보내면 그 일에 덧붙입니다.",
  "",
  "한 줄로 보내면 바로 되는 말",
  "· 메뉴 — 모든 기능",
  "· 상태 — 지금 대화, 엔진·모델, 맥락, 대기열",
  "· 새 대화 · 다시 시도 · 멈춰 · 잠금",
  "· 대화 이름 바꾸기 · 맥락 줄이기",
  "· 꼬리말 끄기 / 꼬리말 켜기 — 답 아래 모델·시간 줄",
  "· 계획 먼저: … — 계획을 먼저 받고 [진행]",
  "· 결정으로 적어 줘: … — 프로젝트 노트에 적기",
  "",
  "메뉴에는: 대화·프로젝트 바꾸기, 엔진·모델, 최근 파일, 프로젝트 노트, 찾기, 예약, 사용량, 알림, 상태·대기열, 채널 잠금",
];
const HELP_SLASH = "명령 버튼(/): /menu /new /chats /model /status /usage /retry /stop /help";
/** Telegram's help: the words, then the command button's list. */
export const HELP = [...HELP_WORDS, HELP_SLASH].join("\n");
/**
 * The help of a messenger without a command button. Slack keeps a line that begins with `/` for its
 * own commands and never delivers it to the app, so the slash words are not named there.
 */
export const HELP_PLAIN = HELP_WORDS.join("\n");

type Reply = (text: string, part?: string) => Promise<unknown>;
type Later = { settled: Promise<"done" | "parked"> };

/** What the everyday words need from the core. */
export type ComfortCore = {
  manager: SessionManager;
  channels: ChannelStore;
  menu: ChannelMenu;
  hidden(work: Work): boolean;
  admitted(): boolean;
  /** A request of the chat to a given conversation, through the core's guarded hand-off (behind the chat's other lines). */
  resend(adapter: ChannelAdapter, binding: Binding, sessionId: string, request: { text: string; attachments: Attachment[]; plan?: boolean }, requestId: string, reply: Reply): Later;
  audit(binding: Binding, action: string, extra?: { sessionId?: string | null; target?: string | null; result?: string | null }): void;
  clean(error: unknown): string;
};

export class ChannelComfort {
  private readonly core: ComfortCore;

  constructor(core: ComfortCore) {
    this.core = core;
  }

  private pointer(binding: Binding): Session | undefined {
    const id = (this.core.channels.binding(binding.id) ?? binding).pointerSessionId;
    return id ? this.core.manager.view.sessions.get(id) : undefined;
  }

  /** A live conversation of the chat, or why there is none (said as everywhere else). */
  private live(binding: Binding): Session | string {
    const session = this.pointer(binding);
    if (!session) return "아직 대화가 없습니다. 적어 보내면 새 대화가 생깁니다.";
    const work = this.core.manager.view.works.get(session.workId);
    if (session.archivedAt || !work || this.core.hidden(work)) return "이 대화는 보관되어 더 보낼 수 없습니다. '새 대화'라고 보내면 새 대화로 옮깁니다.";
    return session;
  }

  /**
   * An everyday word from the paired chat whose gate is open (the core checked pause and lock
   * before). Returns the hand-off when the word became a request for the engine (다시 시도).
   */
  async take(adapter: ChannelAdapter, binding: Binding, chat: ChatRef, event: Extract<Inbound, { type: "message" }>, word: Everyday | "unknown", reply: Reply, key: (what: string) => string): Promise<Later | null> {
    const { menu } = this.core;
    switch (word) {
      case "unknown":
        this.core.audit(binding, "command", { result: "unknown" });
        await reply(adapter.kind === "slack" ? "모르는 명령입니다. '도움말'이라고 보내면 쓸 수 있는 말이 나옵니다." : "모르는 명령입니다. /help 를 보내면 쓸 수 있는 말이 나옵니다.");
        return null;
      case "help":
        await reply(adapter.kind === "slack" ? HELP_PLAIN : HELP);
        return null;
      case "status":
        await menu.status(adapter, binding, key("status"));
        return null;
      case "chats":
        await menu.press(adapter, binding, chat, event.eventId, null, { a: "sessions" });
        return null;
      case "model":
        await menu.press(adapter, binding, chat, event.eventId, null, { a: "engine" });
        return null;
      case "usage":
        await menu.press(adapter, binding, chat, event.eventId, null, { a: "usage" });
        return null;
      case "footer-on":
      case "footer-off":
        this.setFooter(binding, word === "footer-on");
        await reply(word === "footer-on" ? "끝난 답 아래에 꼬리말(엔진 · 모델 · 걸린 시간 · 맥락)을 붙입니다." : "끝난 답 아래 꼬리말을 붙이지 않습니다. '꼬리말 켜기'로 다시 켭니다.");
        return null;
      case "rename": {
        const session = this.live(binding);
        if (typeof session === "string") { await reply(session); return null; }
        await menu.askRename(adapter, binding, key("rename"), session);
        return null;
      }
      case "compact":
        await reply(await this.compact(binding));
        return null;
      case "retry":
        return this.retry(adapter, binding, event, reply);
    }
  }

  /** "꼬리말 켜기 / 끄기", also from [알림]. Kept with the chat (`prefs.footer`; absent = the core's default, on). */
  setFooter(binding: Binding, on: boolean) {
    const fresh = this.core.channels.binding(binding.id) ?? binding;
    const { footer: _gone, ...rest } = fresh.prefs;
    this.core.channels.updateBinding(binding.id, { prefs: { ...rest, footer: on } });
    this.core.audit(fresh, "footer", { result: on ? "on" : "off" });
  }

  /** "맥락 줄이기": the desktop's own "지금 압축" (SessionManager.compact), where the gateway has a way for the engine. */
  async compact(binding: Binding): Promise<string> {
    const session = this.live(binding);
    if (typeof session === "string") return session;
    if (!this.core.admitted()) return "PC가 업데이트를 준비하고 있어 지금은 새 일을 시작하지 않습니다.";
    try {
      await this.core.manager.compact(session.id);
    } catch (error) {
      const code = error instanceof HttpError ? error.code : "failed";
      this.core.audit(binding, "compact", { sessionId: session.id, result: code });
      if (code === "session_busy") return "일하는 중이라 줄이지 않았습니다. 끝난 뒤에 다시 보내 주세요.";
      return `줄이지 못했습니다: ${this.core.clean(error)}`;
    }
    this.core.audit(binding, "compact", { sessionId: session.id, result: "started" });
    return "맥락을 줄이기 시작했습니다. 끝나면 '상태'에서 맥락이 줄어든 것을 볼 수 있습니다.";
  }

  /**
   * "다시 시도": the conversation's last request (its words and its files, by reference) again, as a
   * new turn, only while the conversation rests; through the core's guarded hand-off, which refuses
   * an archived conversation or a removed document's AI as everywhere.
   */
  private async retry(adapter: ChannelAdapter, binding: Binding, event: Extract<Inbound, { type: "message" }>, reply: Reply): Promise<Later | null> {
    const session = this.pointer(binding);
    if (!session) { await reply("다시 보낼 요청이 없습니다."); return null; }
    if (session.status !== "idle" && session.status !== "error") {
      await reply("일하는 중이라 다시 보내지 않았습니다. 끝난 뒤에 '다시 시도'를 보내 주세요.");
      return null;
    }
    const last = this.core.manager.items(session.id).items.findLast((item): item is UserItem => item.kind === "user" && !item.steered && Boolean(item.text.trim() || item.attachments?.length));
    if (!last) { await reply("다시 보낼 요청이 없습니다."); return null; }
    const refused = retryRefusal(last, binding.id);
    if (refused) {
      this.core.audit(binding, "retry", { sessionId: session.id, result: "refused" });
      await reply(refused);
      return null;
    }
    this.core.audit(binding, "retry", { sessionId: session.id });
    await reply(`다시 보냅니다: “${cutAt(last.text.replace(/\s+/g, " "), 80)}${last.text.length > 80 ? "…" : ""}”`, "retry");
    return this.core.resend(adapter, binding, session.id, { text: last.text, attachments: last.attachments ?? [], ...(last.plan ? { plan: true } : {}) }, `ch:${binding.kind}:${binding.botId}:retry:${event.eventId}`, reply);
  }
}

type UserItem = Extract<TranscriptItem, { kind: "user" }>;

/**
 * Why the last request cannot be sent again exactly as it was, or null. Only a request the person
 * typed in this chat is repeated (never one typed at the PC, a schedule's run or an automatic
 * continuation), and only when everything it carried goes again (its words, files and 계획 먼저;
 * not pinned documents, a new-document target, a relay or notes).
 */
export function retryRefusal(item: UserItem, bindingId: string): string | null {
  if (item.id.startsWith("user:cont:")) return "마지막 요청은 자동으로 이어 간 요청이라 다시 보내지 않습니다. 필요한 말을 새로 적어 보내 주세요.";
  if (item.scheduled) return "마지막 요청은 예약 작업이 보낸 것이라 다시 보내지 않습니다. 필요한 말을 새로 적어 보내 주세요.";
  if (item.origin?.bindingId !== bindingId || item.peer) return "마지막 요청은 이 채팅에서 보낸 것이 아니라 다시 보내지 않습니다. 필요한 말을 새로 적어 보내 주세요.";
  if (item.refs?.length || item.create || item.from || item.link || item.notes?.length || item.draw) return "마지막 요청은 PC에서 보낸 형식(문서·연결 등)이 있어 여기서 그대로 다시 보낼 수 없습니다.";
  return null;
}

/** "이름 바꾸기" through the desktop's own rename: one line, at most this many characters (what the desktop keeps). */
export const NAME_LIMIT = 60;

/** The rename itself (the menu's one-line input calls it): refused when archived; the name as typed, never cut. */
export function renameConversation(manager: SessionManager, hidden: (work: Work) => boolean, sessionId: string, name: string): { ok: true; name: string } | { ok: false; text: string } {
  const session = manager.view.sessions.get(sessionId);
  const work = session ? manager.view.works.get(session.workId) : undefined;
  if (!session || !work) return { ok: false, text: "그 대화를 찾지 못했습니다." };
  if (session.archivedAt || hidden(work)) return { ok: false, text: "보관한 대화라 이름을 바꾸지 않았습니다." };
  try {
    const next = manager.updateSession(sessionId, { purpose: name });
    return { ok: true, name: next.purpose };
  } catch (error) {
    return { ok: false, text: `바꾸지 못했습니다: ${error instanceof Error ? error.message : String(error)}` };
  }
}

