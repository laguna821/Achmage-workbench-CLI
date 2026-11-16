// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

// The real path by which 0.5.1 left the Hangul editor held ("everything locked"): the executor turn's
// observer gave up after failed looks (gateway restarted, old grant refused) WITHOUT releasing the
// lock, and the reopened-view observer swallowed its errors and kept it.
const lock = vi.fn();
vi.mock("./execution-adapter.ts", () => ({ lockOfficeExecution: (value: boolean) => lock(value) }));
vi.mock("./bridge.ts", () => ({ post: () => {} }));
const { remoteOfficeRun, observeOfficeExecution } = await import("./execution-client.ts");
const { onTurnActivity } = await import("./turn-activity.ts");

const refused = () => Object.assign(new Error("unauthorized"), { status: 401 });
afterEach(() => { lock.mockClear(); vi.useRealTimers(); });

it("a refused look at an executor turn releases the hold and says why", async () => {
  const events: unknown[] = []; const off = onTurnActivity(e => events.push(e));
  const api = { json: vi.fn(async () => { throw refused(); }) };
  await expect(remoteOfficeRun(api as never, "t").wait(() => {})).rejects.toThrow();
  expect(lock).toHaveBeenLastCalledWith(false);
  expect(events.at(-1)).toMatchObject({ kind: "end", status: "lost" });
  off();
});
it("five failed looks (unreachable gateway) release the hold", async () => {
  vi.useFakeTimers();
  const api = { json: vi.fn(async () => { throw new Error("network"); }) };
  const done = remoteOfficeRun(api as never, "t").wait(() => {}).catch(e => e);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await done).toBeInstanceOf(Error);
  expect(api.json).toHaveBeenCalledTimes(5);
  expect(lock).toHaveBeenLastCalledWith(false);
});
it("tool lines of the executor turn are told as they arrive (not only its answer)", async () => {
  const events: { kind: string }[] = []; const off = onTurnActivity(e => events.push(e));
  let n = 0;
  const api = { json: vi.fn(async () => (++n === 1
    ? { receipt: { turnId: "t", status: "running" }, items: [{ kind: "tool", id: "a", tool: "mcp", title: "use_skill", detail: "use_skill\n{}", status: "running" }] }
    : { receipt: { turnId: "t", status: "completed" }, items: [{ kind: "tool", id: "a", tool: "mcp", title: "스킬", detail: "use_skill\n{}", status: "completed" }, { kind: "assistant", id: "b", text: "끝" }] })) };
  vi.useFakeTimers();
  const result = remoteOfficeRun(api as never, "t").wait(() => {});
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await result).toMatchObject({ text: "끝" });
  expect(events.filter(e => e.kind === "tool")).toMatchObject([{ name: "use_skill", status: "running" }, { name: "use_skill", status: "completed" }]);
  expect(events.at(-1)).toMatchObject({ kind: "end", status: "completed" });
  expect(lock).toHaveBeenLastCalledWith(false);
  off();
});
it("the reopened-view observer lets go of a hold it cannot confirm", async () => {
  vi.useFakeTimers();
  let fail = false;
  const api = { json: vi.fn(async () => { if (fail) throw new Error("network"); return { receipt: { turnId: "t", status: "running" }, items: [] }; }) };
  observeOfficeExecution(() => api as never, () => false);
  await vi.advanceTimersByTimeAsync(10);
  expect(lock).toHaveBeenLastCalledWith(true);
  fail = true;
  await vi.advanceTimersByTimeAsync(1_500 * 3 + 10);
  expect(lock).toHaveBeenLastCalledWith(false);
  window.dispatchEvent(new Event("pagehide"));
});
