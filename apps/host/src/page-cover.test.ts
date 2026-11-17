import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import type { IeumOffice, OfficePage } from "./ieumoffice.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { pagePng } from "../../../scripts/fixtures/png.mjs";

// The first-page picture behind a document tab's placeholder (doc-pages-first): made in the
// background per revision, never made by asking for it, and always the asked revision's own.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wb-cover-")); dirs.push(dir);
  const renders: string[] = [];
  // A stand-in IeumOffice: one PNG per "page", its size taken from the file's first byte (a revision's own picture).
  const ieum = {
    available: true,
    render: async (input: string, outDir: string): Promise<OfficePage[]> => {
      renders.push(input);
      mkdirSync(outDir, { recursive: true });
      const width = 400 + readFileSync(input)[0];
      const file = join(outDir, "page-1.png");
      writeFileSync(file, pagePng(width, 300));
      return [{ page: 1, width, height: 300, file }];
    },
    textView: async () => "",
  } as unknown as IeumOffice;
  const store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir, ieum });
  const work = manager.createWork({ title: "특강", cwd: join(dir, "project") });
  mkdirSync(work.cwd, { recursive: true });
  return { dir, manager, work, renders };
}

describe("a document's first-page picture (the tab's placeholder)", () => {
  it("is never made by asking: the ask queues it, the background makes it, then it is there", async () => {
    const { manager, work, renders } = setup();
    const pictures = manager.documents.enablePictures({ delayMs: 1, memoryAvailable: () => 8 * 1024 ** 3 });
    const file = join(work.cwd, "강의.docx");
    writeFileSync(file, Buffer.from([10, 1, 2]));
    const artifact = manager.openFile(work.id, file);
    // Asked at once: nothing is made by the ask itself (the job waits for its quiet moment).
    expect(manager.documents.cover(artifact.id).cover).toBeNull();
    expect(renders).toEqual([]);
    await pictures.settled();
    expect(manager.documents.cover(artifact.id)).toEqual({ revision: 1, cover: { page: 1, width: 410, height: 300 } });
  });

  it("belongs to its revision: after a save the new revision has none until it is made, and the old one is never given for it", async () => {
    const { manager, work } = setup();
    const pictures = manager.documents.enablePictures({ delayMs: 1, memoryAvailable: () => 8 * 1024 ** 3 });
    const file = join(work.cwd, "발표.pptx");
    writeFileSync(file, Buffer.from([20]));
    const artifact = manager.openFile(work.id, file);
    manager.documents.cover(artifact.id);
    await pictures.settled();
    expect(manager.documents.cover(artifact.id, 1).cover?.width).toBe(420);

    writeFileSync(file, Buffer.from([50]));
    const saved = manager.documents.track(work.id, work.cwd, file, "user", null, null)!;
    expect(saved.artifact.revision).toBe(2);
    // Asked right after the save, before the background job: none (never r1's picture).
    expect(manager.documents.cover(artifact.id, 2).cover).toBeNull();
    await pictures.settled();
    expect(manager.documents.cover(artifact.id, 2).cover?.width).toBe(450);
    expect(manager.documents.cover(artifact.id, 1).cover?.width).toBe(420);
  });

  it("saves in a row make one picture job, of the newest revision", async () => {
    const { manager, work, renders } = setup();
    const pictures = manager.documents.enablePictures({ delayMs: 20, memoryAvailable: () => 8 * 1024 ** 3 });
    const file = join(work.cwd, "표.xlsx");
    writeFileSync(file, Buffer.from([1]));
    const artifact = manager.openFile(work.id, file);
    for (const byte of [2, 3, 4]) { writeFileSync(file, Buffer.from([byte])); manager.documents.track(work.id, work.cwd, file, "user", null, null); }
    await pictures.settled();
    expect(renders.length).toBe(1);
    expect(manager.documents.cover(artifact.id, 4).cover?.width).toBe(404);
  });

  it("keeps the cache under its bound: an old revision's pictures go, the current revision's stay", async () => {
    const { dir, manager, work } = setup();
    const pictures = manager.documents.enablePictures({ delayMs: 1, memoryAvailable: () => 8 * 1024 ** 3 });
    const file = join(work.cwd, "강의.docx");
    writeFileSync(file, Buffer.from([1]));
    const artifact = manager.openFile(work.id, file);
    manager.documents.cover(artifact.id);
    await pictures.settled();
    manager.documents.pictureBound = 1;
    writeFileSync(file, Buffer.from([2]));
    manager.documents.track(work.id, work.cwd, file, "user", null, null);
    await pictures.settled();
    expect(existsSync(join(dir, "artifacts", artifact.id, "r1.pages"))).toBe(false);
    expect(manager.documents.cover(artifact.id, 2).cover).not.toBeNull();
    expect(manager.documents.cover(artifact.id, 1).cover).toBeNull();
  });

  it("is made for nothing else than Office and Hangul documents", () => {
    const { manager, work } = setup();
    const file = join(work.cwd, "메모.md");
    writeFileSync(file, "# 메모\n");
    const artifact = manager.openFile(work.id, file);
    expect(manager.documents.cover(artifact.id).cover).toBeNull();
  });
});
