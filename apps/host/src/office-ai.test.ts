import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OfficeAi, officeAiRequest } from "./office-ai.ts";
import { createOfficeAiEngine, OFFICE_SECRET_PLACEHOLDER } from "./office-ai-engine.mjs";
import type { OfficeAiTestDeps } from "./office-ai-engine.mjs";
import { createEditorsServer, EditorGrants } from "./editors.ts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";

const noPrograms: OfficeAiTestDeps = { detect: async (provider) => ({ provider, state: "signed-out", loginMethod: "signed-out" }), listModels: async () => [] };
const turn = (settings: unknown, requestId = "turn", value = "hello") => ({ settings, requestId, sessionId: "shared-renderer-id", system: "Test system", messages: [{ role: "user", text: value }] });

async function fixture(deps: OfficeAiTestDeps = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-office-ai-"));
  const requests: { body: Record<string, unknown>; authorization?: string }[] = [];
  let disconnected = 0;
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += String(part);
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push({ body, authorization: req.headers.authorization });
    if (!body.stream) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: "한 번의 답" } }] })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const push = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    push({ content: "안녕 " });
    if (raw.includes('"wait"')) { res.once("close", () => { disconnected++; }); return; }
    push({ content: "세계" });
    push({ reasoning_content: "확인" });
    push({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "replace_text", arguments: '{"text":' } }] });
    push({ tool_calls: [{ index: 0, function: { arguments: '"새 글"}' } }] }, "tool_calls");
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 11 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
  mkdirSync(join(dir, "office"));
  const settingsPath = join(dir, "office", "ai-settings.json");
  const configure = (value: unknown) => writeFileSync(settingsPath, JSON.stringify(value), { mode: 0o600 });
  configure({ provider: "custom", providers: { custom: { apiKey: "fixture-key", model: "test-model", baseUrl: providerUrl } } });
  const engine = createOfficeAiEngine(dir, { ...noPrograms, ...deps });
  const store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "AI", cwd: join(dir, "project") }); mkdirSync(work.cwd, { recursive: true });
  const file = join(work.cwd, "one.md"), otherFile = join(work.cwd, "two.md");
  writeFileSync(file, "Document one"); writeFileSync(otherFile, "Document two");
  const first = manager.openFile(work.id, file), second = manager.openFile(work.id, otherFile);
  const grants = new EditorGrants(), access = { viewId: "view-a", writeToken: null };
  let token = grants.issue(first.id, access);
  const otherToken = grants.issue(second.id, { viewId: "view-b", writeToken: null });
  const sameDocumentToken = grants.issue(first.id, { viewId: "view-c", writeToken: null });
  const ai = new OfficeAi(dir, engine), server = createEditorsServer(manager.documents, grants, null, ai);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (operation: string, body?: unknown, grant = token, id = first.id, abort?: AbortSignal) => fetch(`${origin}/api/artifacts/${id}/ai/${operation}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${grant}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: abort });
  return {
    dir, ai, engine, configure, settingsPath, requests, request, first, second, otherToken, sameDocumentToken, disconnected: () => disconnected,
    refresh: () => { token = grants.issue(first.id, access); },
    close: async () => {
      ai.close(); server.closeAllConnections(); provider.closeAllConnections();
      await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => provider.close(() => resolve()))]);
      await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true });
    },
  };
}
const chunks = async (response: Response) => (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

describe("common Office AI", () => {
  it("uses the original provider protocol for text, reasoning, tools, usage and chat without exposing keys", async () => {
    const f = await fixture();
    try {
      const before = readFileSync(f.settingsPath);
      const settings = await (await f.request("settings")).json();
      expect(f.engine.settings()).toEqual(settings);
      expect(JSON.stringify(settings)).not.toContain("fixture-key");
      expect(settings.providers.custom.apiKey).toBe(OFFICE_SECRET_PLACEHOLDER);
      const response = await f.request("stream", { ...turn(settings), tools: [{ name: "replace_text", description: "replace", inputSchema: { type: "object" } }] });
      expect(response.status).toBe(200);
      const result = await chunks(response);
      expect(result.filter((c) => c.type === "error"), JSON.stringify(result)).toEqual([]);
      expect(result.filter((c) => c.type === "delta").map((c) => c.text).join("")).toBe("안녕 세계");
      expect(result.find((c) => c.type === "reasoning")).toMatchObject({ text: "확인" });
      expect(result.find((c) => c.type === "tool-call")).toMatchObject({ toolCall: { id: "call-1", name: "replace_text", input: { text: "새 글" } } });
      expect(result.find((c) => c.type === "usage")).toMatchObject({ usage: { inputTokens: 7, outputTokens: 11 } });
      expect(result.at(-1)).toMatchObject({ type: "done" });
      expect(result.findIndex((c) => c.type === "tool-call")).toBeGreaterThan(result.findIndex((c) => c.type === "reasoning"));
      expect(await (await f.request("chat", { settings, system: "test", user: "한국어" })).json()).toMatchObject({ ok: true, content: "한 번의 답" });
      expect(f.requests).toHaveLength(2);
      expect(f.requests.every((r) => r.authorization === "Bearer fixture-key")).toBe(true);
      expect(JSON.stringify(result)).not.toContain("fixture-key");
      expect(readFileSync(f.settingsPath)).toEqual(before);
    } finally { await f.close(); }
  });

  it("refuses stale or forged settings, unopened sealed keys and auto pay-per-use fallback", async () => {
    const f = await fixture({ detect: async (provider) => ({ provider, state: "metered", loginMethod: "metered", loginKind: "api-key", account: "fixture@example.com" }) });
    try {
      const settings = f.engine.settings();
      const forged = JSON.parse(JSON.stringify(settings)); forged.providers.custom.baseUrl = "https://example.invalid";
      forged.customEndpoints[0].baseUrl = "https://example.invalid";
      expect((await chunks(await f.request("stream", turn(forged)))).at(-1)).toMatchObject({ type: "error" });
      const forgedKey = JSON.parse(JSON.stringify(settings)); forgedKey.customEndpoints[0].apiKey = "not-the-saved-key";
      expect((await chunks(await f.request("stream", turn(forgedKey)))).at(-1)).toMatchObject({ type: "error" });
      f.configure({ provider: "custom", providers: { custom: { apiKey: "sealed:v1:ZmFrZQ==", model: "test-model", baseUrl: "http://127.0.0.1:1" } } });
      expect((await chunks(await f.request("stream", turn(f.engine.settings())))).at(-1)).toMatchObject({ type: "error" });
      f.configure({ provider: "auto", providers: {} });
      const before = readFileSync(f.settingsPath);
      expect((await chunks(await f.request("stream", turn(settings)))).at(-1)).toMatchObject({ type: "error" });
      const statuses = await (await f.request("statuses")).json();
      expect(JSON.stringify(statuses)).not.toContain("fixture@example.com");
      expect((await chunks(await f.request("stream", turn(f.engine.settings())))).at(-1)).toMatchObject({ type: "error" });
      expect(f.requests).toHaveLength(0);
      expect(readFileSync(f.settingsPath)).toEqual(before);
    } finally { await f.close(); }
  });

  it("bounds concurrent turns and aborts excessive output with an explicit error", async () => {
    const f = await fixture();
    try {
      const settings = f.engine.settings();
      const first = await f.request("stream", turn(settings, "first", "wait"));
      const second = await f.request("stream", turn(settings, "second", "wait"));
      expect((await f.request("stream", turn(settings, "third"))).status).toBe(429);
      expect(f.ai.activeCount).toBe(2);
      await f.request("cancel", { requestId: "first" });
      await f.request("cancel", { requestId: "second" });
      await Promise.all([chunks(first), chunks(second)]);
      expect(f.ai.activeCount).toBe(0);
    } finally { await f.close(); }
    let aborted = false;
    const oversized = await fixture({ stream: async (_provider, _config, _system, _messages, _tools, _cap, cb) => {
      (cb.onDelta as (v: string) => void)("x".repeat(32_000_001));
      (cb.onUsage as (v: unknown) => void)({ outputTokens: 1 }); // flushes the original coalescer
      aborted = (cb.signal as AbortSignal).aborted;
    } });
    try {
      const result = await chunks(await oversized.request("stream", turn(oversized.engine.settings())));
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ type: "error" }); expect(result[0]!.error).toContain("한도");
      expect(aborted).toBe(true); expect(oversized.ai.activeCount).toBe(0);
    } finally { await oversized.close(); }
  });

  it("delivers a lone real provider delta before completion on successive cancelled streams", async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 6; i++) {
        const requestId = `partial-${i}`;
        const response = await f.request("stream", turn(f.engine.settings(), requestId, "wait"));
        const received: string[] = [], reader = response.body!.getReader();
        const reading = (async () => { while (true) { const chunk = await reader.read(); if (chunk.done) break; received.push(new TextDecoder().decode(chunk.value)); } })();
        try {
          await expect.poll(() => received.join(""), { timeout: 2500 }).toContain('"type":"delta"');
          expect(received.join("")).toContain("안녕");
          if (i === 0) await expect.poll(() => received.join(""), { timeout: 2000 }).toContain("\n\n");
        } finally { await f.request("cancel", { requestId }); await reading; reader.releaseLock(); }
        expect(f.ai.activeCount).toBe(0);
      }
    } finally { await f.close(); }
  });

  it("scopes cancellation to the view, retains ownership on grant refresh and ends the real HTTP request", async () => {
    const f = await fixture();
    try {
      const settings = f.engine.settings();
      expect((await f.request("settings", undefined, "forged")).status).toBe(401);
      expect((await f.request("settings", undefined, f.otherToken)).status).toBe(401);
      const running = await f.request("stream", turn(settings, "same-id", "wait"));
      await expect.poll(() => f.requests.length).toBe(1);
      expect(f.ai.activeCount).toBe(1);
      expect((await f.request("stream", turn(settings, "same-id"))).status).toBe(409);
      await f.request("cancel", { requestId: "same-id" }, f.sameDocumentToken);
      await f.request("cancel", { requestId: "same-id" }, f.otherToken, f.second.id);
      expect(f.ai.activeCount).toBe(1); expect(f.disconnected()).toBe(0);
      f.refresh();
      await f.request("cancel", { requestId: "same-id" });
      expect((await chunks(running)).at(-1)).toMatchObject({ type: "done" });
      await expect.poll(f.disconnected).toBe(1);
      expect(f.ai.activeCount).toBe(0);
    } finally { await f.close(); }
  });

  it("aborts disconnected pages and gateway shutdown without leaving running streams", async () => {
    const f = await fixture();
    try {
      const controller = new AbortController();
      const running = await f.request("stream", turn(f.engine.settings(), "one", "wait"), undefined, undefined, controller.signal);
      await expect.poll(() => f.requests.length).toBe(1);
      controller.abort();
      await running.text().catch(() => undefined);
      await expect.poll(() => f.ai.activeCount).toBe(0);
      await expect.poll(f.disconnected).toBe(1);
      const second = await f.request("stream", turn(f.engine.settings(), "two", "wait"));
      await expect.poll(() => f.requests.length).toBe(2);
      f.ai.close();
      expect((await chunks(second)).at(-1)).toMatchObject({ type: "done" });
      await expect.poll(f.disconnected).toBe(2);
      expect(f.ai.activeCount).toBe(0);
      expect((await f.request("settings")).status).toBe(503);
    } finally { await f.close(); }
  });

  it("namespaces retained sessions and preserves subscription usage and input-truncation events", async () => {
    const sessions: string[] = [];
    const f = await fixture({ stream: async (_provider, _config, _system, _messages, _tools, _cap, cb) => {
      sessions.push(cb.sessionId as string);
      (cb.onDelta as (v: string) => void)("a");
      (cb.onSubscriptionUsage as (v: unknown[]) => void)([{ usedPercent: 12 }]);
      (cb.onInputTruncated as () => void)();
    } });
    try {
      const request = turn(f.engine.settings());
      const first = await chunks(await f.request("stream", request));
      f.refresh(); await chunks(await f.request("stream", request));
      await chunks(await f.request("stream", request, f.sameDocumentToken));
      await chunks(await f.request("stream", request, f.otherToken, f.second.id));
      expect(sessions[0]).toBe(sessions[1]); expect(new Set(sessions).size).toBe(3);
      expect(first.map((c) => c.type)).toEqual(["delta", "subscription-usage", "input-truncated", "done"]);
    } finally { await f.close(); }
  });

  it("rejects malformed input and reports unreadable settings without rewriting the file", async () => {
    expect(() => officeAiRequest({ ...turn({}), requestId: "../bad" }, true)).toThrow();
    expect(() => officeAiRequest({ ...turn({}), messages: [{ role: "user", text: "ok", images: [{ base64: "/path/to/file", mime: "file/path" }] }] }, true)).toThrow();
    const f = await fixture();
    try {
      expect((await f.request("stream", { ...turn(f.engine.settings()), maxTokens: -1 })).status).toBe(400);
      expect(f.requests).toHaveLength(0);
      const request = turn(f.engine.settings());
      writeFileSync(f.settingsPath, "{broken");
      expect((await f.request("settings")).status).toBe(500);
      expect((await chunks(await f.request("stream", request))).at(-1)).toMatchObject({ type: "error" });
      expect(readFileSync(f.settingsPath, "utf8")).toBe("{broken");
    } finally { await f.close(); }
  });
});
