// v0.13.0's PDF tools through the gateway (unit pdf-tools): the page clipboard between PDF tabs of one window,
// 용량 줄이기 into a private result the parent publishes, and password-protected PDFs that stay protected.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { encodePdfRequest } from "../../../packages/contracts/src/pdf.ts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { createEditorsServer, EditorGrants } from "./editors.ts";
import { PdfPageClipboard, PDF_CLIPBOARD_MAX_BYTES } from "./pdf-clipboard.mjs";
import { copyPdfPages, decryptPdf, editPdf, pastePdfPages, queryPdf, reducePdf } from "./pdf-ops.mjs";
import { OfficeOutputs } from "./office-output.ts";
// Upstream's renderer module, loaded at run time only (its type imports would pull the vendor tree into the typecheck).
const OCR_BAKE = "../../../vendor/ieumoffice/apps/pdf/src/renderer/ocr-bake.ts", ATTACHMENTS = "../../../vendor/ieumoffice/apps/pdf/src/main/pdf-attachments.ts";
const require = createRequire(new URL("../../../vendor/ieumoffice/package.json", import.meta.url));
const { PDFDocument, PDFName, StandardFonts } = require("pdf-lib");
const LOCKED = resolve(dirname(new URL(import.meta.url).pathname), "../../../vendor/ieumoffice/apps/shell/tests/fixtures/testPassword4Spaces.pdf");
const FOUR_SPACES = " ".repeat(4);

async function pdf(label: string, pages: number) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([400 + i, 600]).drawText(`${label} ${i + 1}`, { x: 30, y: 550, size: 18, font });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
const texts = async (bytes: Uint8Array) => ((await queryPdf(bytes, "text", {})) as { pages: { text: string }[] }).pages.map(p => p.text.trim());

describe("page clipboard (held by the gateway)", () => {
  it("holds one slot per window, bounded in size and time", () => {
    let now = 1000;
    const clipboard = new PdfPageClipboard(() => now);
    clipboard.hold("w1", { bytes: Buffer.alloc(10), count: 2 });
    expect(clipboard.count("w1")).toBe(2);
    expect(clipboard.count("w2")).toBe(0);
    expect(clipboard.held("w2")).toBeNull();
    expect(() => clipboard.hold("w1", { bytes: Buffer.alloc(PDF_CLIPBOARD_MAX_BYTES + 1), count: 1 })).toThrow("너무 큽니다");
    expect(clipboard.count("w1")).toBe(2);
    now += 31 * 60_000;
    expect(clipboard.count("w1")).toBe(0);
    for (let i = 0; i < 40; i++) clipboard.hold(`w${i}`, { bytes: Buffer.alloc(1), count: 1 });
    expect(clipboard.size).toBeLessThanOrEqual(16);
    expect(clipboard.count("w39")).toBe(1);
    clipboard.clear();
    expect(clipboard.count("w39")).toBe(0);
  });

  it("copies the pages as displayed (pending edits applied) and pastes them after a page", async () => {
    const a = await pdf("A", 4), b = await pdf("B", 2);
    // The view shows A with page 2 deleted and the rest reversed: positions 0 and 1 are A4 and A3.
    const copied = await copyPdfPages(a, { source: { deletedPages: [1], pageOrder: [3, 2, 0] }, pages: [1, 0, 1, 99, -1] });
    expect(copied.count).toBe(2);
    expect(await texts(copied.bytes)).toEqual(["A 4", "A 3"]);
    const front = await pastePdfPages(b, copied.bytes, -1);
    expect(front.count).toBe(2);
    expect(await texts(front.bytes)).toEqual(["A 4", "A 3", "B 1", "B 2"]);
    expect(await texts((await pastePdfPages(b, copied.bytes, 0)).bytes)).toEqual(["B 1", "A 4", "A 3", "B 2"]);
    await expect(pastePdfPages(b, copied.bytes, 2)).rejects.toThrow("붙여 넣을 위치");
    await expect(copyPdfPages(a, { source: {}, pages: [] })).rejects.toThrow("복사할 쪽");
    await expect(copyPdfPages(a, { source: {}, pages: [7] })).rejects.toThrow("복사할 쪽");
    await expect(copyPdfPages(a, { source: { targetPath: "/elsewhere.pdf" }, pages: [0] })).rejects.toThrow();
  });
});

