import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { Store } from "./store.ts";
import { Schedules, nextRun } from "./schedules.ts";
import { planScheduleTick } from "./schedule-journal.ts";

test("unknown occurrence keeps its identity and is reconciled without resending", () => {
  const tick = { scheduleId: "schedule-1", dueAt: 1000, now: 2000, enabled: true, expiresAt: 9000, mode: "resume_session" as const, previous: "outcome_unknown" as const };
  expect(planScheduleTick(tick)).toEqual({ occurrenceId: "schedule-1:1000", action: "reconcile" });
  expect(planScheduleTick({ ...tick, now: 3000 })).toEqual({ occurrenceId: "schedule-1:1000", action: "reconcile" });
});

test("a lost response survives SQLite restart and never starts the occurrence again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-occurrence-"));
  let db = new Store(join(dir, "state.sqlite")), calls = 0, now = 1000;
  const make = () => new Schedules({ getMeta: key => db.getMeta(key), setMeta: (key, value) => db.setMeta(key, value), transaction: run => db.transaction(run),
    sessionExists: () => true, send: async () => { calls++; throw Error("response lost after dispatch"); }, changed: () => {}, now: () => now });
  try {
    const first = make(), entry = first.create({ sessionId: "session", text: "do once", when: { kind: "once", at: 2000 } });
    now = 2100; await Promise.all([first.tick(), first.tick()]);
    expect(calls).toBe(1); expect(first.journal.list(entry.id)[0]?.status).toBe("outcome_unknown");
    db.close(); db = new Store(join(dir, "state.sqlite"));
    const next = make(); await next.tick(); next.journal.reconcile(`${entry.id}:2000`);
    expect(calls).toBe(1); expect(next.journal.list(entry.id)[0]?.commandId).toBe(`schedule-${entry.id}-2000`);
  } finally { db.close(); rmSync(dir, { force: true, recursive: true }); }
});

test("expiry, missed skip and maximum runs are persisted without dispatching extra requests", async () => {
  const meta = new Map<string, string>(); let now = 0, calls = 0;
  const scheduler = new Schedules({ getMeta: key => meta.get(key) ?? null, setMeta: (key, value) => { meta.set(key, value); }, sessionExists: () => true,
    send: async () => { calls++; }, changed: () => {}, now: () => now });
  const missed = scheduler.create({ sessionId: "s", text: "skip", when: { kind: "once", at: 1000 }, policy: { missed: "skip" } });
  const expired = scheduler.create({ sessionId: "s", text: "expired", when: { kind: "once", at: 1000 }, policy: { expiresAt: 2000 } });
  const limited = scheduler.create({ sessionId: "s", text: "one", when: { kind: "every", hours: 1 }, policy: { maxRuns: 1 } });
  now = 3_600_000; await scheduler.tick(); now += 3_600_000; await scheduler.tick();
  expect(calls).toBe(1);
  expect(scheduler.journal.list(missed.id)[0]?.status).toBe("skipped");
  expect(scheduler.journal.list(expired.id)[0]?.status).toBe("skipped");
  expect(scheduler.all().find(s => s.id === limited.id)).toMatchObject({ enabled: false, runCount: 1 });
});

test("daily wall time is pinned to a timezone and does not repeat during a DST fallback", () => {
  expect(nextRun({ kind: "daily", time: "09:00" }, Date.parse("2026-11-09T00:00:00Z"), "Asia/Seoul")).toBe(Date.parse("2026-11-10T00:00:00Z"));
  expect(nextRun({ kind: "daily", time: "01:30" }, Date.parse("2026-11-01T05:30:00Z"), "America/New_York")).toBe(Date.parse("2026-11-02T06:30:00Z"));
  expect(nextRun({ kind: "daily", time: "02:30" }, Date.parse("2026-03-08T05:00:00Z"), "America/New_York")).toBe(Date.parse("2026-03-09T06:30:00Z"));
});
