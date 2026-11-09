import type { CommandReceipt, ScheduleOccurrence, ScheduleTickInput, ScheduleTickPlan } from "@workbench/contracts";

export function planScheduleTick(input: ScheduleTickInput): ScheduleTickPlan {
  const occurrenceId = `${input.scheduleId}:${input.dueAt}`;
  return { occurrenceId, action: input.previous === "accepted" || input.previous === "outcome_unknown" ? "reconcile"
    : input.previous === "completed" || !input.enabled || input.now < input.dueAt || (input.expiresAt !== null && input.now > input.expiresAt) ? "skip" : "dispatch" };
}

type Meta = { getMeta(key: string): string | null; setMeta(key: string, value: string): void; receipt?(commandId: string): CommandReceipt | null };
const KEY = "schedule-journal:v1";
export class ScheduleJournal {
  private rows: ScheduleOccurrence[];
  private readonly meta: Meta;
  constructor(meta: Meta) {
    this.meta = meta;
    try { this.rows = JSON.parse(meta.getMeta(KEY) ?? "[]") as ScheduleOccurrence[]; } catch { this.rows = []; }
    let changed = false;
    for (const row of this.rows) if (row.status === "accepted") { row.status = "outcome_unknown"; row.detail = "호스트가 재시작되었습니다. 전달 상태를 확인해 주세요."; changed = true; }
    if (changed) this.persist();
  }
  private persist() { this.meta.setMeta(KEY, JSON.stringify(this.rows)); }
  list(scheduleId: string) { return this.rows.filter(row => row.scheduleId === scheduleId).sort((a, b) => b.dueAt - a.dueAt); }
  get(id: string) { return this.rows.find(row => row.id === id) ?? null; }
  admit(scheduleId: string, dueAt: number, now: number, skip?: string): ScheduleOccurrence {
    const id = `${scheduleId}:${dueAt}`, prior = this.get(id); if (prior) return prior;
    const row: ScheduleOccurrence = { id, scheduleId, dueAt, admittedAt: now, updatedAt: now, commandId: `schedule-${scheduleId}-${dueAt}`, status: skip ? "skipped" : "accepted", detail: skip ?? "전달 중", receipt: null };
    this.rows = [...this.rows.slice(-999), row]; this.persist(); return row;
  }
  finish(id: string, receipt: CommandReceipt | void, error?: unknown) {
    const row = this.get(id); if (!row) throw Error("예약 실행 기록이 없습니다.");
    if (error) {
      const status = (error as { status?: number }).status;
      row.status = status && status >= 400 && status < 500 ? "rejected" : "outcome_unknown";
      row.detail = error instanceof Error ? error.message : String(error);
    } else {
      row.receipt = receipt ?? null;
      row.status = receipt?.status === "rejected" ? "rejected" : receipt?.status === "outcome_unknown" ? "outcome_unknown"
        : receipt && receipt.status !== "completed" ? "accepted" : "submitted";
      row.detail = receipt?.detail ?? "대화에 전달했습니다.";
    }
    row.updatedAt = Date.now(); this.persist(); return row;
  }
  reconcile(id: string) {
    const row = this.get(id); if (!row) throw Error("예약 실행 기록이 없습니다.");
    const receipt = this.meta.receipt?.(row.commandId);
    // No receipt is not proof of failure and never authorizes an automatic replay.
    return receipt ? this.finish(id, receipt) : row;
  }
}