describe("용량 줄이기 (upstream's shrink, on a copy)", () => {
  it("re-compresses a weakly compressed stream and reports both sizes; an already small file answers no bytes", async () => {
    const doc = await PDFDocument.create(); doc.addPage([400, 600]);
    // A stored (level 0) Flate stream: upstream re-deflates it at level 9.
    const raw = Buffer.alloc(400_000, "Workbench "), stored = deflateSync(raw, { level: 0 });
    doc.context.register(doc.context.stream(stored, { Filter: "FlateDecode", Length: stored.length }));
    const source = Buffer.from(await doc.save({ useObjectStreams: false })), before = Buffer.from(source);
    const result = await reducePdf(source);
    expect(result.bytesBefore).toBe(source.length);
    expect(result.bytesAfter).toBeLessThan(source.length / 10);
    expect(result.streamsRecompressed).toBeGreaterThan(0);
    expect((await PDFDocument.load(result.bytes!)).getPageCount()).toBe(1);
    expect(source.equals(before)).toBe(true);
    const plain = await PDFDocument.create(); plain.addPage([400, 600]);
    const small = Buffer.from(await plain.save()), again = await reducePdf(small);
    expect(again.bytes).toBeNull();
    expect(again.bytesAfter).toBeGreaterThanOrEqual(again.bytesBefore);
  });
});

describe("password-protected PDFs stay protected", () => {
  it("decrypts only with the password, saves under the same protection, and lifts it only on the dialog's request", async () => {
    const locked = readFileSync(LOCKED);
    expect(await decryptPdf(locked, "wrong")).toEqual({ ok: false, reason: "wrong-password" });
    const opened = await decryptPdf(locked, FOUR_SPACES);
    expect(opened).toMatchObject({ ok: true, neededPassword: true });
    expect((opened as { bytes: Uint8Array }).bytes.length).toBe(0); // plain bytes never travel back to the page
    const plain = await pdf("P", 1);
    expect(await decryptPdf(plain, "")).toMatchObject({ ok: true, neededPassword: false });
    const note = [{ kind: "note", pageIndex: 0, color: [1, 1, 0], at: [60, 500], contents: "kept protected" }];
    // No password in the request: refused, the file is not opened.
    await expect(editPdf(locked, { drawings: note })).rejects.toThrow("암호");
    const kept = await editPdf(locked, { drawings: note, decryption: { userPassword: FOUR_SPACES }, protectionDirty: false }, { unlocked: true });
    expect(Buffer.from(kept.bytes).includes(Buffer.from("/Encrypt"))).toBe(true);
    expect((await decryptPdf(kept.bytes, "wrong")).ok).toBe(false);
    expect((await decryptPdf(kept.bytes, FOUR_SPACES)).ok).toBe(true);
    // The protection dialog's 보호 해제: protectionDirty with no new protection writes a plain file.
    const lifted = await editPdf(locked, { decryption: { userPassword: FOUR_SPACES }, protectionDirty: true }, { unlocked: true });
    expect((await PDFDocument.load(lifted.bytes)).isEncrypted).toBe(false);
    // A plain document gets a password only from the dialog (protectionDirty), never by accident.
    await expect(editPdf(plain, { encryption: { userPassword: "a", ownerPassword: "a", permissions: { printing: true, modifying: true, annotating: true, copying: true } } })).rejects.toThrow();
  });
});

describe("OCR text saved as searchable text (D6)", () => {
  it("bakes the words Workbench's OCR route recognized into invisible, searchable text on save", async () => {
    const scan = await PDFDocument.create(); scan.addPage([595, 842]);
    const words = [{ text: "Scanned", rect: [72, 700, 160, 716] as [number, number, number, number], spaceAfter: true }, { text: "handout", rect: [165, 700, 240, 716] as [number, number, number, number], spaceAfter: false }];
    const { buildOcrBakeInserts } = await import(/* @vite-ignore */ OCR_BAKE) as { buildOcrBakeInserts(page: number, words: unknown[], geom: { pw: number; ph: number; rot: number }): Record<string, unknown>[] };
    const inserts = buildOcrBakeInserts(0, words, { pw: 595, ph: 842, rot: 0 });
    const saved = await editPdf(Buffer.from(await scan.save()), { textInserts: inserts });
    expect(saved.skippedTextInserts).toEqual([]);
    expect((await texts(saved.bytes))[0]).toContain("Scanned handout");
  });
});

