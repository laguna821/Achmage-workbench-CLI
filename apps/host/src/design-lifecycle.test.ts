import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { blankDesign } from "./design.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-design-lifecycle-"));
  const store = new Store(join(dir, "state.sqlite"));
  const options = { hostId: "h", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir };
  const manager = new SessionManager(store, new EventBus(), options);
  cleanups.push(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const work = manager.createWork({ title: "디자인" });
  const design = manager.createDesign(work.id, "원본", "square");
  const open = (artifactId = design.id, viewId = "view", claim = true, sessionId?: string) => {
    const registration = manager.documents.registry.open(artifactId, { viewId, windowId: `${viewId}-window`, claim, sessionId });
    return { viewId, writeToken: registration.writeToken };
  };
  return { dir, store, options, manager, work, design, open };
}

it("durable drafts preserve the source, require a document view, validate the base and delete exact snapshots only", () => {
  const { manager, design, open } = setup(), access = open();
  const original = readFileSync(design.path, "utf8");
  const text = blankDesign("a4");
  const drafts = manager.documents.designDrafts;
  const first = drafts.keep(design.id, { baseRevision: 1, text }, access);
  const second = drafts.keep(design.id, { baseRevision: 1, text: blankDesign("wide") }, access);
  expect(readFileSync(design.path, "utf8")).toBe(original);
  expect(drafts.remove(design.id, first, access).removed).toBe(false);
  expect(drafts.list(design.id, access)).toHaveLength(1);
  expect(() => drafts.keep(design.id, { baseRevision: 2, text }, access)).toThrow();
  expect(() => drafts.keep(design.id, { baseRevision: 1, text: "{}" }, access)).toThrow();
  expect(() => drafts.keep(design.id, { baseRevision: 1, text }, { viewId: "unknown", writeToken: null })).toThrow();
  const other = manager.createDesign(design.workId, "다른 문서", "a4");
  expect(() => drafts.keep(other.id, { baseRevision: 1, text }, access)).toThrow();
  expect(drafts.remove(design.id, second, access).removed).toBe(true);
});

it("a registered reader can keep its private edits but cannot upload or erase another live writer's recovery", () => {
  const { manager, design, open } = setup(), writer = open(), reader = open(design.id, "reader", false);
  const drafts = manager.documents.designDrafts;
  const kept = drafts.keep(design.id, { baseRevision: 1, text: blankDesign("a4") }, writer);
  drafts.keep(design.id, { baseRevision: 1, text: blankDesign("wide") }, reader);
  expect(drafts.list(design.id, reader).find((entry) => entry.viewId === writer.viewId)?.active).toBe(true);
  expect(() => drafts.remove(design.id, kept, reader)).toThrow(/다른 창/);
  expect(() => manager.documents.saveAsset(design.id, Buffer.from("png"), "image/png", "x.png", reader)).toThrow();
  manager.documents.registry.close(writer.viewId, `${writer.viewId}-window`);
  expect(drafts.remove(design.id, kept, reader).removed).toBe(true);
});

it("reopening the host recovers drafts with their old base without overwriting an external edit", async () => {
  const { manager, design, open, store, options } = setup();
  const text = blankDesign("a4");
  manager.documents.designDrafts.keep(design.id, { baseRevision: 1, text }, open());
  writeFileSync(design.path, "external bytes preserved");
  const reopened = new SessionManager(store, new EventBus(), options);
  try {
    const registration = reopened.documents.registry.open(design.id, { viewId: "new", windowId: "new-window", claim: true });
    const access = { viewId: "new", writeToken: registration.writeToken };
    expect(reopened.documents.designDrafts.list(design.id, access)[0]).toMatchObject({ text, baseRevision: 1, active: false });
    await expect(reopened.documents.saveText(design.id, 1, text, access)).rejects.toMatchObject({ code: "disk_changed" });
    expect(readFileSync(design.path, "utf8")).toBe("external bytes preserved");
  } finally { await reopened.shutdown(); }
});

