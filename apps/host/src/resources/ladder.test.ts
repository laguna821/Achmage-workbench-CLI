import { describe, expect, it } from "vitest";
import { GiB, MiB, PRESSURE_MARGIN, lowMarkFor } from "./core.ts";
import { CAP_CHOICES, LADDER_STEP_MS, capSupport, ladderAfter, leastUrgent, type Ladder } from "./ladder.ts";

// 0.5.4: under memory pressure the manager climbs a ladder, one rung at a time — 1 stop admitting, 2 close
// idle engines, 3 sleep off-screen tabs, 4 relieve the least urgent running turn — and comes down at once
// only when memory is clearly back (the same margin as v1's pressure), so it does not flap.

const total = 16 * GiB;
const low = lowMarkFor(total);
const at = (availableBytes: number) => ({ totalBytes: total, availableBytes, cores: 8 });
const calm: Ladder = { stage: 0, since: 0 };

describe("the pressure ladder", () => {
  it("climbs in order, one rung per step, never skipping, and stops at the top", () => {
    let ladder = ladderAfter(calm, at(low - 1), 1_000);
    expect(ladder.stage).toBe(1);
    const seen = [ladder.stage];
    for (let now = 1_000; now <= 1_000 + LADDER_STEP_MS * 6; now += 1_000) {
      ladder = ladderAfter(ladder, at(low - 1), now);
      if (seen.at(-1) !== ladder.stage) seen.push(ladder.stage);
    }
    expect(seen).toEqual([1, 2, 3, 4]);
  });
  it("does not climb before a rung has had its step's time", () => {
    const one = ladderAfter(calm, at(low - 1), 0);
    expect(ladderAfter(one, at(low - 1), LADDER_STEP_MS - 1).stage).toBe(1);
    expect(ladderAfter(one, at(low - 1), LADDER_STEP_MS).stage).toBe(2);
  });
  it("holds its rung inside the margin (neither climbs nor comes down) and comes down at once above it", () => {
    const three: Ladder = { stage: 3, since: 0 };
    expect(ladderAfter(three, at(low + PRESSURE_MARGIN - 1), LADDER_STEP_MS * 10)).toBe(three);
    expect(ladderAfter(three, at(low + PRESSURE_MARGIN), LADDER_STEP_MS * 10).stage).toBe(0);
  });
  it("does not start inside the margin: pressure begins only below the low mark", () => {
    expect(ladderAfter(calm, at(low + 1), 5_000)).toBe(calm);
    expect(ladderAfter(calm, at(low), 5_000)).toBe(calm);
  });
  it("does not flap when memory wavers around the low mark", () => {
    // Readings every second swinging ±100 MB around the low mark for two minutes: it starts once, climbs, and
    // never comes down (the swing never reaches the margin), so idle engines are closed once, tabs slept once.
    let ladder = calm, starts = 0, downs = 0;
    for (let second = 0; second < 120; second++) {
      const next = ladderAfter(ladder, at(low + (second % 2 ? 100 : -100) * MiB), second * 1_000);
      if (ladder.stage === 0 && next.stage > 0) starts++;
      if (next.stage < ladder.stage) downs++;
      ladder = next;
    }
    expect(starts).toBe(1);
    expect(downs).toBe(0);
    expect(ladder.stage).toBe(4);
  });
});

describe("the least urgent running turn", () => {
  const turn = (sessionId: string, extra: Partial<Parameters<typeof leastUrgent>[0][number]> = {}) => ({ sessionId, shown: false, forced: false, since: 0, bytes: null, ...extra });
  it("is never one on screen, and never one when every running turn is on screen", () => {
    expect(leastUrgent([turn("a", { shown: true, bytes: 900 * MiB }), turn("b", { bytes: 100 * MiB })])?.sessionId).toBe("b");
    expect(leastUrgent([turn("a", { shown: true })])).toBeNull();
    expect(leastUrgent([])).toBeNull();
  });
  it("prefers one not started with 지금 바로 실행, then the largest, then the latest started", () => {
    expect(leastUrgent([turn("forced", { forced: true, bytes: 900 * MiB }), turn("plain", { bytes: 100 * MiB })])?.sessionId).toBe("plain");
    expect(leastUrgent([turn("small", { bytes: 100 * MiB }), turn("big", { bytes: 600 * MiB })])?.sessionId).toBe("big");
    expect(leastUrgent([turn("old", { since: 1 }), turn("new", { since: 5 })])?.sessionId).toBe("new");
  });
});

describe("대화당 메모리 상한: what this computer can enforce", () => {
  const all = { cgroup2: true, memory: true, systemdRun: true };
  it("Linux with cgroup v2, its memory controller and systemd-run --user --scope: enforced", () => {
    expect(capSupport("linux", all)).toBe("enforced");
  });
  it("Linux without any of them: cannot be set (said in the settings), never pretended", () => {
    expect(capSupport("linux", { ...all, systemdRun: false })).toBe("unavailable");
    expect(capSupport("linux", { ...all, cgroup2: false })).toBe("unavailable");
    expect(capSupport("linux", { ...all, memory: false })).toBe("unavailable");
    expect(capSupport("linux", null)).toBe("unavailable");
  });
  it("Windows and macOS: a recommended value only (this unit has no native helper there)", () => {
    expect(capSupport("win32", null)).toBe("advised");
    expect(capSupport("darwin", null)).toBe("advised");
    expect(capSupport("freebsd", null)).toBe("unavailable");
  });
  it("the choices are off first, then sizes in GB", () => {
    expect(CAP_CHOICES[0]).toBeNull();
    expect(CAP_CHOICES.slice(1).every((value, index, list) => value !== null && value >= GiB && (index === 0 || value > list[index - 1]!))).toBe(true);
  });
});
