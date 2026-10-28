import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, Schedule, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { Schedules, nextRun, parseWhen } from "./schedules.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

// "예약 작업": requests sessions get at set times.

const at = (text: string) => new Date(text).getTime();

describe("when a schedule goes next", () => {
  it("every day at a time: later today, else tomorrow", () => {
    expect(nextRun({ kind: "daily", time: "09:00" }, at("2026-10-28T08:00:00"))).toBe(at("2026-10-28T09:00:00"));
    expect(nextRun({ kind: "daily", time: "09:00" }, at("2026-10-28T09:00:00"))).toBe(at("2026-10-29T09:00:00"));
  });

  it("every few hours, and once (then never)", () => {
    expect(nextRun({ kind: "every", hours: 3 }, 1_000)).toBe(1_000 + 3 * 3_600_000);
    expect(nextRun({ kind: "once", at: 5_000 }, 1_000)).toBe(5_000);
    expect(nextRun({ kind: "once", at: 5_000 }, 5_000)).toBeNull();
  });

  it("refuses what it cannot read", () => {
    expect(() => parseWhen({ kind: "daily", time: "25:00" })).toThrow(/알아볼 수 없습니다/);
    expect(() => parseWhen({ kind: "every", hours: 0 })).toThrow();
    expect(parseWhen({ kind: "every", hours: 2.4 })).toEqual({ kind: "every", hours: 2 });
  });
});

function store() {
  const meta = new Map<string, string>();
  const sent: string[] = [];
  let now = at("2026-10-28T08:00:00");
  const schedules = new Schedules({
    getMeta: (key) => meta.get(key) ?? null,
    setMeta: (key, value) => meta.set(key, value),
    sessionExists: (id) => id === "s1",
    send: async (schedule) => {
      sent.push(schedule.text);
    },
    changed: () => undefined,
    now: () => now,
  });
  return { schedules, sent, meta, setNow: (value: number) => (now = value) };
}

describe("the schedule tick", () => {
  it("sends what is due once, and moves it on", async () => {
    const { schedules, sent, setNow } = store();
    const daily = schedules.create({ sessionId: "s1", text: "오늘 할 일 정리", when: { kind: "daily", time: "09:00" } });
    await schedules.tick();
    expect(sent).toEqual([]);
    setNow(at("2026-10-28T09:00:30"));
    await schedules.tick();
    await schedules.tick();
    expect(sent).toEqual(["오늘 할 일 정리"]);
    expect(schedules.all().find((entry) => entry.id === daily.id)).toMatchObject({ lastAt: at("2026-10-28T09:00:30"), nextAt: at("2026-10-29T09:00:00") });
  });

  it("sends a time missed while the app was closed once, not once per missed day", async () => {
    const { schedules, sent, setNow } = store();
    schedules.create({ sessionId: "s1", text: "아침 요약", when: { kind: "daily", time: "09:00" } });
    setNow(at("2026-10-31T12:00:00"));
    await schedules.tick();
    expect(sent).toEqual(["아침 요약"]);
    expect(schedules.all()[0]!.nextAt).toBe(at("2026-11-01T09:00:00"));
  });

  it("leaves one turned off alone, counts from now when turned back on, and a one-off ends", async () => {
    const { schedules, sent, setNow } = store();
    const every = schedules.create({ sessionId: "s1", text: "상태 확인", when: { kind: "every", hours: 1 } });
    const once = schedules.create({ sessionId: "s1", text: "한 번만", when: { kind: "once", at: at("2026-10-28T08:30:00") } });
    schedules.update(every.id, { enabled: false });
    setNow(at("2026-10-28T10:00:00"));
    await schedules.tick();
    expect(sent).toEqual(["한 번만"]);
    expect(schedules.all().find((entry) => entry.id === once.id)).toMatchObject({ enabled: false, nextAt: null });
    expect(schedules.update(every.id, { enabled: true }).nextAt).toBe(at("2026-10-28T11:00:00"));
  });

  it("keeps the list across restarts, and refuses a past one-off or an unknown session", () => {
    const { schedules, meta } = store();
    schedules.create({ sessionId: "s1", text: "a", when: { kind: "every", hours: 2 } });
    expect(JSON.parse(meta.get("schedules")!) as Schedule[]).toHaveLength(1);
    expect(() => schedules.create({ sessionId: "s1", text: "a", when: { kind: "once", at: 1 } })).toThrow(/이미 지난/);
    expect(() => schedules.create({ sessionId: "nope", text: "a", when: { kind: "every", hours: 2 } })).toThrow(/세션을 찾지 못했습니다/);
  });
});

class QuietEngine implements ProviderAdapter {
  readonly provider = "codex" as const;
  sent: string[] = [];
  private readonly sink: () => AdapterSink;
  constructor(sink: () => AdapterSink) {
    this.sink = sink;
  }
  async init() {}
  status(): ProviderStatus {
    return emptyStatus("codex");
  }
  async refreshStatus() {
    return this.status();
  }
  async login() {
    return { url: null, message: "" };
  }
  async send(session: Session, _work: Work, text: string) {
    this.sent.push(text);
    this.sink().updateSession(session.id, { status: "running" });
  }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) {
    return false;
  }
  async shutdown() {}
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a schedule in a session", () => {
  it("sends its request marked as scheduled, without changing the session on screen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-schedule-"));
    dirs.push(dir);
    const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
    const engine = new QuietEngine(() => manager.sink);
    manager.registerAdapter(engine);
    const work = manager.createWork({ title: "w" });
    const target = manager.createSession(work.id, { provider: "codex" });
    const shown = manager.createSession(work.id, { provider: "codex" });
    manager.schedules.create({ sessionId: target.id, text: "주간 보고 초안", when: { kind: "once", at: Date.now() + 50 } });
    await new Promise((done) => setTimeout(done, 80));
    await manager.schedules.tick();
    expect(engine.sent).toEqual(["주간 보고 초안"]);
    expect(manager.items(target.id).items.find((item) => item.kind === "user")).toMatchObject({ text: "주간 보고 초안", scheduled: true });
    expect(manager.snapshot().works.find((entry) => entry.id === work.id)?.activeSessionId).toBe(shown.id);
  });
});
