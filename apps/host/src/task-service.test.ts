import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Session, TranscriptItem } from "@workbench/contracts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { reconcileReceipt, TaskService } from "./task-service.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-tasks-")), store = new Store(join(dir, "state.sqlite")), bus = new EventBus();
  const sessions: Session[] = [], histories = new Map<string, TranscriptItem[]>();
  const stop = vi.fn(async () => {});
  const hooks = { sessions: () => sessions, items: (id: string) => histories.get(id) ?? [], canSteer: () => true,
    stop, approve: vi.fn(async () => {}), cancelQueue: vi.fn(), sendQueue: vi.fn(async () => {}) };
  const service = new TaskService(store, bus, hooks);
  cleanup.push(() => { service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = (id: string, parent?: string) => {
    const value: Session = { id, workId: "work", workspaceId: "workspace", hostId: "host", nativeSessionId: `native-${id}`, provider: "codex",
      purpose: id, purposeSource: "user", model: null, effort: null, engineModel: null, engineEffort: null, preview: null, previewAt: null,
      status: "running", activity: "실행 중", lastError: null, pinned: false, sort: 0, archivedAt: null, seenAt: null,
      unread: false, queued: [], access: null, context: null, createdAt: 1, updatedAt: 2,
      ...(parent ? { documentAgent: { artifactId: "document", parentSessionId: parent } } : {}) };
    sessions.push(value); histories.set(id, [{ kind: "user", id: `user:${id}-request`, text: "원문 요청", at: 1 }]); return value;
  };
  return { store, bus, service, hooks, histories, sessions, session, stop };
}

test("projects independent document runs and provider children without granting native child control", () => {
  const f = fixture(); const parent = f.session("main"), child = f.session("document", parent.id);
  f.bus.publish({ type: "item.upserted", sessionId: child.id, item: f.histories.get(child.id)![0]! });
  f.histories.get(parent.id)!.push({ kind: "tool", tool: "agent", id: "spawn", title: "조사", detail: null, output: null, status: "running", at: 2,
    agent: { operation: "spawnAgent", children: [{ nativeSessionId: "native-child", state: "running" }] } });
  const tasks = f.service.list({ workId: "work" }).tasks;
  expect(tasks.find(t => t.sessionId === child.id)).toMatchObject({ executorKind: "office", parentRunId: "main/main-request", state: "running" });
  expect(tasks.find(t => t.nativeSessionId === "native-child")).toMatchObject({ executorKind: "native_agent", capabilities: { observe: true, stop: false, send: false } });
  f.histories.get(parent.id)!.push({ kind: "user", id: "user:next-parent", text: "다른 메인 요청", at: 3 });
  expect(f.service.list().tasks.find(t => t.sessionId === child.id)?.parentRunId).toBe("main/main-request");
});

test("keeps unknown receipts after response loss/restart and never repeats a command", async () => {
  const f = fixture(); f.session("main"); f.stop.mockRejectedValueOnce(Error("transport lost"));
  const command = { commandId: "stop-once", target: f.service.list().tasks[0]!, kind: "stop" as const };
  const first = await f.service.command(command);
  expect(first.status).toBe("outcome_unknown");
  expect(reconcileReceipt(first, { kind: "transport_retry" }).status).toBe("outcome_unknown");
  f.service.close(); const restarted = new TaskService(f.store, f.bus, f.hooks);
  try { expect((await restarted.command(command)).status).toBe("outcome_unknown"); expect(f.stop).toHaveBeenCalledTimes(1); }
  finally { restarted.close(); }
  await expect(f.service.command({ ...command, kind: "send_queue", queuedId: "changed" })).rejects.toMatchObject({ code: "task_command_conflict" });
});

test("rejects another host and a previous run before calling provider controls", async () => {
  const f = fixture(); f.session("main");
  const target = f.service.list().tasks[0]!;
  await expect(f.service.command({ commandId: "wrong-host", target: { ...target, hostId: "other" }, kind: "stop" })).rejects.toMatchObject({ code: "task_target_mismatch" });
  f.histories.get("main")!.push({ kind: "user", id: "user:new-request", text: "새 실행", at: 5 });
  await expect(f.service.command({ commandId: "old-run", target, kind: "stop" })).rejects.toMatchObject({ code: "task_target_stale" });
  expect(f.stop).not.toHaveBeenCalled();
});

test("separates approvals, held queue and interrupted completion", () => {
  const f = fixture(); const session = f.session("main");
  session.queued = [{ id: "queued", text: "다음 요청", refs: [], create: null, at: 2, held: true }];
  f.histories.get("main")!.push({ kind: "approval", id: "permission", title: "명령 확인", detail: null, reason: null, decision: null, at: 2 });
  expect(f.service.list().tasks.map(t => t.state)).toEqual(expect.arrayContaining(["waiting_input", "queued"]));
  f.histories.get("main")!.pop();
  f.histories.get("main")!.push({ kind: "turnEnd", id: "end", status: "interrupted", cause: "restart", durationMs: null, at: 4 });
  expect(f.service.list().tasks.find(t => t.requestId === "main-request")?.state).toBe("interrupted");
});
