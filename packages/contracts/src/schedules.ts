import type { CommandReceipt } from "./tasks.ts";
// The host owns schedule admission, independently from the UI.

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
  policy?: SchedulePolicy;
  runCount?: number;
  /** Made by the person (the PC's schedule form): its text is their draft, shown as typed (R6); otherwise hidden. */
  draft?: boolean;
  /** Made from a paired messenger chat: its request carries this origin, so the result goes back to that chat. */
  origin?: import("./channels.ts").RequestOrigin;
  /** Turned off because the chat that made it was locked or disconnected (shown at the PC; cleared when turned on). */
  offReason?: "locked" | "disconnected";
};

export type SchedulePolicy = {
  mode: "new_run" | "resume_session";
  timezone: string;
  missed: "once" | "skip";
  expiresAt: number | null;
  maxRuns: number | null;
};
export type CreateScheduleRequest = { sessionId: string; text: string; when: ScheduleWhen; policy?: Partial<SchedulePolicy>; draft?: boolean };
export type ScheduleOccurrence = {
  id: string; scheduleId: string; dueAt: number; admittedAt: number; updatedAt: number;
  commandId: string; status: "accepted" | "submitted" | "rejected" | "outcome_unknown" | "skipped";
  detail: string; receipt: CommandReceipt | null;
};
export type ScheduleTickInput = {
  scheduleId: string; dueAt: number; now: number; enabled: boolean; expiresAt: number | null;
  mode: "new_run" | "resume_session"; previous: "none" | "accepted" | "outcome_unknown" | "completed";
};
export type ScheduleTickPlan = { occurrenceId: string; action: "dispatch" | "reconcile" | "skip" };
