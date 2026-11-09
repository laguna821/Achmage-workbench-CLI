import { randomUUID } from "node:crypto";
import type { CommandReceipt, CreateScheduleRequest, Schedule, SchedulePolicy, ScheduleWhen } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { ScheduleJournal, planScheduleTick } from "./schedule-journal.ts";

// "예약 작업": requests sessions get at set times. Kept in the gateway's database; while the app
// runs, a tick sends what is due (as "끝나면 보내기" when the session is working). A time missed
// while the app was closed goes once when it opens again, not once per missed time.

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const KEY = "schedules";

/** The next moment a schedule goes after `after` (null: a one-off that has gone). */
export function nextRun(when: ScheduleWhen, after: number, timezone?: string): number | null {
  if (when.kind === "once") return when.at > after ? when.at : null;
  if (when.kind === "every") return after + when.hours * 3_600_000;
  const [hours, minutes] = when.time.split(":").map(Number) as [number, number];
  if (timezone) {
    const format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const parts = (at: number) => Object.fromEntries(format.formatToParts(at).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    const current = parts(after), wall = Number(current.hour) * 60 + Number(current.minute), target = hours * 60 + minutes;
    const date = (p: Record<string, string>) => `${p.year}-${p.month}-${p.day}`;
    const earliest = date(current), tomorrow = wall >= target;
    // Bounded minute search handles changing offsets and skips a nonexistent DST wall time.
    // Once today's wall time has passed, a repeated DST hour cannot fire it twice.
    const start = Math.floor(after / 60_000) * 60_000 + 60_000;
    for (let at = start; at <= start + 3 * 86_400_000; at += 60_000) {
      const local = parts(at);
      if (Number(local.hour) === hours && Number(local.minute) === minutes && (!tomorrow || date(local) > earliest)) return at;
    }
    return null;
  }
  const next = new Date(after);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= after) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/** A schedule's "when" from a request body, checked. */
export function parseWhen(value: unknown): ScheduleWhen {
  const when = (value ?? {}) as Record<string, unknown>;
  if (when.kind === "daily" && typeof when.time === "string" && TIME.test(when.time)) return { kind: "daily", time: when.time };
  if (when.kind === "once" && typeof when.at === "number" && Number.isFinite(when.at)) return { kind: "once", at: Math.round(when.at) };
  if (when.kind === "every" && typeof when.hours === "number" && when.hours >= 1 && when.hours <= 24 * 7) return { kind: "every", hours: Math.round(when.hours) };
  throw new HttpError(400, "invalid_schedule", "예약 시각을 알아볼 수 없습니다. 매일 HH:MM, 한 번(날짜·시각), 1~168시간마다 중에서 정해 주세요.");
}

export type ScheduleHost = {
  getMeta: (key: string) => string | null;
  setMeta: (key: string, value: string) => void;
  sessionExists: (sessionId: string) => boolean;
  /** Send the request (queued when the session is working); throws when it cannot go. */
  send: (schedule: Schedule, requestId: string) => Promise<CommandReceipt | void>;
  receipt?: (commandId: string) => CommandReceipt | null;
  transaction?: <T>(run: () => T) => T;
  changed: (schedules: Schedule[]) => void;
  now?: () => number;
};

export class Schedules {
  readonly journal: ScheduleJournal;
  private ticking = false;
  private list: Schedule[];
  private timer: NodeJS.Timeout | null = null;
  private readonly host: ScheduleHost;
  private readonly now: () => number;

  constructor(host: ScheduleHost) {
    this.host = host;
    this.now = host.now ?? Date.now;
    this.journal = new ScheduleJournal(host);
    try {
      this.list = JSON.parse(host.getMeta(KEY) ?? "[]") as Schedule[];
    } catch {
      this.list = [];
    }
  }

  all() {
    return this.list;
  }

  create(request: CreateScheduleRequest): Schedule {
    const text = String(request.text ?? "").trim();
    if (!text) throw new HttpError(400, "empty_schedule", "보낼 요청을 적어 주세요.");
    if (!this.host.sessionExists(request.sessionId)) throw new HttpError(404, "session_not_found", "세션을 찾지 못했습니다.");
    const when = parseWhen(request.when);
    const now = this.now();
    const policy = parsePolicy(request.policy, now);
    const nextAt = nextRun(when, now, policy.timezone);
    if (nextAt === null) throw new HttpError(400, "schedule_past", "이미 지난 시각입니다.");
    const schedule: Schedule = { id: randomUUID(), sessionId: request.sessionId, text: text.slice(0, 8000), when, enabled: true, nextAt, lastAt: null, createdAt: now, policy, runCount: 0 };
    this.save([...this.list, schedule]);
    return schedule;
  }

  update(id: string, patch: { enabled?: boolean }): Schedule {
    const schedule = this.list.find((entry) => entry.id === id);
    if (!schedule) throw new HttpError(404, "schedule_not_found", "예약을 찾지 못했습니다.");
    const enabled = patch.enabled ?? schedule.enabled;
    // Turned back on: from now on (no catching up on what passed while it was off).
    if (enabled && ((schedule.policy?.expiresAt && schedule.policy.expiresAt <= this.now()) || (schedule.policy?.maxRuns && (schedule.runCount ?? 0) >= schedule.policy.maxRuns))) throw new HttpError(409, "schedule_ended", "기한 또는 실행 횟수가 끝난 예약입니다. 새 예약을 만들어 주세요.");
    const next = { ...schedule, enabled, nextAt: enabled && !schedule.enabled ? nextRun(schedule.when, this.now(), schedule.policy?.timezone) : schedule.nextAt };
    this.save(this.list.map((entry) => (entry.id === id ? next : entry)));
    return next;
  }

  remove(id: string) {
    this.save(this.list.filter((entry) => entry.id !== id));
  }

  /** Schedules of a session that is gone go with it. */
  forget(sessionId: string) {
    if (this.list.some((entry) => entry.sessionId === sessionId)) this.save(this.list.filter((entry) => entry.sessionId !== sessionId));
  }

  start(intervalMs = 30_000) {
    this.stop();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Send what is due; a time missed while the app was closed goes once. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
    const now = this.now();
    for (const schedule of this.list.filter((entry) => entry.enabled && entry.nextAt !== null && entry.nextAt <= now)) {
      const current = this.list.find(entry => entry.id === schedule.id);
      if (!current?.enabled || current.nextAt !== schedule.nextAt) continue;
      if (!this.host.sessionExists(schedule.sessionId)) {
        this.forget(schedule.sessionId);
        continue;
      }
      const dueAt = schedule.nextAt!, policy = schedule.policy;
      const previous = this.journal.get(`${schedule.id}:${dueAt}`);
      const plan = planScheduleTick({ scheduleId: schedule.id, dueAt, now, enabled: schedule.enabled, expiresAt: policy?.expiresAt ?? null,
        mode: policy?.mode ?? "resume_session", previous: previous?.status === "outcome_unknown" ? "outcome_unknown" : previous?.status === "accepted" ? "accepted" : previous ? "completed" : "none" });
      const expired = !!policy?.expiresAt && now > policy.expiresAt;
      const limited = !!policy?.maxRuns && (schedule.runCount ?? 0) >= policy.maxRuns;
      const missed = policy?.missed === "skip" && now - dueAt > 60_000;
      const skip = expired ? "예약 기한이 지났습니다." : limited ? "설정한 실행 횟수를 마쳤습니다." : missed ? "1분 넘게 지난 예약을 건너뛰었습니다." : undefined;
      const dispatch = plan.action === "dispatch" && !skip;
      const count = (schedule.runCount ?? 0) + Number(dispatch);
      const next = { ...schedule, lastAt: dispatch ? now : schedule.lastAt, runCount: count,
        nextAt: nextRun(schedule.when, now, policy?.timezone), enabled: schedule.when.kind !== "once" && !expired && !limited && !(policy?.maxRuns && count >= policy.maxRuns) };
      const commit = () => {
        const occurrence = this.journal.admit(schedule.id, dueAt, now, skip);
        this.save(this.list.map((entry) => (entry.id === schedule.id ? next : entry)));
        return occurrence;
      };
      const occurrence = this.host.transaction ? this.host.transaction(commit) : commit();
      if (plan.action === "reconcile") this.journal.reconcile(occurrence.id);
      else if (dispatch) {
        try { this.journal.finish(occurrence.id, await this.host.send(next, occurrence.commandId)); }
        catch (error) { this.journal.finish(occurrence.id, undefined, error); }
      }
      this.host.changed(this.list);
    }
    } finally { this.ticking = false; }
  }

  private save(list: Schedule[]) {
    this.list = list;
    this.host.setMeta(KEY, JSON.stringify(list));
    this.host.changed(list);
  }
}

