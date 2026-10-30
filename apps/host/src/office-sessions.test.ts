import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { Session, Work } from "@workbench/contracts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { emptyStatus, type ProviderAdapter } from "./providers/types.ts";
import { createHttpServer } from "./http.ts";
import { createEditorsServer, EditorGrants } from "./editors.ts";
import { OfficeAi } from "./office-ai.ts";
import type { OfficeAiEngine } from "./office-ai-engine.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-office-session-")), store = new Store(join(dir, "state.sqlite")), bus = new EventBus();
  const options = { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir };
  const manager = new SessionManager(store, bus, options), work = manager.createWork({ title: "Office" });
  const file = join(work.cwd, "자료.md"); writeFileSync(file, "처음 문서\n");
  const artifact = manager.openFile(work.id, file), session = manager.createSession(work.id, { provider: "claude" });
  const opened = manager.documents.registry.open(artifact.id, { viewId: "view", windowId: "window", sessionId: session.id, claim: true });
  const binding = { artifactId: artifact.id, sessionId: session.id, owner: "owner", access: { viewId: "view", writeToken: opened.writeToken } };
  const sent: string[] = []; let steered = 0, interrupted = 0, failSend = false;
  const adapter: ProviderAdapter = {
    provider: "claude", init: async () => {}, status: () => emptyStatus("claude"), refreshStatus: async () => emptyStatus("claude"), login: async () => ({ url: null, message: "" }),
    send: async (s: Session, _w: Work, text: string) => { sent.push(text); if (failSend) throw new Error("fixture failure"); manager.sink.updateSession(s.id, { status: "running", nativeSessionId: "original-native" }); },
    steer: async () => { steered++; return true; }, interrupt: async () => { interrupted++; }, answerApproval: async () => false, shutdown: async () => {},
  };
  manager.registerAdapter(adapter);
  const start = (turnId = "run", extra = {}) => manager.office.start(binding, { turnId, instruction: "문서를 고쳐줘", revision: artifact.revision, selection: "첫 문단", ...extra });
  return { dir, store, bus, options, manager, work, artifact, session, binding, sent, adapter, start, steered: () => steered, interrupted: () => interrupted, failSend: (value: boolean) => { failSend = value; },
    items: () => manager.items(session.id).items,
    finish: (turnId = "run") => manager.office.finish(binding, { turnId, status: "completed" }),
    close: async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("Office runs belong to the existing Workbench session", () => {
  it("pins the target and persists original tool/answer events in that session, with replay-safe ordering", async () => {
    const f = fixture();
    try {
      const starts = await Promise.all([f.start(), f.start()]);
      expect(starts.map((x) => x.duplicate)).toEqual([false, true]);
      const user = f.items()[0]; expect(user).toMatchObject({ kind: "user", office: { turnId: "run", artifactId: f.artifact.id }, refs: [{ revision: 1, sha256: f.artifact.sha256, selection: "첫 문단" }] });
      expect(f.manager.view.sessions.size).toBe(1);
      const first = { turnId: "run", seq: 1, events: [{ kind: "tool", id: "call1", name: "replace_text", summary: "첫 문단 변경", input: '{"text":"새 글"}', output: null, status: "running" }] };
      expect(f.manager.office.events(f.binding, first).duplicate).toBe(false);
      expect(f.manager.office.events(f.binding, first).duplicate).toBe(true);
      expect(() => f.manager.office.events(f.binding, { ...first, seq: 3 })).toThrow(/앞선/);
      expect(() => f.manager.office.events(f.binding, { ...first, events: [{ ...first.events[0], input: "changed" }] })).toThrow(/내용이 다릅니다/);
      f.manager.office.events(f.binding, { turnId: "run", seq: 2, events: [{ ...first.events[0], status: "completed", output: "changed one paragraph" }, { kind: "assistant", id: "answer", text: "첫 문단을 바꿨습니다.", streaming: false }] });
      expect(f.finish()).toMatchObject({ status: "completed", duplicate: false });
      expect(f.finish()).toMatchObject({ status: "completed", duplicate: true });
      expect((await f.start()).duplicate).toBe(true);
      expect(f.store.items(f.session.id)).toEqual(f.items());
      expect(f.items().filter((i) => i.kind === "turnEnd")).toHaveLength(1);
      expect(f.manager.office.history(f.binding).items).toEqual(f.items());
      expect(f.manager.view.sessions.get(f.session.id)).toMatchObject({ status: "idle", nativeSessionId: null });
    } finally { await f.close(); }
  });
  it("rejects foreign projects/workspaces, changed views, stale revisions and changed request content", async () => {
    const f = fixture();
    try {
      const other = f.manager.createWork({ title: "다른 프로젝트" }), session = f.manager.createSession(other.id, { provider: "claude" });
      expect(() => f.manager.office.scope(f.artifact.id, session.id)).toThrow(/같은 프로젝트/);
      await expect(f.start("stale", { revision: 9 })).rejects.toThrow(/판이 바뀌었습니다/);
      await f.start();
      await expect(f.start("run", { instruction: "다른 요청" })).rejects.toThrow(/같은 요청 번호/);
      await expect(f.manager.office.start({ ...f.binding, owner: "foreign" }, { turnId: "run", instruction: "문서를 고쳐줘", revision: 1, selection: "첫 문단" })).rejects.toThrow(/다른 문서 창/);
      expect(() => f.manager.office.requireRun({ ...f.binding, owner: "foreign" }, "run")).toThrow(/진행 중인 AI 요청/);
      f.manager.documents.registry.open(f.artifact.id, { viewId: "view", windowId: "window", sessionId: session.id });
      expect(() => f.manager.office.history(f.binding)).toThrow(/세션이 바뀌었/);
    } finally { await f.close(); }
  });
  it("queues a general CLI request during an Office loop, then passes the persisted Office work as context", async () => {
    const f = fixture();
    try {
      await f.start();
      const waiting = await f.manager.send(f.session.id, "next", "이어서 요약해줘");
      expect(waiting.delivery).toBe("queued"); expect(f.steered()).toBe(0); expect(f.sent).toHaveLength(0);
      f.manager.office.events(f.binding, { turnId: "run", seq: 1, events: [{ kind: "assistant", id: "answer", text: "문서 수정 결과", streaming: false }] });
      f.finish();
      await expect.poll(() => f.sent.length).toBe(1);
      expect(f.sent[0]).toContain("문서 수정 결과"); expect(f.sent[0]).toContain("이어서 요약해줘");
      expect(f.manager.view.sessions.get(f.session.id)?.nativeSessionId).toBe("original-native");
      expect(f.manager.office.nativeContext(f.session.id).text).toBe("");
      await expect(f.start("later")).rejects.toThrow(/세션의 응답/);
    } finally { await f.close(); }
  });
  it("stops from the Workbench session without interrupting its unrelated CLI and holds queued requests", async () => {
    const f = fixture();
    try {
      await f.start(); const signal = f.manager.office.requireRun(f.binding, "run").controller.signal;
      f.manager.office.events(f.binding, { turnId: "run", seq: 1, events: [{ kind: "assistant", id: "partial", text: "진행 중", streaming: true }] });
      await f.manager.send(f.session.id, "next", "나중 요청");
      await f.manager.interrupt(f.session.id);
      expect(signal.aborted).toBe(true); expect(f.interrupted()).toBe(0);
      expect(f.items().find((i) => i.kind === "assistant")).toMatchObject({ text: "진행 중", streaming: false });
      expect(f.items().find((i) => i.kind === "turnEnd")).toMatchObject({ status: "interrupted", cause: "stop" });
      expect(f.manager.view.sessions.get(f.session.id)?.queued[0]?.held).toBe(true);
      expect(() => f.manager.office.requireRun(f.binding, "run")).toThrow();
    } finally { await f.close(); }
  });
  it("serializes CLI/Office preparation and retains Office context after failed CLI dispatch", async () => {
    const f = fixture();
    try {
      const [office, cli] = await Promise.all([f.start(), f.manager.send(f.session.id, "cli", "나중 요청")]);
      expect(office.status).toBe("running"); expect(cli.delivery).toBe("queued");
      f.manager.cancelQueued(f.session.id, "cli"); f.finish();
      f.failSend(true); await f.manager.send(f.session.id, "failed", "연속 요청");
      expect(f.manager.office.nativeContext(f.session.id).text).toContain("문서를 고쳐줘");
      f.failSend(false); await f.manager.send(f.session.id, "retry", "다시 요청");
      expect(f.sent[1]).toContain("문서를 고쳐줘"); expect(f.manager.office.nativeContext(f.session.id).text).toBe("");
    } finally { await f.close(); }
  });
  it("recovers an unfinished Office run from persisted data without creating or replaying a conversation", async () => {
    const f = fixture(); let reopened: Store | undefined, next: SessionManager | undefined;
    try {
      f.manager.sink.updateSession(f.session.id, { engineModel: "previous-cli-model", nativeSessionId: "previous-native" });
      await f.start();
      f.manager.office.events(f.binding, { turnId: "run", seq: 1, events: [{ kind: "assistant", id: "partial", text: "보존할 부분 답", streaming: true }] });
      // Copy the committed rows while the run is active, then open that independent profile.
      const db = join(f.dir, "restarted.sqlite"), copy = new Store(db);
      copy.saveWork(f.manager.view.works.get(f.work.id)!);
      for (const space of f.store.workspaces()) copy.saveWorkspace(space);
      copy.saveSession(f.manager.view.sessions.get(f.session.id)!);
      copy.saveArtifact(f.artifact); for (const rev of f.store.revisions(f.artifact.id)) copy.saveRevision(rev);
      for (const item of f.store.items(f.session.id)) copy.saveItem(f.session.id, item);
      const receipt = f.store.findRequest("office:run")!; copy.saveRequest("office:run", receipt.sessionId, receipt.textHash); copy.close();
      reopened = new Store(db); next = new SessionManager(reopened, new EventBus(), f.options);
      const view = next.documents.registry.open(f.artifact.id, { viewId: "new-view", windowId: "new-window", sessionId: f.session.id, claim: true });
      const binding = { ...f.binding, owner: "new-owner", access: { viewId: "new-view", writeToken: view.writeToken } };
      expect(await next.office.start(binding, { turnId: "run", instruction: "문서를 고쳐줘", revision: 1, selection: "첫 문단" })).toMatchObject({ duplicate: true, status: "interrupted" });
      const items = next.items(f.session.id).items;
      expect(items.find((i) => i.kind === "turnEnd")).toMatchObject({ status: "interrupted", cause: "restart", office: { turnId: "run" }, model: null, effort: null });
      expect(items.find((i) => i.kind === "assistant")).toMatchObject({ text: "보존할 부분 답", streaming: false });
      expect(next.view.sessions.size).toBe(1); expect(next.office.busy(f.session.id)).toBe(false);
    } finally { await next?.shutdown(); reopened?.close(); await f.close(); }
  });
  it("rolls back a failed durable start and explicitly paginates the same session history", async () => {
    const f = fixture(), original = f.store.saveRequest.bind(f.store);
    try {
      f.store.saveRequest = () => { throw new Error("disk full fixture"); };
      await expect(f.start()).rejects.toThrow(/disk full/);
      expect(f.items()).toHaveLength(0); expect(f.manager.office.busy(f.session.id)).toBe(false);
      f.store.saveRequest = original; await f.start(); f.finish();
      for (let i = 0; i < 205; i++) f.manager.sink.upsertItem(f.session.id, { kind: "assistant", id: `history-${i}`, text: `답 ${i}`, streaming: false, at: Date.now() });
      const page = f.manager.office.history(f.binding);
      expect(page.items).toHaveLength(200); expect(page.hasMore).toBe(true);
      const first = f.manager.office.history(f.binding, page.before);
      expect(first.items[0]).toMatchObject({ kind: "user", text: "문서를 고쳐줘" }); expect(first.hasMore).toBe(false);
    } finally { f.store.saveRequest = original; await f.close(); }
  });
  it("requires the saved target and stops on an expired view without touching another session", async () => {
    const f = fixture();
    try {
      f.manager.documents.registry.open(f.artifact.id, { viewId: "view", windowId: "window", dirty: true });
      await expect(f.start()).rejects.toThrow(/먼저 저장/);
      expect(f.items()).toHaveLength(0);
      f.manager.documents.registry.open(f.artifact.id, { viewId: "view", windowId: "window", dirty: false });
      vi.useFakeTimers(); await f.start();
      const signal = f.manager.office.requireRun(f.binding, "run").controller.signal;
      f.manager.documents.registry.close("view", "window");
      await vi.advanceTimersByTimeAsync(10_001);
      expect(signal.aborted).toBe(true); expect(f.manager.office.busy(f.session.id)).toBe(false);
      expect(f.items().find((i) => i.kind === "turnEnd")).toMatchObject({ status: "interrupted" });
    } finally { vi.useRealTimers(); await f.close(); }
  });
  it("keeps an already dispatched CLI running if only the Office delivery cursor cannot be saved", async () => {
    const f = fixture(), original = f.store.setMeta.bind(f.store), warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await f.start(); f.finish();
      f.store.setMeta = (key, value) => { if (key.startsWith("office-context:")) throw new Error("cursor write fixture"); original(key, value); };
      await f.manager.send(f.session.id, "cursor-fail", "계속");
      expect(f.sent).toHaveLength(1); expect(f.manager.view.sessions.get(f.session.id)?.status).toBe("running");
      expect(f.manager.office.nativeContext(f.session.id).text).toContain("문서를 고쳐줘");
      expect(warning).toHaveBeenCalledOnce();
    } finally { f.store.setMeta = original; warning.mockRestore(); await f.close(); }
  });
  it("immediately interrupts the owned document run when its view selects another session", async () => {
    const f = fixture();
    try {
      await f.start();
      const signal = f.manager.office.requireRun(f.binding, "run").controller.signal;
      const next = f.manager.createSession(f.work.id, { provider: "claude" });
      f.manager.documents.registry.open(f.artifact.id, { viewId: "view", windowId: "window", sessionId: next.id });
      f.manager.office.reconcileViews();
      expect(signal.aborted).toBe(true); expect(f.manager.office.busy(f.session.id)).toBe(false);
      expect(f.items().find((item) => item.kind === "turnEnd")).toMatchObject({ status: "interrupted" });
      expect(f.manager.items(next.id).items).toHaveLength(0);
      expect(f.interrupted()).toBe(0);
    } finally { await f.close(); }
  });
  it("serializes an earlier CLI dispatch before Office and counts only native requests when forking", async () => {
    const f = fixture(); let kept: { turns: number; requests: number } | undefined;
    try {
      const [sent, blocked] = await Promise.allSettled([f.manager.send(f.session.id, "native1", "먼저 CLI"), f.start()]);
      expect(sent.status).toBe("fulfilled"); expect(blocked.status).toBe("rejected");
      f.manager.sink.upsertItem(f.session.id, { kind: "assistant", id: "native-answer", text: "CLI 답", streaming: false, at: Date.now() });
      f.manager.sink.upsertItem(f.session.id, { kind: "turnEnd", id: "native-end", status: "completed", durationMs: 1, at: Date.now() });
      f.manager.sink.updateSession(f.session.id, { status: "idle" });
      await f.start(); f.finish();
      await f.start("second"); f.finish("second");
      f.adapter.forkNative = async (_s, _w, keep) => { kept = keep; return "forked-native"; };
      const fork = await f.manager.forkBefore(f.session.id, "user:office:second");
      expect(kept).toEqual({ turns: 1, requests: 1 });
      expect(fork.session.nativeSessionId).toBe("forked-native");
      expect(f.manager.items(fork.session.id).items.filter((item) => item.office && item.kind === "user")).toHaveLength(1);
    } finally { await f.close(); }
  });
  it("keeps event identifiers separate from host notices and rejects malformed, oversized and final-item rewrites", async () => {
    const f = fixture();
    try {
      await f.start();
      f.manager.office.events(f.binding, { turnId: "run", seq: 1, events: [{ kind: "assistant", id: "error", text: "실제 답", streaming: false }] });
      expect(() => f.manager.office.events(f.binding, { turnId: "run", seq: 2, events: [{ kind: "assistant", id: "error", text: "덮어쓰기", streaming: true }] })).toThrow(/이미 마친/);
      expect(() => f.manager.office.events(f.binding, { turnId: "run", seq: 2, events: [{ kind: "assistant", id: "next", text: "x".repeat(2_000_001), streaming: false }] })).toThrow(/형식/);
      expect(() => f.manager.office.events(f.binding, { turnId: "run", seq: 2, events: [{ kind: "tool", id: "tool", name: "edit", input: {}, output: "", status: "completed" }] })).toThrow(/형식/);
      expect(() => f.manager.office.events(f.binding, { turnId: "run", seq: 2, events: [{ kind: "tool", id: "tool", name: "edit", summary: "summary", input: "{}", output: "", status: ["completed"] }] })).toThrow(/형식/);
      expect(() => f.manager.office.finish(f.binding, { turnId: "run", status: ["completed"] })).toThrow(/형식/);
      f.manager.office.finish(f.binding, { turnId: "run", status: "failed", error: "실패 알림" });
      expect(f.items().find((i) => i.kind === "assistant")).toMatchObject({ text: "실제 답" });
      expect(f.items().find((i) => i.kind === "notice")).toMatchObject({ text: "실패 알림" });
      expect(f.items().find((i) => i.kind === "turnEnd")).toMatchObject({ status: "failed" });
    } finally { await f.close(); }
  });
});

