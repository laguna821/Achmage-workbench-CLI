import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopEnvelope, Session, TranscriptItem } from "@workbench/contracts";
import { DesktopService, type DesktopRunner } from "./desktop-adapter.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture(action?: DesktopRunner) {
  const dir = mkdtempSync(join(tmpdir(), "workbench-desktop-test-")), meta = new Map<string, string>(), items: TranscriptItem[] = [], calls: string[][] = [];
  let instance = "process-start-1", n = 0;
  const run: DesktopRunner = async (args, signal) => {
    calls.push(args);
    const command = args.includes("snapshot") ? "snapshot" : args.includes("list-windows") ? "list-windows" : args.at(-2) ?? "click";
    if (command === "list-windows") return { version: "2.6", command, ok: true, data: [{ id: "window-1", app_name: "Editor", title: "Draft", pid: 123, process_instance: instance }] };
    if (command === "snapshot") return { version: "2.6", command, ok: true, data: { app: "Editor", window: { id: "window-1" }, snapshot_id: `snap${++n}`, complete: false, tree: [{ ref: `@snap${n}:e1`, role: "button" }] } };
    return action ? action(args, signal) : { version: "2.6", command: "click", ok: true, data: { disposition: { delivery: "delivered_unverified", retry: "unsafe" } } };
  };
  const store = { getMeta: (key: string) => meta.get(key) ?? null, setMeta: (key: string, value: string) => { meta.set(key, value); }, metaEntries: (prefix: string) => [...meta].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) };
  const service = new DesktopService(dir, store, { session: id => ({ id, archivedAt: null }) as Session, item: (_id, item) => items.push(item) }, run);
  cleanup.push(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
  return { service, calls, items, changeInstance: () => { instance = "process-start-2"; } };
}
describe("official desktop adapter session boundary and delivery", () => {
  it("requires an explicit selected window, preserves partial snapshots and refuses a changed process", async () => {
    const f = fixture(); await expect(f.service.observe("one")).rejects.toThrow("먼저 연결");
    await f.service.bind("one", "window-1", false); const view = await f.service.observe("one"); expect(view.complete).toBe(false);
    await expect(f.service.act("one", { commandId: "stale-ref-1", observationId: view.id, action: "click", ref: "@old:e1" })).rejects.toThrow("현재 관찰");
    f.changeInstance(); await expect(f.service.act("one", { commandId: "changed-1", observationId: view.id, action: "click", ref: `@${view.snapshotId}:e1` })).rejects.toThrow("실행 인스턴스");
    expect(f.calls.some(args => args.includes("click"))).toBe(false);
  });
  it("records delivery separately from app saving, and repeated command IDs execute only once", async () => {
    const f = fixture(); await f.service.bind("one", "window-1", false); const view = await f.service.observe("one");
    const input = { commandId: "one-click-1", observationId: view.id, action: "click" as const, ref: `@${view.snapshotId}:e1` };
    const receipt = await f.service.act("one", input); expect(receipt.delivery).toBe("delivered_unverified"); expect(receipt.state).toBe("completed");
    expect(await f.service.act("one", input)).toEqual(receipt); expect(f.calls.filter(args => args.includes("click"))).toHaveLength(1);
    expect(f.items.at(-1)).toMatchObject({ kind: "tool", status: "completed" });
  });
  it("keeps uncertain actions unknown after reobservation, without retrying them", async () => {
    const f = fixture(async () => { throw new Error("transport closed after delivery"); });
    await f.service.bind("one", "window-1", false); const view = await f.service.observe("one");
    const input = { commandId: "unknown-1", observationId: view.id, action: "click" as const, ref: `@${view.snapshotId}:e1` };
    const receipt = await f.service.act("one", input); expect(receipt.state).toBe("outcome_unknown");
    expect(await f.service.act("one", input)).toEqual(receipt);
    await expect(f.service.act("one", { ...input, commandId: "unknown-2" })).rejects.toThrow("불명확");
    const reconciled = await f.service.reconcile("one", receipt.id); expect(reconciled.receipt.state).toBe("outcome_unknown"); expect(reconciled.observation.id).not.toBe(view.id);
    expect(f.calls.filter(args => args.includes("click"))).toHaveLength(1);
  });
  it("serializes physical input across sessions and aborts only its owned action on human takeover", async () => {
    let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    const f = fixture((_args, signal) => new Promise<DesktopEnvelope>((_resolve, reject) => { started(); signal.addEventListener("abort", () => reject(new Error("person took over")), { once: true }); }));
    await f.service.bind("one", "window-1", true); await f.service.bind("two", "window-1", true);
    const a = await f.service.observe("one"), b = await f.service.observe("two");
    const first = f.service.act("one", { commandId: "input-first", observationId: a.id, action: "click", ref: `@${a.snapshotId}:e1` }); await entered;
    await expect(f.service.act("two", { commandId: "input-second", observationId: b.id, action: "click", ref: `@${b.snapshotId}:e1` })).rejects.toThrow("키보드");
    f.service.takeOver(); expect((await first).state).toBe("outcome_unknown"); expect(f.service.targetFor("one")).toBeNull(); expect(f.service.input.owner).toBeNull();
    expect(f.calls.filter(args => args.includes("click"))).toHaveLength(1);
  });
});
