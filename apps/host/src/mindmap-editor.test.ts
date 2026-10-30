import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { mindmapFixture } from "../../../scripts/app-e2e/mindmap-fixture.ts";
import { inspectMindmap, mindmapText } from "./mindmap-ops.mjs";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { createEditorsServer, EditorGrants, officeEditorKind } from "./editors.ts";

describe("original mindmap editor gate", () => {
  it("accepts modern maps and refuses legacy, encrypted and malformed archives without normalization", async () => {
    expect(officeEditorKind("xmind")).toBe("mindmap");
    const bytes = await mindmapFixture(), before = Buffer.from(bytes);
    expect(await inspectMindmap(bytes)).toBe("ok");
    expect(await mindmapText(bytes)).toContain("Preserved floating topic");
    expect(bytes).toEqual(before);
    expect(await inspectMindmap(await mindmapFixture("old", { legacy: true }))).toBe("legacy-format");
    expect(await inspectMindmap(await mindmapFixture("locked", { encrypted: true }))).toBe("encrypted");
    expect(await inspectMindmap(await mindmapFixture("broken", { invalid: true }))).toBe("unreadable");
    expect(await inspectMindmap(Buffer.from("PK junk"))).toBe("unreadable");
  });

  it("preserves revision history and scopes validated save/recovery to the opened map and live writer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-mindmap-http-")), store = new Store(join(dir, "state.sqlite"));
    const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
    const work = manager.createWork({ title: "Map", cwd: join(dir, "project") }); mkdirSync(work.cwd, { recursive: true });
    const original = await mindmapFixture(), file = join(work.cwd, "지도.xmind"); writeFileSync(file, original);
    const artifact = manager.openFile(work.id, "지도.xmind"), documents = manager.documents;
    const writer = documents.registry.open(artifact.id, { viewId: "writer", windowId: "writer", claim: true });
    const reader = documents.registry.open(artifact.id, { viewId: "reader", windowId: "reader", claim: true });
    const grants = new EditorGrants(), token = grants.issue(artifact.id, { viewId: "writer", writeToken: writer.writeToken }), readToken = grants.issue(artifact.id, { viewId: "reader", writeToken: reader.writeToken });
    const server = createEditorsServer(documents, grants, null);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (operation: string, revision: number, bytes = original, grant = token, id = artifact.id) => fetch(`${origin}/api/artifacts/${id}/mindmap/${operation}?revision=${revision}`, { method: operation === "open" ? "GET" : "POST", headers: { authorization: `Bearer ${grant}` }, body: operation === "open" ? undefined : new Uint8Array(bytes).buffer });
    try {
      expect((await call("save", 1, original, "forged")).status).toBe(401);
      expect((await call("open", 1, original, token, "another-artifact")).status).toBe(401);
      expect((await call("save", 1, original, readToken)).status).toBe(423);
      expect(Buffer.from(await (await call("open", 1)).arrayBuffer())).toEqual(original);
      expect((await documents.text(artifact.id)).editable).toBe(false);
      expect((await documents.text(artifact.id)).text).toContain("First branch");
      await expect(documents.saveText(artifact.id, 1, "destructive text", { viewId: "writer", writeToken: writer.writeToken })).rejects.toMatchObject({ code: "binary_document" });
      await expect(documents.prepare({ artifactId: artifact.id, mode: "edit", revision: 1 }, "session", "request", work.cwd)).rejects.toMatchObject({ code: "not_editable" });
      expect((await call("save", 1, Buffer.from("PK junk"))).status).toBe(422);
      const kept = await mindmapFixture("Unsaved retained map");
      expect(await (await call("check", 1, kept, readToken)).json()).toEqual({ status: "ok" });
      expect(readFileSync(file)).toEqual(original);
      expect((await call("save", 1)).status).toBe(200); expect(documents.get(artifact.id).revision).toBe(1);
      expect((await (await call("save", 1, kept)).json()).revision).toBe(2);
      expect(readFileSync(documents.revisionPath(artifact.id, 1))).toEqual(original);
      expect((await call("save", 1, kept)).status).toBe(409);
      const external = await mindmapFixture("External replacement"); writeFileSync(file, external);
      expect((await call("save", 2, kept)).status).toBe(409); expect(readFileSync(file)).toEqual(external);
      documents.adoptDisk(artifact.id);
      expect((await (await call("save", 3, kept)).json()).revision).toBe(4);
      expect(readFileSync(file)).toEqual(kept);
      expect(readFileSync(documents.revisionPath(artifact.id, 3))).toEqual(external);
      documents.registry.close("writer", "writer");
      expect((await call("save", 4, kept)).status).toBe(423);
      expect((await call("check", 4, kept, readToken)).status).toBe(200);
      const badPath = join(work.cwd, "열리지 않는 지도.xmind"); writeFileSync(badPath, await mindmapFixture("broken", { invalid: true }));
      const bad = manager.openFile(work.id, badPath), badToken = grants.issue(bad.id);
      expect(await (await call("open", 1, kept, badToken, bad.id)).json()).toEqual({ status: "unreadable" });
      expect((await call("save", 1, kept, badToken, bad.id)).status).toBe(422);
      expect(readFileSync(badPath)).not.toEqual(kept);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
});