function parsePolicy(input: Partial<SchedulePolicy> | undefined, now: number): SchedulePolicy {
  const policy: SchedulePolicy = { mode: input?.mode ?? "resume_session", timezone: input?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    missed: input?.missed ?? "once", expiresAt: input?.expiresAt ?? null, maxRuns: input?.maxRuns ?? null };
  if (!["resume_session", "new_run"].includes(policy.mode) || !["once", "skip"].includes(policy.missed)) throw new HttpError(400, "schedule_policy", "예약 실행 방식을 확인해 주세요.");
  try { if (typeof policy.timezone !== "string" || policy.timezone.length > 80) throw Error(); new Intl.DateTimeFormat("en", { timeZone: policy.timezone }); }
  catch { throw new HttpError(400, "schedule_timezone", "시간대를 확인해 주세요. 예: Asia/Seoul"); }
  if (policy.expiresAt !== null && (!Number.isFinite(policy.expiresAt) || policy.expiresAt <= now)) throw new HttpError(400, "schedule_expiry", "예약 기한은 현재 이후로 정해 주세요.");
  if (policy.maxRuns !== null && (!Number.isSafeInteger(policy.maxRuns) || policy.maxRuns < 1 || policy.maxRuns > 100_000)) throw new HttpError(400, "schedule_limit", "최대 실행 횟수는 1~100000 사이입니다.");
  return policy;
}
