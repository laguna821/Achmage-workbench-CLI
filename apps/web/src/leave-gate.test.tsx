import { expect, it, vi } from "vitest";
import { LeaveGate } from "./leave-gate.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
it("never treats another tab's pending save as confirmation for the current tab", async () => {
  const gate = new LeaveGate(); let oldSaved!: () => void;
  const opened = vi.fn(), failed = vi.fn();
  gate.run("group", () => new Promise<void>((resolve) => { oldSaved = resolve; }), vi.fn(), failed, "hidden-tab");
  gate.run("group", async () => { throw new Error("current document conflict"); }, opened, failed, "current-tab");
  await settle(); oldSaved(); await settle();
  expect(failed).toHaveBeenCalledOnce(); expect(opened).not.toHaveBeenCalled();
});
it("keeps the current view after a rejected save and allows a later successful retry", async () => {
  const gate = new LeaveGate(), proceed = vi.fn(), failed = vi.fn();
  gate.run("a", async () => { throw new Error("save conflict"); }, proceed, failed);
  await settle();
  expect(proceed).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce();
  gate.run("a", async () => {}, proceed, failed);
  await settle(); expect(proceed).toHaveBeenCalledOnce();
});
it("shares a pending save and opens only the latest destination without blocking another pane", async () => {
  const gate = new LeaveGate(); let saved!: () => void;
  const guard = vi.fn(() => new Promise<void>((resolve) => { saved = resolve; }));
  const first = vi.fn(), last = vi.fn(), other = vi.fn();
  gate.run("a", guard, first, vi.fn()); gate.run("a", guard, last, vi.fn());
  gate.run("b", null, other, vi.fn());
  await settle(); expect(guard).toHaveBeenCalledOnce(); expect(other).toHaveBeenCalledOnce();
  expect(last).not.toHaveBeenCalled(); saved(); await settle();
  expect(first).not.toHaveBeenCalled(); expect(last).toHaveBeenCalledOnce();
});
it("ignores completion of an older save after a newer navigation already happened", async () => {
  const gate = new LeaveGate(); let saved!: () => void;
  const old = vi.fn(), next = vi.fn();
  gate.run("a", () => new Promise<void>((resolve) => { saved = resolve; }), old, vi.fn());
  await settle(); gate.run("a", null, next, vi.fn()); saved(); await settle();
  expect(old).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledOnce();
});
