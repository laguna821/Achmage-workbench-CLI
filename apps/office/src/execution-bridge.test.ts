// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { OfficeHostMessage, OfficePageMessage } from "@workbench/contracts";
import { Gateway, Events, listen, type Init } from "./bridge.ts";
import { createOfficeAi } from "./office-ai.ts";
import { WorkbenchAgentLoop } from "./office-agent.ts";

const wire = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("./bridge.ts", async original => ({ ...await original<typeof import("./bridge.ts")>(), post: wire.post }));
afterEach(() => { window.dispatchEvent(new Event("pagehide")); vi.unstubAllGlobals(); wire.post.mockReset(); });

it("saves a mutated tool with its pinned execution grant without another parent prepare", async () => {
  const originalBridge = await vi.importActual<typeof import("./bridge.ts")>("./bridge.ts");
  const init: Init = { type: "office:init", token: "ui-first", sessionId: "session", artifact: { id: "doc", name: "note.md", path: "/note.md", revision: 1, sha256: "hash" }, readOnly: false, theme: "light", recover: false };
  const requests: { path: string; token: string; body: unknown }[] = [];
  const receive = (data: OfficeHostMessage) => window.dispatchEvent(new MessageEvent("message", { origin: location.origin, source: window, data }));
  vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
    const token = new Headers(options.headers).get("authorization")!;
    requests.push({ path, token, body: options.body });
    const value = path.endsWith("/history") ? { workId: "work", sessionId: "session", items: [] }
      : path.endsWith("/turn-start") ? { turnId: "server", sessionId: "session", duplicate: false, status: "running", executionToken: "execution-capability" }
      : path.endsWith("/drive-state") ? { enabled: false, connected: false }
      : path.includes("/text?") ? { id: "doc", revision: 2, sha256: "new-hash" } : {};
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }));
  wire.post.mockImplementation((message: OfficePageMessage) => {
    if (message.type === "office:ai-request") receive({ type: "office:ai-result", requestId: message.requestId, value: { revision: 1, token: "ui-prepared", sessionId: "session" } });
  });
  const gateway = new Gateway(init.token); createOfficeAi(init, gateway, new Events());
  const stop = listen(message => {
    if (message.type === "office:flush") void gateway.saveText("doc", 1, "changed by original serializer").then(() => originalBridge.post({ type: "office:flushed", revision: 2 }));
  });
  let turns = 0;
  const done = vi.fn(), failed = vi.fn();
  const loop = new WorkbenchAgentLoop({
    skill: { id: "fixture", systemPrompt: "fixture", tools: [{ name: "edit", description: "edit", inputSchema: { type: "object" } }], executeTool: () => {
      receive({ type: "office:grant", token: "renewed-ui", sessionId: "session" });
      return { summary: "edit", output: "changed", mutated: true };
    } },
    transport: { stream: (_request, callbacks) => {
      queueMicrotask(() => { if (++turns === 1) callbacks.onToolCall({ id: "tool", name: "edit", input: {} }); else callbacks.onDelta("done"); callbacks.onDone(); });
      return { cancel: () => callbacks.onDone() };
    } }, events: { onDone: done, onError: failed },
  });
  try {
    loop.run("edit"); await loop.settled;
    expect(failed).not.toHaveBeenCalled(); expect(done).toHaveBeenCalledOnce();
    expect(wire.post.mock.calls.filter(([message]) => message.type === "office:ai-request")).toHaveLength(1);
    expect(requests.find(request => request.path.includes("/text?"))).toMatchObject({ token: "Bearer execution-capability", body: "changed by original serializer" });
    expect(requests.find(request => request.path.endsWith("/turn-finish"))?.token).toBe("Bearer execution-capability");
    await gateway.saveText("doc", 2, "manual next");
    expect(requests.at(-1)?.token).toBe("Bearer renewed-ui");
  } finally { stop(); }
});

it("attaches the original loop to an admitted executor turn without another prepare or turn-start", async () => {
  const init: Init = { type: "office:init", token: "execution-token", sessionId: "session", artifact: { id: "doc", name: "note.md", path: "/note.md", revision: 1, sha256: "hash" }, readOnly: false, theme: "light", recover: false, execution: { turnId: "same-turn" } };
  const calls: { path: string; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
    calls.push({ path, body: options.body ? JSON.parse(String(options.body)) : undefined });
    const value = path.endsWith("/history") ? { workId: "work", sessionId: "session", items: [{ id: "current", kind: "user", text: "original request", at: 1, office: { turnId: "same-turn", artifactId: "doc" } }] }
      : path.endsWith("/drive-state") ? { enabled: false, connected: false } : {};
    return new Response(JSON.stringify(value), { status: 200 });
  }));
  createOfficeAi(init, new Gateway(init.token), new Events());
  const done = vi.fn(), failure = vi.fn();
  const loop = new WorkbenchAgentLoop({ skill: { id: "fixture", systemPrompt: "", tools: [], executeTool: () => ({ summary: "", output: "" }) },
    transport: { stream: (_request, callbacks) => { queueMicrotask(() => { callbacks.onDelta("same answer"); callbacks.onDone(); }); return { cancel: () => callbacks.onDone() }; } },
    events: { onDone: done, onError: failure } });
  loop.run("original request"); await loop.settled;
  expect(failure).not.toHaveBeenCalled(); expect(done).toHaveBeenCalledOnce();
  expect(calls.some(call => call.path.endsWith("/turn-start"))).toBe(false);
  expect(wire.post.mock.calls.some(([message]) => message.type === "office:ai-request")).toBe(false);
  expect(calls.find(call => call.path.endsWith("/turn-finish"))?.body).toMatchObject({ turnId: "same-turn", status: "completed" });
  expect(calls.filter(call => call.path.endsWith("/turn-events")).every(call => call.body.turnId === "same-turn")).toBe(true);
});
