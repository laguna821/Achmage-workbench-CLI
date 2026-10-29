import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, Work } from "@workbench/contracts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Workspaces } from "./workspaces.ts";
import { emptyStatus, type ProviderAdapter } from "./providers/types.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-spaces-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "state.sqlite");
  const store = new Store(db);
  const options = { hostId: "local", hostLabel: "여기", managedWorksDir: join(dir, "works") };
  const manager = new SessionManager(store, new EventBus(), options);
  cleanup.push(async () => { await manager.shutdown(); store.close(); });
  return { dir, db, store, manager, options };
}

async function legacy() {
  const setupState = setup();
  const { manager, store, db, dir } = setupState;
  const work = manager.createWork({ title: "예전 프로젝트" });
  const session = manager.createSession(work.id, { provider: "codex" });
  const second = manager.createSession(work.id, { provider: "claude" });
  const path = join(work.cwd, "기존.md");
  const bytes = "---\r\nDIKM_단계:: I\r\ntags: [한글]\r\n---\r\n원문 🌊\r\n";
  writeFileSync(path, bytes);
  const artifact = manager.openFile(work.id, path);
  const external = join(dir, "외부.md"); writeFileSync(external, "외부 원문");
  manager.openFile(work.id, external);
  await manager.shutdown(); store.close(); cleanup.pop();
  const raw = new DatabaseSync(db);
  const before = { works: [] as object[], sessions: [] as object[], artifacts: [] as object[] };
  const descriptor = { root: work.cwd, path: join(dir, "old-worktree"), cwd: join(dir, "old-worktree", "notes"), branch: "feature", base: "abc123" };
  for (const table of ["works", "sessions", "artifacts"] as const) {
    for (const row of raw.prepare(`SELECT id,json FROM ${table}`).all()) {
      const value = JSON.parse(String(row.json));
      delete value.defaultWorkspaceId; delete value.workspaceId; delete value.relativePath;
      value.retainedUnknownField = { old: [1, null, "yes"] };
      if (table === "sessions") { value.nativeSessionId = `native-${row.id}`; value.worktree = descriptor; }
      before[table].push(value);
      raw.prepare(`UPDATE ${table} SET json=? WHERE id=?`).run(JSON.stringify(value), row.id);
    }
  }
  raw.exec("DELETE FROM workspaces; DELETE FROM meta WHERE key='workspaces.version'"); raw.close();
  return { ...setupState, work, session, second, path, bytes, artifact, before };
}

