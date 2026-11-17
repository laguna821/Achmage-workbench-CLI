import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TERMINAL_SLEEP_MS, ViewSleep } from "./terminal-sleep.ts";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("B4: a hidden terminal releases its view after the grace time and wakes at once when shown", () => {
  const changes: boolean[] = [];
  const sleep = new ViewSleep(TERMINAL_SLEEP_MS, (awake) => changes.push(awake));
  expect(sleep.awake).toBe(true);
  sleep.set(false);
  vi.advanceTimersByTime(TERMINAL_SLEEP_MS - 1);
  expect(sleep.awake).toBe(true);
  vi.advanceTimersByTime(1);
  expect(sleep.awake).toBe(false);
  sleep.set(true);
  expect(sleep.awake).toBe(true);
  expect(changes).toEqual([false, true]);
});

it("B4: shown again within the grace time, the view is kept (no replay for a quick switch)", () => {
  const changes: boolean[] = [];
  const sleep = new ViewSleep(TERMINAL_SLEEP_MS, (awake) => changes.push(awake));
  sleep.set(false); vi.advanceTimersByTime(TERMINAL_SLEEP_MS / 2);
  sleep.set(true); vi.advanceTimersByTime(TERMINAL_SLEEP_MS * 2);
  expect(changes).toEqual([]);
  sleep.set(false); sleep.dispose(); vi.advanceTimersByTime(TERMINAL_SLEEP_MS * 2);
  expect(changes).toEqual([]);
  expect(TERMINAL_SLEEP_MS).toBe(10_000);
});
