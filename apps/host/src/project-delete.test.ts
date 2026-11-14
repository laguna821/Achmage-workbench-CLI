import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-project-delete-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "삭제 대상" }), session = manager.createSession(work.id, { provider: "codex" });
  const file = join(work.cwd, "보존.md"); writeFileSync(file, "보존할 문서 원문");
  const artifact = manager.openFile(work.id, file);
  return { dir, store, manager, work, session, file, artifact, close: async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

it("removes the project's records and search results across restart, preserving files and another project", async () => {
  const f = fixture();
  try {
    const other = f.manager.createWork({ title: "남길 프로젝트" });
    f.manager.sink.upsertItem(f.session.id, { kind: "user", id: "prompt", text: "삭제할 원문 프롬프트", at: 1 });
    f.store.setMeta("project.notes", JSON.stringify({ [f.work.id]: f.file, [other.id]: "other.md" }));
    f.manager.updateWork(f.work.id, { archived: true });
    // No document of this project is in the app trash: none stays behind in 보관함.
    expect(f.manager.deleteWork(f.work.id)).toEqual({ ok: true, preservedPath: f.work.cwd, trashedDocuments: 0 });
    expect(f.manager.snapshot().works.map(work => work.id)).toEqual([other.id]);
    expect(f.manager.snapshot().sessions).toEqual([]);
    expect(f.manager.snapshot().artifacts).toEqual([]);
    expect(f.store.search.cached().every(row => row.workId !== f.work.id)).toBe(true);
    expect(readFileSync(f.file, "utf8")).toBe("보존할 문서 원문");
    const reloaded = new Store(join(f.dir, "state.sqlite"));
    try {
      expect(reloaded.works().map(work => work.id)).toEqual([other.id]);
      expect(reloaded.sessions()).toEqual([]); expect(reloaded.artifacts()).toEqual([]);
      expect(JSON.parse(reloaded.getMeta("project.notes")!)).toEqual({ [other.id]: "other.md" });
    } finally { reloaded.close(); }
  } finally { await f.close(); }
});

it("refuses deletion during AI work or when another editor has unsaved changes", async () => {
  const f = fixture();
  try {
    f.manager.sink.updateSession(f.session.id, { status: "running" });
    expect(() => f.manager.deleteWork(f.work.id)).toThrow(/실행 중/);
    f.manager.sink.updateSession(f.session.id, { status: "idle" });
    f.manager.documents.registry.open(f.artifact.id, { viewId: "editor", windowId: "window", claim: true, dirty: true });
    expect(() => f.manager.deleteWork(f.work.id)).toThrow(/저장한 뒤/);
    expect(f.store.works()).toHaveLength(1); expect(readFileSync(f.file, "utf8")).toBe("보존할 문서 원문");
  } finally { await f.close(); }
});
