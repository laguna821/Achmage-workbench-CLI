import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SequencedEvent, Session } from "@workbench/contracts";
import { DONE_SOUND_DEFAULTS, DoneSounds, SOUND_CHOICES, SoundLimiter, doneSoundPrefs, soundKindOf, type SoundKind } from "./done-sound.ts";

const session = (id = "s1", extra: Partial<Session> = {}) => ({ id, provider: "claude", muted: false, archivedAt: null, ...extra }) as Session;
let seq = 0;
const turnEnd = (sessionId: string, status: "completed" | "failed" | "interrupted", cause: string | null = null, id = `end-${++seq}`) =>
  ({ type: "item.upserted", sessionId, item: { kind: "turnEnd", id, status, durationMs: 1, at: 1, cause }, seq: ++seq, at: 1 }) as SequencedEvent;
const approval = (sessionId: string, decision: string | null = null, id = `ap-${++seq}`, extra: Record<string, unknown> = {}) =>
  ({ type: "item.upserted", sessionId, item: { kind: "approval", id, title: "?", detail: null, reason: null, decision, at: 1, ...extra }, seq: ++seq, at: 1 }) as SequencedEvent;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("tells which event plays which sound (the host's own attention rule)", () => {
  expect(soundKindOf(turnEnd("s1", "completed"))).toBe("done");
  expect(soundKindOf(turnEnd("s1", "failed"))).toBe("failed");
  expect(soundKindOf(turnEnd("s1", "interrupted", "crash"))).toBe("failed"); // the engine died
  expect(soundKindOf(turnEnd("s1", "interrupted", "stop"))).toBeNull(); // the person stopped it
  expect(soundKindOf(turnEnd("s1", "completed", "stop"))).toBeNull();
  expect(soundKindOf(approval("s1"))).toBe("needs"); // an approval
  expect(soundKindOf(approval("s1", null, undefined, { plan: true }))).toBe("needs"); // 계획 먼저: go-ahead
  expect(soundKindOf(approval("s1", null, "browser:x", { title: "로그인이 필요합니다" }))).toBe("needs"); // the browser's sign-in hand-over
  expect(soundKindOf(approval("s1", "accept"))).toBeNull(); // answered
  expect(soundKindOf({ type: "item.upserted", sessionId: "s1", item: { kind: "assistant", id: "a", text: "", streaming: false, at: 1 }, seq: 1, at: 1 } as SequencedEvent)).toBeNull();
  expect(soundKindOf({ type: "attention.changed", seq: 1, at: 1 } as SequencedEvent)).toBeNull();
});

it("has the settings' defaults: on, 45 % (0.5.3: 70 was a little loud), three different sounds, quiet for the conversation in front", () => {
  expect(DONE_SOUND_DEFAULTS).toEqual({ on: true, volume: 45, done: "chime", needs: "rise", failed: "fall", quietOnScreen: true });
  expect(doneSoundPrefs({})).toEqual(DONE_SOUND_DEFAULTS);
  expect(new Set([DONE_SOUND_DEFAULTS.done, DONE_SOUND_DEFAULTS.needs, DONE_SOUND_DEFAULTS.failed]).size).toBe(3);
  expect(SOUND_CHOICES.map(choice => choice.id)).toEqual(["chime", "bell", "pop", "rise", "fall"]);
  // Saved values are read back; anything malformed falls back to the default.
  expect(doneSoundPrefs({ doneSound: false, doneSoundVolume: 30, doneSoundDone: "bell", doneSoundNeeds: "pop", doneSoundFailed: "chime", doneSoundQuietOnScreen: false }))
    .toEqual({ on: false, volume: 30, done: "bell", needs: "pop", failed: "chime", quietOnScreen: false });
  expect(doneSoundPrefs({ doneSound: "yes", doneSoundVolume: 400, doneSoundDone: "../x.wav", doneSoundQuietOnScreen: 1 })).toEqual(DONE_SOUND_DEFAULTS);
  expect(doneSoundPrefs({ doneSoundVolume: -5 }).volume).toBe(45);
  // A level the person chose is kept, the old default included.
  expect(doneSoundPrefs({ doneSoundVolume: 70 }).volume).toBe(70);
  expect(doneSoundPrefs({}).volume).toBe(45);
});

function rig() {
  const played: SoundKind[] = [];
  const limiter = new SoundLimiter(kind => played.push(kind));
  return { played, limiter, sounds: new DoneSounds(limiter) };
}
const away = { windowShown: false, onScreen: new Set<string>() };

it("plays for a turn that ends while the window is hidden, on another tab or minimised, and only once per item", () => {
  const { played, sounds } = rig();
  const end = turnEnd("s1", "completed");
  expect(sounds.take(end, session("s1"), DONE_SOUND_DEFAULTS, away)).toBe("done");
  expect(sounds.take(end, session("s1"), DONE_SOUND_DEFAULTS, away)).toBeNull(); // the same item upserted again
  vi.advanceTimersByTime(200);
  expect(played).toEqual(["done"]);
});

