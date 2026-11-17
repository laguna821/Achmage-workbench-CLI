// @vitest-environment jsdom
// Point 4 (brief office-ai-live): a turn sent while the editor is on screen runs in that editor (its edits
// arrive live); one sent while it is hidden goes to the independent executor, as before.
import { afterEach, expect, it, vi } from "vitest";
import type { OfficeHostMessage, OfficePageMessage } from "@workbench/contracts";
import { Gateway, Events, listen, pageRest, type Init } from "./bridge.ts";
import { createOfficeAi, runsLiveHere } from "./office-ai.ts";
import { WorkbenchAgentLoop } from "./office-agent.ts";
import { registerOriginalExecutor } from "./execution-adapter.ts";

const wire = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("./bridge.ts", async original => ({ ...await original<typeof import("./bridge.ts")>(), post: wire.post }));
afterEach(() => { window.dispatchEvent(new Event("pagehide")); vi.unstubAllGlobals(); wire.post.mockReset(); pageRest.shown(true); localStorage.clear(); });

async function turn(path = "/a.docx", options: { never?: boolean; during?: (receive: (data: OfficeHostMessage) => void) => Promise<void> } = {}) {
  const init: Init = { type: "office:init", token: "ui", sessionId: "session", artifact: { id: "doc", name: path.slice(1), path, revision: 1, sha256: "h" }, readOnly: false, theme: "light", recover: false };
  const paths: string[] = [];
  const receive = (data: OfficeHostMessage) => window.dispatchEvent(new MessageEvent("message", { origin: location.origin, source: window, data }));
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    paths.push(path.replace(/^.*\/ai\//, ""));
    const value = path.endsWith("/history") ? { workId: "work", sessionId: "session", items: [] }
      : path.endsWith("/turn-start") ? { turnId: "t", sessionId: "session", duplicate: false, status: "running", executorAvailable: true, executionToken: "exec" }
      : path.endsWith("/executor-observe") ? { receipt: { turnId: "t", status: "completed" }, items: [] }
      : path.endsWith("/drive-state") ? { enabled: false, connected: false } : {};
    return new Response(JSON.stringify(value), { status: 200 });
  }));
  wire.post.mockImplementation((message: OfficePageMessage) => {
    if (message.type === "office:ai-request") receive({ type: "office:ai-result", requestId: message.requestId, value: { revision: 1, token: "ui", sessionId: "session" } });
  });
  const off = registerOriginalExecutor({ ready: () => true, capture: () => ({ format: "docx", data: {} }), execute: () => true, lock: () => {} });
  createOfficeAi(init, new Gateway(init.token), new Events());
  const real = await vi.importActual<typeof import("./bridge.ts")>("./bridge.ts");
  const stop = listen(message => { if (message.type === "office:flush") real.post({ type: "office:flushed", revision: 2 }); });
  const edits: string[] = [];
  let calls = 0;
  const loop = new WorkbenchAgentLoop({
    skill: { id: "fixture", systemPrompt: "", tools: [{ name: "replace_blocks", description: "", inputSchema: { type: "object" } }], executeTool: () => { edits.push("edited here"); return { summary: "edit", output: "ok", mutated: true }; } },
    transport: { stream: (_request, callbacks) => { queueMicrotask(() => { if (++calls === 1) callbacks.onToolCall({ id: "c", name: "replace_blocks", input: {} }); else if (options.never) return; else callbacks.onDelta("done"); callbacks.onDone(); }); return { cancel: () => callbacks.onDone() }; } },
    events: { onDone: () => {}, onError: () => {} },
  });
  loop.run("고쳐 줘");
  if (options.during) await options.during(receive);
  await loop.settled; off(); stop();
  return { paths, edits };
}

it("on screen: the turn runs in the visible editor, no executor", async () => {
  expect(runsLiveHere()).toBe(true);
  const { paths, edits } = await turn();
  expect(paths).not.toContain("executor-start");
  expect(edits).toEqual(["edited here"]);
  // The window is told the live turn runs here (its tab's closing keeps the page), then that it ended.
  const live = wire.post.mock.calls.map(([message]) => message).filter((message) => message.type === "office:live-turn");
  expect(live).toEqual([{ type: "office:live-turn", running: true }, { type: "office:live-turn", running: false }]);
});
it("a kept closed tab's turn with no sign of life is stopped by the page itself, and the page is let go", async () => {
  Object.assign(window, { workbenchEditorHold: { state: { view: () => ({ silent: true }) } } });
  try {
    await turn("/a.docx", { never: true, during: async (receive) => {
      await vi.waitFor(() => expect(wire.post.mock.calls.some(([message]) => message.type === "office:live-turn" && message.running)).toBe(true));
      receive({ type: "office:kept-closed", closed: true });
      await new Promise((resolve) => setTimeout(resolve, 5_500));
    } });
    const live = wire.post.mock.calls.map(([message]) => message).filter((message) => message.type === "office:live-turn");
    expect(live.at(-1)).toEqual({ type: "office:live-turn", running: false });
  } finally { delete (window as { workbenchEditorHold?: unknown }).workbenchEditorHold; }
}, 15_000);
it("hidden: the turn goes to the independent executor", async () => {
  pageRest.shown(false);
  expect(runsLiveHere()).toBe(false);
  const { paths, edits } = await turn();
  expect(paths).toContain("executor-start");
  expect(edits).toEqual([]);
});
it("the Hangul editor keeps 0.5.2's executor path, on screen too", async () => {
  const { paths } = await turn("/b.hwpx");
  expect(paths).toContain("executor-start");
});
it("the rig's measuring knob keeps 0.5.2's executor path", () => {
  localStorage.setItem("workbench.check.office-ai", "executor");
  expect(runsLiveHere()).toBe(false);
});
