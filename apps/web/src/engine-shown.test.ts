import { afterEach, expect, it, vi } from "vitest";
import { createShownReporter } from "./engine-shown.ts";

afterEach(() => { vi.useRealTimers(); });

it("tells the gateway which conversations are on screen, once per change, after the screen settles (A11)", async () => {
  vi.useFakeTimers();
  const sent: string[][] = [];
  const reporter = createShownReporter(async (ids) => { sent.push(ids); }, 300);
  reporter.report(["a"]);
  reporter.report(["a", "b"]);
  expect(sent).toEqual([]);
  await vi.advanceTimersByTimeAsync(300);
  expect(sent).toEqual([["a", "b"]]);
  // The same set again (a re-render): nothing sent.
  reporter.report(["b", "a"]);
  await vi.advanceTimersByTimeAsync(300);
  expect(sent).toHaveLength(1);
  // The gateway came back (a restart): the set is said again.
  reporter.again();
  await vi.advanceTimersByTimeAsync(300);
  expect(sent).toEqual([["a", "b"], ["a", "b"]]);
  reporter.report([]);
  await vi.advanceTimersByTimeAsync(300);
  expect(sent.at(-1)).toEqual([]);
});

it("a failed report is tried again with the next change or reconnect", async () => {
  vi.useFakeTimers();
  let fail = true;
  const sent: string[][] = [];
  const reporter = createShownReporter(async (ids) => { if (fail) throw new Error("offline"); sent.push(ids); }, 100);
  reporter.report(["a"]);
  await vi.advanceTimersByTimeAsync(100);
  fail = false;
  reporter.again();
  await vi.advanceTimersByTimeAsync(100);
  expect(sent).toEqual([["a"]]);
});
