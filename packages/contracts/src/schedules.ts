// "예약 작업": a request a session gets at set times, sent by the gateway while the app runs.

/** When: every day at a local time, once at a moment, or every few hours. */
export type ScheduleWhen = { kind: "daily"; time: string } | { kind: "once"; at: number } | { kind: "every"; hours: number };

export type Schedule = {
  id: string;
  sessionId: string;
  text: string;
  when: ScheduleWhen;
  enabled: boolean;
  /** The next time it goes (null once a one-off has gone). */
  nextAt: number | null;
  lastAt: number | null;
  createdAt: number;
};

export type CreateScheduleRequest = { sessionId: string; text: string; when: ScheduleWhen };
