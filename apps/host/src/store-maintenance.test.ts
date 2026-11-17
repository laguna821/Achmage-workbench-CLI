// 0.5.3 G4: a small quiet database — the search cache bound, the idle compaction and its guard, log rotation.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { Store } from "./store.ts";
import { SEARCH_CACHE_LIMITS } from "./search-index.ts";
import { COMPACT_RULE, StoreMaintenance } from "./store-maintenance.ts";
import { appendLogLine, LOG_LIMIT, rotateLogAtStart, trimOpenLog } from "./log-rotate.ts";
import type { TranscriptItem } from "@workbench/contracts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "wb-maint-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const note = (n: number, body: string, at: number) => ({ key: `note:n${n}.md`, kind: "note" as const, scope: "vault" as const, path: `n${n}.md`, at, title: `노트 ${n}`, tags: ["태그"], body });

/** A database with real rows, then most of it deleted: lots of free pages, like the owner's (51 MB free of 78). */
function bloated(dir: string) {
  const store = new Store(join(dir, "state.sqlite"));
  const work = { id: "w1", title: "w", cwd: dir } as never;
  store.saveWork(work);
  store.saveSession({ id: "s1", workId: "w1" } as never);
  for (let n = 0; n < 200; n++) store.saveItem("s1", { kind: "user", id: `u${n}`, text: `요청 ${n} ` + "가".repeat(200), at: n } as TranscriptItem);
  store.transaction(() => { for (let n = 0; n < 400; n++) store.appendTerminalOutput(`old-${n % 20}`, Math.floor(n / 20) * 65_536, Buffer.alloc(65_536, 120), 64 * 1024 * 1024); });
  store.transaction(() => { for (let n = 0; n < 20; n++) store.deleteTerminal(`old-${n}`); });
  return store;
}
const itemsOf = (store: Store) => store.items("s1").map((item) => JSON.stringify(item));

it("G4: the search cache is bounded; the oldest bodies are cut to a head first and titles stay", () => {
  const dir = folder();
  const store = new Store(join(dir, "state.sqlite"));
  const seen: (string[] | null)[] = [];
  store.search.subscribe((keys) => seen.push(keys));
  for (let n = 0; n < 6; n++) store.search.put(note(n, `본문${n} ` + "나".repeat(10_000), 1000 + n));
  const result = store.search.boundCache({ totalChars: 35_000, headChars: 100 });
  expect(result.trimmed).toBe(3);
  const rows = store.search.cached({ limit: 50 });
  const length = (n: number) => rows.find((row) => row.key === `note:n${n}.md`)!.body.length;
  expect([0, 1, 2].map(length)).toEqual([100, 100, 100]);
  expect([3, 4, 5].map(length)).toEqual([10_004, 10_004, 10_004]);
  expect(rows.find((row) => row.key === "note:n0.md")!.fields.title).toBe("노트 0");
  expect(rows.find((row) => row.key === "note:n0.md")!.body.startsWith("본문0 ")).toBe(true);
  expect(seen.at(-1)).toEqual(["note:n0.md", "note:n1.md", "note:n2.md"]); // the search engine re-reads them
  expect(store.search.boundCache({ totalChars: 35_000, headChars: 100 }).trimmed).toBe(0);
  expect(SEARCH_CACHE_LIMITS).toEqual({ totalChars: 32 * 1024 * 1024, headChars: 4096 });
  // The cut leaves no statement open: a compaction right after it (as the maintenance does) runs.
  for (let n = 6; n < 9; n++) store.search.put(note(n, "라".repeat(20_000), 900 + n));
  expect(store.search.boundCache({ totalChars: 35_000, headChars: 100 }).trimmed).toBeGreaterThan(0);
  expect(store.compact({ minFreeBytes: 0, minFreeShare: 0 }).compacted).toBe(true);
  store.close();
});

