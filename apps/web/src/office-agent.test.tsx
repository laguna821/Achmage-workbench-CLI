import { expect, it, vi } from "vitest";
import { WorkbenchAgentLoop, type OfficeConversationPort, type OfficeRun } from "../../office/src/office-agent.ts";
import type { AgentStreamCallbacks, AgentStreamRequest } from "../../../vendor/ieumoffice/packages/agent-core/src/types.ts";
import type { OfficeTurnEvent } from "../../../packages/contracts/src/office-ai.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function fixture(options: { append?: OfficeRun["append"]; save?: OfficeRun["save"]; begin?: OfficeConversationPort["begin"]; stream?: (request: AgentStreamRequest, callbacks: AgentStreamCallbacks, index: number) => void } = {}) {
  const log: string[] = [], recorded: OfficeTurnEvent[] = [], requests: AgentStreamRequest[] = [];
  const done = vi.fn(), failed = vi.fn(), execute = vi.fn(async () => { log.push("edit"); return { summary: "문단 수정", output: "수정됨", mutated: true }; });
  const finish = vi.fn(async (status: string) => { log.push(`finish:${status}`); });
  const run: OfficeRun = { history: [{ role: "user", text: "이전 CLI 요청" }, { role: "assistant", text: "이전 CLI 응답" }],
    append: async (events) => { await options.append?.(events); recorded.push(...events); log.push(...events.map((e) => e.kind === "tool" ? e.status : e.kind)); },
    save: async () => { log.push("save"); await options.save?.(); }, finish };
  const port: OfficeConversationPort = { begin: options.begin ?? (async () => { log.push("start"); return run; }), attach: () => () => { log.push("release"); } };
  const loop = new WorkbenchAgentLoop({
    skill: { id: "fixture", systemPrompt: "Edit the test document", tools: [{ name: "edit", description: "edit a paragraph", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }], executeTool: execute },
    transport: { stream: (request, callbacks) => {
      requests.push(request); log.push("model");
      queueMicrotask(() => {
        if (options.stream) { options.stream(request, callbacks, requests.length); return; }
        if (requests.length === 1) callbacks.onToolCall({ id: "provider:tool/1", name: "edit", input: { text: "새 문단" } });
        else callbacks.onDelta("문단을 수정했습니다.");
        callbacks.onDone();
      });
      return { cancel: () => { queueMicrotask(() => callbacks.onDone()); } };
    } },
    events: { onDone: done, onError: failed },
  }, port);
  return { loop, log, recorded, requests, done, failed, execute, run, finish };
}

it("awaits the Workbench start and tool-start record before editing, then saves before the next model call", async () => {
  const ack = deferred<void>();
  const f = fixture({ append: async (events) => { if (events.some((e) => e.kind === "tool" && e.status === "running")) await ack.promise; } });
  f.loop.run("문단을 바꿔 줘");
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  expect(f.execute).not.toHaveBeenCalled(); expect(f.done).not.toHaveBeenCalled();
  ack.resolve(); await f.loop.settled;
  expect(f.failed).not.toHaveBeenCalled(); expect(f.done).toHaveBeenCalledOnce();
  expect(f.log.slice(0, 7)).toEqual(["start", "model", "running", "edit", "completed", "save", "model"]);
  expect(f.log.at(-2)).toBe("finish:completed");
  expect(f.recorded).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "assistant", text: "문단을 수정했습니다.", streaming: false })]));
  expect(f.requests[0]!.messages.some((m) => m.role === "assistant" && m.text === "이전 CLI 응답")).toBe(true);
  expect(f.recorded.find((e) => e.kind === "tool")!.id).toMatch(/^[A-Za-z0-9_-]+$/);
});
it("never executes a tool whose durable start record was rejected", async () => {
  const f = fixture({ append: async () => { throw new Error("SQLite write refused"); } });
  f.loop.run("edit"); await f.loop.settled;
  expect(f.execute).not.toHaveBeenCalled(); expect(f.requests).toHaveLength(1);
  expect(f.finish).toHaveBeenCalledWith("failed", "SQLite write refused");
  expect(f.failed).toHaveBeenCalledWith("SQLite write refused");
});
it("a failed document save preserves the tool result and stops further model calls", async () => {
  const f = fixture({ save: async () => { throw new Error("revision conflict"); } });
  f.loop.run("edit"); await f.loop.settled;
  expect(f.execute).toHaveBeenCalledOnce(); expect(f.requests).toHaveLength(1);
  expect(f.recorded).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "tool", status: "completed", output: "수정됨" })]));
  expect(f.failed).toHaveBeenCalledWith("revision conflict");
});
it("cancels a request still awaiting its start receipt without invoking a provider", async () => {
  const ready = deferred<OfficeRun>();
  const f = fixture({ begin: () => ready.promise });
  f.loop.run("edit"); f.loop.cancel(); ready.resolve(f.run); await f.loop.settled;
  expect(f.requests).toHaveLength(0); expect(f.finish).toHaveBeenCalledWith("interrupted", undefined);
  expect(f.done).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true }));
});
it("unmounting cancels and records the owned run without sending callbacks into the retired panel", async () => {
  const f = fixture({ stream: (_request, cb) => { cb.onDelta("중간 답변"); } });
  f.loop.run("edit"); await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  f.loop.reset(); await f.loop.settled;
  expect(f.finish).toHaveBeenCalledWith("interrupted", undefined);
  expect(f.recorded).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "assistant", text: "중간 답변", streaming: false })]));
  expect(f.done).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
});
it("freshly loads the Workbench transcript on each follow-up", async () => {
  const f = fixture({ stream: (_request, cb) => { cb.onDelta("대답"); cb.onDone(); } });
  f.loop.run("one"); await f.loop.settled;
  f.run.history.push({ role: "user", text: "다른 화면에서 보낸 요청" }, { role: "assistant", text: "다른 화면의 답변" });
  f.loop.run("two"); await f.loop.settled;
  expect(f.requests[1]!.messages.some((m) => m.role === "assistant" && m.text === "다른 화면의 답변")).toBe(true);
  expect(f.done).toHaveBeenCalledTimes(2);
});

it("coalesces rapid stream deltas while durably retaining the final answer on cancellation", async () => {
  const f = fixture({ stream: (_request, cb) => { for (let i = 0; i < 1000; i++) cb.onDelta("가"); } });
  f.loop.run("long answer");
  await vi.waitFor(() => expect(f.recorded.filter((e) => e.kind === "assistant")).toHaveLength(1));
  expect(f.recorded[0]).toMatchObject({ text: "가".repeat(1000), streaming: true });
  f.loop.cancel(); await f.loop.settled;
  expect(f.recorded.filter((e) => e.kind === "assistant")).toHaveLength(2);
  expect(f.recorded.at(-1)).toMatchObject({ text: "가".repeat(1000), streaming: false });
});