it("a conflict copy keeps the workspace, nested assets and exact source/session provenance", () => {
  const { manager, work, dir, open } = setup();
  const other = join(dir, "other"); mkdirSync(other);
  const workspace = manager.createWorkspace(work.id, { cwd: other, label: "작업공간" });
  const session = manager.createSession(work.id, { provider: "codex", workspaceId: workspace.id });
  const design = manager.createDesign(work.id, "디자인", "square", null, workspace.id);
  const access = open(design.id, "copy", true, session.id);
  const image = Buffer.from("picture bytes");
  const { src } = manager.documents.saveAsset(design.id, image, "image/png", "x.png", access);
  const document = JSON.parse(readFileSync(design.path, "utf8"));
  document.pages[0].background = { type: "image", src, fit: "cover" };
  document.pages[0].objects.push({ id: "group", type: "group", objects: [{ id: "image", type: "image", src, customUnknown: "keep" }] });
  const copied = manager.copyDesign(design.id, JSON.stringify(document), 1, access);
  const copy = JSON.parse(readFileSync(copied.path, "utf8"));
  expect(copied.workspaceId).toBe(workspace.id);
  expect(copied.path.startsWith(other)).toBe(true);
  const copiedSrc = copy.pages[0].objects[0].objects[0].src;
  expect(copiedSrc).not.toBe(src);
  expect(copy.pages[0].background.src).toBe(copiedSrc);
  expect(copy.pages[0].objects[0].objects[0].customUnknown).toBe("keep");
  rmSync(manager.documents.assetPath(design.id, src));
  expect(readFileSync(manager.documents.assetPath(copied.id, copiedSrc))).toEqual(image);
  expect(manager.documents.revisions(copied.id)[0]).toMatchObject({ sessionId: session.id, derivedFrom: [{ artifactId: design.id, revision: 1 }] });
  expect(JSON.parse(readFileSync(design.path, "utf8")).pages[0].objects).toEqual([]);
});

it("confirmed exports retain workspace/source/session receipts and never replace another file", () => {
  const { manager, work, dir, open } = setup();
  const other = join(dir, "other"); mkdirSync(other);
  const workspace = manager.createWorkspace(work.id, { cwd: other, label: "출력" });
  const design = manager.createDesign(work.id, "문서", "square", null, workspace.id);
  const session = manager.createSession(work.id, { provider: "codex", workspaceId: workspace.id });
  const access = open(design.id, "export", false, session.id);
  writeFileSync(join(other, "result.pdf"), "keep");
  const saved = manager.exportDesign(design.id, Buffer.from("%PDF-1.4"), "result.pdf", access, 1);
  expect(saved.name).toBe("result 2.pdf");
  expect(manager.documents.get(saved.artifactId!).workspaceId).toBe(workspace.id);
  expect(readFileSync(join(other, "result.pdf"), "utf8")).toBe("keep");
  const receipt = JSON.parse(readFileSync(join(dir, "design-exports", `${saved.receiptId}.json`), "utf8"));
  expect(receipt).toMatchObject({ sourceArtifactId: design.id, sourceRevision: 1, workspaceId: workspace.id, sessionId: session.id, size: 8 });
  manager.exportDesign(design.id, Buffer.from("png"), "canvas.png", access);
  expect(readdirSync(join(dir, "design-exports"))).toHaveLength(2);
  expect(() => manager.exportDesign(design.id, Buffer.from("x"), "script.sh", access)).toThrow();
});

it.skipIf(process.platform === "win32")("does not read or write design assets through links outside its folder", () => {
  const { dir, manager, design } = setup();
  const outside = join(dir, "outside"); mkdirSync(outside);
  writeFileSync(join(outside, "picture.png"), "private");
  symlinkSync(outside, join(manager.documents.get(design.id).path, "..", "원본.assets"));
  expect(() => manager.documents.assetPath(design.id, "원본.assets/picture.png")).toThrow(/밖/);
  expect(() => manager.documents.saveAsset(design.id, Buffer.from("image"), "image/png", "x.png")).toThrow(/밖/);
  expect(readdirSync(outside)).toEqual(["picture.png"]);
});
