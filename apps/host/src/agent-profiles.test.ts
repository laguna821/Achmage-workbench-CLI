import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { AgentProfileInput, Session } from "@workbench/contracts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { emptyStatus, type ProviderAdapter } from "./providers/types.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const input: AgentProfileInput = { name: "조사", provider: "codex", model: "model-a", effort: "high", access: "ask", instructions: "출처를 확인하세요." };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-profile-")), store = new Store(join(dir, "state.sqlite")), bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "host", hostLabel: "시험", dataDir: dir, managedWorksDir: join(dir, "works") });
  const calls: { session: Session; text: string; id: string }[] = [];
  const adapter: ProviderAdapter = { provider: "codex", init: async () => {}, status: () => emptyStatus("codex"), refreshStatus: async () => emptyStatus("codex"), login: async () => ({ url: null, message: "" }),
    send: async (session, _work, text, id) => { calls.push({ session, text, id }); manager.sink.updateSession(session.id, { status: "running" }); },
    interrupt: async () => {}, answerApproval: async () => false, shutdown: async () => {}, steer: async () => true };
  manager.registerAdapter(adapter);
  const work = manager.createWork({ title: "profile" }), session = manager.createSession(work.id, { provider: "codex" });
  const finish = () => { manager.sink.upsertItem(session.id, { kind: "turnEnd", id: `end:${calls.at(-1)?.id}`, status: "completed", at: Date.now(), durationMs: 1 }); manager.sink.updateSession(session.id, { status: "idle" }); };
  cleanups.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { manager, store, calls, session, finish };
}
test("profile edits apply to the next run while active settings and original prompt are preserved", async () => {
  const f = setup(), profile = f.manager.profiles.save(input);
  f.manager.updateSession(f.session.id, { profileId: profile.id });
  await f.manager.send(f.session.id, "first", "원문 요청");
  f.manager.profiles.save({ ...input, model: "model-b", instructions: "새 역할 설명" }, profile.id, profile.revision);
  expect(f.calls[0]?.session).toMatchObject({ model: "model-a", effort: "high", access: "ask" });
  expect(f.store.items(f.session.id).find(item => item.kind === "user")).toMatchObject({ text: "원문 요청", runSettings: { model: "model-a", profileRevision: 1 } });
  expect(f.calls[0]?.text).toContain(input.instructions);
  f.finish(); await f.manager.send(f.session.id, "second", "다음 요청");
  expect(f.calls[1]?.session.model).toBe("model-b");
  f.finish(); f.manager.updateSession(f.session.id, { model: "custom-model" });
  await f.manager.send(f.session.id, "third", "직접 선택"); expect(f.calls[2]?.session.model).toBe("custom-model");
});
test("queued requests keep their admitted settings even when the selected profile is deleted", async () => {
  const f = setup(), profile = f.manager.profiles.save(input);
  f.manager.updateSession(f.session.id, { profileId: profile.id });
  await f.manager.send(f.session.id, "first", "진행 중");
  await f.manager.send(f.session.id, "queued", "끝나면 다음", [], null, null, "queue");
  f.manager.removeAgentProfile(profile.id, profile.revision);
  expect(f.manager.view.sessions.get(f.session.id)?.profileId).toBeNull();
  f.finish(); await f.manager.sendQueued(f.session.id, "queued");
  expect(f.calls[1]?.session).toMatchObject({ model: "model-a", access: "ask" });
});
test("stale edits and another engine's profile are rejected before starting a run", () => {
  const f = setup(), profile = f.manager.profiles.save({ ...input, provider: "claude" });
  expect(() => f.manager.updateSession(f.session.id, { profileId: profile.id })).toThrow(/다른 AI/);
  expect(() => f.manager.profiles.save(input, profile.id, profile.revision - 1)).toThrow(/다른 화면/);
  expect(f.calls).toHaveLength(0);
});
