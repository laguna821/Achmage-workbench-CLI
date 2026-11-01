import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { OfficeImageOutputs } from "./office-image-output.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function setup() {
  const root = mkdtempSync(join(tmpdir(), "wb-markdown-images-")), store = new Store(join(root, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(root, "works"), dataDir: root, kordoc: null });
  const work = manager.createWork({ title: "그림 출력", cwd: join(root, "project") }); mkdirSync(work.cwd, { recursive: true });
  const path = join(work.cwd, "source.md"), original = "\ufeff# 원문\r\n"; writeFileSync(path, original);
  const artifact = manager.openFile(work.id, path), output = join(work.cwd, "output"); mkdirSync(output); writeFileSync(join(output, "existing.txt"), "보존");
  const access = { viewId: "markdown-a", writeToken: null };
  manager.documents.registry.open(artifact.id, { viewId: access.viewId, windowId: "window", sessionId: null, claim: true });
  const images = new OfficeImageOutputs(manager.documents);
  return { manager, artifact, output, access, images, path, original, async close() { await images.close(); store.close(); rmSync(root, { force: true, recursive: true }); } };
}
it("writes ordered PNG pages into unique folders, preserving the source, its revision and existing exports", async () => {
  const c = setup();
  try {
    const first = await c.images.prepare(c.artifact.id, 1, c.output, "../문서", c.access);
    await c.images.write(c.artifact.id, first.id, 1, png, c.access); await c.images.write(c.artifact.id, first.id, 2, png, c.access);
    const result = await c.images.finish(c.artifact.id, first.id, true, c.access);
    expect(result.path?.startsWith(c.output)).toBe(true); expect(readdirSync(result.path!)).toEqual(["page-01.png", "page-02.png"]);
    expect(readFileSync(join(result.path!, "page-02.png"))).toEqual(Buffer.from(png, "base64"));
    const second = await c.images.prepare(c.artifact.id, 1, c.output, "../문서", c.access);
    await c.images.write(c.artifact.id, second.id, 1, png, c.access);
    const other = await c.images.finish(c.artifact.id, second.id, true, c.access); expect(other.path).not.toBe(result.path);
    expect(readFileSync(c.path, "utf8")).toBe(c.original); expect(c.manager.documents.get(c.artifact.id).revision).toBe(1);
    expect(readFileSync(join(c.output, "existing.txt"), "utf8")).toBe("보존");
  } finally { await c.close(); }
});
it("rejects other views, bad page order and invalid PNG data; cancel deletes only this incomplete export", async () => {
  const c = setup();
  try {
    const job = await c.images.prepare(c.artifact.id, 1, c.output, "출력", c.access);
    const other = { viewId: "markdown-b", writeToken: null };
    c.manager.documents.registry.open(c.artifact.id, { viewId: other.viewId, windowId: "window", sessionId: null });
    await expect(c.images.write(c.artifact.id, job.id, 1, png, other)).rejects.toThrow("이 문서에서 시작한");
    await expect(c.images.finish(c.artifact.id, job.id, false, other)).rejects.toThrow();
    await expect(c.images.write(c.artifact.id, job.id, 2, png, c.access)).rejects.toThrow("page number");
    await expect(c.images.write(c.artifact.id, job.id, 1, Buffer.from("not a PNG").toString("base64"), c.access)).rejects.toThrow("PNG");
    await c.images.write(c.artifact.id, job.id, 1, png, c.access);
    await expect(c.images.write(c.artifact.id, job.id, 1, png, c.access)).rejects.toThrow("page number");
    expect(await c.images.finish(c.artifact.id, job.id, false, c.access)).toEqual({ ok: true, canceled: true });
    expect(readdirSync(c.output)).toEqual(["existing.txt"]);
    const empty = await c.images.prepare(c.artifact.id, 1, c.output, "빈출력", c.access);
    await expect(c.images.finish(c.artifact.id, empty.id, true, c.access)).rejects.toThrow("empty");
    expect(readdirSync(c.output)).toEqual(["existing.txt"]);
  } finally { await c.close(); }
});
it("removes partial exports on view closure, session change and shutdown, retaining completed files", async () => {
  const c = setup();
  try {
    const done = await c.images.prepare(c.artifact.id, 1, c.output, "완료", c.access); await c.images.write(c.artifact.id, done.id, 1, png, c.access);
    const result = await c.images.finish(c.artifact.id, done.id, true, c.access);
    for (const mode of ["session", "view", "shutdown"]) {
      c.manager.documents.registry.open(c.artifact.id, { viewId: c.access.viewId, windowId: "window", sessionId: null });
      const job = await c.images.prepare(c.artifact.id, 1, c.output, mode, c.access); await c.images.write(c.artifact.id, job.id, 1, png, c.access);
      if (mode === "session") c.manager.documents.registry.open(c.artifact.id, { viewId: c.access.viewId, windowId: "window", sessionId: "different" });
      if (mode === "view") c.manager.documents.registry.close(c.access.viewId, "window");
      if (mode === "shutdown") await c.images.close(); else await c.images.reconcile();
      expect(readdirSync(c.output)).toHaveLength(2); expect(existsSync(join(result.path!, "page-01.png"))).toBe(true);
      await expect(c.images.write(c.artifact.id, job.id, 2, png, c.access)).rejects.toThrow();
    }
  } finally { await c.close(); }
});
