import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { encodePdfRequest } from "../../../packages/contracts/src/pdf.ts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { createEditorsServer, EditorGrants } from "./editors.ts";
const require = createRequire(new URL("../../../vendor/ieumoffice/package.json", import.meta.url));
const { PDFDocument } = require("pdf-lib");

describe("scoped PDF editor", () => {
  it("enforces lease, path, revision and disk guards; recovery never writes the original and rebase uses the retained PDF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-pdf-http-")), store = new Store(join(dir, "state.sqlite"));
    const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
    const work = manager.createWork({ title: "PDF", cwd: join(dir, "project") }); mkdirSync(work.cwd, { recursive: true });
    const doc = await PDFDocument.create(); doc.addPage([400, 600]); doc.addPage([500, 700]);
    const original = Buffer.from(await doc.save()), file = join(work.cwd, "원본.pdf"); writeFileSync(file, original);
    const artifact = manager.openFile(work.id, "원본.pdf"), documents = manager.documents;
    const writer = documents.registry.open(artifact.id, { viewId: "writer", windowId: "writer", claim: true });
    const reader = documents.registry.open(artifact.id, { viewId: "reader", windowId: "reader", claim: true });
    const grants = new EditorGrants(), writerToken = grants.issue(artifact.id, { viewId: "writer", writeToken: writer.writeToken }), readerToken = grants.issue(artifact.id, { viewId: "reader", writeToken: reader.writeToken });
    const server = createEditorsServer(documents, grants, null);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (operation: string, revision: number, request: Record<string, unknown>, token = writerToken, source?: ArrayBuffer, id = artifact.id) => fetch(`${origin}/api/artifacts/${id}/pdf/${operation}?revision=${revision}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: encodePdfRequest(request, source) });
    try {
      expect((await call("save", 1, {}, "forged")).status).toBe(401);
      expect((await call("save", 1, {}, readerToken)).status).toBe(423);
      expect((await call("save", 1, { path: join(dir, "secret.pdf") })).status).toBe(403);
      expect((await call("save", 1, { targetPath: join(dir, "secret.pdf") })).status).toBe(422);
      const kept = await call("recover", 1, { rotations: [{ pageIndex: 0, delta: 90 }] });
      expect(kept.status).toBe(200); const draft = await kept.arrayBuffer();
      expect(readFileSync(file)).toEqual(original); expect(documents.get(artifact.id).revision).toBe(1);
      expect((await PDFDocument.load(draft)).getPage(0).getRotation().angle).toBe(90);
      expect((await call("save", 1, {})).status).toBe(200); expect(documents.get(artifact.id).revision).toBe(1);
      const saved = await call("save", 1, { rotations: [{ pageIndex: 1, delta: 180 }] });
      expect(saved.status).toBe(200); expect((await saved.json()).revision).toBe(2);
      expect(readFileSync(documents.revisionPath(artifact.id, 1))).toEqual(original);
      expect((await call("save", 1, {})).status).toBe(409);
      const external = await PDFDocument.create(); external.addPage([600, 800]);
      const externalBytes = Buffer.from(await external.save()); writeFileSync(file, externalBytes);
      expect((await call("save", 2, {})).status).toBe(409); expect(readFileSync(file)).toEqual(externalBytes);
      documents.adoptDisk(artifact.id);
      // Explicit rebase replaces the new file with the retained draft; no old rotation is
      // accidentally applied to the structurally different one-page external document.
      const rebased = await call("save", 3, {}, writerToken, draft);
      expect(rebased.status).toBe(200); expect((await rebased.json()).revision).toBe(4);
      const final = await PDFDocument.load(readFileSync(file));
      expect(final.getPageCount()).toBe(2); expect(final.getPage(0).getRotation().angle).toBe(90);
      expect(readFileSync(documents.revisionPath(artifact.id, 3))).toEqual(externalBytes);
      // A renderer Undo may restore an older base with no pending operations.
      // It still saves against the latest CAS and preserves every intervening file.
      const undone = await call("save", 4, {}, writerToken, Uint8Array.from(original).buffer);
      expect(undone.status).toBe(200); expect((await undone.json()).revision).toBe(5);
      expect(readFileSync(file)).toEqual(original);
      expect((await PDFDocument.load(readFileSync(documents.revisionPath(artifact.id, 4)))).getPage(0).getRotation().angle).toBe(90);
      expect((await call("save", 4, {}, writerToken, draft)).status).toBe(409);
      expect(readFileSync(file)).toEqual(original);
      const redone = await call("save", 5, {}, writerToken, draft);
      expect(redone.status).toBe(200); expect((await redone.json()).revision).toBe(6);
      expect(Buffer.from(draft)).toEqual(readFileSync(file));
      documents.registry.close("writer", "writer");
      expect((await call("save", 6, {})).status).toBe(423);
      expect((await call("recover", 6, {}, readerToken)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
});
