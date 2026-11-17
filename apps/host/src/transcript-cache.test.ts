import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { adaptTitle } from "./titles.ts";

// 0.5.3 B3: the gateway's transcript cache — idle transcripts are evicted; retitle reads only requests.

const managers: SessionManager[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.finder.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-transcripts-"));
  dirs.push(dir);
  const store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
  managers.push(manager);
  const work = manager.createWork({ title: "새 프로젝트", cwd: join(dir, "project") });
  mkdirSync(work.cwd, { recursive: true });
  return { store, manager, work };
}
const user = (id: string, text: string, at: number) => ({ kind: "user" as const, id: `user:${id}`, text, attachments: [], at });

describe("the gateway's transcript cache (B3)", () => {
  it("a request in one conversation does not load every transcript of its project; the project title still follows all requests", () => {
    const { store, manager, work } = setup();
    const a = manager.createSession(work.id, { provider: "claude" }), b = manager.createSession(work.id, { provider: "claude" }), c = manager.createSession(work.id, { provider: "codex" });
    // b and c were used in an earlier run: their items are only in the database.
    store.saveItem(b.id, user("b1", "강의 계획서 초안을 만들어 줘", 1));
    store.saveItem(c.id, { kind: "assistant", id: "a:c1", text: "긴 답".repeat(1000), streaming: false, at: 2 } as never);
    store.saveItem(c.id, user("c1", "강의 계획서 평가 기준을 정리해 줘", 3));
    manager.sink.upsertItem(a.id, user("a1", "강의 계획서 주차별 일정을 짜 줘", 4));
    expect(manager.cachedTranscripts().sort()).toEqual([a.id]);
    const expected = adaptTitle(["강의 계획서 초안을 만들어 줘", "강의 계획서 평가 기준을 정리해 줘", "강의 계획서 주차별 일정을 짜 줘"], "새 프로젝트") ?? "새 프로젝트";
    expect(manager.snapshot().works.find((entry) => entry.id === work.id)!.title).toBe(expected);
  });

  it("an idle transcript not touched for a while leaves the cache; a running one or one with unsaved pieces stays; it reloads whole", () => {
    const { manager, work } = setup();
    const idle = manager.createSession(work.id, { provider: "claude" }), busy = manager.createSession(work.id, { provider: "claude" });
    manager.sink.upsertItem(idle.id, user("i1", "첫 요청", 1));
    manager.sink.upsertItem(busy.id, user("b1", "둘째 요청", 2));
    manager.sink.updateSession(busy.id, { status: "running" });
    expect(manager.cachedTranscripts().sort()).toEqual([idle.id, busy.id].sort());
    manager.evictIdleTranscripts(Date.now() + 11 * 60_000);
    expect(manager.cachedTranscripts()).toEqual([busy.id]);
    expect(manager.items(idle.id).items.map((item) => item.id)).toEqual(["user:i1"]);
    expect(manager.cachedTranscripts().sort()).toEqual([idle.id, busy.id].sort());
    // Touched just now: stays.
    manager.evictIdleTranscripts(Date.now() + 60_000);
    expect(manager.cachedTranscripts().sort()).toEqual([idle.id, busy.id].sort());
  });
});
