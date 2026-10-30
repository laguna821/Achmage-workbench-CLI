// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OfficeHostMessage, OfficePageMessage } from "@workbench/contracts";
import type { AgentStreamCallbacks, AgentStreamRequest } from "../../../vendor/ieumoffice/packages/agent-core/src/types.ts";
import { Events, type Gateway, type Init } from "../../office/src/bridge.ts";
import { createOfficeAi } from "../../office/src/office-ai.ts";
import { WorkbenchAgentLoop } from "../../office/src/office-agent.ts";

const wire = vi.hoisted(() => ({ handlers: [] as ((message: OfficeHostMessage) => void)[], post: vi.fn() }));
vi.mock("../../office/src/bridge.ts", async (original) => ({
  ...await original<typeof import("../../office/src/bridge.ts")>(),
  listen: (handler: (message: OfficeHostMessage) => void) => { wire.handlers.push(handler); return () => {}; },
  post: wire.post,
}));
beforeEach(() => { wire.handlers.length = 0; wire.post.mockClear(); });
afterEach(() => vi.useRealTimers());

function fixture(initial: string | null = null, hold = false) {
  let selected = initial, token = "initial";
  const calls: { operation: string; token: string; body?: unknown }[] = [];
  const gateway = {
    setToken: (value: string) => { token = value; },
    aiSession: () => {
      const captured = token;
      return { json: async (operation: string, body?: unknown) => {
        calls.push({ operation, token: captured, body });
        if (operation === "history") return { workId: "work", sessionId: selected, items: [] };
        if (operation === "turn-start") return { status: "running", duplicate: false };
        return {};
      } };
    },
  } as unknown as Gateway;
  const init: Init = { type: "office:init", token, sessionId: initial, artifact: { id: "doc", name: "test.docx", path: "/test.docx", revision: 1, sha256: "hash" }, readOnly: false, theme: "light", recover: true };
  const ai = createOfficeAi(init, gateway, new Events());
  const model = vi.fn((_request: AgentStreamRequest, cb: AgentStreamCallbacks) => {
    queueMicrotask(() => { cb.onDelta("대답"); if (!hold) cb.onDone(); });
    return { cancel: () => queueMicrotask(() => cb.onDone()) };
  });
  const done = vi.fn(), failed = vi.fn(), changed = vi.fn(); ai.subscribe(changed);
  const loop = new WorkbenchAgentLoop({ skill: { id: "fixture", systemPrompt: "fixture", tools: [], executeTool: async () => ({ summary: "unused", output: "unused" }) }, transport: { stream: model }, events: { onDone: done, onError: failed } });
  const receive = (message: OfficeHostMessage) => wire.handlers.forEach((handler) => handler(message));
  const request = () => wire.post.mock.calls.at(-1)![0] as Extract<OfficePageMessage, { type: "office:ai-request" }>;
  const grant = (id: string | null) => { selected = id; receive({ type: "office:grant", token: `token-${id}`, sessionId: id }); };
  const reply = (id: string, createdSession = true) => {
    selected = id;
    receive({ type: "office:ai-result", requestId: request().requestId, value: { revision: 2, token: `token-${id}`, sessionId: id, createdSession } });
  };
  return { ai, loop, calls, model, done, failed, changed, receive, request, grant, reply };
}

it.each(["grant-first", "reply-first"])("keeps the first instruction and original panel through its own initial binding (%s)", async (order) => {
  const f = fixture(), panelKey = f.ai.snapshot();
  f.loop.run("처음 요청");
  expect(f.request()).toMatchObject({ action: "prepare", sessionId: null });
  expect(f.model).not.toHaveBeenCalled();
  if (order === "grant-first") { f.grant("created"); expect(f.changed).not.toHaveBeenCalled(); }
  f.reply("created");
  if (order === "reply-first") f.grant("created");
  await f.loop.settled;
  expect(f.ai.snapshot()).toBe(panelKey); expect(f.changed).not.toHaveBeenCalled();
  expect(f.failed).not.toHaveBeenCalled(); expect(f.done).toHaveBeenCalledOnce(); expect(f.model).toHaveBeenCalledOnce();
  expect(f.calls.find((call) => call.operation === "turn-start")).toMatchObject({ token: "token-created", body: { instruction: "처음 요청", revision: 2 } });
  expect(await f.ai.projectApi.resolveChat()).toEqual({ projectId: "work", chatId: "created" });
  f.loop.run("두 번째 요청"); expect(f.request()).toMatchObject({ action: "prepare", sessionId: "created" });
  f.reply("created", false); await f.loop.settled;
  expect(f.model).toHaveBeenCalledTimes(2); expect(f.calls.filter((call) => call.operation === "turn-start")).toHaveLength(2);
});
it("does not adopt an unrelated selection that happened during the first binding", async () => {
  const f = fixture(); f.loop.run("처음 요청");
  f.grant("other"); f.grant("created"); f.reply("created"); await f.loop.settled;
  expect(f.model).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0); expect(f.changed).toHaveBeenCalledOnce();
});
it("requires the parent's explicit creation receipt to preserve an unbound panel", async () => {
  const f = fixture(); f.loop.run("처음 요청"); f.reply("existing", false); await f.loop.settled;
  expect(f.model).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0); expect(f.failed).toHaveBeenCalledWith(expect.stringContaining("세션이 바뀌"));
});
it("does not start a turn when cancelled while its first session is being prepared", async () => {
  const f = fixture(); f.loop.run("처음 요청"); f.loop.cancel(); f.grant("created"); f.reply("created"); await f.loop.settled;
  expect(f.model).not.toHaveBeenCalled(); expect(f.calls.some((call) => call.operation === "turn-start")).toBe(false);
});
it("ends a failed binding and ignores its late success without invoking a model", async () => {
  const f = fixture(); f.loop.run("처음 요청"); const requestId = f.request().requestId;
  f.receive({ type: "office:ai-result", requestId, error: "저장 실패" }); await f.loop.settled;
  f.receive({ type: "office:ai-result", requestId, value: { revision: 2, token: "late", sessionId: "created", createdSession: true } });
  expect(f.failed).toHaveBeenCalledWith("저장 실패"); expect(f.model).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0);
});
it("does not preserve a later user-selected conversation change during an active run", async () => {
  const f = fixture(null, true); f.loop.run("처음 요청"); f.reply("created");
  await vi.waitFor(() => expect(f.model).toHaveBeenCalledOnce());
  f.grant("other"); await f.loop.settled;
  expect(f.ai.snapshot()).toBe("other"); expect(f.changed).toHaveBeenCalledOnce();
  expect(f.calls.find((call) => call.operation === "turn-finish")).toMatchObject({ token: "token-created", body: { status: "interrupted" } });
  expect(f.done).not.toHaveBeenCalled();
});
it("clears an expired binding before accepting a late unrelated grant", async () => {
  vi.useFakeTimers(); const f = fixture(); f.loop.run("처음 요청"); const requestId = f.request().requestId;
  await vi.advanceTimersByTimeAsync(25_000); await f.loop.settled;
  f.grant("other");
  f.receive({ type: "office:ai-result", requestId, value: { revision: 2, token: "late", sessionId: "created", createdSession: true } });
  expect(f.failed).toHaveBeenCalledWith(expect.stringContaining("초과")); expect(f.ai.snapshot()).toBe("other");
  expect(f.model).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0);
});
