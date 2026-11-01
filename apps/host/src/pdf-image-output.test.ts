import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { pdfImageOutputs } from "./pdf-image-output.mjs";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "wb-pdf-images-")), store = new Store(join(root, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(root, "works"), dataDir: root, kordoc: null });
  const work = manager.createWork({ title: "PDF 그림", cwd: join(root, "project") }); mkdirSync(work.cwd, { recursive: true });
  const { PDFDocument } = createRequire(new URL("../../../vendor/ieumoffice/package.json", import.meta.url))("pdf-lib");
  const pdf = await PDFDocument.create(); pdf.addPage(); const original = Buffer.from(await pdf.save());
  const path = join(work.cwd, "source.pdf"); writeFileSync(path, original);
  const artifact = manager.openFile(work.id, path), output = join(work.cwd, "output"); mkdirSync(output); writeFileSync(join(output, "existing.txt"), "보존");
  const access = { viewId: "pdf-a", writeToken: null };
  manager.documents.registry.open(artifact.id, { viewId: access.viewId, windowId: "window", sessionId: null, claim: true });
  const images = pdfImageOutputs(manager.documents);
  return { manager, artifact, output, access, images, path, original, async close() { await images.close(); await manager.shutdown(); store.close(); rmSync(root, { force: true, recursive: true }); } };
}
it("preserves original page numbers in new output folders and never overwrites previous exports", async () => {
  const c = await setup();
  try {
    const paths: string[] = [];
    for (let i = 0; i < 2; i++) {
      const job = await c.images.prepare(c.artifact.id, 1, c.output, "문서", c.access);
      await c.images.write(c.artifact.id, job.id, { images: [png, png], pageNumbers: [4, 2], baseName: "문서" }, c.access);
      const result = await c.images.finish(c.artifact.id, job.id, true, c.access); paths.push(result.path!);
      expect(readdirSync(result.path!)).toEqual(["문서-p2.png", "문서-p4.png"]);
    }
    expect(paths[0]).not.toBe(paths[1]); expect(readFileSync(c.path)).toEqual(c.original);
    expect(c.manager.documents.get(c.artifact.id).revision).toBe(1); expect(readFileSync(join(c.output, "existing.txt"), "utf8")).toBe("보존");
  } finally { await c.close(); }
});
it("rejects foreign views and duplicate pages, and removes only the incomplete job after invalid PNG data", async () => {
  const c = await setup();
  try {
    const job = await c.images.prepare(c.artifact.id, 1, c.output, "취소", c.access);
    const other = { viewId: "pdf-b", writeToken: null }; c.manager.documents.registry.open(c.artifact.id, { viewId: other.viewId, windowId: "window" });
    await expect(c.images.finish(c.artifact.id, job.id, false, other)).rejects.toThrow("이 문서에서 시작한");
    await expect(c.images.write(c.artifact.id, job.id, { images: [png, png], pageNumbers: [1, 1], baseName: "test" }, c.access)).rejects.toThrow("페이지");
    await expect(c.images.write(c.artifact.id, job.id, { images: [png, "invalid"], pageNumbers: [1, 2], baseName: "test" }, c.access)).rejects.toThrow("PNG");
    expect(readdirSync(c.output)).toEqual(["existing.txt"]);
    expect(await c.images.finish(c.artifact.id, job.id, false, c.access)).toMatchObject({ ok: true, canceled: true });
    const empty = await c.images.prepare(c.artifact.id, 1, c.output, "empty", c.access);
    await c.images.run(c.artifact.id, empty.id, c.access, 1, async () => undefined);
    expect(await c.images.finish(c.artifact.id, empty.id, true, c.access)).toEqual({ ok: true, files: [] });
    expect(readdirSync(c.output)).toEqual(["existing.txt"]);
  } finally { await c.close(); }
});
it("cancels a live extraction on view closure and cleans its files when the writer settles", async () => {
  const c = await setup();
  try {
    const job = await c.images.prepare(c.artifact.id, 1, c.output, "pending", c.access);
    let finish!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const running = c.images.run(c.artifact.id, job.id, c.access, 1, async path => {
      writeFileSync(join(path, "part.png"), Buffer.from(png, "base64")); entered();
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const rejected = expect(running).rejects.toThrow(); await ready;
    c.manager.documents.registry.close(c.access.viewId, "window"); await c.images.prune(); finish(); await rejected;
    expect(readdirSync(c.output)).toEqual(["existing.txt"]);
  } finally { await c.close(); }
});
