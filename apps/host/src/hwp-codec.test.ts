import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";
import { encodeHwpSave, type MemoSnapshot } from "../../../packages/contracts/src/hwp.ts";
import { hwpMemosOf, hwpToText } from "../../../third_party/ieumoffice/file-parse/hwp.ts";
import { sectionTailsOf } from "../../../third_party/ieumoffice/hwp/section-tails.ts";
import { decodeHwpSave, openHwpBytes, prepareHwpSave } from "./hwp-codec.ts";
import { hwpWasmPath } from "./hwp-resource.ts";
import { hwpStructureOf } from "./hwp-structure.ts";
import { notesWithBreaks } from "./hwp-census-fixture.ts";
import { EventBus } from "./bus.ts";
import { createEditorsServer, EditorGrants, officeEditorKind } from "./editors.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });
const fixture = (name: string) => readFileSync(resolve("vendor/ieumoffice/apps/hwp/tests/fixtures", name));
function document(text = "한글 보존 검사") {
  const doc = HwpDocument.createEmpty(); doc.createBlankDocument(); doc.insertText(0, 0, 0, text); return doc;
}
const memos = (doc: HwpDocument): MemoSnapshot[] => JSON.parse(doc.getMemoList());
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); });

describe("Ieum HWP save boundary", () => {
  it("uses one bounded metadata prefix and refuses malformed tab/memo coordinates", () => {
    const bytes = Buffer.from([1, 2, 3]);
    const decoded = decodeHwpSave(Buffer.from(encodeHwpSave({ memos: [] }, bytes)));
    expect(decoded.bytes).toEqual(bytes); expect(decoded.metadata).toEqual({ memos: [] });
    expect(() => decodeHwpSave(Buffer.from([0, 255, 255, 255, 1]))).toThrow();
    const framed = (metadata: unknown) => { const json = Buffer.from(JSON.stringify(metadata)), head = Buffer.alloc(4); head.writeUInt32BE(json.length); return Buffer.concat([head, json, bytes]); };
    expect(() => decodeHwpSave(framed({ tabs: [{ sec: -1 }] }))).toThrow();
    expect(() => decodeHwpSave(framed({ memos: [{ author: "A", text: "memo", place: "body", date: null, sectionIndex: 0, paraIndex: 0, startCharIdx: -1, endCharIdx: 1, path: null }] }))).toThrow();
    expect(() => decodeHwpSave(framed({ memos: "not a list" }))).toThrow();
  });

  it("opens HWP and HWPX with the exact engine and rejects format substitution", async () => {
    expect(officeEditorKind("hwp")).toBe("hwp"); expect(officeEditorKind("hwpx")).toBe("hwp");
    const doc = document();
    try {
      const hwp = doc.exportHwp(), hwpx = doc.exportHwpx();
      expect((await openHwpBytes(hwp, "hwp")).bytes).toEqual(hwp);
      expect((await openHwpBytes(hwpx, "hwpx")).bytes).toEqual(hwpx);
      await expect(openHwpBytes(hwp, "hwpx")).rejects.toMatchObject({ status: 422 });
      await expect(openHwpBytes(Buffer.from("PK\x03\x04broken"), "hwpx")).rejects.toMatchObject({ status: 422 });
    } finally { doc.free(); }
  });

  it("preserves Korean body and memo content through a HWPX edit, and rejects memo loss", async () => {
    const doc = document();
    try {
      doc.insertMemo(0, 0, 0, 2, JSON.stringify({ author: "검토자", text: "이 메모를 보존" }));
      const original = doc.exportHwpx();
      doc.insertText(0, 0, doc.getParagraphLength(0, 0), " 수정됨");
      const snapshot = memos(doc), output = await prepareHwpSave(original, doc.exportHwpx(), "hwpx", { memos: snapshot });
      expect(await hwpToText(output)).toContain("한글 보존 검사 수정됨");
      expect((await hwpMemosOf(output))[0]).toMatchObject({ author: "검토자", text: "이 메모를 보존" });
      const empty = document("메모 없는 내용");
      try {
        await expect(prepareHwpSave(original, empty.exportHwpx(), "hwpx", { memos: snapshot })).rejects.toMatchObject({ code: "hwp_content_loss" });
        await expect(prepareHwpSave(original, empty.exportHwpx(), "hwpx", {})).rejects.toMatchObject({ code: "hwp_content_loss" });
        // Explicitly listed no memos means the user deleted them. The recovery path never
        // decides whether a memo deletion is intentional, and never writes the original.
        await expect(prepareHwpSave(original, empty.exportHwpx(), "hwpx", { memos: [] })).resolves.toBeInstanceOf(Buffer);
        await expect(prepareHwpSave(original, empty.exportHwpx(), "hwpx", {}, "recovery")).resolves.toBeInstanceOf(Buffer);
      } finally { empty.free(); }
    } finally { doc.free(); }
  });

  it("keeps Hancom memo section tails across native HWP export and recovery reopening", async () => {
    const original = fixture("memo-short-header-tail.hwp"), before = await hwpMemosOf(original);
    const opened = await openHwpBytes(original, "hwp"), doc = new HwpDocument(opened.bytes);
    expect(before.length).toBeGreaterThan(0); expect(opened.base.tails?.tails.size).toBeGreaterThan(0);
    let fixed: Buffer;
    try { doc.insertText(0, 0, 0, "WORKBENCH "); fixed = await prepareHwpSave(original, doc.exportHwp(), "hwp", {}, "recovery"); }
    finally { doc.free(); }
    expect(await hwpToText(fixed!)).toContain("WORKBENCH");
    expect((await hwpMemosOf(fixed!)).map((memo) => memo.text)).toEqual(before.map((memo) => memo.text));
    const restored = new HwpDocument(fixed!);
    try {
      const saved = await prepareHwpSave(original, restored.exportHwp(), "hwp", {});
      expect(sectionTailsOf(saved)?.tails.size).toBe(opened.base.tails?.tails.size);
      expect(await hwpToText(saved)).toContain("WORKBENCH");
      expect((await hwpMemosOf(saved)).map((memo) => memo.text)).toEqual(before.map((memo) => memo.text));
    } finally { restored.free(); }
  });

  it("scopes HWP bytes to one document, enforces writer/revision/disk CAS, and keeps drafts after lease loss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-hwp-"));
    const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "한글 검사", managedWorksDir: join(dir, "works"), dataDir: dir });
    const work = manager.createWork({ title: "한글", cwd: join(dir, "project") }); mkdirSync(work.cwd, { recursive: true });
    const doc = document(), original = Buffer.from(doc.exportHwpx());
    writeFileSync(join(work.cwd, "문서.hwpx"), original); writeFileSync(join(work.cwd, "다른.hwpx"), original);
    const artifact = manager.openFile(work.id, "문서.hwpx"), other = manager.openFile(work.id, "다른.hwpx");
    const writer = manager.documents.registry.open(artifact.id, { viewId: "hwp-writer", windowId: "one", claim: true });
    const reader = manager.documents.registry.open(artifact.id, { viewId: "hwp-reader", windowId: "two", claim: true });
    const grants = new EditorGrants(), token = grants.issue(artifact.id, { viewId: writer.view.viewId, writeToken: writer.writeToken });
    const readToken = grants.issue(artifact.id, { viewId: reader.view.viewId, writeToken: reader.writeToken });
    const server = createEditorsServer(manager.documents, grants, null); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = (id: string, auth = token) => fetch(`${origin}/api/artifacts/${id}/hwp/open?revision=1`, { headers: { authorization: `Bearer ${auth}` } });
    const save = (revision: number, bytes: Uint8Array, auth = token, operation = "save") => fetch(`${origin}/api/artifacts/${artifact.id}/hwp/${operation}?revision=${revision}`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: encodeHwpSave({ memos: [] }, bytes) });
    try {
      expect((await get(other.id)).status).toBe(401); expect((await get(artifact.id, "forged")).status).toBe(401);
      expect(Buffer.from(await (await get(artifact.id, readToken)).arrayBuffer())).toEqual(original);
      doc.insertText(0, 0, doc.getParagraphLength(0, 0), " 작성자의 수정");
      const edited = doc.exportHwpx();
      expect((await save(1, edited, readToken)).status).toBe(423);
      const saved = await save(1, edited); expect(saved.status).toBe(200); expect((await saved.json()).revision).toBe(2);
      expect((await save(1, edited)).status).toBe(409);
      expect((await save(2, edited)).status).toBe(200); expect(manager.documents.get(artifact.id).revision).toBe(2);
      expect(readFileSync(manager.documents.revisionPath(artifact.id, 1))).toEqual(original);
      writeFileSync(artifact.path, original);
      expect((await save(2, edited)).status).toBe(409); expect(readFileSync(artifact.path)).toEqual(original);
      manager.documents.registry.close("hwp-writer", "one");
      expect((await save(2, edited)).status).toBe(423);
      const draft = await save(2, edited, token, "repair"); expect(draft.status).toBe(200);
      expect(await hwpToText(new Uint8Array(await draft.arrayBuffer()))).toContain("작성자의 수정");
      expect(readFileSync(artifact.path)).toEqual(original); expect(manager.documents.get(artifact.id).revision).toBe(2);
      const bypass = await fetch(`${origin}/api/artifacts/${artifact.id}/bytes?expectedRevision=2`, { method: "PUT", headers: { authorization: `Bearer ${readToken}` }, body: edited.slice().buffer });
      expect(bypass.status).toBe(423);
    } finally { doc.free(); }
  });
});