describe("bookmarks (D8)", () => {
  it("saves an edited bookmark tree through the gateway", async () => {
    const source = await pdf("K", 3);
    const saved = await editPdf(source, { outline: [{ title: "마지막 쪽", pageIndex: 2, top: null, children: [] }, { title: "제목 없는 책갈피", pageIndex: 1, top: null, children: [] }] });
    const doc = await PDFDocument.load(saved.bytes), root = doc.catalog.lookup(PDFName.of("Outlines"));
    const titles: string[] = [];
    for (let node = root.lookup(PDFName.of("First")); node; node = node.lookup(PDFName.of("Next"))) titles.push(node.lookup(PDFName.of("Title")).decodeText());
    expect(titles).toEqual(["마지막 쪽", "제목 없는 책갈피"]);
  });
  it("saves attachment removals and additions (the attachments panel's pending changes)", async () => {
    const withFile = await PDFDocument.load(await pdf("F", 1)); await withFile.attach(Buffer.from("old"), "old.txt", { mimeType: "text/plain" });
    const saved = await editPdf(Buffer.from(await withFile.save({ useObjectStreams: false })), { attachments: { remove: ["old.txt"], add: [{ name: "new.txt", bytesBase64: Buffer.from("new").toString("base64") }] } });
    const { attachmentLabels } = await import(/* @vite-ignore */ ATTACHMENTS) as { attachmentLabels(doc: unknown): string[] };
    expect(attachmentLabels(await PDFDocument.load(saved.bytes))).toEqual(["new.txt"]);
  });
});

