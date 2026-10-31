import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { EditorGrants, createEditorsServer } from "./editors.ts";
import { OfficeStyles } from "./office-styles.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-office-styles-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "Design gallery" }), session = manager.createSession(work.id, { provider: "claude" }), grants = new EditorGrants();
  const open = (name: string) => {
    const path = join(work.cwd, name); writeFileSync(path, "UNCHANGED_PPTX");
    const viewId = name.replace(/\./g, "-"), artifact = manager.openFile(work.id, path), view = manager.documents.registry.open(artifact.id, { viewId, windowId: "window", sessionId: session.id, claim: true });
    return { artifact, context: { artifactId: artifact.id, token: grants.issue(artifact.id, { viewId, writeToken: view.writeToken }, session.id), grants } };
  };
  const first = open("first.pptx"), second = open("second.pptx"), service = new OfficeStyles(manager.documents, null);
  const call = (operation: string, input: unknown = {}) => service.call(first.context, operation, input) as any;
  return { dir, store, manager, work, session, grants, first, second, service, call,
    close: async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const data = { topic: "topic", styleSkill: "Original style\n\n추가 요청: 파란색", createdAt: "2026-10-31T00:00:00Z", basedOn: "clean", layout: { title: { x: 20, y: 30 }, future: "preserve" } };

it("remembers each document's selection across service restarts and rejects stale clear/write", async () => {
  const f = fixture();
  try {
    expect(f.call("selection-get")).toEqual({ revision: null, selection: null });
    const picked = f.call("selection-set", { expectedRevision: null, selection: { kind: "builtin", key: "clean", adjustments: ["  파란색  "] } });
    expect(picked.selection).toMatchObject({ kind: "builtin", key: "clean", adjustments: ["파란색"] });
    expect(new OfficeStyles(f.manager.documents, null).call(f.first.context, "selection-get")).toEqual(picked);
    expect(f.service.call(f.second.context, "selection-get")).toEqual({ revision: null, selection: null });
    expect(() => f.call("selection-set", { expectedRevision: null, selection: null })).toThrow(/바뀌었/);
    expect(() => f.call("selection-set", { expectedRevision: picked.revision, selection: { kind: "bad", key: "clean" } })).toThrow(/올바르지/);
    expect(f.call("selection-get")).toEqual(picked);
    expect(f.call("selection-set", { expectedRevision: picked.revision, selection: null }).selection).toBeNull();
    expect(readFileSync(f.first.artifact.path, "utf8")).toBe("UNCHANGED_PPTX");
  } finally { await f.close(); }
});
it("requires the registered PPTX view and its current writer for selection and style saves", async () => {
  const f = fixture();
  try {
    expect(() => f.service.call({ ...f.first.context, artifactId: f.second.artifact.id }, "list")).toThrow(/권한/);
    const view = f.manager.documents.registry.open(f.first.artifact.id, { viewId: "reader", windowId: "other", sessionId: f.session.id });
    const token = f.grants.issue(f.first.artifact.id, { viewId: view.view.viewId, writeToken: null }, f.session.id), context = { ...f.first.context, token };
    expect(f.service.call(context, "list")).toEqual([]);
    expect(() => f.service.call(context, "save", { name: "mine", data, expectedRevision: null })).toThrow();
    expect(() => f.service.call(context, "selection-set", { selection: null, expectedRevision: null })).toThrow();
    const old = f.first.context.token;
    f.manager.documents.registry.close("first-pptx", "window");
    expect(() => f.service.call({ ...f.first.context, token: old }, "list")).toThrow(/바뀌었/);
  } finally { await f.close(); }
});
it("preserves saved layout, ancestry and every style version, with compare-and-save", async () => {
  const f = fixture();
  try {
    const saved = f.call("save", { name: "내 발표", data, expectedRevision: null });
    expect(f.call("load", { name: "내 발표" })).toMatchObject({ ok: true, ...data, revision: saved.revision });
    const changed = f.call("save", { name: "내 발표", data: { ...data, styleSkill: "Revised" }, expectedRevision: saved.revision });
    expect(() => f.call("save", { name: "내 발표", data, expectedRevision: saved.revision })).toThrow(/바뀌었/);
    expect(f.call("list")).toEqual([{ name: "내 발표", topic: data.topic, createdAt: data.createdAt }]);
    expect(new OfficeStyles(f.manager.documents, null).call(f.second.context, "load", { name: "내 발표" })).toMatchObject({ styleSkill: "Revised", revision: changed.revision });
    const folder = join(f.dir, "office-styles/history", readdirSync(join(f.dir, "office-styles/history"))[0]!);
    expect(readdirSync(folder)).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(folder, `${saved.revision}.json`), "utf8")).data).toEqual(data);
    expect(() => f.call("selection-set", { selection: { kind: "saved", key: "missing" }, expectedRevision: null })).toThrow(/찾을 수/);
    expect(f.call("selection-set", { selection: { kind: "saved", key: "내 발표" }, expectedRevision: null }).selection.key).toBe("내 발표");
    for (const name of ["../outside", "folder/name", "\u0000name", " name"]) expect(() => f.call("save", { name, data, expectedRevision: null })).toThrow();
  } finally { await f.close(); }
});
it("keeps an existing sidecar byte for byte before updates and refuses linked sidecars", async () => {
  const f = fixture();
  try {
    const file = f.first.artifact.path.replace(/\.pptx$/, ".styleskill.json"), original = Buffer.from("EXISTING_UNKNOWN_FORMAT\r\n");
    writeFileSync(file, original); expect(f.call("sidecar", { data })).toEqual({ ok: true });
    const root = join(f.dir, "office-styles/sidecars"), folder = join(root, readdirSync(root)[0]!);
    expect(readFileSync(join(folder, readdirSync(folder)[0]!))).toEqual(original);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(data);
    rmSync(file); const outside = join(f.dir, "outside.json"); writeFileSync(outside, original); symlinkSync(outside, file);
    expect(() => f.call("sidecar", { data })).toThrow(/링크/);
    expect(readFileSync(outside)).toEqual(original);
    expect(readFileSync(f.first.artifact.path, "utf8")).toBe("UNCHANGED_PPTX");
  } finally { await f.close(); }
});
it("exposes style IPC only through the authenticated editor route", async () => {
  const f = fixture(), server = createEditorsServer(f.manager.documents, f.grants, null);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/artifacts/${f.first.artifact.id}/ai/styles/list`;
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    const headers = { authorization: `Bearer ${f.first.context.token}` };
    expect((await fetch(url, { headers })).status).toBe(405);
    const response = await fetch(url, { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store"); expect(await response.json()).toEqual([]);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await f.close(); }
});