describe("workspace migration and execution boundaries", () => {
  it("adds links once while preserving IDs, native sessions, unknown fields, revisions and original bytes", async () => {
    const old = await legacy();
    const store = new Store(old.db); cleanup.push(() => store.close());
    new Workspaces(store, "local", new EventBus());
    expect(store.works()[0]).toMatchObject(old.before.works[0]!);
    for (const value of old.before.sessions) expect(store.sessions()).toEqual(expect.arrayContaining([expect.objectContaining(value)]));
    for (const value of old.before.artifacts) expect(store.artifacts()).toEqual(expect.arrayContaining([expect.objectContaining(value)]));
    const sessions = store.sessions();
    expect(sessions[0]!.workspaceId).toBe(sessions[1]!.workspaceId);
    expect(sessions[0]!.workspaceId).not.toBe(store.works()[0]!.defaultWorkspaceId);
    expect(store.artifacts().find((a) => a.id === old.artifact.id)).toMatchObject({ relativePath: "기존.md", workspaceId: store.works()[0]!.defaultWorkspaceId });
    expect(store.revisions(old.artifact.id)).toHaveLength(1);
    expect(readFileSync(old.path, "utf8")).toBe(old.bytes);
    const once = JSON.stringify([store.works(), store.sessions(), store.artifacts(), store.workspaces()]);
    new Workspaces(store, "local", new EventBus());
    expect(JSON.stringify([store.works(), store.sessions(), store.artifacts(), store.workspaces()])).toBe(once);
  });

  it("rolls back every linkage when a migration write fails", async () => {
    const old = await legacy();
    const store = new Store(old.db); cleanup.push(() => store.close());
    vi.spyOn(store, "saveSession").mockImplementationOnce(() => { throw new Error("disk fault"); });
    expect(() => new Workspaces(store, "local", new EventBus())).toThrow("disk fault");
    expect(store.works()).toEqual(old.before.works);
    expect(store.sessions()).toEqual(old.before.sessions);
    expect(store.artifacts()).toEqual(old.before.artifacts);
    expect(store.workspaces()).toEqual([]);
    expect(store.getMeta("workspaces.version")).not.toBe("1");
  });

  it("links records written later by an older app even when the migration version is already present", () => {
    const { manager, store } = setup();
    const work = manager.createWork({ title: "기존" });
    const session = manager.createSession(work.id, { provider: "codex" });
    const olderWork = { ...work, id: "created-by-old-version", defaultWorkspaceId: undefined };
    store.saveWork(olderWork);
    store.saveSession({ ...session, id: "old-session", workId: olderWork.id, workspaceId: undefined, nativeSessionId: "keep-native" });
    expect(store.getMeta("workspaces.version")).toBe("1");
    new Workspaces(store, "local", new EventBus());
    const restored = store.sessions().find((entry) => entry.id === "old-session")!;
    expect(restored.workspaceId).toBeTruthy();
    expect(restored.nativeSessionId).toBe("keep-native");
    expect(store.sessions().find((entry) => entry.id === session.id)!.workspaceId).toBe(session.workspaceId);
  });

  it("pins sessions to their workspace and separates equal relative file names without rewriting the project cwd", async () => {
    const { manager, dir } = setup();
    const work = manager.createWork({ title: "프로젝트" });
    const other = join(dir, "other"); mkdirSync(other);
    const workspace = manager.createWorkspace(work.id, { cwd: other, label: "두 번째" });
    const session = manager.createSession(work.id, { provider: "codex", workspaceId: workspace.id });
    const original = join(work.cwd, "같은.md"); writeFileSync(original, "원본");
    const first = manager.openFile(work.id, original);
    const engine: ProviderAdapter = {
      provider: "codex", init: async () => {}, status: () => emptyStatus("codex"), refreshStatus: async () => emptyStatus("codex"), login: async () => ({ url: null, message: "" }), interrupt: async () => {}, shutdown: async () => {}, answerApproval: async () => false,
      send: async (sent: Session, execution: Work, text: string, requestId: string) => {
        expect(execution.cwd).toBe(other);
        expect(sent.workspaceId).toBe(workspace.id);
        expect(text).toContain("새 결과.md");
        writeFileSync(join(execution.cwd, "새 결과.md"), "새 문서");
        writeFileSync(join(execution.cwd, "같은.md"), "다른 사본");
        writeFileSync(join(execution.cwd, "스캔.md"), "도구가 경로를 보고하지 않은 파일");
        manager.sink.upsertItem(sent.id, { kind: "tool", id: "relative-write", tool: "fileChange", title: "write", detail: null, output: null, status: "completed", paths: ["같은.md"], at: Date.now() });
        manager.sink.upsertItem(sent.id, { kind: "turnEnd", id: "end", status: "completed", durationMs: 1, requestId, at: Date.now() });
        manager.sink.updateSession(sent.id, { status: "idle" });
      },
    };
    manager.registerAdapter(engine);
    await manager.send(session.id, "create", "만들어 줘", [], null, { format: "markdown", name: "새 결과" });
    const snapshot = manager.snapshot();
    expect(snapshot.works[0]!.cwd).toBe(work.cwd);
    expect(readFileSync(original, "utf8")).toBe("원본");
    const second = snapshot.artifacts.find((a) => a.path === join(other, "같은.md"))!;
    expect(second).toMatchObject({ relativePath: "같은.md", workspaceId: workspace.id });
    expect(second.id).not.toBe(first.id);
    expect(first.relativePath).toBe(second.relativePath);
    expect(snapshot.artifacts.filter((a) => a.workspaceId === workspace.id).map((a) => a.relativePath)).toEqual(expect.arrayContaining(["새 결과.md", "같은.md", "스캔.md"]));
    const page = manager.createPage(work.id, "수동 페이지", workspace.id);
    expect(page.path).toBe(join(other, "수동 페이지.md"));
    expect(manager.openFile(work.id, "같은.md", workspace.id).id).toBe(second.id);
  });

  it("rejects cross-project sessions and archives metadata without removing the folder or stopping sessions", async () => {
    const { manager } = setup();
    const one = manager.createWork({ title: "one" });
    const two = manager.createWork({ title: "two" });
    expect(() => manager.createSession(one.id, { provider: "codex", workspaceId: two.defaultWorkspaceId })).toThrow("다른 프로젝트");
    const session = manager.createSession(one.id, { provider: "codex" });
    manager.sink.updateSession(session.id, { status: "running" });
    expect(() => manager.updateWorkspace(one.defaultWorkspaceId!, { archived: true })).toThrow("실행 중");
    manager.sink.updateSession(session.id, { status: "idle" });
    manager.updateWorkspace(one.defaultWorkspaceId!, { archived: true });
    expect(() => manager.createSession(one.id, { provider: "codex" })).toThrow("보관되거나");
    await expect(manager.send(session.id, "blocked", "hello")).rejects.toThrow("보관되거나");
    expect(manager.snapshot().sessions[0]!.archivedAt).toBeNull();
    manager.updateWorkspace(one.defaultWorkspaceId!, { archived: false });
    expect(manager.createPage(one.id, "보존 확인", one.defaultWorkspaceId).workspaceId).toBe(one.defaultWorkspaceId);
  });
});
