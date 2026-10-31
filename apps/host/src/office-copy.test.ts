import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import { expect, it, vi } from "vitest";
import { mindmapFixture } from "../../../scripts/app-e2e/mindmap-fixture.ts";
import { epubFixture } from "../../../scripts/app-e2e/epub-fixture.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { OfficeOutputs } from "./office-output.ts";
import { OfficeStyles } from "./office-styles.ts";
import { EditorGrants } from "./editors.ts";

async function bytesFor(format: string) {
  if (format === "docx") return readFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx"));
  if (format === "pptx") return readFileSync(resolve("vendor/ieumoffice/packages/pptx-engine/tests/fixtures/01_standard_business.pptx"));
  if (format === "xmind") return mindmapFixture();
  if (format === "epub") return epubFixture();
  if (format === "pdf") return Buffer.from("%PDF-1.7\noutput contract fixture");
  if (format === "xlsx" || format === "xlsm") {
    const zip = new JSZip(); // Container gate fixture, not a claim of workbook engine/rendering validation.
    for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"]) zip.file(name, "<root/>");
    zip.file("xl/worksheets/sheet1.xml", '<worksheet><c><f>A1*2</f><v>4</v></c></worksheet>');
    if (format === "xlsm") zip.file("xl/vbaProject.bin", "MACROS_PRESERVED");
    return zip.generateAsync({ type: "nodebuffer" });
  }
  return Buffer.from(format === "html" || format === "htm" ? '<!doctype html><p>현재 편집</p><img src="assets/a.png">' : "# 현재 편집\n\n![사진](assets/a.png)\n");
}
async function setup(format = "md") {
  const dir = mkdtempSync(join(tmpdir(), "wb-office-copy-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "Copy" }), session = manager.createSession(work.id, { provider: "claude" });
  const bytes = await bytesFor(format), path = join(work.cwd, `source.${format}`);
  writeFileSync(path, bytes);
  const artifact = manager.openFile(work.id, path);
  const view = manager.documents.registry.open(artifact.id, { viewId: "original", windowId: "one", sessionId: session.id, claim: true });
  const access = { viewId: view.view.viewId, writeToken: view.writeToken };
  const register = manager.registerOfficeCopy.bind(manager), outputs = new OfficeOutputs(manager.documents, register);
  return { dir, store, manager, work, session, bytes, path, artifact, access, outputs, register,
    close: async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

for (const format of ["docx", "pptx", "xlsx", "xlsm", "md", "markdown", "html", "htm", "xmind", "epub", "pdf"]) it(`copies ${format} bytes with source revision/session/workspace and a durable duplicate receipt`, async () => {
  const f = await setup(format);
  try {
    const plan = f.outputs.prepare(f.artifact.id, 1, `copy.${format}`, f.access);
    const saved = await f.outputs.commit(f.artifact.id, plan.id, f.bytes, false, f.access);
    expect(readFileSync(saved.path)).toEqual(f.bytes); expect(readFileSync(f.path)).toEqual(f.bytes);
    expect(f.artifact.workspaceId).toBeTruthy();
    expect(saved.artifact.workspaceId).toBe(f.artifact.workspaceId);
    expect(f.manager.documents.revisions(saved.artifact.id)[0]).toMatchObject({ sessionId: f.session.id, author: "user", derivedFrom: [{ artifactId: f.artifact.id, revision: 1 }] });
    const restarted = new OfficeOutputs(f.manager.documents, f.register);
    expect(await restarted.commit(f.artifact.id, plan.id, f.bytes, false, f.access)).toEqual(saved);
    await expect(restarted.commit(f.artifact.id, plan.id, Buffer.from("different"), false, f.access)).rejects.toMatchObject({ code: "output_payload_changed" });
    expect(f.manager.documents.get(f.artifact.id).revision).toBe(1);
    expect(f.manager.documents.revisions(saved.artifact.id)).toHaveLength(1);
  } finally { await f.close(); }
});

it("reopens persisted work/session/document state before replaying a completed receipt", async () => {
  const f = await setup();
  let originalClosed = false, reopened: SessionManager | null = null, store: Store | null = null;
  try {
    const plan = f.outputs.prepare(f.artifact.id, 1, "persistent.md", f.access);
    const saved = await f.outputs.commit(f.artifact.id, plan.id, Buffer.from("# latest unsaved buffer"), false, f.access);
    await f.manager.shutdown(); f.store.close(); originalClosed = true;
    store = new Store(join(f.dir, "state.sqlite"));
    reopened = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(f.dir, "works"), dataDir: f.dir });
    reopened.documents.registry.open(f.artifact.id, { viewId: "after-restart", windowId: "new", sessionId: f.session.id });
    const result = await new OfficeOutputs(reopened.documents, reopened.registerOfficeCopy.bind(reopened))
      .commit(f.artifact.id, plan.id, Buffer.from("# latest unsaved buffer"), false, { viewId: "after-restart", writeToken: null });
    expect(result).toEqual(saved);
    expect(reopened.documents.get(result.artifact.id).revision).toBe(1);
    expect(reopened.documents.revisions(result.artifact.id)[0]?.sessionId).toBe(f.session.id);
    expect(readFileSync(f.path)).toEqual(f.bytes);
  } finally {
    if (reopened) await reopened.shutdown(); store?.close();
    if (!originalClosed) await f.close(); else rmSync(f.dir, { recursive: true, force: true });
  }
});

it("allows a registered reader to copy without writing the original, but binds the pending destination to its view and session", async () => {
  const f = await setup();
  try {
    const registration = f.manager.documents.registry.open(f.artifact.id, { viewId: "reader", windowId: "two", sessionId: f.session.id });
    const reader = { viewId: registration.view.viewId, writeToken: null };
    const plan = f.outputs.prepare(f.artifact.id, 1, "read-copy.md", reader);
    await expect(f.outputs.commit(f.artifact.id, plan.id, f.bytes, false, f.access)).rejects.toMatchObject({ code: "output_view_changed" });
    f.manager.documents.registry.open(f.artifact.id, { viewId: "reader", windowId: "two", sessionId: "different" });
    await expect(f.outputs.commit(f.artifact.id, plan.id, f.bytes, false, reader)).rejects.toMatchObject({ code: "output_view_changed" });
    f.manager.documents.registry.open(f.artifact.id, { viewId: "reader", windowId: "two", sessionId: f.session.id });
    const saved = await f.outputs.commit(f.artifact.id, plan.id, Buffer.from("# reader's copy"), false, reader);
    expect(readFileSync(saved.path, "utf8")).toContain("reader's copy"); expect(readFileSync(f.path)).toEqual(f.bytes);
  } finally { await f.close(); }
});

it("recovers a publication whose registration failed, even after its view is replaced, without rewriting the target", async () => {
  const f = await setup();
  try {
    const failed = new OfficeOutputs(f.manager.documents, () => { throw new Error("registration interrupted"); });
    const plan = failed.prepare(f.artifact.id, 1, "recover.md", f.access);
    await expect(failed.commit(f.artifact.id, plan.id, f.bytes, false, f.access)).rejects.toThrow("registration interrupted");
    expect(readFileSync(plan.path)).toEqual(f.bytes);
    f.manager.documents.registry.close("original", "one");
    const view = f.manager.documents.registry.open(f.artifact.id, { viewId: "reopened", windowId: "new", sessionId: f.session.id });
    const access = { viewId: view.view.viewId, writeToken: view.writeToken };
    const result = await new OfficeOutputs(f.manager.documents, f.register).commit(f.artifact.id, plan.id, f.bytes, false, access);
    expect(result.path).toBe(plan.path); expect(f.manager.documents.revisions(result.artifact.id)).toHaveLength(1);
  } finally { await f.close(); }
});

it("does not retry an uncertain publication over a changed file", async () => {
  const f = await setup();
  try {
    const failed = new OfficeOutputs(f.manager.documents, () => { throw new Error("interrupted"); });
    const plan = failed.prepare(f.artifact.id, 1, "recover.md", f.access);
    await expect(failed.commit(f.artifact.id, plan.id, f.bytes, false, f.access)).rejects.toThrow("interrupted");
    writeFileSync(plan.path, "external edit after interrupted registration");
    await expect(new OfficeOutputs(f.manager.documents, f.register).commit(f.artifact.id, plan.id, f.bytes, false, f.access)).rejects.toMatchObject({ code: "output_uncertain" });
    expect(readFileSync(plan.path, "utf8")).toContain("external edit");
  } finally { await f.close(); }
});

it("refuses format changes, damaged containers, macro loss and missing relocated assets", async () => {
  const f = await setup("xlsx");
  try {
    expect(() => f.outputs.prepare(f.artifact.id, 1, "wrong.docx", f.access)).toThrow(/같은 파일 형식/);
    const plan = f.outputs.prepare(f.artifact.id, 1, "new.xlsx", f.access);
    await expect(f.outputs.commit(f.artifact.id, plan.id, Buffer.from("PK damaged"), false, f.access)).rejects.toMatchObject({ code: "invalid_office_copy" });
    await expect(f.outputs.commit(f.artifact.id, plan.id, await bytesFor("xlsm"), false, f.access)).rejects.toMatchObject({ code: "office_copy_macros" });
    const path = join(f.work.cwd, "text.md"); writeFileSync(path, "![asset](assets/a.png)");
    const text = f.manager.openFile(f.work.id, path), folder = join(f.dir, "elsewhere"); mkdirSync(folder);
    const copy = f.outputs.prepare(text.id, 1, join(folder, "copy.md"));
    await expect(f.outputs.commit(text.id, copy.id, readFileSync(path), false)).rejects.toMatchObject({ code: "asset_missing" });
    expect(existsSync(copy.path)).toBe(false);
  } finally { await f.close(); }
});

it("preserves the selected PPT design on a copy and keeps the original selection unchanged", async () => {
  const f = await setup("pptx");
  try {
    const grants = new EditorGrants(), token = grants.issue(f.artifact.id, f.access, f.session.id), styles = new OfficeStyles(f.manager.documents, null);
    const context = { artifactId: f.artifact.id, token, grants };
    const original = styles.call(context, "selection-set", { expectedRevision: null, selection: { kind: "builtin", key: "clean", adjustments: ["파란 표지"] } }) as any;
    const plan = f.outputs.prepare(f.artifact.id, 1, "copy.pptx", f.access);
    const saved = await f.outputs.commit(f.artifact.id, plan.id, f.bytes, false, f.access);
    const view = f.manager.documents.registry.open(saved.artifact.id, { viewId: "copy", windowId: "one", sessionId: f.session.id, claim: true });
    const copy = styles.call({ artifactId: saved.artifact.id, token: grants.issue(saved.artifact.id, { viewId: "copy", writeToken: view.writeToken }, f.session.id), grants }, "selection-get") as any;
    expect(copy.selection).toEqual(original.selection); expect(copy.revision).not.toBe(original.revision);
    expect(styles.call(context, "selection-get")).toEqual(original);
  } finally { await f.close(); }
});

const picture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
function textAssets(f: Awaited<ReturnType<typeof setup>>) {
  const assets = join(f.work.cwd, "assets"), destination = join(f.work.cwd, "copies");
  mkdirSync(assets); mkdirSync(destination);
  writeFileSync(join(assets, "a.png"), picture);
  return { assets, destination };
}

it("relocates current Markdown images with collision-safe ownership, preserving raw source and history", async () => {
  const f = await setup();
  try {
    const { assets, destination } = textAssets(f);
    mkdirSync(join(destination, "assets")); writeFileSync(join(destination, "assets/a.png"), "unrelated");
    const draft = '\ufeff# 바뀐 초안\r\n\r\n![사진](assets/a.png)\r\n\r\n[link]: https://example.com\r\n[^1]: 원래 각주\r\n\r\n```md\r\n![sample](missing.png)\r\n```\r\n';
    const plan = f.outputs.prepare(f.artifact.id, 1, join(destination, "copy.md"), f.access);
    const result = await f.outputs.commit(f.artifact.id, plan.id, Buffer.from(draft), false, f.access);
    const saved = readFileSync(result.path, "utf8"), manifest = JSON.parse(readFileSync(join(destination, "assets/.genoffice-assets.json"), "utf8"));
    const name = manifest.pending["copy.md"][0];
    expect(saved).toBe(draft.replace("assets/a.png", `assets/${name}`));
    expect(readFileSync(join(destination, "assets", name))).toEqual(picture);
    expect(readFileSync(join(destination, "assets/a.png"), "utf8")).toBe("unrelated");
    expect(readFileSync(join(assets, "a.png"))).toEqual(picture); expect(readFileSync(f.path)).toEqual(f.bytes);
    expect(f.manager.documents.get(f.artifact.id).revision).toBe(1);
    expect(await new OfficeOutputs(f.manager.documents, f.register).commit(f.artifact.id, plan.id, Buffer.from(draft), false, f.access)).toEqual(result);
    expect(readdirSync(join(destination, "assets"))).toHaveLength(3);
  } finally { await f.close(); }
});

it("preserves HTML base, exact untouched source, CSS dependencies, media and scripts in an independent tree", async () => {
  const f = await setup("html");
  try {
    const { assets, destination } = textAssets(f);
    mkdirSync(join(assets, "css"));
    const style = '@import "theme.css"; h1{background:url(../a.png?v=2#icon)}';
    writeFileSync(join(assets, "css/style.css"), style);
    writeFileSync(join(assets, "css/theme.css"), 'p { color: teal } @import "style.css";');
    writeFileSync(join(assets, "run.js"), 'document.body.dataset.copied="yes";');
    const draft = '\ufeff<!DOCTYPE html>\r\n<base href="assets/"><link rel="stylesheet" href="css/style.css">\r\n    <img src="a.png?v=2#icon" srcset="a.png 1x, a.png 2x">\r\n<style>p{background:url("a.png")}</style><p data-gx-redact="keep" style="background:url(&quot;a.png&quot;)"> Keep  spacing </p><script src="run.js"></script><script>const sample = "<img src=missing.png>";</script>\r\n<!--<img src=missing.png>-->';
    const plan = f.outputs.prepare(f.artifact.id, 1, join(destination, "copy.html"), f.access);
    const result = await f.outputs.commit(f.artifact.id, plan.id, Buffer.from(draft), false, f.access);
    const saved = readFileSync(result.path, "utf8"), root = readdirSync(join(destination, "assets"))[0]!;
    expect(saved).toContain('<base href="assets/">'); expect(saved.startsWith('\ufeff<!DOCTYPE html>\r\n')).toBe(true);
    expect(saved).toContain('data-gx-redact="keep"'); expect(saved).toContain('> Keep  spacing </p>');
    expect(saved).toContain(`<img src="${root}/assets/a.png?v=2#icon"`);
    expect(saved).toContain(`srcset="${root}/assets/a.png 1x, ${root}/assets/a.png 2x"`);
    expect(saved).toContain(`url(&quot;${root}/assets/a.png&quot;)`);
    expect(saved).toContain('<script>const sample = "<img src=missing.png>";</script>');
    expect(saved).toContain('<!--<img src=missing.png>-->');
    expect(readFileSync(join(destination, "assets", root, "assets/css/style.css"), "utf8")).toBe(style);
    expect(readFileSync(join(destination, "assets", root, "assets/a.png"))).toEqual(picture);
    expect(readFileSync(join(destination, "assets", root, "assets/run.js"), "utf8")).toContain('copied="yes"');
    expect(readFileSync(f.path)).toEqual(f.bytes);
  } finally { await f.close(); }
});

for (const format of ["md", "html"]) it(`${format} rolls back only newly created assets if the destination changes during preparation`, async () => {
  const f = await setup(format);
  try {
    const { assets, destination } = textAssets(f), target = join(destination, `copy.${format}`);
    const plan = f.outputs.prepare(f.artifact.id, 1, target, f.access);
    const assertPath = f.manager.documents.registry.assertPath.bind(f.manager.documents.registry);
    const spy = vi.spyOn(f.manager.documents.registry, "assertPath").mockImplementation((path, ...args) => { writeFileSync(target, "external edit"); return assertPath(path, ...args); });
    try { await expect(f.outputs.commit(f.artifact.id, plan.id, f.bytes, false, f.access)).rejects.toMatchObject({ code: "output_changed" }); }
    finally { spy.mockRestore(); }
    expect(readFileSync(target, "utf8")).toBe("external edit");
    expect(readdirSync(join(destination, "assets")).filter((name) => !name.startsWith("."))).toHaveLength(0);
    expect(readFileSync(join(assets, "a.png"))).toEqual(picture); expect(readFileSync(f.path)).toEqual(f.bytes);
  } finally { await f.close(); }
});

it("keeps published HTML assets when registration is interrupted and replays without duplicate assets", async () => {
  const f = await setup("html");
  try {
    const { destination } = textAssets(f);
    const failed = new OfficeOutputs(f.manager.documents, () => { throw new Error("registration interrupted"); });
    const plan = failed.prepare(f.artifact.id, 1, join(destination, "copy.html"), f.access);
    await expect(failed.commit(f.artifact.id, plan.id, f.bytes, false, f.access)).rejects.toThrow("registration interrupted");
    const before = readdirSync(join(destination, "assets")), published = readFileSync(plan.path);
    const saved = await new OfficeOutputs(f.manager.documents, f.register).commit(f.artifact.id, plan.id, f.bytes, false, f.access);
    expect(saved.path).toBe(plan.path); expect(readFileSync(plan.path)).toEqual(published);
    expect(readdirSync(join(destination, "assets"))).toEqual(before);
    expect(readFileSync(join(destination, "assets", before[0]!, "assets/a.png"))).toEqual(picture);
  } finally { await f.close(); }
});

it("never copies hidden files, escaping symlinks or missing resources and preserves authored remote URLs", async () => {
  const f = await setup("html");
  try {
    const { assets, destination } = textAssets(f);
    writeFileSync(join(assets, ".secret.png"), picture); writeFileSync(join(f.dir, "outside.png"), picture);
    symlinkSync(join(f.dir, "outside.png"), join(assets, "escape.png"));
    for (const ref of ["assets/.secret.png", "assets/escape.png", "missing.png"]) {
      const plan = f.outputs.prepare(f.artifact.id, 1, join(destination, "copy.html"), f.access);
      await expect(f.outputs.commit(f.artifact.id, plan.id, Buffer.from(`<img src="assets/a.png"><img src="${ref}">`), false, f.access)).rejects.toBeTruthy();
      expect(existsSync(plan.path)).toBe(false);
      expect(readdirSync(join(destination, "assets"))).toHaveLength(0);
    }
    const remote = '<base href="https://example.com/docs/"><img src="image.png"><style>p{background:url(data:image/png;base64,abc)}</style>';
    const plan = f.outputs.prepare(f.artifact.id, 1, join(destination, "remote.html"), f.access);
    const saved = await f.outputs.commit(f.artifact.id, plan.id, Buffer.from(remote), false, f.access);
    expect(readFileSync(saved.path, "utf8")).toBe(remote);
  } finally { await f.close(); }
});