it("G4: compaction gives free pages back, keeps every row, and is skipped below the threshold", () => {
  const dir = folder(), file = join(dir, "state.sqlite");
  const store = bloated(dir);
  store.flushWal();
  const before = store.diskSettings(), items = itemsOf(store);
  expect(before.freePages * before.pageSize).toBeGreaterThan(COMPACT_RULE.minFreeBytes);
  const sizeBefore = statSync(file).size;
  const result = store.compact();
  expect(result.compacted).toBe(true);
  const after = store.diskSettings();
  expect(after.autoVacuum).toBe(2); // INCREMENTAL from now on
  expect(after.freePages).toBeLessThan(10);
  expect(statSync(file).size).toBeLessThan(sizeBefore / 3);
  expect(itemsOf(store)).toEqual(items);
  expect(store.compact().compacted).toBe(false); // nothing left to give back
  store.close();
  const check = new DatabaseSync(file, { readOnly: true });
  expect(check.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  check.close();
});

it("G4: the maintenance never runs while something is at work, and runs once it is quiet", () => {
  const dir = folder();
  const store = bloated(dir);
  let busy: string | null = "turn running";
  const done: string[] = [];
  const maintenance = new StoreMaintenance({ store, quiet: () => busy, terminals: { prune: () => { done.push("prune"); return 0; } } });
  expect(maintenance.runOnce()).toEqual({ skipped: "turn running" });
  expect(store.diskSettings().autoVacuum).toBe(0);
  expect(done).toEqual([]);
  busy = null;
  const result = maintenance.runOnce();
  expect(result).toMatchObject({ skipped: null, compacted: true });
  expect(done).toEqual(["prune"]);
  store.close();
});

it("G4: after compaction the backup before a migration still works", () => {
  const dir = folder(), file = join(dir, "state.sqlite");
  const store = bloated(dir); store.compact();
  const items = itemsOf(store);
  store.setMeta("search.version", "older"); // the next start sees a changed index: backup, then rebuild
  store.close();
  const reopened = new Store(file);
  expect(reopened.migration.backupPath).toBeTruthy();
  expect(existsSync(reopened.migration.backupPath!)).toBe(true);
  const backup = new DatabaseSync(reopened.migration.backupPath!, { readOnly: true });
  expect(backup.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
  expect(Number(backup.prepare("SELECT COUNT(*) AS n FROM items").get()?.n)).toBe(200);
  backup.close();
  expect(itemsOf(reopened)).toEqual(items);
  reopened.close();
});

it("G4: a gateway killed in the middle of the compaction leaves the data whole", async () => {
  const dir = folder(), file = join(dir, "state.sqlite");
  const seed = bloated(dir);
  for (let n = 0; n < 3000; n++) seed.saveItem("s1", { kind: "user", id: `x${n}`, text: `더 ${n} ` + "다".repeat(400), at: 1000 + n } as TranscriptItem);
  const items = itemsOf(seed);
  seed.close();
  const here = fileURLToPath(new URL(".", import.meta.url));
  const script = join(dir, "compact.mts");
  writeFileSync(script, `
    import { Store } from ${JSON.stringify(join(here, "store.ts"))};
    const store = new Store(${JSON.stringify(file)});
    process.stdout.write("START");
    setTimeout(() => { store.compact(); process.stdout.write("DONE"); setInterval(() => {}, 1000); }, 5);
  `);
  // Killed at several moments of the rewrite (it takes about 80 ms here): each time the file is whole.
  for (const at of [3, 20, 45]) {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
    let said = "";
    await new Promise<void>((resolve) => child.stdout.on("data", (data) => { said += String(data); if (said.includes("START")) resolve(); }));
    await new Promise((resolve) => setTimeout(resolve, at));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const check = new DatabaseSync(file);
    expect(check.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    check.close();
    const reopened = new Store(file);
    expect(itemsOf(reopened)).toEqual(items);
    reopened.close();
  }
}, 30_000);

it("G4: another connection holding the lock makes the compaction skip quietly (no error, no wait loop) and the next round does it", () => {
  const dir = folder(), file = join(dir, "state.sqlite");
  const store = bloated(dir);
  const items = itemsOf(store);
  const other = new DatabaseSync(file); // a search worker, a backup, another process
  other.exec("BEGIN IMMEDIATE");
  const started = Date.now();
  const busy = store.compact();
  expect(busy).toMatchObject({ compacted: false, busy: true });
  expect(Date.now() - started).toBeLessThan(1000); // no 3 s busy wait on the event loop, no retry loop
  const maintenance = new StoreMaintenance({ store, quiet: () => null });
  const round = Date.now();
  expect(maintenance.runOnce()).toMatchObject({ skipped: null, compacted: false });
  expect(Date.now() - round).toBeLessThan(1000);
  other.exec("ROLLBACK");
  // A reader in the middle of a read: the compaction either waits for the next round or runs; never throws.
  other.exec("BEGIN"); other.prepare("SELECT COUNT(*) FROM items").get();
  expect(() => store.compact()).not.toThrow();
  other.exec("COMMIT"); other.close();
  expect(maintenance.runOnce()).toMatchObject({ skipped: null });
  expect(store.diskSettings().autoVacuum).toBe(2);
  expect(store.diskSettings().freePages).toBeLessThan(10);
  expect(itemsOf(store)).toEqual(items);
  store.saveItem("s1", { kind: "user", id: "after", text: "다음 쓰기", at: 9 } as TranscriptItem); // normal writes wait again as before
  expect(itemsOf(store)).toHaveLength(201);
  store.close();
});

it("B9: client.log keeps one previous file once it passes its size", () => {
  const dir = folder(), file = join(dir, "client.log");
  expect(LOG_LIMIT).toBe(5 * 1024 * 1024);
  for (let n = 0; n < 30; n++) appendLogLine(file, `line ${n} ${"x".repeat(90)}`, 1000);
  expect(statSync(file).size).toBeLessThanOrEqual(1000);
  expect(readFileSync(`${file}.1`, "utf8")).toContain("line ");
  expect(readdirSync(dir).sort()).toEqual(["client.log", "client.log.1"]);
  expect(readFileSync(file, "utf8").trim().split("\n").at(-1)).toContain("line 29 ");
});

it("B9: service.log is rotated at start and trimmed in place while the service writes to it", () => {
  const dir = folder(), file = join(dir, "service.log");
  writeFileSync(file, "a".repeat(2000));
  rotateLogAtStart(file, 1000);
  expect(readFileSync(`${file}.1`, "utf8")).toHaveLength(2000);
  expect(existsSync(file)).toBe(false);
  const fd = openSync(file, "a"); // the service's stdout and stderr (lifecycle.ts)
  writeSync(fd, "b".repeat(1500));
  expect(trimOpenLog(file, 1000)).toBe(true);
  writeSync(fd, "after\n");
  closeSync(fd);
  expect(readFileSync(file, "utf8")).toBe("after\n");
  expect(readFileSync(`${file}.1`, "utf8")).toBe("b".repeat(1500));
  expect(trimOpenLog(file, 1000)).toBe(false);
  appendFileSync(file, "");
});
