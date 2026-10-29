import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import init, { HwpDocument } from "../../../vendor/ieumoffice/vendor/rhwp-core/rhwp.js";
import { encodeHwpSave, type MemoSnapshot } from "../../../packages/contracts/src/hwp.ts";
import { hwpMemosOf, hwpToText } from "../../../third_party/ieumoffice/file-parse/hwp.ts";
import { sectionTailsOf } from "../../../third_party/ieumoffice/hwp/section-tails.ts";
import { decodeHwpSave, openHwpBytes, prepareHwpSave } from "./hwp-codec.ts";
import { hwpWasmPath } from "./hwp-resource.ts";
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
