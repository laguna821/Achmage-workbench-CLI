import { mkdirSync, mkdtempSync, existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PagePictures, pictureEntries, sweepPictures } from "./page-pictures.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fake(over: Partial<ConstructorParameters<typeof PagePictures>[0]> = {}) {
  const made: string[] = [];
  const pictures = new PagePictures({
    make: async (id, revision) => { made.push(`${id}@${revision}`); },
    has: () => false,
    current: () => true,
    busy: () => false,
    memoryAvailable: () => 8 * 1024 ** 3,
    delayMs: 5,
    ...over,
  });
  return { pictures, made };
}

describe("page pictures made in the background", () => {
  it("makes one job per document after a quiet moment, the newest revision of saves in a row", async () => {
    const { pictures, made } = fake();
    pictures.add("a", 2); pictures.add("a", 3); pictures.add("b", 1);
    await pictures.settled();
    expect(made).toEqual(["a@3", "b@1"]);
  });

  it("makes nothing while the machine is short of memory (made on demand instead)", async () => {
    const { pictures, made } = fake({ memoryAvailable: () => 512 * 1024 ** 2 });
    pictures.add("a", 1);
    await pictures.settled();
    expect(made).toEqual([]);
    expect(pictures.log.at(-1)?.outcome).toBe("low-memory");
  });

  it("waits for another heavy document job (the same save's text index), then makes it", async () => {
    let busy = true;
    setTimeout(() => { busy = false; }, 30);
    const { pictures, made } = fake({ busy: () => busy, busyWaitMs: 2000 });
    pictures.add("a", 1);
    await pictures.settled();
    expect(made).toEqual(["a@1"]);
  });

  it("asking again for what already waits does not push its job back", async () => {
    const { pictures, made } = fake({ delayMs: 40 });
    pictures.add("a", 1);
    const asking = setInterval(() => pictures.add("a", 1), 10);
    await pictures.settled();
    clearInterval(asking);
    expect(made).toEqual(["a@1"]);
  });

  it("makes nothing while another heavy document job of the gateway keeps running", async () => {
    const { pictures, made } = fake({ busy: () => true, busyWaitMs: 20 });
    pictures.add("a", 1);
    await pictures.settled();
    expect(made).toEqual([]);
    expect(pictures.log.at(-1)?.outcome).toBe("busy");
  });

  it("skips a revision that is no longer current, or whose pictures are there", async () => {
    const { pictures, made } = fake({ current: (_id, revision) => revision === 5, has: (id) => id === "b" });
    pictures.add("a", 4); pictures.add("b", 5);
    await pictures.settled();
    expect(made).toEqual([]);
    expect(pictures.log.map((entry) => entry.outcome)).toEqual(["stale", "had"]);
  });

  it("runs one job at a time", async () => {
    let running = 0, most = 0;
    const { pictures } = fake({ make: async () => { running += 1; most = Math.max(most, running); await new Promise((done) => setTimeout(done, 10)); running -= 1; } });
    for (const id of ["a", "b", "c"]) pictures.add(id, 1);
    await pictures.settled();
    expect(most).toBe(1);
  });

  it("a failed job does not stop the queue", async () => {
    const made: string[] = [];
    const { pictures } = fake({ make: async (id) => { if (id === "a") throw new Error("no tool"); made.push(id); } });
    pictures.add("a", 1); pictures.add("b", 1);
    await pictures.settled();
    expect(made).toEqual(["b"]);
  });
});

describe("the picture cache's bound", () => {
  const cache = () => {
    const root = mkdtempSync(join(tmpdir(), "pictures-")); dirs.push(root);
    const put = (id: string, name: string, bytes: number, age: number) => {
      const path = join(root, id, name);
      if (name.endsWith(".pages")) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "page-1.png"), Buffer.alloc(bytes)); }
      else { mkdirSync(join(root, id), { recursive: true }); writeFileSync(path, Buffer.alloc(bytes)); }
      const at = new Date(Date.now() - age * 1000);
      utimesSync(path, at, at);
      return path;
    };
    return { root, put };
  };

  it("counts revision page folders and cover files, nothing else of the document's folder", () => {
    const { root, put } = cache();
    put("a", "r1.pages", 100, 3); put("a", "r2.cover.png", 50, 2); put("a", "r2.docx", 999, 1);
    expect(pictureEntries(root).reduce((sum, entry) => sum + entry.bytes, 0)).toBe(150);
  });

  it("removes the oldest pictures first until it is under the bound, never a current revision's", () => {
    const { root, put } = cache();
    const oldCurrent = put("a", "r3.pages", 400, 100);
    const oldest = put("b", "r1.pages", 300, 90);
    const middle = put("a", "r2.pages", 300, 50);
    const newest = put("c", "r1.cover.png", 300, 10);
    const result = sweepPictures(root, 1000, (id, revision) => id === "a" && revision === 3);
    expect(result.removed).toEqual([oldest]);
    expect(existsSync(oldCurrent) && existsSync(middle) && existsSync(newest)).toBe(true);
    const tighter = sweepPictures(root, 500, (id, revision) => id === "a" && revision === 3);
    expect(tighter.removed).toEqual([middle, newest]);
    expect(existsSync(oldCurrent)).toBe(true);
  });
});
