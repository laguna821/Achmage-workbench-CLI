import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { DeviceGrant } from "@workbench/contracts";
import { Store } from "../store.ts";
import { EventBus } from "../bus.ts";
import { SessionManager } from "../sessions.ts";
import { RemoteMediaAccess } from "./media.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6N8AAAAASUVORK5CYII=", "base64");
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "workbench-remote-media-"));
  const store = new Store(join(directory, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "media-host", hostLabel: "첨부 검사", dataDir: directory, managedWorksDir: join(directory, "works") });
  cleanups.push(async () => { try { await manager.shutdown(); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); } });
  const own = manager.createWork({ title: "허용" }), foreign = manager.createWork({ title: "비공개" });
  const session = manager.createSession(own.id, { provider: "codex" });
  const otherSession = manager.createSession(foreign.id, { provider: "codex" });
  const access = new RemoteMediaAccess(directory, manager);
  const save = (name: string) => manager.attachments.save(Buffer.concat([PNG, Buffer.from(name)]), name + ".png", "image/png");
  const grant = (workIds = [own.id], deviceId = "device-a"): DeviceGrant => ({
    deviceId, hostId: "media-host", name: "기기", platform: "test", permissions: ["read", "send"], workIds,
    createdAt: 1, approvedAt: 1, activatedAt: 1, expiresAt: null, revokedAt: null, credentialVersion: 1, lastRotatedAt: null,
  });
  return { directory, manager, own, foreign, session, otherSession, access, save, grant };
}

test("reads only attachment IDs actually referenced by a granted transcript or queue", () => {
  const f = fixture();
  const user = f.save("user"), tool = f.save("tool"), assistant = f.save("assistant"), queued = f.save("queued");
  const foreign = f.save("foreign"), unreferenced = f.save("unreferenced");
  f.manager.sink.upsertItem(f.session.id, { kind: "user", id: "user:one", text: "첨부", attachments: [user], at: 1 });
  f.manager.sink.upsertItem(f.session.id, { kind: "tool", tool: "agent", id: "tool:one", title: "그림 결과", detail: null, output: null, status: "completed", images: [tool], at: 2 });
  f.manager.sink.upsertItem(f.session.id, { kind: "assistant", id: "assistant:one", text: "그림", streaming: false, media: [{ source: "result.png", attachment: assistant }], at: 3 });
  f.manager.sink.updateSession(f.session.id, { queued: [{ id: "waiting", text: "대기 첨부", refs: [], create: null, at: 4, held: true, attachments: [queued] }] });
  f.manager.sink.upsertItem(f.otherSession.id, { kind: "user", id: "user:foreign", text: "다른 작업", attachments: [foreign], at: 5 });

  for (const attachment of [user, tool, assistant, queued]) expect(f.access.workFor(f.grant(), attachment.id)).toBe(f.own.id);
  expect(f.access.workFor(f.grant(), foreign.id)).toBeNull();
  expect(f.access.workFor(f.grant(), unreferenced.id)).toBeNull();
  expect(f.access.workFor(f.grant(), "../state.sqlite")).toBeNull();
  // Another approved device can read the shared work's actual conversation, not global uploads.
  expect(f.access.workFor(f.grant([f.own.id], "device-b"), user.id)).toBe(f.own.id);
  for (const attachment of [user, tool, assistant, queued]) expect(f.access.workFor(f.grant([]), attachment.id)).toBeNull();
});

test("persists a new upload's device and work ownership without copying the global attachment bytes", () => {
  const f = fixture(), uploaded = f.save("new-upload");
  const sourcePath = f.manager.attachments.path(uploaded.id);
  expect(f.access.workFor(f.grant(), uploaded.id)).toBeNull();
  f.access.remember(f.grant(), f.own.id, uploaded);
  f.access.remember(f.grant(), f.own.id, uploaded);
  const restored = new RemoteMediaAccess(f.directory, f.manager);
  expect(restored.workFor(f.grant(), uploaded.id)).toBe(f.own.id);
  expect(restored.workFor(f.grant([f.own.id], "device-b"), uploaded.id)).toBeNull();
  expect(restored.workFor(f.grant([]), uploaded.id)).toBeNull();
  expect(restored.workFor({ ...f.grant(), revokedAt: Date.now() }, uploaded.id)).toBeNull();
  expect(restored.workFor({ ...f.grant(), expiresAt: Date.now() - 1 }, uploaded.id)).toBeNull();
  expect(restored.workFor({ ...f.grant(), hostId: "different-host" }, uploaded.id)).toBeNull();
  expect(() => restored.remember(f.grant(), f.foreign.id, uploaded)).toThrow(expect.objectContaining({ status: 403 }));
  expect(f.manager.attachments.path(uploaded.id)).toBe(sourcePath);

  const path = join(f.directory, "devices", "media.json");
  const persisted = JSON.parse(readFileSync(path, "utf8")) as { uploads: unknown[] };
  expect(persisted.uploads).toHaveLength(1);
  expect(persisted.uploads[0]).toMatchObject({ deviceId: "device-a", workId: f.own.id, attachmentId: uploaded.id });
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("checks every actual send attachment and preserves a damaged ownership sidecar", () => {
  const f = fixture(), allowed = f.save("allowed-send"), secret = f.save("secret-send");
  f.access.remember(f.grant(), f.own.id, allowed);
  f.manager.sink.upsertItem(f.otherSession.id, { kind: "user", id: "secret", text: "비공개", attachments: [secret], at: 1 });
  expect(() => f.access.requireReferences(f.grant(), { attachments: [allowed] })).not.toThrow();
  expect(() => f.access.requireReferences(f.grant(), { attachments: [allowed, secret] })).toThrow(expect.objectContaining({ status: 403, code: "attachment_scope_denied" }));
  expect(() => f.access.requireReferences(f.grant([]), { attachments: [allowed] })).toThrow(expect.objectContaining({ status: 403 }));
  expect(() => f.access.requireReferences(f.grant(), { attachments: [{ name: "ID 없음" }] })).toThrow(expect.objectContaining({ status: 403 }));
  expect(() => f.access.requireReferences(f.grant(), { attachments: "not-an-array" })).toThrow(expect.objectContaining({ status: 400 }));
  // The current drawing request has no attachment-ID field; route scope owns its targets.
  expect(() => f.access.requireReferences(f.grant(), { requestId: "draw", brief: "원", via: "helper", insertInto: null })).not.toThrow();
  rmSync(f.manager.attachments.path(allowed.id));
  expect(f.access.workFor(f.grant(), allowed.id)).toBeNull();

  const path = join(f.directory, "devices", "media.json");
  writeFileSync(path, "{damaged", { mode: 0o600 });
  expect(() => new RemoteMediaAccess(f.directory, f.manager)).toThrow(expect.objectContaining({ code: "remote_media_store" }));
  expect(readFileSync(path, "utf8")).toBe("{damaged");
});
