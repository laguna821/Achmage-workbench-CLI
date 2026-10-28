import { randomUUID } from "node:crypto";
import type { CreateScheduleRequest, Schedule, ScheduleWhen } from "@workbench/contracts";
import { HttpError } from "./errors.ts";

// "예약 작업": requests sessions get at set times. Kept in the gateway's database; while the app
// runs, a tick sends what is due (as "끝나면 보내기" when the session is working). A time missed
// while the app was closed goes once when it opens again, not once per missed time.

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const KEY = "schedules";

/** The next moment a schedule goes after `after` (null: a one-off that has gone). */
export function nextRun(when: ScheduleWhen, after: number): number | null {
  if (when.kind === "once") return when.at > after ? when.at : null;
  if (when.kind === "every") return after + when.hours * 3_600_000;
  const [hours, minutes] = when.time.split(":").map(Number) as [number, number];
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
  send: (schedule: Schedule, requestId: string) => Promise<void>;
  changed: (schedules: Schedule[]) => void;
  now?: () => number;
};

export class Schedules {
  private list: Schedule[];
  private timer: NodeJS.Timeout | null = null;
  private readonly host: ScheduleHost;
  private readonly now: () => number;

  constructor(host: ScheduleHost) {
    this.host = host;
    this.now = host.now ?? Date.now;
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
    const nextAt = nextRun(when, now);
    if (nextAt === null) throw new HttpError(400, "schedule_past", "이미 지난 시각입니다.");
    const schedule: Schedule = { id: randomUUID(), sessionId: request.sessionId, text: text.slice(0, 8000), when, enabled: true, nextAt, lastAt: null, createdAt: now };
    this.save([...this.list, schedule]);
    return schedule;
  }

  update(id: string, patch: { enabled?: boolean }): Schedule {
    const schedule = this.list.find((entry) => entry.id === id);
    if (!schedule) throw new HttpError(404, "schedule_not_found", "예약을 찾지 못했습니다.");
    const enabled = patch.enabled ?? schedule.enabled;
    // Turned back on: from now on (no catching up on what passed while it was off).
    const next = { ...schedule, enabled, nextAt: enabled && !schedule.enabled ? nextRun(schedule.when, this.now()) : schedule.nextAt };
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
    const now = this.now();
    for (const schedule of this.list.filter((entry) => entry.enabled && entry.nextAt !== null && entry.nextAt <= now)) {
      if (!this.host.sessionExists(schedule.sessionId)) {
        this.forget(schedule.sessionId);
        continue;
      }
      // Moved on first, so a slow send never sends twice.
      const next = { ...schedule, lastAt: now, nextAt: nextRun(schedule.when, now), enabled: schedule.when.kind === "once" ? false : schedule.enabled };
      this.save(this.list.map((entry) => (entry.id === schedule.id ? next : entry)));
      await this.host.send(next, `schedule-${schedule.id}-${now}`).catch(() => undefined);
    }
  }

  private save(list: Schedule[]) {
    this.list = list;
    this.host.setMeta(KEY, JSON.stringify(list));
    this.host.changed(list);
  }
}