it("keeps quiet for the conversation on screen in the focused window, unless the person turned that rule off", () => {
  const { played, sounds } = rig();
  const front = { windowShown: true, onScreen: new Set(["s1"]) };
  expect(sounds.take(turnEnd("s1", "completed"), session("s1"), DONE_SOUND_DEFAULTS, front)).toBeNull();
  expect(sounds.take(approval("s1"), session("s1"), DONE_SOUND_DEFAULTS, front)).toBeNull();
  // Another project's conversation, or the same one with the window in the back, still sounds.
  expect(sounds.take(turnEnd("s2", "completed"), session("s2"), DONE_SOUND_DEFAULTS, front)).toBe("done");
  vi.advanceTimersByTime(2000);
  expect(sounds.take(turnEnd("s1", "completed"), session("s1"), DONE_SOUND_DEFAULTS, { windowShown: false, onScreen: new Set(["s1"]) })).toBe("done");
  vi.advanceTimersByTime(2000);
  expect(sounds.take(turnEnd("s1", "completed"), session("s1"), { ...DONE_SOUND_DEFAULTS, quietOnScreen: false }, front)).toBe("done");
  vi.advanceTimersByTime(2000);
  expect(played).toEqual(["done", "done", "done"]);
});

it("respects 완료 소리 off, a muted conversation and an archived one", () => {
  const { played, sounds } = rig();
  expect(sounds.take(turnEnd("s1", "completed"), session("s1"), { ...DONE_SOUND_DEFAULTS, on: false }, away)).toBeNull();
  expect(sounds.take(turnEnd("s1", "completed"), session("s1", { muted: true }), DONE_SOUND_DEFAULTS, away)).toBeNull();
  expect(sounds.take(turnEnd("s1", "completed"), session("s1", { archivedAt: 5 }), DONE_SOUND_DEFAULTS, away)).toBeNull();
  vi.advanceTimersByTime(2000);
  expect(played).toEqual([]);
});

it("plays a turn started from the phone like any other: the event carries no origin, the PC sounds", () => {
  const { played, sounds } = rig();
  // A phone-started turn reaches the PC as the same item.upserted on the same session (it is also pushed to the phone).
  const phone = { ...turnEnd("s1", "completed"), origin: "phone" } as unknown as SequencedEvent;
  expect(sounds.take(phone, session("s1", { purpose: "휴대폰에서 시작" } as Partial<Session>), DONE_SOUND_DEFAULTS, away)).toBe("done");
  vi.advanceTimersByTime(200);
  expect(played).toEqual(["done"]);
});

it("never bursts: ten turns ending together make one sound", () => {
  const { played, sounds } = rig();
  for (let i = 0; i < 10; i++) sounds.take(turnEnd(`s${i}`, "completed"), session(`s${i}`), DONE_SOUND_DEFAULTS, away);
  vi.advanceTimersByTime(5000);
  expect(played).toEqual(["done"]);
});

it("lets 'needs the person' win over 'done' when they arrive together, and does not lose it inside the quiet gap", () => {
  const { played, limiter } = rig();
  limiter.push("done"); limiter.push("done"); limiter.push("needs"); limiter.push("done");
  vi.advanceTimersByTime(200);
  expect(played).toEqual(["needs"]);
  // Inside the 1.5 s gap what the last sound already covers (same or lower) is dropped.
  vi.advanceTimersByTime(300); limiter.push("done"); limiter.push("failed");
  vi.advanceTimersByTime(3000);
  expect(played).toEqual(["needs"]);
});

it("defers a more urgent sound to the end of the gap instead of losing it", () => {
  const { played, limiter } = rig();
  limiter.push("done"); limiter.push("done");
  vi.advanceTimersByTime(200);
  expect(played).toEqual(["done"]);
  vi.advanceTimersByTime(300); limiter.push("done"); // covered: dropped
  vi.advanceTimersByTime(300); limiter.push("failed"); // waits
  vi.advanceTimersByTime(300); limiter.push("needs"); // waits, and wins over the failure
  vi.advanceTimersByTime(400);
  expect(played).toEqual(["done"]);
  vi.advanceTimersByTime(300); // 1.5 s after the first sound
  expect(played).toEqual(["done", "needs"]);
  vi.advanceTimersByTime(1600); limiter.push("done"); // after the gap a done sounds again
  vi.advanceTimersByTime(200);
  expect(played).toEqual(["done", "needs", "done"]);
});

it("plays at most one sound per 1.5 s under a long stream of events", () => {
  const played: SoundKind[] = [], times: number[] = [];
  const timed = new SoundLimiter(kind => { played.push(kind); times.push(Date.now()); });
  for (let i = 0; i < 40; i++) { timed.push(i % 7 === 0 ? "needs" : i % 5 === 0 ? "failed" : "done"); vi.advanceTimersByTime(100); }
  vi.advanceTimersByTime(3000);
  for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1500);
  expect(times.length).toBeGreaterThanOrEqual(2);
  expect(times.length).toBeLessThanOrEqual(5); // 7 s in all → at most 1 + 7000/1500
  expect(played[0]).toBe("needs"); // the first gather held a needs (i = 0)
});