describe("PDF tool routes", () => {
  it("scopes the page clipboard to one window, pastes as a new revision, and reduces into a private result only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-pdf-tools-")), store = new Store(join(dir, "state.sqlite"));
    const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
    const work = manager.createWork({ title: "PDF", cwd: join(dir, "project") }); mkdirSync(work.cwd, { recursive: true });
    writeFileSync(join(work.cwd, "가.pdf"), await pdf("A", 3)); writeFileSync(join(work.cwd, "나.pdf"), await pdf("B", 2));
    writeFileSync(join(work.cwd, "잠김.pdf"), readFileSync(LOCKED));
    const a = manager.openFile(work.id, "가.pdf"), b = manager.openFile(work.id, "나.pdf"), locked = manager.openFile(work.id, "잠김.pdf"), documents = manager.documents;
    const viewA = documents.registry.open(a.id, { viewId: "va", windowId: "w1", claim: true });
    const viewB = documents.registry.open(b.id, { viewId: "vb", windowId: "w1", claim: true });
    const viewL = documents.registry.open(locked.id, { viewId: "vl", windowId: "w1", claim: true });
    const otherA = documents.registry.open(a.id, { viewId: "va2", windowId: "w2" });
    const grants = new EditorGrants();
    const tokenA = grants.issue(a.id, { viewId: "va", writeToken: viewA.writeToken }), tokenB = grants.issue(b.id, { viewId: "vb", writeToken: viewB.writeToken });
    const tokenL = grants.issue(locked.id, { viewId: "vl", writeToken: viewL.writeToken });
    const tokenOther = grants.issue(a.id, { viewId: "va2", writeToken: otherA.writeToken }), tokenBare = grants.issue(b.id);
    const server = createEditorsServer(documents, grants, null);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (id: string, operation: string, revision: number, request: Record<string, unknown>, token: string) =>
      fetch(`${origin}/api/artifacts/${id}/pdf/${operation}?revision=${revision}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: encodePdfRequest(request) });
    try {
      expect(await (await call(b.id, "copied-count", 1, {}, tokenB)).json()).toEqual({ count: 0 });
      const copied = await call(a.id, "copy-pages", 1, { source: { path: a.path }, pages: [2, 0] }, tokenA);
      expect(copied.status).toBe(200); expect(await copied.json()).toEqual({ count: 2 });
      // Another window (and so a phone's page, or an AI run) never sees what this window copied.
      expect(await (await call(a.id, "copied-count", 1, {}, tokenOther)).json()).toEqual({ count: 0 });
      expect((await call(b.id, "copied-count", 1, {}, tokenBare)).status).toBe(409);
      expect((await call(b.id, "paste-pages", 1, { path: b.path, afterPageIndex: 0 }, tokenBare)).status).not.toBe(200);
      expect(documents.get(b.id).revision).toBe(1);
      // A path the page names is never read: only the open document's own.
      expect((await call(a.id, "copy-pages", 1, { source: { path: join(dir, "secret.pdf") }, pages: [0] }, tokenA)).status).toBe(403);
      expect((await call(b.id, "paste-pages", 1, { path: join(dir, "secret.pdf"), afterPageIndex: 0 }, tokenB)).status).toBe(403);
      expect(await (await call(b.id, "copied-count", 1, {}, tokenB)).json()).toEqual({ count: 2 });
      const pasted = await call(b.id, "paste-pages", 1, { path: b.path, afterPageIndex: 0 }, tokenB);
      expect(pasted.status).toBe(200); expect(await pasted.json()).toEqual({ revision: 2, insertedCount: 2 });
      expect(await texts(readFileSync(b.path))).toEqual(["B 1", "A 1", "A 3", "B 2"]); // in document order, as upstream copies
      expect(await texts(readFileSync(documents.revisionPath(b.id, 1)))).toEqual(["B 1", "B 2"]); // one undo away
      expect((await call(b.id, "paste-pages", 1, { path: b.path, afterPageIndex: 0 }, tokenB)).status).toBe(409); // stale revision
      // A protected document is neither a source nor a target of the page clipboard.
      const fromLocked = await call(locked.id, "copy-pages", 1, { source: { path: locked.path }, pages: [0] }, tokenL);
      expect(fromLocked.status).toBe(422); expect((await fromLocked.json()).code).toBe("encrypted_pdf");
      const intoLocked = await call(locked.id, "paste-pages", 1, { path: locked.path, afterPageIndex: 0 }, tokenL);
      expect(intoLocked.status).toBe(422); expect(readFileSync(locked.path)).toEqual(readFileSync(LOCKED));

      // 용량 줄이기: the revision's bytes shrink into a private result; no file in the project changes.
      const fat = await PDFDocument.create(); fat.addPage([400, 600]);
      const stored = deflateSync(Buffer.alloc(300_000, "Workbench "), { level: 0 });
      fat.context.register(fat.context.stream(stored, { Filter: "FlateDecode", Length: stored.length }));
      writeFileSync(a.path, Buffer.from(await fat.save({ useObjectStreams: false }))); documents.adoptDisk(a.id);
      const projectBefore = readdirSync(work.cwd).sort(), sourceBefore = readFileSync(a.path), revisionA = documents.get(a.id).revision;
      expect((await call(a.id, "reduce", revisionA, {}, tokenBare)).status).toBe(401);
      const reduced = await call(a.id, "reduce", revisionA, {}, tokenA);
      expect(reduced.status).toBe(200);
      const answer = await reduced.json() as { generatedId: string; bytesBefore: number; bytesAfter: number };
      expect(answer.bytesBefore).toBe(sourceBefore.length); expect(answer.bytesAfter).toBeLessThan(answer.bytesBefore);
      expect(readdirSync(work.cwd).sort()).toEqual(projectBefore); expect(readFileSync(a.path)).toEqual(sourceBefore);
      expect(documents.get(a.id).revision).toBe(revisionA);
      // Only the parent's chosen place publishes it, beside the source as `{stem} (작게).pdf`, never over the original.
      const outputs = new OfficeOutputs(documents, manager.registerOfficeCopy.bind(manager));
      expect(() => outputs.prepare(a.id, revisionA, "가.pdf", { viewId: "va", writeToken: viewA.writeToken })).toThrow("원본과 다른 파일");
      const plan = outputs.prepare(a.id, revisionA, "가 (작게).pdf", { viewId: "va", writeToken: viewA.writeToken });
      const published = await outputs.commit(a.id, plan.id, Buffer.alloc(0), false, { viewId: "va", writeToken: viewA.writeToken }, revisionA, answer.generatedId);
      expect(published.path).toBe(join(work.cwd, "가 (작게).pdf"));
      expect(readFileSync(published.path).length).toBe(answer.bytesAfter);
      expect(readFileSync(a.path)).toEqual(sourceBefore);
      expect((await call(locked.id, "reduce", 1, {}, tokenL)).status).toBe(422);

      // pdf:decrypt answers from the gateway's own copy of the revision; a save keeps the protection.
      expect(await (await call(locked.id, "decrypt", 1, { password: "wrong" }, tokenL)).json()).toEqual({ ok: false, reason: "wrong-password" });
      expect(await (await call(locked.id, "decrypt", 1, { password: FOUR_SPACES }, tokenL)).json()).toMatchObject({ ok: true, unlockedAs: expect.any(String) });
      expect((await call(locked.id, "save", 1, { path: locked.path, rotations: [{ pageIndex: 0, delta: 90 }] }, tokenL)).status).toBe(422);
      const saved = await call(locked.id, "save", 1, { path: locked.path, rotations: [{ pageIndex: 0, delta: 90 }], decryption: { userPassword: FOUR_SPACES }, protectionDirty: false }, tokenL);
      expect(saved.status).toBe(200); expect((await saved.json()).revision).toBe(2);
      expect(readFileSync(locked.path).includes(Buffer.from("/Encrypt"))).toBe(true);
      expect((await call(locked.id, "recover", 2, { path: locked.path, decryption: { userPassword: FOUR_SPACES }, protectionDirty: false }, tokenL)).status).toBe(422);
      expect(existsSync(join(dir, "office-generated"))).toBe(true);
    } finally {
      server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
      await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
});