describe("Hangul save fingerprint", () => {
  const LOSS = /보존할 수 없는 내용이 있어 저장하지 않았습니다/;
  const live = (bytes: Uint8Array) => new HwpDocument(new Uint8Array(bytes));
  function withTable() {
    const doc = document(); doc.createTable(0, 0, 0, 2, 2); return doc;
  }
  const tableOf = (doc: HwpDocument) => (JSON.parse(doc.getControls()) as { ctrlId: string; para: number; controlIndex: number }[]).find((control) => control.ctrlId === "tbl")!;

  it("refuses bytes that lost a table the editor still holds, and names it", async () => {
    const doc = withTable(), lossy = document();
    try {
      const original = doc.exportHwpx();
      await expect(prepareHwpSave(original, lossy.exportHwpx(), "hwpx", { memos: [], structure: hwpStructureOf(doc) }))
        .rejects.toMatchObject({ status: 422, code: "hwp_content_loss", message: expect.stringMatching(LOSS) });
      await expect(prepareHwpSave(original, lossy.exportHwpx(), "hwpx", { memos: [], structure: hwpStructureOf(doc) })).rejects.toThrow(/표 1→0/);
    } finally { doc.free(); lossy.free(); }
  });

  it("saves a deliberate deletion the editor reports, and a normal edit", async () => {
    const doc = withTable();
    try {
      const original = doc.exportHwpx(), table = tableOf(doc);
      doc.insertText(0, 0, 0, "고침 ");
      expect(await prepareHwpSave(original, doc.exportHwpx(), "hwpx", { memos: [], structure: hwpStructureOf(doc) })).toBeInstanceOf(Buffer);
      doc.deleteTableControl(0, table.para, table.controlIndex);
      const saved = await prepareHwpSave(original, doc.exportHwpx(), "hwpx", { memos: [], structure: hwpStructureOf(doc) });
      const back = live(saved);
      try { expect(hwpStructureOf(back).objects.tbl ?? 0).toBe(0); } finally { back.free(); }
    } finally { doc.free(); }
  });

  it("refuses bytes that lost a section", async () => {
    const original = fixture("master-page-next-section.hwpx"), doc = live((await openHwpBytes(original, "hwpx")).bytes), lossy = document();
    try {
      expect(hwpStructureOf(doc).sections).toBe(2);
      await expect(prepareHwpSave(original, lossy.exportHwpx(), "hwpx", { memos: [], structure: hwpStructureOf(doc) })).rejects.toThrow(/구역 2→1/);
    } finally { doc.free(); lossy.free(); }
  });

  it("refuses an HWP save that lost memos, which the HWPX memo check does not cover", async () => {
    const original = fixture("memo.hwp"), doc = live((await openHwpBytes(original, "hwp")).bytes), lossy = live((await openHwpBytes(original, "hwp")).bytes);
    try {
      const held = hwpStructureOf(doc);
      expect(held.memos).toBeGreaterThan(0);
      for (const memo of JSON.parse(lossy.getMemoList()) as { id: number }[]) lossy.removeMemo(memo.id);
      await expect(prepareHwpSave(original, lossy.exportHwp(), "hwp", { structure: held })).rejects.toThrow(new RegExp(`메모 ${held.memos}→0`));
      // The person removed them in the editor: the editor reports what it holds, the save goes ahead.
      expect(await prepareHwpSave(original, lossy.exportHwp(), "hwp", { structure: hwpStructureOf(lossy) })).toBeInstanceOf(Buffer);
    } finally { doc.free(); lossy.free(); }
  });

  it("keeps the file on disk byte-identical when the gateway refuses, and saves the next good attempt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-hwp-print-"));
    const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "지문 검사", managedWorksDir: join(dir, "works"), dataDir: dir });
    const work = manager.createWork({ title: "한글", cwd: join(dir, "project") }); mkdirSync(work.cwd, { recursive: true });
    const doc = withTable(), lossy = document(), original = Buffer.from(doc.exportHwpx());
    writeFileSync(join(work.cwd, "문서.hwpx"), original);
    const artifact = manager.openFile(work.id, "문서.hwpx");
    const writer = manager.documents.registry.open(artifact.id, { viewId: "hwp-writer", windowId: "one", claim: true });
    const token = new EditorGrants(), auth = token.issue(artifact.id, { viewId: writer.view.viewId, writeToken: writer.writeToken });
    const server = createEditorsServer(manager.documents, token, null); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const save = (bytes: Uint8Array) => fetch(`${origin}/api/artifacts/${artifact.id}/hwp/save?revision=1`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: encodeHwpSave({ memos: [], structure: hwpStructureOf(doc) }, bytes) });
    try {
      const refused = await save(lossy.exportHwpx());
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({ code: "hwp_content_loss", message: expect.stringMatching(/표 1→0/) });
      expect(readFileSync(artifact.path)).toEqual(original); expect(manager.documents.get(artifact.id).revision).toBe(1);
      doc.insertText(0, 0, 0, "고침 ");
      expect((await save(doc.exportHwpx())).status).toBe(200);
    } finally { doc.free(); lossy.free(); }
  });

  // N2-1: a tab or a line break in a footnote/endnote made every save of the document impossible.
  it("saves a document with a tab and a line break in its notes through the save route, with the text checked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-hwp-notes-"));
    const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "각주 탭", managedWorksDir: join(dir, "works"), dataDir: dir });
    const work = manager.createWork({ title: "한글", cwd: join(dir, "project") }); mkdirSync(work.cwd, { recursive: true });
    const original = await notesWithBreaks(), doc = new HwpDocument(original);
    writeFileSync(join(work.cwd, "각주.hwpx"), original);
    const artifact = manager.openFile(work.id, "각주.hwpx");
    const writer = manager.documents.registry.open(artifact.id, { viewId: "hwp-writer", windowId: "one", claim: true });
    const token = new EditorGrants(), auth = token.issue(artifact.id, { viewId: writer.view.viewId, writeToken: writer.writeToken });
    const server = createEditorsServer(manager.documents, token, null); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      doc.insertText(0, 0, 0, "고침 ");
      const saved = await fetch(`${origin}/api/artifacts/${artifact.id}/hwp/save?revision=1`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: encodeHwpSave({ memos: memos(doc), structure: hwpStructureOf(doc) }, doc.exportHwpx()) });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ revision: 2, text: "checked" });
    } finally { doc.free(); }
  });

  it("saves an HWP as HWPX with the live report: duplicate page-number settings in one paragraph are one setting", async () => {
    // memo-source.hwp holds 8 page-number-position controls in one paragraph; HWPX keeps one per paragraph.
    const original = fixture("memo-source.hwp"), doc = live((await openHwpBytes(original, "hwp")).bytes);
    try {
      const report = hwpStructureOf(doc);
      expect(await prepareHwpSave(original, doc.exportHwpx(), "hwpx", { memos: memos(doc), structure: report }, "save", "hwp")).toBeInstanceOf(Buffer);
      expect(await prepareHwpSave(original, doc.exportHwp(), "hwp", { memos: memos(doc), structure: report })).toBeInstanceOf(Buffer);
    } finally { doc.free(); }
  }, 30_000);

  it("tells the person the original is kept and Save As can keep a copy", async () => {
    const doc = withTable(), lossy = document();
    try {
      await expect(prepareHwpSave(doc.exportHwpx(), lossy.exportHwpx(), "hwpx", { memos: [], structure: hwpStructureOf(doc) }))
        .rejects.toThrow(/표 1→0.*원본 파일은 그대로입니다.*다른 이름으로 저장/);
    } finally { doc.free(); lossy.free(); }
  });

  it("leaves recovery drafts alone and refuses a malformed structure in the request", async () => {
    const doc = withTable(), lossy = document();
    try {
      await expect(prepareHwpSave(doc.exportHwpx(), lossy.exportHwpx(), "hwpx", { structure: hwpStructureOf(doc) }, "recovery")).resolves.toBeInstanceOf(Buffer);
      const framed = Buffer.from(encodeHwpSave({ structure: { ...hwpStructureOf(doc), sections: -1 } }, Buffer.from([1, 2, 3])));
      expect(() => decodeHwpSave(framed)).toThrow(/문서 구조 정보가 올바르지 않습니다/);
      expect(decodeHwpSave(Buffer.from(encodeHwpSave({ structure: hwpStructureOf(doc) }, Buffer.from([1, 2, 3])))).metadata.structure?.objects.tbl).toBe(1);
    } finally { doc.free(); lossy.free(); }
  });
});
