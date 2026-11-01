import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { epubFixture, epubEntry } from "../../../scripts/app-e2e/epub-fixture.ts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { createEditorsServer, EditorGrants } from "./editors.ts";
import { OfficeOutputs } from "./office-output.ts";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-epub-translation-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "Book" }); mkdirSync(work.cwd, { recursive: true });
  const original = await epubFixture(), file = join(work.cwd, "source.epub"); writeFileSync(file, original);
  const artifact = manager.openFile(work.id, file), documents = manager.documents;
  const writer = documents.registry.open(artifact.id, { viewId: "writer", windowId: "writer", claim: true });
  const access = { viewId: "writer", writeToken: writer.writeToken };
  const grants = new EditorGrants(), token = grants.issue(artifact.id, access);
  const server = createEditorsServer(documents, grants, null); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let session = "";
  const call = (operation: string, args: unknown = {}, sid = session) => fetch(`${origin}/api/artifacts/${artifact.id}/epub/${operation}?session=${sid}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
  const json = async (op: string, args: unknown = {}, sid = session) => (await call(op, args, sid)).json();
  const open = async (revision = 1) => {
    const result = await (await fetch(`${origin}/api/artifacts/${artifact.id}/epub/open?revision=${revision}`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json();
    session = result.sessionId; return result;
  };
  const initial = await open();
  const outputs = new OfficeOutputs(documents, manager.registerOfficeCopy.bind(manager));
  return { dir, manager, work, documents, file, original, artifact, access, initial, outputs, open, call, json,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
function unpack(payload: Buffer) {
  const length = payload.readUInt32BE(0);
  return { ...JSON.parse(payload.subarray(4, 4 + length).toString()), bytes: payload.subarray(4 + length) };
}

it("scopes the original store and writes translated/bilingual books through the selected output only", async () => {
  const f = await fixture();
  try {
    expect(await f.json("store-translation", { docHash: "unknown", lang: "ko" })).toMatchObject({ ok: false, error: "not-granted" });
    expect(await f.json("translation-units", { chapters: [999] })).toMatchObject({ ok: false, error: "invalid-request" });
    const units = await f.json("translation-units"), block = units.units.find((unit: { text: string }) => unit.text === "First paragraph.");
    expect(units.ok).toBe(true); expect(block).toBeTruthy();
    expect(await f.json("store-write", { kind: "translationBlocks", docHash: units.docHash, lang: "ko", blocks: [{ key: block.key, status: "translated", text: "번역된 첫 문단입니다." }] })).toMatchObject({ ok: true });
    expect(await f.json("store-write", { kind: "job", docHash: units.docHash, lang: "ko", job: { kind: "ai-read", state: "running", lang: "ko" } })).toMatchObject({ ok: false, error: "invalid-request" });
    expect((await f.call("translation-build", { kind: "translated", lang: "ko", docHash: units.docHash })).status).toBe(409);
    await f.json("lock", { locked: true });
    expect(await f.json("translation-build", { kind: "translated", lang: "ko", docHash: "old" })).toMatchObject({ ok: false, error: "stale" });
    for (const kind of ["translated", "bilingual"]) {
      const response = await f.call("translation-build", { kind, lang: "ko", docHash: units.docHash });
      expect(response.headers.get("content-type")).toBe("application/x-workbench-epub-result");
      const built = unpack(Buffer.from(await response.arrayBuffer()));
      expect(built.identifier).toMatch(/^urn:uuid:/);
      const chapter = (await epubEntry(built.bytes, "OEBPS/text/one.xhtml"))!.toString();
      expect(chapter).toContain("번역된 첫 문단입니다."); expect(chapter.includes("First paragraph.")).toBe(kind === "bilingual");
      expect(await epubEntry(built.bytes, "future/unknown.bin")).toEqual(await epubEntry(f.original, "future/unknown.bin"));
      const plan = f.outputs.prepare(f.artifact.id, 1, join(f.work.cwd, `${kind}.epub`), f.access, true);
      const result = await f.outputs.commit(f.artifact.id, plan.id, built.bytes, false, f.access, 1);
      expect(result.artifact?.format).toBe("epub"); expect(readFileSync(result.path)).toEqual(built.bytes);
    }
    expect(readFileSync(f.file)).toEqual(f.original); expect(f.documents.get(f.artifact.id).revision).toBe(1);
    writeFileSync(f.file, await epubFixture("External change"));
    expect((await f.call("translation-build", { kind: "translated", lang: "ko", docHash: units.docHash })).status).toBe(409);
  } finally { await f.close(); }
});

it("retains unchanged translations and interrupted job records after a source save and reopen", async () => {
  const f = await fixture();
  try {
    const first = await f.json("translation-units"), kept = first.units.find((u: { text: string }) => u.text === "Second paragraph remains."), changed = first.units.find((u: { text: string }) => u.text === "First paragraph.");
    await f.json("store-write", { kind: "translationBlocks", docHash: first.docHash, lang: "ko", blocks: [kept, changed].map((unit, i) => ({ key: unit.key, status: "translated", text: i ? "이전 글 번역" : "보존할 번역", edited: true })) });
    await f.json("store-write", { kind: "job", docHash: first.docHash, lang: "ko", job: { kind: "translate", lang: "ko", state: "running", progress: { done: 2, total: 8 }, outputs: [] } });
    await f.json("close"); await f.open();
    expect((await f.json("store-jobs", { docHash: first.docHash })).jobs[0]).toMatchObject({ state: "stopped", last_error: "interrupted" });
    const chapter = await f.json("chapter", { spineIndex: 0 }), p = chapter.blocks.find((b: { kind: string }) => b.kind === "p");
    await f.json("apply", { spineIndex: 0, edits: [{ op: "replace", blockId: p.id, text: "A genuinely changed source paragraph." }] });
    expect((await f.call("lock", { locked: true })).status).toBe(409);
    const saved = await f.json("save", { expectedRevision: 1 }); expect(saved.revision).toBe(2); expect(saved.migrationWarning).toBeUndefined();
    expect(saved.docHash).not.toBe(first.docHash);
    const stored = await f.json("store-translation", { docHash: saved.docHash, lang: "ko" });
    expect(stored.translation.blocks).toHaveLength(1); expect(stored.translation.blocks[0]).toMatchObject({ text: "보존할 번역", edited: true });
    expect((await f.json("store-jobs", { docHash: saved.docHash })).jobs[0]).toMatchObject({ state: "stopped", lang: "ko" });
    await f.json("close"); await f.open(2);
    expect((await f.json("store-translation", { docHash: saved.docHash, lang: "ko" })).translation.blocks).toHaveLength(1);
    expect(await f.json("store-translation", { docHash: first.docHash, lang: "ko" })).toMatchObject({ ok: false, error: "not-granted" });
    expect(readFileSync(f.documents.revisionPath(f.artifact.id, 1))).toEqual(f.original);
  } finally { await f.close(); }
});

it("keeps a long-job destination beyond fifteen minutes but refuses changed files and closed views", async () => {
  const f = await fixture();
  try {
    const base = Date.now(), path = join(f.dir, "translation.epub");
    const plan = f.outputs.prepare(f.artifact.id, 1, path, f.access, true);
    const now = vi.spyOn(Date, "now").mockReturnValue(base + 3_600_000);
    try { expect((await f.outputs.commit(f.artifact.id, plan.id, f.original, false, f.access, 1)).path).toBe(path); } finally { now.mockRestore(); }
    const changed = f.outputs.prepare(f.artifact.id, 1, join(f.dir, "changed.epub"), f.access, true);
    writeFileSync(changed.path, "A later file");
    await expect(f.outputs.commit(f.artifact.id, changed.id, f.original, false, f.access, 1)).rejects.toMatchObject({ code: "output_changed" });
    expect(readFileSync(changed.path, "utf8")).toBe("A later file");
    const closed = f.outputs.prepare(f.artifact.id, 1, join(f.dir, "closed.epub"), f.access, true);
    for (let i = 0; i < 98; i++) f.outputs.prepare(f.artifact.id, 1, join(f.dir, `abandoned-${i}.epub`), f.access, true);
    f.documents.registry.close("writer", "writer");
    await expect(f.outputs.commit(f.artifact.id, closed.id, f.original, false, f.access, 1)).rejects.toMatchObject({ code: "output_view_changed" });
    // A closed book must not consume every output slot for the rest of the app's life.
    const later = vi.spyOn(Date, "now").mockReturnValue(base + 3_600_000);
    try { expect(f.outputs.prepare(f.artifact.id, 1, join(f.dir, "after-close.epub")).path).toBe(join(f.dir, "after-close.epub")); }
    finally { later.mockRestore(); }
  } finally { await f.close(); }
});
