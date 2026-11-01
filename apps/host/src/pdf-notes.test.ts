import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { EditorGrants } from "./editors.ts";
import { PdfNotes } from "./pdf-notes.mjs";
import type { PdfNoteResult } from "../../../packages/contracts/src/pdf-notes.ts";
const { PDFDocument } = createRequire(new URL("../../../vendor/ieumoffice/package.json", import.meta.url))("pdf-lib");

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-pdf-note-")), store = new Store(join(dir, "state.sqlite")), bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "PDF note" }), session = manager.createSession(work.id, { provider: "codex" });
  const pdf = await PDFDocument.create(); pdf.addPage().drawText("Original PDF");
  const source = join(work.cwd, "Original (one).pdf"), bytes = Buffer.from(await pdf.save()); writeFileSync(source, bytes);
  const artifact = manager.openFile(work.id, source), grants = new EditorGrants();
  const bind = (id: string, viewId = `view-${id}`, write = true, windowId = "window") => {
    const view = manager.documents.registry.open(id, { viewId, windowId, sessionId: session.id, claim: write });
    return grants.issue(id, { viewId, writeToken: view.writeToken }, session.id);
  };
  const token = bind(artifact.id), notes = new PdfNotes(manager, bus); let serial = 0;
  const call = (action: string, input: Record<string, unknown> = {}) => notes.action(artifact.id, token, grants, action, { requestId: `request-${++serial}`, ...input }) as Promise<PdfNoteResult>;
  return { dir, store, bus, manager, work, source, bytes, artifact, grants, token, notes, call, bind,
    close: async () => { notes.close(); await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

it("uses the original picker/default name, exclusive creation, path/hash lookup and restart links", async () => {
  const f = await fixture();
  try {
    const initial = await f.call("open"); expect(initial).toMatchObject({ ok: false, reason: "cancelled", choosePath: join(f.work.cwd, "Original (one) 노트.md") });
    const alias = join(f.dir, "chosen-folder"); symlinkSync(f.work.cwd, alias, "dir");
    const result = await f.call("open", { selectedPath: join(alias, "Original (one) 노트.md"), request: { title: "PDF 연구\n제목", path: "/not-authorized" } });
    expect(result.ok).toBe(true); expect(readFileSync(result.artifact!.path, "utf8")).toBe("# PDF 연구 제목\n");
    expect(result.artifact).toMatchObject({ workId: f.work.id, workspaceId: f.artifact.workspaceId });
    const restarted = new PdfNotes(f.manager, f.bus);
    try {
      expect(await restarted.action(f.artifact.id, f.token, f.grants, "open", { requestId: "after-restart" })).toMatchObject({ ok: true, artifact: { id: result.artifact!.id } });
      const copyPath = join(f.work.cwd, "Copied.pdf"); writeFileSync(copyPath, f.bytes); const copy = f.manager.openFile(f.work.id, copyPath);
      expect(await restarted.action(copy.id, f.bind(copy.id), f.grants, "open", { requestId: "copy-by-hash" })).toMatchObject({ ok: true, artifact: { id: result.artifact!.id } });
      const all = await restarted.store.readNoteLinks(); expect(Object.values(all.links)).toHaveLength(2);
    } finally { restarted.close(); }
    expect(readFileSync(f.source)).toEqual(f.bytes);
  } finally { await f.close(); }
});

it("preserves an existing dirty note, queues original quoted/overview text once for its live writer, and never writes its disk contents", async () => {
  const f = await fixture();
  try {
    const path = join(f.work.cwd, "Existing.md"), original = '---\r\n"DIKM_단계:": ""\r\nunknown: null\r\n---\r\n# Keep\r\n'; writeFileSync(path, original);
    const note = f.manager.openFile(f.work.id, path), writer = f.bind(note.id, "writer", true, "another-window");
    f.manager.documents.registry.open(note.id, { viewId: "writer", windowId: "another-window", sessionId: f.grants.session(writer), dirty: true });
    const request = { kind: "quote", page: 1, excerpt: "Quoted\nsecond line ![image](https://invalid.test/a)", body: "My reasoning <img src='https://invalid.test/a'>" };
    const input = { requestId: "quote-1", selectedPath: path, request };
    expect(await f.call("insert", input)).toMatchObject({ ok: true, artifact: { id: note.id } });
    expect(await f.call("insert", input)).toMatchObject({ ok: true });
    const readOnly = f.bind(note.id, "reader", false);
    await expect(f.notes.action(note.id, readOnly, f.grants, "take")).rejects.toMatchObject({ code: "editor_access_lost" });
    const texts = await f.notes.action(note.id, writer, f.grants, "take");
    expect(texts).toEqual(["> Quoted\n> second line \\![image](https://invalid.test/a) ([p.1](Original%20%28one%29.pdf#page=1))\n\nMy reasoning \\<img src='https://invalid.test/a'>"]);
    expect(await f.notes.action(note.id, writer, f.grants, "take")).toEqual([]);
    await f.call("insert", { request: { kind: "overview", heading: "Summary", body: "Overview body" } });
    expect(await f.notes.action(note.id, writer, f.grants, "take")).toEqual(["## Summary\n\nOverview body"]);
    expect(readFileSync(path, "utf8")).toBe(original); expect(readFileSync(f.source)).toEqual(f.bytes);
  } finally { await f.close(); }
});

it("rejects foreign/closed views, malformed quotes and file links; a closed note cannot leak queued text to another view", async () => {
  const f = await fixture();
  try {
    await expect(f.notes.action(f.artifact.id, "forged", f.grants, "open", { requestId: "forged" })).rejects.toMatchObject({ code: "pdf_note" });
    await expect(f.call("insert", { request: { kind: "quote", page: 0, excerpt: "invalid" } })).rejects.toMatchObject({ code: "pdf_note" });
    const path = join(f.work.cwd, "Note.md"); writeFileSync(path, "ORIGINAL"); const link = join(f.work.cwd, "link.md"); symlinkSync(path, link);
    expect(await f.call("open", { selectedPath: link })).toMatchObject({ ok: false, reason: "failed" });
    const result = await f.call("open", { selectedPath: path }), note = result.artifact!; f.bind(note.id, "writer");
    await f.call("insert", { request: { kind: "quote", page: 1, excerpt: "closed view" } });
    f.manager.documents.registry.close("writer", "window");
    const replacement = f.bind(note.id, "replacement"); expect(await f.notes.action(note.id, replacement, f.grants, "take")).toEqual([]);
    f.manager.documents.registry.close(`view-${f.artifact.id}`, "window");
    await expect(f.call("open")).rejects.toMatchObject({ code: "pdf_note" }); expect(readFileSync(path, "utf8")).toBe("ORIGINAL");
  } finally { await f.close(); }
});

it("updates linked hashes after PDF saves and asks again when the note was deleted", async () => {
  const f = await fixture();
  try {
    const path = join(f.work.cwd, "Note.md"); const result = await f.call("open", { selectedPath: path });
    const changed = await PDFDocument.load(f.bytes); changed.addPage(); const bytes = Buffer.from(await changed.save()); writeFileSync(f.source, bytes);
    await f.notes.service.afterSave(f.source);
    const links = await f.notes.store.readNoteLinks();
    expect(Object.values(links.links)).toEqual([expect.objectContaining({ notePath: path, docHash: createHash("sha256").update(bytes).digest("hex") })]);
    unlinkSync(result.artifact!.path); expect(await f.call("open")).toMatchObject({ ok: false, reason: "cancelled", choosePath: expect.any(String) });
  } finally { await f.close(); }
});
