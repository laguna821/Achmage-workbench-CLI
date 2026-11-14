import { ACCESS_LABEL, EFFORT_LABEL, PROVIDER_LABEL, SEARCH_KIND_LABEL, isAccessMode, type AccessMode, type Artifact, type Provider, type Schedule, type ScheduleWhen, type SearchPage, type Session, type Work } from "@workbench/contracts";
import { HttpError } from "../errors.ts";
import type { Projects } from "../project.ts";
import type { SessionManager } from "../sessions.ts";
import { previewed } from "./files.ts";
import { cutAt } from "./shape.ts";
import { NAME_LIMIT } from "./comfort.ts";
import type { Binding, ChannelStore } from "./store.ts";
import type { ChannelAdapter, ChatRef, Inbound } from "./types.ts";

// "메뉴": one message with buttons, edited in place as the person moves through it, and the few
// one-line inputs a menu opens (a search, a schedule's text, a new project's name, a note entry or
// property). What a button does is written in the core's button table (kind "menu", `data` below);
// the button itself carries only a random token. Every action goes through the same functions the
// desktop calls (SessionManager, Projects, Schedules), never a second path.

/** What a menu button does. Kept in the button's row; the messenger never sees it. */
export type MenuAct =
  | { a: "main" }
  | { a: "new" }
  | { a: "sessions"; workId?: string; move?: string }
  | { a: "pick"; sessionId: string; move?: string }
  | { a: "works"; move?: string }
  | { a: "newin"; workId: string; move?: string }
  | { a: "newwork" }
  | { a: "engine"; note?: string }
  | { a: "provider"; provider: Provider }
  | { a: "model"; model: string | null }
  | { a: "effort"; effort: string | null }
  | { a: "access"; access: AccessMode }
  | { a: "status" }
  | { a: "q-send"; sessionId: string; queuedId: string }
  | { a: "q-drop"; sessionId: string; queuedId: string }
  | { a: "files" }
  | { a: "doc"; artifactId: string }
  | { a: "doc-ai"; artifactId: string }
  | { a: "note" }
  | { a: "note-add"; workId: string; section: "decision" | "question"; base: number | null }
  | { a: "note-props"; workId: string }
  | { a: "note-prop"; workId: string; key: string; base: number | null }
  | { a: "note-retry"; workId: string; section: "decision" | "question"; text: string }
  | { a: "note-drop" }
  | { a: "search" }
  | { a: "hit"; hit: Hit; list: Hit[]; query: string }
  | { a: "results"; list: Hit[]; query: string }
  | { a: "schedule" }
  | { a: "when"; when: ScheduleWhen; label: string }
  | { a: "when-typed" }
  | { a: "schedules" }
  | { a: "vault" }
  | { a: "usage" }
  | { a: "notify"; workId?: string }
  | { a: "lock" }
  | { a: "schedules-on" }
  | { a: "schedule-on"; scheduleId: string }
  | { a: "run-schedule"; scheduleId: string }
  | { a: "cancel" }
  | { a: "footer" }
  | { a: "rename" }
  | { a: "compact" };

type Hit = { kind: string; title: string; snippet: string; sessionId: string | null; artifactId: string | null };

/** A line the person was asked for (a menu opened a one-line input). Kept with the chat for ten minutes. */
export type Awaiting =
  | { kind: "search" }
  | { kind: "work-title" }
  | { kind: "note-entry"; workId: string; section: "decision" | "question"; base: number | null }
  | { kind: "note-prop"; workId: string; key: string; base: number | null; list: boolean }
  | { kind: "schedule-time" }
  | { kind: "schedule-text"; when: ScheduleWhen; label: string }
  | { kind: "rename"; sessionId: string };

/** `taking`: the line being acted on (a gateway stopped meanwhile does not hand it to the AI after). */
type Stored = Awaiting & { until: number; messageId: string | null; taking?: string };

/** A button of a screen: a menu action, or one of the core's own kinds (`kind`, `data`). */
export type MenuButton = { label: string; act: MenuAct; ttl?: number; set?: string } | { label: string; kind: string; data?: unknown; group?: string };
/** `strict`: the screen carries the stricter-mode notice of this conversation (counted as said once shown). */
export type Screen = { text: string; buttons?: MenuButton[][]; strict?: string };

export const INPUT_TTL = 3 * 60_000;
/** Time buttons are only good for a short while: "내일" means the next day from when they were drawn. */
const TIME_BUTTON_TTL = 30 * 60_000;
/** An input that ran out is mentioned when the next line comes within this time after; later, not. */
/** At most this many skipped schedules are named, each with its own [n 지금 실행]; the rest are counted. */
const SKIPPED_NAMED = 8;
const EXPIRED_MENTION = 60 * 60_000;
/** Each access mode by what it does, the same wherever it is offered. */
export const MODE_LABEL: Record<AccessMode, string> = { ask: "묻기 · 매번 확인", auto: "자동 · 명령은 확인", full: "전체 접근 · 묻지 않음" };
const NOTE_LIMIT = 400;
const TITLE_LIMIT = 80;
const QUERY_LIMIT = 200;
const SCHEDULE_LIMIT = 8000;
const INPUT_NAME: Record<Awaiting["kind"], string> = {
  "search": "찾을 말을 적는 칸", "work-title": "새 프로젝트 이름 칸", "note-entry": "노트에 적을 말 칸", "note-prop": "노트 속성 값 칸", "schedule-time": "예약 시각 칸", "schedule-text": "예약할 내용 칸", "rename": "대화 이름 칸",
};
const tooLongForNote = (text: string) => { const length = text.replace(/\s+/g, " ").trim().length; return length > NOTE_LIMIT ? `노트의 결정·질문은 ${NOTE_LIMIT}자까지입니다(지금 ${length}자). 적지 않았습니다. 줄여서 다시 보내 주세요.` : null; };
const BACK: MenuButton = { label: "← 메뉴", act: { a: "main" } };
const SECTION_LABEL = { decision: "결정", question: "열린 질문" } as const;
const NOTE_SENTENCE = /^\s*(결정|열린\s*질문|질문)으로\s*(?:적어|남겨)\s*줘\s*[:：]\s*([\s\S]+)$/;
const PLAN_SENTENCE = /^\s*계획\s*먼저\s*[:：]\s*([\s\S]+)$/;

/** "결정으로 적어 줘: …" / "질문으로 적어 줘: …": a line for the project note, not for the AI. */
export function noteSentence(text: string): { section: "decision" | "question"; text: string } | null {
  const match = NOTE_SENTENCE.exec(text);
  if (!match || !match[2]!.trim()) return null;
  return { section: match[1] === "결정" ? "decision" : "question", text: match[2]!.trim() };
}

/** "계획 먼저: …": the person asks for a plan first (an approval comes back with one [진행]). */
export function planSentence(text: string): string | null {
  const match = PLAN_SENTENCE.exec(text);
  return match && match[1]!.trim() ? match[1]!.trim() : null;
}

/** How long ago, as a phone list says it. */
export function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 5) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
  const days = Math.floor(minutes / (24 * 60));
  if (days === 1) return "어제";
  if (days < 7) return `${days}일 전`;
  const date = new Date(at);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

const hhmm = (at: number) => { const date = new Date(at); return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; };

/**
 * A time the person typed for a schedule: "18:30" (today, else tomorrow), "내일 9:00", "11/20 14:00",
 * "매일 7:30". Null when it cannot be read.
 */