describe("scoped Office lifecycle HTTP", () => {
  it("does not run a production engine when the caller forgot to wire session ownership", async () => {
    const f = fixture(), grants = new EditorGrants(), token = grants.issue(f.artifact.id, f.binding.access);
    const server = createEditorsServer(f.manager.documents, grants, null);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${origin}/api/artifacts/${f.artifact.id}/ai/stream`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ requestId: "unowned", system: "test", settings: {}, messages: [{ role: "user", text: "never send" }] }) });
      expect(response.status).toBe(409); expect((await response.json()).code).toBe("office_session_required");
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await f.close(); }
  });
  it("binds grants in the trusted host and connects provider cancellation and disconnect to the existing session", async () => {
    const f = fixture(), grants = new EditorGrants(); let calls = 0;
    const engine: OfficeAiEngine = { settings: () => ({}), statuses: async () => ({}), chat: async () => ({ ok: true, content: "answer" }),
      stream: async (req, _sid, signal, send) => { calls++; send({ type: "delta", requestId: req.requestId, text: "partial" }); await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); }); send({ type: "done", requestId: req.requestId }); },
    };
    const ai = new OfficeAi(f.dir, engine, f.manager.office), editors = createEditorsServer(f.manager.documents, grants, null, ai);
    await new Promise<void>((resolve) => editors.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(editors.address() as AddressInfo).port}`;
    const host = createHttpServer(f.manager, f.bus, { token: "host-token", webDir: null, editors: { grants, origin: () => origin } });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    try {
      const main = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
      const editor = await (await fetch(`${main}/api/artifacts/${f.artifact.id}/editor`, { method: "POST", headers: { authorization: "Bearer host-token", "x-workbench-view": f.binding.access.viewId, "x-workbench-write": f.binding.access.writeToken! } })).json();
      const request = (op: string, body?: unknown, token = editor.token, signal?: AbortSignal) => fetch(`${origin}/api/artifacts/${f.artifact.id}/ai/${op}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body), signal });
      expect(grants.session(editor.token)).toBe(f.session.id);
      const unbound = grants.issue(f.artifact.id, f.binding.access);
      expect((await request("history", undefined, unbound)).status).toBe(409);
      const stream = { requestId: "call1", turnId: "run", system: "test", messages: [{ role: "user", text: "test" }], settings: {} };
      expect((await request("stream", stream)).status).toBe(409); expect(calls).toBe(0);
      expect((await request("turn-start", { turnId: "run", instruction: "같은 세션", revision: 1 })).status).toBe(200);
      expect((await (await request("history")).json()).sessionId).toBe(f.session.id);
      const response = await request("stream", stream);
      await expect.poll(() => calls).toBe(1);
      expect((await request("stream", stream)).status).toBe(409);
      await f.manager.interrupt(f.session.id); expect(await response.text()).toContain('"type":"done"');
      expect(f.items().find((i) => i.kind === "turnEnd")).toMatchObject({ status: "interrupted" });
      expect((await request("turn-start", { turnId: "next", instruction: "연결 종료", revision: 1 })).status).toBe(200);
      const abort = new AbortController(), open = await request("stream", { ...stream, turnId: "next", requestId: "call2" }, editor.token, abort.signal);
      abort.abort(); await open.text().catch(() => {});
      await expect.poll(() => f.manager.office.busy(f.session.id)).toBe(false);
      expect(f.items().filter((i) => i.kind === "turnEnd")).toHaveLength(2);
    } finally {
      ai.close(); host.closeAllConnections(); editors.closeAllConnections();
      await Promise.all([new Promise<void>((resolve) => host.close(() => resolve())), new Promise<void>((resolve) => editors.close(() => resolve()))]); await f.close();
    }
  });
});
