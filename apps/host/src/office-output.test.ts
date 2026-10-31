import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, expect, it } from "vitest";
import init, { HwpDocument } from "../../../vendor/ieumoffice/vendor/rhwp-core/rhwp.js";
import { encodeHwpSave } from "../../../packages/contracts/src/hwp.ts";
import { hwpToText, hwpMemosOf } from "../../../third_party/ieumoffice/file-parse/hwp.ts";
import { hwpWasmPath } from "./hwp-resource.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { OfficeOutputs } from "./office-output.ts";
import { runSave, type SaveEditorPort } from "../../office/src/hwp-save.ts";

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });
function setup(format: "hwp" | "hwpx" = "hwpx") {
  const dir = mkdtempSync(join(tmpdir(), "wb-office-output-"));
  const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir, kordoc: null });
  const work = manager.createWork({ title: "한글", cwd: join(dir, "project") }); mkdirSync(work.cwd, { recursive: true });
  const doc = HwpDocument.createEmpty(); doc.createBlankDocument(); doc.insertText(0, 0, 0, "원본 한글");
  doc.insertMemo(0, 0, 0, 2, JSON.stringify({ author: "검토자", text: "이 메모를 보존" }));
  const bytes = Buffer.from(format === "hwp" ? doc.exportHwp() : doc.exportHwpx());
  const path = join(work.cwd, `original.${format}`); writeFileSync(path, bytes);
  const artifact = manager.openFile(work.id, path);
  const outputs = new OfficeOutputs(manager.documents, (source, path) => manager.openFile(source.workId, path));
  return { manager, work, doc, bytes, path, artifact, outputs };
}
it("saves the original Word HTML export as a new HTML document without changing its DOCX source", async () => {
  const { manager, work, outputs, doc } = setup();
  try {
    const bytes = readFileSync(new URL("../../../vendor/ieumoffice/fixtures/generated/simple.docx", import.meta.url));
    const path = join(work.cwd, "word.docx"); writeFileSync(path, bytes);
    const source = manager.openFile(work.id, path);
    const plan = outputs.prepare(source.id, source.revision, "word.html");
    const html = Buffer.from('<!doctype html><html><body><h1>한글 내보내기</h1></body></html>');
    const result = await outputs.commit(source.id, plan.id, html, false);
    expect(result.artifact.format).toBe("html");
    expect(result.artifact.id).not.toBe(source.id);
    expect(readFileSync(result.path)).toEqual(html);
    expect(readFileSync(path)).toEqual(bytes);
    expect(manager.documents.get(source.id).revision).toBe(source.revision);
  } finally { doc.free(); }
});
for (const from of ["hwp", "hwpx"] as const) for (const to of ["hwp", "hwpx"] as const) it(`saves edited ${from} as ${to}, retaining original bytes and memos`, async () => {
  const { outputs, artifact, doc, path, bytes, manager } = setup(from);
  try {
    doc.insertText(0, 0, 0, "COPY ");
    const plan = outputs.prepare(artifact.id, 1, `new.${to}`);
    const body = Buffer.from(encodeHwpSave({}, to === "hwp" ? doc.exportHwp() : doc.exportHwpx()));
    const result = await outputs.commit(artifact.id, plan.id, body, false);
    expect(await hwpToText(readFileSync(result.path))).toContain("COPY 원본 한글");
    expect((await hwpMemosOf(readFileSync(result.path))).map((memo) => memo.text)).toContain("이 메모를 보존");
    expect(readFileSync(path)).toEqual(bytes); expect(manager.documents.get(artifact.id).revision).toBe(1);
    expect(result.artifact.id).not.toBe(artifact.id); expect(result.artifact.revision).toBe(1);
    expect(await outputs.commit(artifact.id, plan.id, body, false)).toEqual(result);
  } finally { doc.free(); }
});
it("saves HTML as Word while preserving the original text and revision", async () => {
  const { manager, work, outputs, doc } = setup();
  try {
    const path = join(work.cwd, "page.html"), html = '<!doctype html><h1>한글 원본</h1>';
    writeFileSync(path, html); const source = manager.openFile(work.id, path);
    const plan = outputs.prepare(source.id, source.revision, "page.docx");
    await expect(outputs.commit(source.id, plan.id, Buffer.from("bad DOCX"), false)).rejects.toMatchObject({ status: 422 });
    const bytes = readFileSync(new URL("../../../vendor/ieumoffice/fixtures/generated/simple.docx", import.meta.url));
    const result = await outputs.commit(source.id, plan.id, bytes, false);
    expect(result.artifact.format).toBe("docx"); expect(result.artifact.id).not.toBe(source.id);
    expect(readFileSync(result.path)).toEqual(bytes); expect(readFileSync(path, "utf8")).toBe(html);
    expect(manager.documents.get(source.id).revision).toBe(source.revision);
  } finally { doc.free(); }
});
it("Save As carries an intentional memo deletion into HWP while refusing an unlisted loss", async () => {
  const { outputs, artifact, doc, path, bytes } = setup("hwpx");
  try {
    const memos = JSON.parse(doc.getMemoList()) as { id: number }[];
    expect(memos).toHaveLength(1); doc.removeMemo(memos[0]!.id);
    const plan = outputs.prepare(artifact.id, 1, "without-memo.hwp");
    await expect(outputs.commit(artifact.id, plan.id, Buffer.from(encodeHwpSave({}, doc.exportHwp())), false)).rejects.toMatchObject({ code: "hwp_content_loss" });
    let locked = false;
    const editor: SaveEditorPort = {
      isPasswordProtected: async () => false,
      exportHwpVerify: async () => ({ recovered: true, pageCountBefore: 1, pageCountAfter: 1 }),
      setMemoLock: async (value) => { locked = value; },
      listMemos: async () => { expect(locked).toBe(true); return []; },
      exportHwp: async () => { expect(locked).toBe(true); return doc.exportHwp(); },
      exportHwpx: async () => doc.exportHwpx(),
      measureTabs: async () => [], notifySaved: async () => {},
    };
    const outcome = await runSave(editor, {
      beginSave: async () => ({ ok: true, path: plan.path, format: "hwp" }),
      newTabs: async () => [], abortSave: () => {},
      commitSave: async (data, tabs, options) => {
        expect(locked).toBe(false); expect(options?.memos).toEqual([]);
        const saved = await outputs.commit(artifact.id, plan.id, Buffer.from(encodeHwpSave({ tabs, memos: options?.memos }, data)), false);
        return { ok: true, path: saved.path };
      },
    }, "saveAs");
    expect(outcome.kind).toBe("saved"); expect(await hwpMemosOf(readFileSync(plan.path))).toHaveLength(0);
    expect(readFileSync(path)).toEqual(bytes);
  } finally { doc.free(); }
});
it("refuses destination changes and active writers; confirmed overwrite keeps a backup", async () => {
  const { outputs, artifact, doc, work, manager } = setup();
  try {
    const path = join(work.cwd, "out.pdf"), original = Buffer.from("%PDF-1.7\nprevious"); writeFileSync(path, original);
    const plan = outputs.prepare(artifact.id, 1, path), bytes = Buffer.from("%PDF-1.7\nnew");
    expect(plan.exists).toBe(true);
    await expect(outputs.commit(artifact.id, plan.id, bytes, false)).rejects.toMatchObject({ code: "output_exists" });
    writeFileSync(path, "%PDF-1.7\nexternal");
    await expect(outputs.commit(artifact.id, plan.id, bytes, true)).rejects.toMatchObject({ code: "output_changed" });
    const fresh = outputs.prepare(artifact.id, 1, path), dest = manager.openFile(work.id, path);
    manager.documents.registry.open(dest.id, { viewId: "writer", windowId: "one", claim: true });
    await expect(outputs.commit(artifact.id, fresh.id, bytes, true)).rejects.toMatchObject({ status: 423 });
    manager.documents.registry.close("writer", "one");
    const result = await outputs.commit(artifact.id, fresh.id, bytes, true);
    expect(readFileSync(result.backupPath!, "utf8")).toContain("external"); expect(readFileSync(path)).toEqual(bytes);
    expect(readFileSync(manager.documents.revisionPath(dest.id, 1), "utf8")).toContain("external");
  } finally { doc.free(); }
});
it("refuses source paths, foreign tickets, corrupt bytes, symlinks and new-file races", async () => {
  const { outputs, artifact, doc, work, path, bytes } = setup();
  try {
    expect(() => outputs.prepare(artifact.id, 1, path)).toThrow(/원본/);
    const plan = outputs.prepare(artifact.id, 1, "new.hwpx");
    await expect(outputs.commit("another", plan.id, Buffer.from("bad"), false)).rejects.toMatchObject({ code: "output_expired" });
    await expect(outputs.commit(artifact.id, plan.id, Buffer.from("bad"), false)).rejects.toMatchObject({ status: 422 });
    writeFileSync(plan.path, bytes);
    await expect(outputs.commit(artifact.id, plan.id, Buffer.from(encodeHwpSave({}, doc.exportHwpx())), false)).rejects.toMatchObject({ code: "output_changed" });
    if (process.platform !== "win32") {
      const link = join(work.cwd, "linked.hwpx"); symlinkSync(path, link);
      expect(() => outputs.prepare(artifact.id, 1, link)).toThrow(/일반 파일/);
    }
    expect(readFileSync(path)).toEqual(bytes);
  } finally { doc.free(); }
});
