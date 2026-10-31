import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { emptyStatus, type ProviderAdapter } from "./providers/types.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-document-agents-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "병렬 문서" }), main = manager.createSession(work.id, { provider: "claude" });
  const sent: string[] = [], interrupted: string[] = [];
  const adapter: ProviderAdapter = {
    provider: "claude", init: async () => {}, status: () => emptyStatus("claude"), refreshStatus: async () => emptyStatus("claude"), login: async () => ({ url: null, message: "" }),
    send: async (session, _work, text) => { sent.push(text); manager.sink.updateSession(session.id, { status: "running", nativeSessionId: "main-native" }); },
    interrupt: async (session) => { interrupted.push(session.id); }, answerApproval: async () => false, shutdown: async () => {},
  };
  manager.registerAdapter(adapter);
  const doc = (name: string) => {
    const path = join(work.cwd, name); writeFileSync(path, "원문\n");
    const artifact = manager.openFile(work.id, path), child = manager.documentSession(artifact.id, main.id);
    const viewId = `view-${artifact.id}`;
    const view = manager.documents.registry.open(artifact.id, { viewId, windowId: "window", sessionId: child.id, claim: true });
    const binding = { artifactId: artifact.id, sessionId: child.id, owner: viewId, access: { viewId, writeToken: view.writeToken } };
    return { artifact, child, binding };
  };
  return { dir, store, manager, work, main, doc, sent, interrupted, close: async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

it("runs two document agents alongside the main CLI and interrupts only the chosen conversation", async () => {
  const f = setup();
  try {
    const a = f.doc("한글 자료.md"), b = f.doc("워드 자료.md");
    await f.manager.send(f.main.id, "main-request", "메인에서 다른 일을 해줘");
    const mainTitle = f.manager.view.works.get(f.work.id)?.title;
    const turns = await Promise.all([a, b].map((doc, index) => f.manager.office.start(doc.binding, { turnId: `child-${index}`, instruction: `문서 ${index} 수정`, revision: 1 })));
    expect(turns.map((turn) => turn.status)).toEqual(["running", "running"]);
    expect(f.manager.view.works.get(f.work.id)?.title).toBe(mainTitle);
    expect(f.manager.view.works.get(f.work.id)?.activeSessionId).toBe(f.main.id);
    expect(f.manager.items(f.main.id).items.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(f.manager.documentSession(a.artifact.id, f.main.id).id).toBe(a.child.id);
    await f.manager.interrupt(a.child.id);
    expect(f.manager.office.busy(a.child.id)).toBe(false); expect(f.manager.office.busy(b.child.id)).toBe(true);
    expect(f.interrupted).toEqual([]);
    expect(f.manager.view.sessions.get(f.main.id)?.status).toBe("running");
    await f.manager.interrupt(f.main.id);
    expect(f.interrupted).toEqual([f.main.id]); expect(f.manager.office.busy(b.child.id)).toBe(true);
    f.manager.office.events(b.binding, { turnId: "child-1", seq: 1, events: [{ kind: "assistant", id: "answer", text: "워드 문서의 결과", streaming: false }] });
    f.manager.office.finish(b.binding, { turnId: "child-1", status: "completed" });
    expect(f.manager.office.nativeContext(f.main.id).text).toContain("워드 문서의 결과");
    expect(f.manager.office.nativeContext(f.main.id).text).toContain(b.artifact.path);
    expect(f.manager.items(a.child.id).items.some((item) => item.kind === "user" && item.text.includes("문서 1"))).toBe(false);
  } finally { await f.close(); }
});

it("keeps old main-chat document history readable, rejects cross-document bindings and preserves scope", async () => {
  const f = setup();
  try {
    const a = f.doc("자료.md"), b = f.doc("다른 자료.md");
    const legacy = { kind: "user" as const, id: "legacy", text: "이전 설치본의 요청", at: 1, office: { artifactId: a.artifact.id, turnId: "old" } };
    f.manager.sink.upsertItem(f.main.id, legacy);
    expect(f.manager.office.history(a.binding).items).toContainEqual(legacy);
    expect(f.manager.office.attachmentHistory(a.binding)).toContainEqual(legacy);
    expect(f.store.items(f.main.id)).toContainEqual(legacy);
    expect(f.manager.office.history(b.binding).items).not.toContainEqual(legacy);
    expect(() => f.manager.office.scope(b.artifact.id, a.child.id)).toThrow(/다른 문서/);
    const other = f.manager.createWork({ title: "다른 프로젝트" }), foreign = f.manager.createSession(other.id, { provider: "claude" });
    expect(() => f.manager.documentSession(a.artifact.id, foreign.id)).toThrow(/같은 프로젝트/);
    const fresh = f.manager.documentSession(a.artifact.id, f.main.id, true);
    expect(fresh.id).not.toBe(a.child.id); expect(f.store.sessions().find((entry) => entry.id === a.child.id)?.documentAgent).toEqual(a.child.documentAgent);
    expect(f.manager.view.works.get(f.work.id)?.activeSessionId).toBe(f.main.id);
  } finally { await f.close(); }
});

it("opens the saved file in Ieum, adopts its external save, and supplies the current revision to main chat", async () => {
  const f = setup();
  try {
    const a = f.doc("같은 파일.md"), open = vi.spyOn(f.manager.ieumDesktop, "open").mockResolvedValue({ app: "이음오피스", path: a.artifact.path });
    f.manager.documents.registry.open(a.artifact.id, { viewId: a.binding.owner, windowId: "window", sessionId: a.child.id, dirty: true });
    await expect(f.manager.openExternal(a.artifact.id)).rejects.toThrow(/저장한 뒤/);
    expect(open).not.toHaveBeenCalled();
    f.manager.documents.registry.open(a.artifact.id, { viewId: a.binding.owner, windowId: "window", sessionId: a.child.id, dirty: false });
    await f.manager.openExternal(a.artifact.id);
    expect(open).toHaveBeenCalledWith(a.artifact.path);
    writeFileSync(a.artifact.path, "이음 앱에서 저장한 최신 내용\n");
    await expect.poll(() => f.manager.documents.get(a.artifact.id).revision, { timeout: 6_000 }).toBe(2);
    expect(f.manager.documents.get(a.artifact.id).path).toBe(a.artifact.path);
    expect(f.manager.office.nativeContext(f.main.id).text).toContain("이음오피스에서 저장");
    expect(f.manager.office.nativeContext(f.main.id).text).toContain('"revision":2');
  } finally { await f.close(); }
}, 10_000);
