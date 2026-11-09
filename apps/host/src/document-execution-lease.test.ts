import { linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { DocumentExecutionLeases } from "./document-execution-lease.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-execution-lease-"));
  const store = new Store(join(dir, "state.sqlite")), bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "fixture", hostLabel: "fixture", managedWorksDir: join(dir, "works"), dataDir: dir });
  cleanups.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const work = manager.createWork({ title: "실행 권한" }), path = join(work.cwd, "note.md"), alias = join(work.cwd, "alias.md");
  writeFileSync(path, "before\n"); symlinkSync(path, alias);
  const artifact = manager.openFile(work.id, path), session = manager.createSession(work.id, { provider: "claude" });
  const registration = manager.documents.registry.open(artifact.id, { viewId: "view", windowId: "window", sessionId: session.id, claim: true });
  const binding = { artifactId: artifact.id, sessionId: session.id, owner: "fixture", access: { viewId: "view", writeToken: registration.writeToken } };
  return { manager, work, path, alias, artifact, session, binding };
}

it("rejects_stale_physical_writer", async () => {
  const f = fixture(), registry = f.manager.documents.registry;
  const first = registry.acquireExecution(f.artifact.id, "first", f.session.id, f.binding.access);
  registry.executions.release(first); registry.close("view", "window");
  const alias = f.manager.openFile(f.work.id, f.alias);
  const opened = registry.open(alias.id, { viewId: "second", windowId: "other", sessionId: f.session.id, claim: true });
  const second = registry.acquireExecution(alias.id, "second", f.session.id, { viewId: "second", writeToken: opened.writeToken });
  expect(second.physicalFileIdentity).toBe(first.physicalFileIdentity);
  expect(second.generation).toBeGreaterThan(first.generation);
  await expect(f.manager.documents.saveText(f.artifact.id, 1, "stale", first.access)).rejects.toMatchObject({ code: "STALE_WRITER" });
  expect(readFileSync(f.path, "utf8")).toBe("before\n");
  await f.manager.documents.saveText(alias.id, 1, "current\n", second.access);
  expect(readFileSync(f.path, "utf8")).toBe("current\n"); expect(lstatSync(f.alias).isSymbolicLink()).toBe(true);
});

it("finishes a pinned document run after UI loss and fences cancellation and external saves", async () => {
  const f = fixture(), office = f.manager.office, documents = f.manager.documents;
  await office.start(f.binding, { turnId: "retained", instruction: "내용 바꾸기", revision: 1 });
  const run = office.requireRun(f.binding, "retained");
  documents.registry.close("view", "window"); office.reconcileViews();
  const reopened = documents.registry.open(f.artifact.id, { viewId: "new-ui", windowId: "new-window", sessionId: f.session.id, claim: true });
  expect(reopened.view.mode).toBe("read"); expect(reopened.writer?.viewId).toBe(run.lease.id);
  const saved = await documents.saveText(f.artifact.id, 1, "from executor\n", run.lease.access);
  expect(saved.revision).toBe(2);
  writeFileSync(f.path, "external save\n");
  await expect(documents.saveText(f.artifact.id, 2, "overwrite", run.lease.access)).rejects.toMatchObject({ code: "disk_changed" });
  office.interrupt(f.session.id);
  await expect(documents.saveText(f.artifact.id, 2, "late", run.lease.access)).rejects.toMatchObject({ code: "STALE_WRITER" });
  expect(readFileSync(f.path, "utf8")).toBe("external save\n");
  expect(f.manager.items(f.session.id).items.filter(item => item.kind === "turnEnd")).toHaveLength(1);
});

it("separates writer ownership from read helpers and fences expired capabilities including hardlinks", () => {
  const f = fixture(), hardlink = join(f.work.cwd, "hardlink.md"); linkSync(f.path, hardlink);
  let now = 1; const leases = new DocumentExecutionLeases(() => now);
  const input = { path: f.path, artifactId: f.artifact.id, sessionId: f.session.id, owner: "writer", mode: "host" as const, writable: true, baseRevision: 1, baseHash: f.artifact.sha256, sourceAccess: f.binding.access };
  const writer = leases.acquire(input), reader = leases.acquire({ ...input, owner: "reader", writable: false });
  expect(() => leases.acquire({ ...input, path: hardlink, owner: "other" })).toThrow(/다른 AI/);
  expect(() => leases.access(f.path, reader.access)).toThrow(/읽기 작업/);
  leases.release(reader); expect(leases.require(writer).owner).toBe("writer");
  now += 120_001;
  expect(() => leases.renew(writer)).toThrow(/실행 권한/);
  expect(leases.acquire({ ...input, owner: "next" }).generation).toBeGreaterThan(writer.generation);
  expect(() => leases.access(f.path, writer.access)).toThrow(/실행 권한/);
});
