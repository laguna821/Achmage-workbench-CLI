import { describe, expect, it } from "vitest";
import type { ProjectEvent, Session, Work } from "@workbench/contracts";
import { asLink, continueSession, duration, eventDays, linkLabel, markProjectSeen, projectSeenAt, sessionOrder, stageOf } from "./project.ts";

const work = { id: "w", activeSessionId: "s-old" } as Work;
const session = (id: string, patch: Partial<Session> = {}) => ({ id, workId: "w", status: "idle", updatedAt: 1, archivedAt: null, lastError: null, unread: false, previewAt: null, seenAt: null, ...patch }) as Session;

describe("project page rules", () => {
  it("gives a stage its colour, and a renamed one grey", () => {
    const stages = [{ name: "할일", color: "#e5484d" }];
    expect(stageOf(stages, "할일")).toEqual({ name: "할일", color: "#e5484d" });
    expect(stageOf(stages, "옛 이름")).toEqual({ name: "옛 이름", color: "#8b8d98" });
    expect(stageOf(stages, null)).toBeNull();
  });

  it("says how long turns took", () => {
    expect(duration(30_000)).toBe("1분 미만");
    expect(duration(45 * 60_000)).toBe("45분");
    expect(duration(192 * 60_000)).toBe("3시간 12분");
    expect(duration(120 * 60_000)).toBe("2시간");
  });

  it("groups the record by day: 오늘, 어제, then dates", () => {
    const now = new Date(2026, 9, 29, 15).getTime();
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour).getTime();
    const events = [at(29, 9), at(28, 20), at(27, 10), at(29, 14)].map((time, index) => ({ id: String(index), at: time, kind: "request", text: "", sessionId: null, artifactId: null, by: "user" }) as ProjectEvent);
    expect(eventDays(events, now).map((group) => `${group.label}:${group.events.length}`)).toEqual(["오늘:2", "어제:1", "10월 27일 (화)"+":1"]);
  });

  it("continues the session that needs the user, else the error, else unread, else the last one open", () => {
    expect(continueSession(work, [session("s-old"), session("s-new", { updatedAt: 5 })])!.id).toBe("s-old");
    expect(continueSession(work, [session("s-old"), session("unread", { unread: true })])!.id).toBe("unread");
    expect(continueSession(work, [session("unread", { unread: true }), session("err", { lastError: "x" })])!.id).toBe("err");
    expect(continueSession(work, [session("err", { lastError: "x" }), session("ask", { status: "awaitingApproval" })])!.id).toBe("ask");
    expect(continueSession(work, [session("gone", { archivedAt: 5 })])).toBeNull();
    expect(sessionOrder([session("a", { updatedAt: 9 }), session("ask", { status: "awaitingApproval" }), session("run", { status: "running", updatedAt: 2 })]).map((entry) => entry.id)).toEqual(["ask", "run", "a"]);
  });

  it("writes related projects as wikilinks and shows them without brackets", () => {
    expect(asLink("가을 특강")).toBe("[[가을 특강]]");
    expect(asLink("[[가을 특강]]")).toBe("[[가을 특강]]");
    expect(asLink("https://x.org")).toBe("https://x.org");
    expect(linkLabel("[[노트|별칭]]")).toBe("별칭");
    expect(linkLabel("[[가을 특강]]")).toBe("가을 특강");
  });
});

describe("지난번 본 뒤", () => {
  it("remembers when the person left each project's page, the 300 most recent", () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) };
    const before = (globalThis as { localStorage?: unknown }).localStorage;
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    try {
      expect(projectSeenAt("w1")).toBeNull();
      markProjectSeen("w1", 1000);
      markProjectSeen("w2", 2000);
      expect(projectSeenAt("w1")).toBe(1000);
      for (let index = 0; index < 310; index += 1) markProjectSeen(`x${index}`, 3000 + index);
      expect(projectSeenAt("w2")).toBeNull();
      expect(projectSeenAt("x309")).toBe(3309);
      kept.set("workbench.projectSeen", "{not json");
      expect(projectSeenAt("x309")).toBeNull();
    } finally {
      Object.defineProperty(globalThis, "localStorage", { value: before, configurable: true });
    }
  });
});