export function parseWhen(raw: string, now: number): { when: ScheduleWhen; label: string } | null {
  const text = raw.trim().replace(/\s+/g, " ");
  const time = (h: string, m: string | undefined) => { const hours = Number(h), minutes = Number(m ?? 0); return hours <= 23 && minutes <= 59 ? [hours, minutes] as const : null; };
  const at = (date: Date, hours: number, minutes: number) => { const copy = new Date(date); copy.setHours(hours, minutes, 0, 0); return copy.getTime(); };
  const pad = (hours: number, minutes: number) => `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  let match = /^매일 (\d{1,2})(?:[:시] ?(\d{1,2})?분?)?$/.exec(text);
  if (match) { const t = time(match[1]!, match[2]); return t ? { when: { kind: "daily", time: pad(t[0], t[1]) }, label: `매일 ${pad(t[0], t[1])}` } : null; }
  match = /^(오늘 |내일 )?(\d{1,2})(?:[:시] ?(\d{1,2})?분?)?$/.exec(text);
  if (match) {
    const t = time(match[2]!, match[3]);
    if (!t) return null;
    const today = new Date(now);
    let when = at(today, t[0], t[1]);
    const tomorrow = match[1] === "내일 " || (!match[1] && when <= now);
    if (tomorrow) { const next = new Date(now); next.setDate(next.getDate() + 1); when = at(next, t[0], t[1]); }
    if (when <= now) return null;
    return { when: { kind: "once", at: when }, label: `${tomorrow ? "내일" : "오늘"} ${pad(t[0], t[1])}` };
  }
  match = /^(\d{1,2})[/.월] ?(\d{1,2})일? (\d{1,2})(?:[:시] ?(\d{1,2})?분?)?$/.exec(text);
  if (match) {
    const t = time(match[3]!, match[4]), month = Number(match[1]) - 1, day = Number(match[2]);
    if (!t || month > 11 || day < 1 || day > 31) return null;
    const date = new Date(now);
    date.setMonth(month, day);
    // 11/31 is no date (not 12/1).
    if (date.getMonth() !== month || date.getDate() !== day) return null;
    let when = at(date, t[0], t[1]);
    if (when <= now) {
      date.setFullYear(date.getFullYear() + 1, month, day);
      if (date.getMonth() !== month) return null;
      when = at(date, t[0], t[1]);
    }
    return { when: { kind: "once", at: when }, label: `${month + 1}/${day} ${pad(t[0], t[1])}` };
  }
  return null;
}

/** What the menu needs from the core: its gates, its sends and the conversations it points at. */
export type MenuCore = {
  manager: SessionManager;
  channels: ChannelStore;
  projects: () => Projects | null;
  search: (query: string) => Promise<SearchPage>;
  now: () => number;
  /** Show a screen on a message the chat already has (its other buttons are retired). True when it was shown. */
  show(adapter: ChannelAdapter, binding: Binding, messageId: string, screen: Screen): Promise<boolean>;
  /** Send a screen as a new message, once under `key`; its message id. */
  send(adapter: ChannelAdapter, binding: Binding, key: string, screen: Screen): Promise<string | null>;
  label(session: Session): string;
  where(binding: Binding): string;
  hidden(work: Work): boolean;
  recentWork(): Work | null;
  newConversation(binding: Binding): Session;
  conversationIn(binding: Binding, work: Work, provider?: Provider): Session;
  setPointer(bindingId: string, sessionId: string): Binding;
  /** The conversation a line of the chat goes to now (made when there is none); null when it is archived. */
  target(binding: Binding): Session | null;
  /** Said once per conversation that is not in full access (the stricter-mode notice), now. */
  strictNote(binding: Binding, session: Session): MenuButton[][] | null;
  strictSaid(binding: Binding, sessionId: string): void;
  enableSchedules(binding: Binding): number;
  /** The redactor (search results are kept in buttons with their secrets hidden). */
  scrub(text: string): string;
  /** A request of the chat to a given conversation now (a skipped schedule's text, [지금 실행]). */
  runNow(adapter: ChannelAdapter, binding: Binding, chat: ChatRef, eventId: string, sessionId: string, text: string): void;
  statusText(binding: Binding): string;
  admitted(): boolean;
  lock(binding: Binding, chat: ChatRef, eventId: string): Promise<void>;
  /** Hand a parked line (its conversation was archived) to another conversation. */
  moveParked(adapter: ChannelAdapter, binding: Binding, chat: ChatRef, eventId: string, sessionId: string): Promise<void>;
  audit(binding: Binding, action: string, extra?: { sessionId?: string | null; target?: string | null; result?: string | null }): void;
  clean(error: unknown): string;
  /** Unit 14 (comfort.ts): the footer under finished answers, "맥락 줄이기", and the rename through the desktop's own. */
  setFooter(binding: Binding, on: boolean): void;
  footerOn(binding: Binding): boolean;
  compact(binding: Binding): Promise<string>;
  rename(sessionId: string, name: string): { ok: true; name: string } | { ok: false; text: string };
  /** "비밀 보관함" (units 7-8): the list as the sentence gives it, as a message of its own; null without the credential module. */
  vault: ((binding: Binding, eventId: string) => Promise<void>) | null;
};

const sessionsOf = (manager: SessionManager, workId: string) => [...manager.view.sessions.values()]
  .filter((session) => session.workId === workId && !session.archivedAt && !session.pageAgent && !session.documentAgent)
  .sort((a, b) => b.updatedAt - a.updatedAt);

export class ChannelMenu {
  private readonly core: MenuCore;

  constructor(core: MenuCore) {
    this.core = core;
  }

  private get manager() { return this.core.manager; }

  // The awaited line

  awaiting(binding: Binding): Stored | null {
    const stored = binding.prefs.awaiting as Stored | undefined;
    return stored && stored.until > this.core.now() ? stored : null;
  }

  private stored(binding: Binding): Stored | null {
    return (this.fresh(binding).prefs.awaiting as Stored | undefined) ?? null;
  }

  private await(binding: Binding, awaiting: Awaiting, messageId: string | null) {
    const stored: Stored = { ...awaiting, until: this.core.now() + INPUT_TTL, messageId };
    this.core.channels.updateBinding(binding.id, { prefs: { ...this.fresh(binding).prefs, awaiting: stored } });
  }

  /** The person did something else (a command, another button): the input the menu opened is closed. */
  clear(binding: Binding) {
    const current = this.fresh(binding);
    if (!current.prefs.awaiting) return;
    const { awaiting: _gone, ...rest } = current.prefs;
    this.core.channels.updateBinding(binding.id, { prefs: rest });
  }

  private fresh(binding: Binding) {
    return this.core.channels.binding(binding.id) ?? binding;
  }

  // Opening

  /** "메뉴": the menu as a new message. */
  async open(adapter: ChannelAdapter, binding: Binding, key: string) {
    this.clear(binding);
    await this.core.send(adapter, binding, key, this.mainScreen(binding));
  }

  /** "상태": where the chat writes, what runs, and what waits (with 지금 보내기 and 빼기). */
  async status(adapter: ChannelAdapter, binding: Binding, key: string) {
    this.clear(binding);
    await this.core.send(adapter, binding, key, this.statusScreen(binding));
  }

  private renamePrompt(session: Session): Screen {
    return { text: `「${session.purpose}」의 새 이름을 적어 보내 주세요(한 줄, ${NAME_LIMIT}자까지).`, buttons: [[{ label: "취소", act: { a: "cancel" } }]] };
  }

  /** "대화 이름 바꾸기" as a word: the one-line input opens with its own message. */
  async askRename(adapter: ChannelAdapter, binding: Binding, key: string, session: Session) {
    this.clear(binding);
    const id = await this.core.send(adapter, binding, key, this.renamePrompt(session));
    if (id) this.await(binding, { kind: "rename", sessionId: session.id }, id);
  }

  /** Data shown in a line or a label: stored values hidden first, then cut (a value across the cut would leave its beginning). */
  private clip(text: string, limit: number): string {
    return cutAt(this.core.scrub(text), limit);
  }

  mainScreen(binding: Binding, note?: string): Screen {
    return {
      text: `${note ? `${note}\n\n` : ""}메뉴 · 지금: ${this.core.where(binding)}`,
      buttons: [
        [{ label: "새 대화", act: { a: "new" } }, { label: "대화 바꾸기", act: { a: "sessions" } }, { label: "프로젝트 바꾸기", act: { a: "works" } }],
        [{ label: "엔진·모델", act: { a: "engine" } }, { label: "최근 파일", act: { a: "files" } }, { label: "프로젝트 노트", act: { a: "note" } }],
        [{ label: "찾기", act: { a: "search" } }, { label: "예약", act: { a: "schedule" } }, { label: "사용량", act: { a: "usage" } }],
        [{ label: "알림", act: { a: "notify" } }, { label: "상태·대기열", act: { a: "status" } }, { label: "채널 잠금", act: { a: "lock" } }],
        ...(this.core.vault ? [[{ label: "비밀 보관함", act: { a: "vault" } } as MenuButton]] : []),
      ],
    };
  }

  private pointer(binding: Binding): Session | null {
    const id = this.fresh(binding).pointerSessionId;
    return id ? this.manager.view.sessions.get(id) ?? null : null;
  }

  /** The project the chat is in: its conversation's, else the one used last at the PC. */
  private work(binding: Binding): Work | null {
    const session = this.pointer(binding);
    const work = session ? this.manager.view.works.get(session.workId) : undefined;
    return work && !this.core.hidden(work) ? work : this.core.recentWork();
  }

  // A press

  async press(adapter: ChannelAdapter, binding: Binding, chat: ChatRef, eventId: string, messageId: string | null, act: MenuAct): Promise<void> {
    if (act.a !== "cancel") this.clear(binding);
    const show = async (screen: Screen) => {
      const shown = messageId ? await this.core.show(adapter, binding, messageId, screen) : Boolean(await this.core.send(adapter, binding, `menu:${eventId}`, screen));
      // The stricter-mode notice counts as said only once the message carrying it went.
      if (shown && screen.strict) this.core.strictSaid(binding, screen.strict);
    };
    switch (act.a) {
      case "main": return show(this.mainScreen(binding));
      case "new": {
        const session = this.core.newConversation(binding);
        return show({ text: `새 대화를 만들었습니다: ${this.core.label(session)}`, buttons: [[BACK]] });
      }
      case "sessions": return show(this.sessionsScreen(binding, act.workId, act.move));
      case "works": return show(this.worksScreen(binding, act.move));
      case "pick": return show(await this.pick(adapter, binding, chat, act.sessionId, act.move));
      case "newin": {
        const work = this.manager.view.works.get(act.workId);
        if (!work || this.core.hidden(work)) return show({ text: "보관한 프로젝트입니다. 다른 프로젝트를 골라 주세요.", buttons: [[{ label: "프로젝트 바꾸기", act: { a: "works" } }, BACK]] });
        const session = this.core.conversationIn(binding, work);
        if (act.move) await this.core.moveParked(adapter, binding, chat, act.move, session.id);
        return show({ text: `「${work.title}」에 새 대화를 만들었습니다: ${this.core.label(session)}`, buttons: [[BACK]] });
      }
      case "newwork":
        this.await(binding, { kind: "work-title" }, messageId);
        return show({ text: "새 프로젝트 이름을 적어 보내 주세요.", buttons: [[{ label: "취소", act: { a: "cancel" } }]] });
      case "engine": return show(this.engineScreen(binding, act.note));
      case "provider": return show(this.engineScreen(binding, this.provider(binding, act.provider)));
      case "model":
      case "effort":
      case "access": return show(this.engineScreen(binding, this.setting(binding, act)));
      case "status": return show(this.statusScreen(binding));
      case "vault":
        await this.core.vault?.(binding, eventId);
        return show(this.mainScreen(binding, "비밀 보관함을 아래에 보냈습니다."));
      case "q-send": return show(this.statusScreen(binding, await this.sendQueued(binding, act.sessionId, act.queuedId)));
      case "q-drop": return show(this.statusScreen(binding, this.dropQueued(binding, act.sessionId, act.queuedId)));
      case "files": return show(this.filesScreen(binding));
      case "doc": return show(this.docScreen(act.artifactId));
      case "doc-ai": return show(this.documentAi(binding, act.artifactId));
      case "note": return show(this.noteScreen(binding));
      case "note-add":
        this.await(binding, { kind: "note-entry", workId: act.workId, section: act.section, base: act.base }, messageId);
        return show({ text: `'${SECTION_LABEL[act.section]}'에 남길 말을 적어 보내 주세요.`, buttons: [[{ label: "취소", act: { a: "cancel" } }]] });
      case "note-props": return show(this.propsScreen(act.workId));
      case "note-prop": {
        const row = this.core.projects()?.page(act.workId).rows?.find((entry) => entry.key === act.key);
        const list = row?.type === "list" || row?.type === "tags" || row?.type === "links";
        this.await(binding, { kind: "note-prop", workId: act.workId, key: act.key, base: act.base, list }, messageId);
        const now = row?.values?.length ? row.values.join(", ") : "값 없음";
        return show({ text: `「${act.key}」에 ${list ? "더할 값을" : "새 값을"} 적어 보내 주세요. 지금: ${this.clip(now, 200)}`, buttons: [[{ label: "취소", act: { a: "cancel" } }]] });
      }
      case "note-retry": return show(this.noteWrite(binding, act.workId, act.section, act.text, "current"));
      case "note-drop": return show({ text: "노트에 적지 않았습니다.", buttons: [[BACK]] });
      case "search":
        this.await(binding, { kind: "search" }, messageId);
        return show({ text: "무엇을 찾을까요? (한 줄로 적어 주세요)", buttons: [[{ label: "취소", act: { a: "cancel" } }]] });
      case "results": return show(this.resultsScreen(act.query, act.list));
      case "hit": return show(this.hitScreen(act.hit, act.list, act.query));
      case "schedule": return show(this.scheduleScreen(binding));
      case "when": {
        this.await(binding, { kind: "schedule-text", when: act.when, label: act.label }, messageId);
        return show({ text: `무엇을 할까요? (${act.label} 예약)`, buttons: [[{ label: "취소", act: { a: "cancel" } }]] });
      }
      case "when-typed":
        this.await(binding, { kind: "schedule-time" }, messageId);
        return show({ text: "언제 할까요? 예: 18:30 · 내일 9:00 · 11/20 14:00 · 매일 7:30", buttons: [[{ label: "취소", act: { a: "cancel" } }]] });
      case "schedules": return show(this.schedulesScreen(binding));
      case "usage": return show(this.usageScreen());
      case "notify": {
        if (act.workId) this.toggleNotify(binding, act.workId);
        return show(this.notifyScreen(binding));
      }
      case "schedule-on": {
        const mine = this.manager.schedules.all().find((entry) => entry.id === act.scheduleId && entry.origin?.bindingId === binding.id);
        let note = "그 예약을 찾지 못했습니다.";
        if (mine) {
          try {
            this.manager.schedules.update(mine.id, { enabled: true });
            const fresh = this.fresh(binding);
            const off = Array.isArray(fresh.prefs.schedulesOff) ? (fresh.prefs.schedulesOff as string[]).filter((id) => id !== mine.id) : [];
            this.core.channels.updateBinding(binding.id, { prefs: { ...fresh.prefs, schedulesOff: off } });
            this.core.audit(binding, "schedule.enabled", { result: "1" });
            note = "다시 켰습니다.";
          } catch (error) {
            note = `켜지 못했습니다: ${this.core.clean(error)}`;
          }
        }
        return show(this.schedulesScreen(binding, note));
      }
      case "run-schedule": {
        const schedule = this.manager.schedules.all().find((entry) => entry.id === act.scheduleId && entry.origin?.bindingId === binding.id);
        if (!schedule) return show({ text: "그 예약을 찾지 못했습니다.", buttons: [[BACK]] });
        this.core.runNow(adapter, binding, chat, eventId, schedule.sessionId, schedule.text);
        return;
      }
      case "schedules-on": {
        const on = this.core.enableSchedules(binding);
        return show({ text: on ? `예약 ${on}개를 다시 켰습니다.` : "다시 켤 예약이 없습니다.", buttons: [[{ label: "예약 목록", act: { a: "schedules" } }, BACK]] });
      }
      case "lock": {
        if (messageId) await this.core.show(adapter, binding, messageId, { text: "채널을 잠급니다." });
        return this.core.lock(binding, chat, eventId);
      }
      case "cancel":
        this.clear(binding);
        return show({ text: "취소했습니다.", buttons: [[BACK]] });
      case "footer":
        this.core.setFooter(binding, !this.core.footerOn(this.fresh(binding)));
        return show(this.notifyScreen(binding));
      case "compact": return show(this.statusScreen(binding, await this.core.compact(binding)));
      case "rename": {
        const session = this.pointer(binding);
        if (!session || session.archivedAt) return show(this.statusScreen(binding, "보관한 대화라 이름을 바꿀 수 없습니다."));
        this.await(binding, { kind: "rename", sessionId: session.id }, messageId);
        return show(this.renamePrompt(session));
      }
    }
  }

  // Conversations and projects

  private sessionsScreen(binding: Binding, workId?: string, move?: string): Screen {
    const work = workId ? this.manager.view.works.get(workId) : this.work(binding);
    if (!work || this.core.hidden(work)) return { text: "고를 프로젝트가 없습니다.", buttons: [[{ label: "프로젝트 바꾸기", act: { a: "works", ...(move ? { move } : {}) } }, BACK]] };
    const current = this.fresh(binding).pointerSessionId, now = this.core.now();
    const rows: MenuButton[][] = sessionsOf(this.manager, work.id).slice(0, 6).map((session) => [{
      label: `${session.id === current ? "✓ " : ""}${this.clip(session.purpose, 20)} · ${ago(session.updatedAt, now)}`,
      act: { a: "pick", sessionId: session.id, ...(move ? { move } : {}) },
    }]);
    rows.push([{ label: "이 프로젝트에 새 대화", act: { a: "newin", workId: work.id, ...(move ? { move } : {}) } }]);
    rows.push([{ label: "다른 프로젝트…", act: { a: "works", ...(move ? { move } : {}) } }, BACK]);
    return { text: `「${work.title}」의 최근 대화${move ? "\n보낼 대화를 고르세요." : ""}`, buttons: rows };
  }

  private worksScreen(binding: Binding, move?: string): Screen {
    const current = this.work(binding)?.id;
    const works = [...this.manager.view.works.values()].filter((work) => !this.core.hidden(work)).sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt).slice(0, 6);
    const rows: MenuButton[][] = works.map((work) => [{ label: `${work.id === current ? "✓ " : ""}${this.clip(work.title, 24)}`, act: { a: "sessions", workId: work.id, ...(move ? { move } : {}) } }]);
    if (!move) rows.push([{ label: "새 프로젝트", act: { a: "newwork" } }]);
    rows.push([BACK]);
    return { text: works.length ? "어느 프로젝트로 갈까요?" : "프로젝트가 없습니다.", buttons: rows };
  }

  private async pick(adapter: ChannelAdapter, binding: Binding, chat: ChatRef, sessionId: string, move?: string): Promise<Screen> {
    let next: Binding;
    try {
      next = this.core.setPointer(binding.id, sessionId);
    } catch (error) {
      return { text: error instanceof HttpError && error.code === "archived" ? "보관한 대화라 옮길 수 없습니다. 다른 대화를 골라 주세요." : "그 대화를 찾지 못했습니다.", buttons: [[{ label: "대화 바꾸기", act: { a: "sessions", ...(move ? { move } : {}) } }, BACK]] };
    }
    const session = this.manager.view.sessions.get(sessionId)!;
    this.core.audit(next, "pointer", { sessionId });
    if (move) await this.core.moveParked(adapter, next, chat, move, sessionId);
    const strict = this.core.strictNote(next, session);
    const text = `이제 「${session.purpose}」로 보냅니다 (${this.settings(session)}).`;
    if (strict) return { text: `${text}\n이 대화는 '${MODE_LABEL[this.manager.accessOf(session)]}' 모드라 중간에 확인 요청이 올 수 있습니다.`, buttons: [...strict, [BACK]], strict: session.id };
    return { text, buttons: [[BACK]] };
  }

  private settings(session: Session) {
    return [PROVIDER_LABEL[session.provider], session.model, session.effort ? `노력 ${EFFORT_LABEL[session.effort] ?? session.effort}` : null, ACCESS_LABEL[this.manager.accessOf(session)]].filter(Boolean).join(" · ");
  }

  // Engine, model, effort, access

  private engineScreen(binding: Binding, note?: string): Screen {
    const session = this.pointer(binding);
    if (!session) return { text: `${note ? `${note}\n` : ""}아직 대화가 없습니다. 적어 보내면 새 대화가 생깁니다.`, buttons: [[BACK]] };
    const status = this.manager.snapshot().providers.find((entry) => entry.provider === session.provider);
    const mark = (on: boolean, label: string) => `${on ? "✓ " : ""}${label}`;
    const rows: MenuButton[][] = [(["claude", "codex"] as const).map((provider) => ({ label: mark(session.provider === provider, PROVIDER_LABEL[provider]), act: { a: "provider", provider } }))];
    const models = status?.models ?? [];
    const options: { id: string | null; label: string }[] = [{ id: null, label: "기본" }, ...models.slice(0, 5).map((model) => ({ id: model.id, label: model.label }))];
    for (let index = 0; index < options.length; index += 3) rows.push(options.slice(index, index + 3).map((option) => ({ label: mark(session.model === option.id, `모델: ${cutAt(option.label, 14)}`), act: { a: "model", model: option.id } })));
    const model = models.find((entry) => entry.id === session.model) ?? models.find((entry) => entry.isDefault) ?? models[0];
    const efforts = [null, ...(model?.efforts ?? []).slice(0, 5)];
    if (efforts.length > 1) for (let index = 0; index < efforts.length; index += 3) rows.push(efforts.slice(index, index + 3).map((effort) => ({ label: mark(session.effort === effort, `노력: ${effort ? EFFORT_LABEL[effort] ?? effort : "기본"}`), act: { a: "effort", effort } })));
    const access = this.manager.accessOf(session);
    rows.push(...(["ask", "auto", "full"] as const).map((mode): MenuButton[] => [{ label: mark(access === mode && session.access === mode, MODE_LABEL[mode]), act: { a: "access", access: mode } }]));
    rows.push([BACK]);
    return { text: `${note ? `${note}\n\n` : ""}지금: ${this.settings(session)}\n「${session.purpose}」`, buttons: rows };
  }

  /** The engine is fixed per conversation (as at the PC): another engine is a new conversation. */
  private provider(binding: Binding, provider: Provider): string {
    const session = this.pointer(binding);
    if (!session) return "아직 대화가 없습니다.";
    if (session.provider === provider) return `이미 ${PROVIDER_LABEL[provider]} 대화입니다.`;
    const installed = this.manager.snapshot().providers.find((entry) => entry.provider === provider)?.installed;
    if (!installed) return `${PROVIDER_LABEL[provider]}가 이 PC에 설치되어 있지 않습니다.`;
    let next: Session;
    try {
      if (session.documentAgent) {
        next = this.manager.documentSession(session.documentAgent.artifactId, session.documentAgent.parentSessionId, false, provider);
        this.core.setPointer(binding.id, next.id);
      } else {
        const work = this.manager.view.works.get(session.workId);
        if (!work || this.core.hidden(work)) return "보관한 프로젝트라 새 대화를 만들 수 없습니다.";
        next = this.core.conversationIn(binding, work, provider);
      }
    } catch (error) {
      return `바꾸지 못했습니다: ${this.core.clean(error)}`;
    }
    this.core.audit(binding, "engine", { sessionId: next.id, result: provider });
    return `이 대화를 ${PROVIDER_LABEL[provider]}로 바꿀 수 없어 ${PROVIDER_LABEL[provider]}로 새 대화를 만들었습니다: 「${next.purpose}」.`;
  }

  private setting(binding: Binding, act: Extract<MenuAct, { a: "model" | "effort" | "access" }>): string {
    const session = this.pointer(binding);
    if (!session) return "아직 대화가 없습니다.";
    if (session.archivedAt) return "보관한 대화는 바꿀 수 없습니다.";
    try {
      if (act.a === "model") this.manager.updateSession(session.id, { model: act.model });
      else if (act.a === "effort") this.manager.updateSession(session.id, { effort: act.effort });
      else if (isAccessMode(act.access)) this.manager.updateSession(session.id, { access: act.access });
    } catch (error) {
      return `바꾸지 못했습니다: ${this.core.clean(error)}`;
    }
    this.core.audit(binding, act.a, { sessionId: session.id, result: act.a === "model" ? act.model ?? "default" : act.a === "effort" ? act.effort ?? "default" : act.access });
    // A new access mode reaches a running engine at once (Claude; Codex when it goes to full access);
    // a running Codex turn keeps its policy otherwise; a model or effort, the next turn.
    const running = session.status !== "idle" && session.status !== "error";
    if (act.a === "access" && session.provider === "codex" && running && act.access !== "full") return "바꿨습니다. 다음 요청부터 적용합니다(지금 하던 일은 그대로).";
    return act.a === "access" ? "바꿨습니다. 지금부터 적용합니다." : "바꿨습니다. 다음 요청부터 적용합니다.";
  }

  // What runs and waits

  statusScreen(binding: Binding, note?: string): Screen {
    const session = this.pointer(binding);
    const queued = session && !session.archivedAt ? session.queued : [];
    const lines = [this.core.statusText(this.fresh(binding))];
    queued.slice(0, 5).forEach((entry, index) => lines.push(`${index + 1}. ${this.clip(entry.text.replace(/\s+/g, " "), 60)}${entry.held ? " (남겨 둠)" : ""}`));
    const rows: MenuButton[][] = queued.slice(0, 5).map((entry, index) => [
      { label: `${index + 1} 지금 보내기`, act: { a: "q-send", sessionId: session!.id, queuedId: entry.id } },
      { label: `${index + 1} 빼기`, act: { a: "q-drop", sessionId: session!.id, queuedId: entry.id } },
    ]);
    if (session && !session.archivedAt) rows.push([{ label: "이름 바꾸기", act: { a: "rename" } }, { label: "맥락 줄이기", act: { a: "compact" } }]);
    rows.push([BACK]);
    return { text: `${note ? `${note}\n\n` : ""}${lines.join("\n")}`, buttons: rows };
  }

  /** "지금 보내기": the desktop's own guarded send of a waiting request (it leaves the queue only when its user item is written). */
  private async sendQueued(binding: Binding, sessionId: string, queuedId: string): Promise<string> {
    if (!this.core.admitted()) return "PC가 업데이트를 준비하고 있어 지금은 새 일을 시작하지 않습니다.";
    try {
      const result = await this.manager.sendQueued(sessionId, queuedId);
      this.core.audit(binding, "queue.send", { sessionId, result: result.delivery });
      return result.delivery === "queued" ? "지금 일이 끝나면 바로 보냅니다." : "보냈습니다.";
    } catch (error) {
      const code = error instanceof HttpError ? error.code : "failed";
      this.core.audit(binding, "refused", { sessionId, result: `queue.${code}` });
      if (code === "queued_not_found" || code === "queued_changed") return "이미 보냈거나 빠진 요청입니다.";
      if (code === "archived") return "보관한 대화라 보내지 않았습니다.";
      if (code === "document_removed") return "문서를 지운 문서 AI라 보내지 않았습니다.";
      return `보내지 못했습니다: ${this.core.clean(error)}`;
    }
  }

  /** "빼기": the desktop's own removal of a waiting request (it was never sent). */
  private dropQueued(binding: Binding, sessionId: string, queuedId: string): string {
    const session = this.manager.view.sessions.get(sessionId);
    if (!session?.queued.some((entry) => entry.id === queuedId)) return "이미 보냈거나 빠진 요청입니다.";
    this.manager.cancelQueued(sessionId, queuedId);
    this.core.audit(binding, "queue.drop", { sessionId });
    return "대기열에서 뺐습니다.";
  }

  // Files and a document's AI

  private documents(workId: string): Artifact[] {
    return this.manager.documents.list().filter((artifact) => artifact.workId === workId && !artifact.removed && artifact.role !== "project-note").sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private filesScreen(binding: Binding): Screen {
    const work = this.work(binding);
    const files = work ? this.documents(work.id).slice(0, 6) : [];
    if (!work || !files.length) return { text: work ? `「${work.title}」에 아직 파일이 없습니다.` : "프로젝트가 없습니다.", buttons: [[BACK]] };
    return { text: `「${work.title}」의 최근 파일`, buttons: [...files.map((file): MenuButton[] => [{ label: this.clip(file.name, 28), act: { a: "doc", artifactId: file.id } }]), [BACK]] };
  }

  /** 받기 (the file itself) and 1쪽 보기 (its first page, for Office and HWPX documents): sent by the core under the block list. */
  private docButtons(artifact: Artifact): MenuButton[] {
    return [{ label: "받기", kind: "file-get", data: { artifactId: artifact.id } }, ...(previewed(artifact) ? [{ label: "1쪽 보기", kind: "file-page", data: { artifactId: artifact.id } }] : [])];
  }

  private docScreen(artifactId: string): Screen {
    const artifact = this.manager.documents.list().find((entry) => entry.id === artifactId && !entry.removed);
    if (!artifact) return { text: "그 파일을 찾지 못했습니다.", buttons: [[{ label: "← 최근 파일", act: { a: "files" } }]] };
    return {
      text: `「${artifact.name}」 · ${ago(artifact.updatedAt, this.core.now())} 수정`,
      buttons: [[...this.docButtons(artifact), { label: "이 문서의 AI에게", act: { a: "doc-ai", artifactId } }], [{ label: "← 최근 파일", act: { a: "files" } }, BACK]],
    };
  }

  /** "이 문서의 AI에게": the document's own child conversation (made by `documentSession` as at the PC), and the chat moves to it. */
  private documentAi(binding: Binding, artifactId: string): Screen {
    const artifact = this.manager.documents.list().find((entry) => entry.id === artifactId && !entry.removed);
    if (!artifact) return { text: "그 파일을 찾지 못했습니다.", buttons: [[BACK]] };
    const pointer = this.pointer(binding);
    const parent = pointer && !pointer.documentAgent && !pointer.pageAgent && pointer.workId === artifact.workId ? pointer.id : null;
    let session: Session;
    try {
      try {
        session = this.manager.documentSession(artifactId, parent, false);
      } catch (error) {
        // The chat's conversation is in another workspace of the project: the document's own default parent.
        if (!(error instanceof HttpError && error.code === "document_session_scope") || !parent) throw error;
        session = this.manager.documentSession(artifactId, null, false);
      }
      this.core.setPointer(binding.id, session.id);
    } catch (error) {
      return { text: `문서 AI로 옮기지 못했습니다: ${this.core.clean(error)}`, buttons: [[BACK]] };
    }
    this.core.audit(binding, "pointer", { sessionId: session.id, target: "document" });
    const strict = this.core.strictNote(this.fresh(binding), session);
    const text = `이제 「${artifact.name.replace(/\.[^.]+$/, "")}」의 AI에게 보냅니다 (${this.settings(session)}).`;
    return strict ? { text: `${text}\n이 대화는 '${MODE_LABEL[this.manager.accessOf(session)]}' 모드라 중간에 확인 요청이 올 수 있습니다.`, buttons: [...strict, [BACK]], strict: session.id } : { text, buttons: [[BACK]] };
  }

  // The project note

  private noteScreen(binding: Binding): Screen {
    const projects = this.core.projects(), work = this.work(binding);
    if (!projects || !work) return { text: projects ? "프로젝트가 없습니다." : "프로젝트 노트는 지금 쓸 수 없습니다.", buttons: [[BACK]] };
    const note = projects.note(work, true);
    const base = note.revision;
    const lines = [`「${work.title}」 노트`];
    if (!note.exists) lines.push("아직 노트가 없습니다. 결정이나 질문을 적으면 노트가 생깁니다.");
    else if (note.problem) lines.push(`노트의 속성 부분이 망가져 있어 여기서는 고치지 않습니다. PC에서 확인해 주세요.`);
    else {
      if (note.stage) lines.push(`단계: ${note.stage}`);
      const decisions = note.decisions.slice(-3), open = note.questions.filter((entry) => !entry.done).slice(-3);
      if (decisions.length) lines.push("결정", ...decisions.map((entry) => `· ${this.clip(entry.text, 120)}`));
      if (open.length) lines.push("열린 질문", ...open.map((entry) => `· ${this.clip(entry.text, 120)}`));
      const shown = note.properties.filter(([key]) => key !== "단계" && key !== "stage").slice(0, 5);
      if (shown.length) lines.push(`속성: ${shown.map(([key, values]) => `${key}: ${this.clip((values ?? []).join(", ") || "값 없음", 40)}`).join(" · ")}`);
    }
    const rows: MenuButton[][] = note.problem ? [[BACK]] : [
      [{ label: "결정 추가", act: { a: "note-add", workId: work.id, section: "decision", base } }, { label: "질문 추가", act: { a: "note-add", workId: work.id, section: "question", base } }],
      [{ label: "속성 바꾸기", act: { a: "note-props", workId: work.id } }, BACK],
    ];
    return { text: cutAt(lines.join("\n"), 1500), buttons: rows };
  }

  private propsScreen(workId: string): Screen {
    const projects = this.core.projects();
    const page = projects?.page(workId);
    if (!page || page.note.problem) return { text: "노트의 속성을 지금은 바꿀 수 없습니다.", buttons: [[BACK]] };
    const base = page.note.revision;
    // What the note has first, then the template's empty ones.
    const rows = (page.rows ?? []).filter((row) => row.editable !== false).sort((a, b) => Number(b.present) - Number(a.present)).slice(0, 8);
    if (!rows.length) return { text: "바꿀 수 있는 속성이 없습니다.", buttons: [[{ label: "← 노트", act: { a: "note" } }, BACK]] };
    return {
      text: "어느 속성을 바꿀까요?",
      buttons: [...rows.map((row): MenuButton[] => [{ label: this.clip(`${row.key}: ${(row.values ?? []).join(", ") || "값 없음"}`, 30), act: { a: "note-prop", workId, key: row.key, base } }]), [{ label: "← 노트", act: { a: "note" } }, BACK]],
    };
  }

  /**
   * A decision or an open question for the note, through the note's own guarded write: one line,
   * with the revision the person saw (`base`); "current" when they saw none (a plain sentence, or
   * their own choice after a conflict). A stale base is refused and asked once, the words kept.
   */
  noteWrite(binding: Binding, workId: string, section: "decision" | "question", text: string, base: number | null | "current"): Screen {
    const projects = this.core.projects(), work = this.manager.view.works.get(workId);
    if (!projects || !work) return { text: "프로젝트 노트에 적지 못했습니다.", buttons: [[BACK]] };
    try {
      const revision = base === "current" ? projects.note(work, true).revision : base;
      projects.addEntry(workId, { section, text, sessionId: this.fresh(binding).pointerSessionId, itemId: null, baseRevision: revision });
    } catch (error) {
      if (error instanceof HttpError && error.code === "note_changed") {
        this.core.audit(binding, "note.conflict", { target: `work:${workId}` });
        return {
          text: `노트가 그사이 바뀌어 적지 않았습니다.\n적으려던 말: “${this.clip(text, 400)}”`,
          buttons: [[{ label: "지금 노트에 적기", act: { a: "note-retry", workId, section, text } }, { label: "그만두기", act: { a: "note-drop" } }]],
        };
      }
      return { text: `노트에 적지 못했습니다: ${this.core.clean(error)}`, buttons: [[BACK]] };
    }
    this.core.audit(binding, "note.entry", { target: `work:${workId}`, result: section });
    return { text: `「${work.title}」 노트 '${SECTION_LABEL[section]}'에 추가했습니다.` };
  }

  private noteProperty(binding: Binding, input: Extract<Awaiting, { kind: "note-prop" }>, value: string): Screen {
    const projects = this.core.projects();
    if (!projects) return { text: "프로젝트 노트에 적지 못했습니다." };
    try {
      const written = input.list
        ? projects.setProperty(input.workId, input.key, null, null, undefined, input.base, { add: value })
        : projects.setProperty(input.workId, input.key, [value], null, undefined, input.base);
      this.core.audit(binding, "note.property", { target: `work:${input.workId}`, result: input.key });
      return { text: `노트를 고쳤습니다: ${this.clip(written.summary, 300)}` };
    } catch (error) {
      if (error instanceof HttpError && error.code === "note_changed") {
        this.core.audit(binding, "note.conflict", { target: `work:${input.workId}` });
        return { text: `노트가 그사이 바뀌어 고치지 않았습니다. 넣으려던 값: “${this.clip(value, 200)}”`, buttons: [[{ label: "노트 다시 보기", act: { a: "note" } }, { label: "그만두기", act: { a: "note-drop" } }]] };
      }
      return { text: `노트를 고치지 못했습니다: ${this.core.clean(error)}` };
    }
  }

  // Search

  private async find(query: string): Promise<Screen> {
    let page: SearchPage;
    try {
      page = await this.core.search(query);
    } catch (error) {
      return { text: `찾지 못했습니다: ${this.core.clean(error)}`, buttons: [[BACK]] };
    }
    const list: Hit[] = page.groups.flatMap((group) => group.hits).slice(0, 6).map((hit) => ({
      kind: hit.kind, title: this.clip(hit.title || "제목 없음", 40), snippet: this.clip(hit.snippet.replace(/\s+/g, " "), 300), sessionId: hit.sessionId, artifactId: hit.artifactId,
    }));
    return this.resultsScreen(this.core.scrub(query), list, page.total);
  }

  private resultsScreen(query: string, list: Hit[], total = list.length): Screen {
    if (!list.length) return { text: `찾은 것이 없습니다: “${this.clip(query, 60)}”`, buttons: [[{ label: "다시 찾기", act: { a: "search" } }, BACK]] };
    return {
      text: `${total}건 · “${this.clip(query, 60)}”`,
      buttons: [...list.map((hit): MenuButton[] => [{ label: `${cutAt(hit.title, 20)} · ${SEARCH_KIND_LABEL[hit.kind as keyof typeof SEARCH_KIND_LABEL] ?? hit.kind}`, act: { a: "hit", hit, list, query } }]), [{ label: "다시 찾기", act: { a: "search" } }, BACK]],
    };
  }

  private hitScreen(hit: Hit, list: Hit[], query: string): Screen {
    const session = hit.sessionId ? this.manager.view.sessions.get(hit.sessionId) : undefined;
    const row: MenuButton[] = [];
    if (session && !session.archivedAt) row.push({ label: "이 대화로 보내기", act: { a: "pick", sessionId: session.id } });
    if (hit.artifactId) row.push({ label: "이 문서의 AI에게", act: { a: "doc-ai", artifactId: hit.artifactId } });
    return { text: `${hit.title} · ${SEARCH_KIND_LABEL[hit.kind as keyof typeof SEARCH_KIND_LABEL] ?? hit.kind}\n“${hit.snippet}”`, buttons: [...(row.length ? [row] : []), [{ label: "← 찾은 목록", act: { a: "results", list, query } }, BACK]] };
  }

  // Schedules

  private scheduleScreen(binding: Binding): Screen {
    const now = this.core.now();
    const at = (days: number, hours: number) => { const date = new Date(now); date.setDate(date.getDate() + days); date.setHours(hours, 0, 0, 0); return date.getTime(); };
    const evening = at(0, 18) > now ? { when: { kind: "once", at: at(0, 18) } as ScheduleWhen, label: "오늘 18:00" } : { when: { kind: "once", at: at(1, 18) } as ScheduleWhen, label: "내일 18:00" };
    const options = [evening, { when: { kind: "once", at: at(1, 8) } as ScheduleWhen, label: "내일 08:00" }, { when: { kind: "daily", time: "09:00" } as ScheduleWhen, label: "매일 09:00" }];
    const session = this.pointer(binding);
    return {
      text: `언제 할까요?${session ? ` (「${session.purpose}」에서)` : ""}`,
      buttons: [options.map((option) => ({ label: option.label, act: { a: "when", when: option.when, label: option.label }, ttl: TIME_BUTTON_TTL })), [{ label: "직접 적기", act: { a: "when-typed" } }, { label: "예약 목록", act: { a: "schedules" } }], [BACK]],
    };
  }

  private whenLabel(when: ScheduleWhen) {
    if (when.kind === "daily") return `매일 ${when.time}`;
    if (when.kind === "every") return `${when.hours}시간마다`;
    const date = new Date(when.at);
    return `${date.getMonth() + 1}/${date.getDate()} ${hhmm(when.at)}`;
  }

  /** A schedule's state in words: 끝남, 잠금으로 꺼짐, 연결 끊어 꺼짐, 꺼짐, else when it goes next. */
  private stateOf(schedule: Schedule): { word: string; mayTurnOn: boolean } {
    if (schedule.enabled) return { word: schedule.nextAt ? `다음 ${this.whenLabel({ kind: "once", at: schedule.nextAt })}` : "끝남", mayTurnOn: false };
    const ended = schedule.nextAt === null || (schedule.policy?.expiresAt ?? Infinity) <= this.core.now() || Boolean(schedule.policy?.maxRuns && (schedule.runCount ?? 0) >= schedule.policy.maxRuns);
    if (ended) return { word: "끝남", mayTurnOn: false };
    if (schedule.offReason === "locked") return { word: "잠금으로 꺼짐", mayTurnOn: true };
    if (schedule.offReason === "disconnected") return { word: "연결 끊어 꺼짐", mayTurnOn: false };
    return { word: "꺼짐", mayTurnOn: true };
  }

  private schedulesScreen(binding: Binding, note?: string): Screen {
    const pointer = this.fresh(binding).pointerSessionId;
    const mine = this.manager.schedules.all().filter((schedule) => schedule.origin?.bindingId === binding.id || schedule.sessionId === pointer).slice(-8);
    if (!mine.length) return { text: `${note ? `${note}\n\n` : ""}예약이 없습니다.`, buttons: [[{ label: "예약하기", act: { a: "schedule" } }, BACK]] };
    const rows: MenuButton[][] = [];
    const lines = mine.map((schedule, index) => {
      const session = this.manager.view.sessions.get(schedule.sessionId);
      const state = this.stateOf(schedule);
      // Only the chat's own schedules are turned on from here.
      if (state.mayTurnOn && schedule.origin?.bindingId === binding.id) rows.push([{ label: `${index + 1} 켜기`, act: { a: "schedule-on", scheduleId: schedule.id } }]);
      return `${index + 1}. ${this.whenLabel(schedule.when)} 「${session?.purpose ?? "?"}」: ${this.clip(schedule.text.replace(/\s+/g, " "), 40)} · ${state.word}`;
    });
    return { text: `${note ? `${note}\n\n` : ""}예약 ${mine.length}개\n${lines.join("\n")}`, buttons: [...rows, [{ label: "예약하기", act: { a: "schedule" } }, BACK]] };
  }

  /** Resumed after a pause: the schedules that came due meanwhile, each with [지금 실행] (its own set: one press runs one). */
  async offerSkipped(adapter: ChannelAdapter, binding: Binding, ids: string[], key: string) {
    const skipped = ids.flatMap((id) => this.manager.schedules.all().filter((schedule) => schedule.id === id));
    if (!skipped.length) return;
    const named = skipped.slice(0, SKIPPED_NAMED);
    const lines = named.map((schedule, index) => `${index + 1}. ${this.whenLabel(schedule.when)} 「${this.manager.view.sessions.get(schedule.sessionId)?.purpose ?? "?"}」: ${this.clip(schedule.text.replace(/\s+/g, " "), 60)}`);
    if (skipped.length > named.length) lines.push(`그 밖 ${skipped.length - named.length}개는 메뉴의 [예약] → [예약 목록]에서 볼 수 있습니다.`);
    await this.core.send(adapter, binding, key, {
      text: `멈춰 둔 동안 예약 ${skipped.length}개가 실행되지 않았습니다.\n${lines.join("\n")}`,
      buttons: named.map((schedule, index): MenuButton[] => [{ label: `${index + 1} 지금 실행`, act: { a: "run-schedule", scheduleId: schedule.id }, set: `run:${schedule.id}` }]),
    });
  }

  /** A schedule through the desktop's own `Schedules.create`, marked with this chat: its result comes back here. */
  private schedule(binding: Binding, when: ScheduleWhen, label: string, text: string): Screen {
    const session = this.core.target(binding);
    if (!session) return { text: "보관한 대화에는 예약할 수 없습니다. 먼저 대화를 바꿔 주세요.", buttons: [[{ label: "대화 바꾸기", act: { a: "sessions" } }, BACK]] };
    try {
      this.manager.schedules.create({ sessionId: session.id, text, when }, { channel: binding.kind, bindingId: binding.id });
    } catch (error) {
      return { text: `예약하지 못했습니다: ${this.core.clean(error)}\n적으려던 내용: “${text}”`, buttons: [[{ label: "예약", act: { a: "schedule" } }, BACK]] };
    }
    this.core.audit(binding, "schedule", { sessionId: session.id, result: when.kind });
    return { text: `예약했습니다: ${label} 「${session.purpose}」에서.`, buttons: [[{ label: "예약 목록", act: { a: "schedules" } }]] };
  }

  // Usage, notifications

  private usageScreen(): Screen {
    const now = this.core.now();
    const lines: string[] = [];
    for (const status of this.manager.snapshot().providers.filter((entry) => entry.installed)) {
      lines.push(`${PROVIDER_LABEL[status.provider]}${status.plan ? ` · ${status.plan}` : ""}`);
      if (!status.usage.length) lines.push("· 사용량 정보가 아직 없습니다");
      for (const window of status.usage) lines.push(`· ${window.label}: ${window.usedPercent === null ? "알 수 없음" : `${Math.round(window.usedPercent)}% 사용`}${window.resetsAt ? ` · ${window.resetsAt - now < 86_400_000 ? hhmm(window.resetsAt) : `${new Date(window.resetsAt).getMonth() + 1}/${new Date(window.resetsAt).getDate()}`} 초기화` : ""}`);
      if (status.usageObservedAt) lines.push(`  (${ago(status.usageObservedAt, now)} 기준)`);
    }
    return { text: lines.length ? lines.join("\n") : "설치된 엔진이 없습니다.", buttons: [[BACK]] };
  }

  /** Projects whose desktop work is told to this chat when it ends or asks (off for every project by default). */
  notified(binding: Binding): string[] {
    const list = this.fresh(binding).prefs.notify;
    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
  }

  private toggleNotify(binding: Binding, workId: string) {
    const list = this.notified(binding);
    const next = list.includes(workId) ? list.filter((entry) => entry !== workId) : [...list, workId];
    this.core.channels.updateBinding(binding.id, { prefs: { ...this.fresh(binding).prefs, notify: next } });
    this.core.audit(binding, "notify", { target: `work:${workId}`, result: next.includes(workId) ? "on" : "off" });
  }

  private notifyScreen(binding: Binding): Screen {
    const on = new Set(this.notified(binding));
    const works = [...this.manager.view.works.values()].filter((work) => !this.core.hidden(work)).sort((a, b) => Number(on.has(b.id)) - Number(on.has(a.id)) || b.updatedAt - a.updatedAt).slice(0, 8);
    return {
      text: "PC에서 시킨 일이 끝나거나 확인을 기다리면 이 채팅으로 알릴 프로젝트를 고르세요. 휴대폰에서 시킨 일의 답은 언제나 옵니다.",
      buttons: [...works.map((work): MenuButton[] => [{ label: `${on.has(work.id) ? "켜짐" : "꺼짐"} · ${this.clip(work.title, 22)}`, act: { a: "notify", workId: work.id } }]),
        [{ label: `${this.core.footerOn(this.fresh(binding)) ? "켜짐" : "꺼짐"} · 답 아래 꼬리말(모델·시간·맥락)`, act: { a: "footer" } }], [BACK]],
    };
  }

  // The line the person was asked for

  /**
   * A line that answers the input a menu opened. Returns false when the line goes to the AI as
   * usual: nothing was awaited; the input ran out (said); a line with files came instead (the
   * input closes); or the line does not fit a name or a search (said, the input closes). A line
   * too long for the note is refused with the limit and the input stays open: nothing is cut.
   */
  async take(adapter: ChannelAdapter, binding: Binding, event: Extract<Inbound, { type: "message" }>): Promise<boolean> {
    const stored = this.stored(binding);
    if (!stored) return false;
    if (event.files.length) { this.clear(binding); return false; }
    // Acted on already when the gateway stopped: at most once, and never to the AI after.
    if (stored.taking === event.eventId) {
      this.clear(binding);
      await this.core.send(adapter, binding, `input:${binding.kind}:${binding.botId}:${event.eventId}:stopped`, { text: "앞의 입력을 처리하는 중에 PC가 멈췄습니다. 처리되지 않았을 수 있으니, 결과가 없으면 다시 보내 주세요." });
      return true;
    }
    const key = `input:${binding.kind}:${binding.botId}:${event.eventId}`;
    const send = (screen: Screen) => this.core.send(adapter, binding, key, screen);
    const text = event.text.trim();
    if (!text) return false;
    if (stored.until <= this.core.now()) {
      this.clear(binding);
      // Said only when the line comes soon after; much later it is simply a line.
      if (this.core.now() - stored.until <= EXPIRED_MENTION) await send({ text: `${INPUT_NAME[stored.kind]}은 시간이 지나 닫혔습니다. 이 글은 AI에게 보냈습니다.` });
      return false;
    }
    const oneLine = !/\n/.test(text);
    // What does not fit a name or a search is refused with the limit, and the input stays open: a
    // wrong paste never becomes a request to the full-access AI.
    if (stored.kind === "search" && (!oneLine || text.length > QUERY_LIMIT)) {
      await send({ text: `찾을 말은 한 줄로 ${QUERY_LIMIT}자까지입니다(지금 ${text.length}자). 찾지 않았습니다. 짧게 다시 보내거나 [취소]를 누르세요.`, buttons: [[{ label: "취소", act: { a: "cancel" } }]] });
      return true;
    }
    if (stored.kind === "rename" && (!oneLine || text.length > NAME_LIMIT)) {
      await send({ text: `대화 이름은 한 줄로 ${NAME_LIMIT}자까지입니다(지금 ${text.length}자). 바꾸지 않았습니다. 짧게 다시 보내거나 [취소]를 누르세요.`, buttons: [[{ label: "취소", act: { a: "cancel" } }]] });
      return true;
    }
    if (stored.kind === "work-title" && (!oneLine || text.length > TITLE_LIMIT)) {
      await send({ text: `프로젝트 이름은 한 줄로 ${TITLE_LIMIT}자까지입니다(지금 ${text.length}자). 만들지 않았습니다. 짧게 다시 보내거나 [취소]를 누르세요.`, buttons: [[{ label: "취소", act: { a: "cancel" } }]] });
      return true;
    }
    const refuse = stored.kind === "note-entry" ? tooLongForNote(text)
      : stored.kind === "note-prop" && text.length > NOTE_LIMIT ? `노트의 속성 값은 ${NOTE_LIMIT}자까지입니다(지금 ${text.length}자). 고치지 않았습니다. 줄여서 다시 보내 주세요.`
        : stored.kind === "schedule-text" && text.length > SCHEDULE_LIMIT ? `예약할 내용은 ${SCHEDULE_LIMIT}자까지입니다(지금 ${text.length}자). 예약하지 않았습니다. 줄여서 다시 보내 주세요.`
          : null;
    if (refuse) {
      // The input stays open for the shorter line.
      await send({ text: refuse });
      return true;
    }
    if (/매주|[월화수목금토일]요일|^매(주|週)/.test(text) && stored.kind === "schedule-time") {
      await send({ text: "매주 예약은 아직 없습니다. 매일 또는 날짜로 적어 주세요. 예: 매일 9:00 · 11/20 9:00" });
      return true;
    }
    // Marked before acting: a stop in the middle does not turn the line into a request afterwards.
    this.core.channels.updateBinding(binding.id, { prefs: { ...this.fresh(binding).prefs, awaiting: { ...stored, taking: event.eventId } } });
    // The prompt is answered: its 취소 goes.
    if (stored.messageId) await this.core.show(adapter, binding, stored.messageId, { text: "받았습니다." });
    let next: { awaiting: Awaiting; messageId: string | null } | null = null;
    switch (stored.kind) {
      case "search": await send(await this.find(text)); break;
      case "work-title": {
        const work = this.manager.createWork({ title: text.replace(/\s+/g, " "), titleSource: "user" });
        const session = this.core.conversationIn(binding, work);
        this.core.audit(binding, "work.created", { sessionId: session.id, target: `work:${work.id}` });
        await send({ text: `「${work.title}」 프로젝트를 만들고 새 대화로 옮겼습니다: ${this.core.label(session)}` });
        break;
      }
      case "note-entry": await send(this.noteWrite(binding, stored.workId, stored.section, text, stored.base)); break;
      case "note-prop": await send(this.noteProperty(binding, stored, text)); break;
      case "schedule-time": {
        const parsed = parseWhen(text, this.core.now());
        if (!parsed) {
          const id = await send({ text: "시각을 알아보지 못했습니다. 예: 18:30 · 내일 9:00 · 11/20 14:00 · 매일 7:30", buttons: [[{ label: "취소", act: { a: "cancel" } }]] });
          next = { awaiting: { kind: "schedule-time" }, messageId: id };
          break;
        }
        const id = await send({ text: `무엇을 할까요? (${parsed.label} 예약)`, buttons: [[{ label: "취소", act: { a: "cancel" } }]] });
        next = { awaiting: { kind: "schedule-text", when: parsed.when, label: parsed.label }, messageId: id };
        break;
      }
      case "schedule-text": await send(this.schedule(binding, stored.when, stored.label, text)); break;
      case "rename": {
        const renamed = this.core.rename(stored.sessionId, text.replace(/\s+/g, " "));
        if (renamed.ok) this.core.audit(binding, "rename", { sessionId: stored.sessionId });
        await send({ text: renamed.ok ? `대화 이름을 「${renamed.name}」(으)로 바꿨습니다.` : renamed.text });
        break;
      }
    }
    this.clear(binding);
    if (next) this.await(binding, next.awaiting, next.messageId);
    return true;
  }

  /** "결정으로 적어 줘: …" as a plain sentence: written to the note of the chat's project at once. */
  async sentence(adapter: ChannelAdapter, binding: Binding, key: string, entry: { section: "decision" | "question"; text: string }) {
    const long = tooLongForNote(entry.text);
    if (long) return void (await this.core.send(adapter, binding, key, { text: long }));
    const work = this.work(binding);
    const screen = work ? this.noteWrite(binding, work.id, entry.section, entry.text, "current") : { text: "노트를 적을 프로젝트가 없습니다." };
    await this.core.send(adapter, binding, key, screen);
  }
}
