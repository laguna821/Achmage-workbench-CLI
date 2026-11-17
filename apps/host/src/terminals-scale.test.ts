// 0.5.3 G2/G4: many light terminals and a quiet database (ux/briefs/perf-g2g4-terminals-disk-brief.md).
// The worker is the stand-in (scripts/fixtures/fake-pty-worker.mjs): the same protocol, the shell on pipes.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Store } from "./store.ts";
import { Terminals, terminalAdmission, TERMINAL_LIMITS, TERMINAL_SCROLLBACK, TERMINAL_RETENTION } from "./terminals.ts";
import { TerminalEmulator } from "./terminal-emulator.ts";
import type { Workspaces } from "./workspaces.ts";

export const fakeWorker = fileURLToPath(new URL("../../../scripts/fixtures/fake-pty-worker.mjs", import.meta.url));
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** The two things Terminals asks of the workspaces: the record and that it is still active. */
export function spacesFor(cwd: string): Workspaces {
  const space = { id: "ws-1", workId: "work-1", hostId: "local", cwd, archivedAt: null, removedAt: null };
  return { get: () => space, requireActive: () => space } as unknown as Workspaces;
}
function fixture(options: ConstructorParameters<typeof Terminals>[3] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-term-scale-"));
  const store = new Store(join(dir, "state.sqlite"));
  const api = new Terminals(store, spacesFor(dir), fakeWorker, options);
  cleanup.push(async () => { await api.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, api };
}
async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() >= end) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 20)); }
}
const GiB = 1024 ** 3;

it("A5: admits terminals while the machine has memory to spare, up to a 64-terminal safety net", () => {
  expect(TERMINAL_LIMITS.maxLive).toBe(64);
  expect(terminalAdmission(16, 8 * GiB)).toBeNull(); // the old 17th is admitted now
  expect(terminalAdmission(50, 4 * GiB)).toBeNull();
  expect(terminalAdmission(63, 2 * GiB)).toBeNull();
  const cap = terminalAdmission(64, 8 * GiB);
  expect(cap).toMatch(/64개/);
  const low = terminalAdmission(3, 700 * 1024 * 1024);
  expect(low).toMatch(/남은 메모리가 700 MB/);
  expect(low).toMatch(/1,024 MB/);
});

it("A5: a refusal for memory says why in Korean and starts no worker", () => {
  const { api } = fixture({ availableMemory: () => 512 * 1024 * 1024 });
  let error: unknown;
  try { api.create("ws-1", { requestId: randomUUID() }); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ status: 429, code: "terminal_limit" });
  expect(String((error as Error).message)).toMatch(/메모리/);
  expect(api.list("ws-1").terminals).toHaveLength(0);
});

it("A5: more than 16 live terminals run at once when memory allows", async () => {
  const { api } = fixture({ availableMemory: () => 8 * GiB });
  const ids = Array.from({ length: 18 }, () => api.create("ws-1", { requestId: randomUUID(), shell: "/bin/sh" }).id);
  await until(() => ids.every((id) => api.get(id).status === "running"), 20_000);
  expect(ids).toHaveLength(18);
}, 30_000);

it("A6: the gateway's screen model keeps a bounded tail of scrollback and still restores the latest screen", async () => {
  const model = new TerminalEmulator(24, 80, () => {});
  try {
    const text = Array.from({ length: 6000 }, (_, n) => `line ${String(n).padStart(5, "0")}`).join("\r\n") + "\r\n";
    model.feed(Buffer.from(text), text.length);
    const captured = await model.capture();
    expect(captured.retainedHistoryLines).toBeLessThanOrEqual(TERMINAL_SCROLLBACK.gateway);
    expect(captured.retainedHistoryLines).toBeGreaterThan(TERMINAL_SCROLLBACK.gateway - 30);
    const screen = Buffer.from(captured.data, "base64").toString("utf8");
    expect(screen).toContain("line 05999");
    expect(screen).not.toContain("line 00001");
  } finally { model.dispose(); }
  expect(TERMINAL_SCROLLBACK).toEqual({ gateway: 2000, window: 5000, journalLive: 1024 * 1024, journalEnded: 256 * 1024 });
});

it("A6: the stored journal keeps 1 MiB while running and a 256 KiB tail after the end; a restart restores it", async () => {
  const { api, store, dir } = fixture({ availableMemory: () => 8 * GiB });
  const script = "process.stdout.write('x'.repeat(1500000) + '\\nEND_OF_OUTPUT\\n'); setTimeout(() => {}, 1500)";
  const terminal = api.create("ws-1", { requestId: randomUUID(), shell: process.execPath, args: ["-e", script] });
  await until(() => api.get(terminal.id).outputEnd >= 1_500_000, 15_000);
  await until(() => { const t = api.get(terminal.id); return t.outputEnd - t.outputStart <= TERMINAL_SCROLLBACK.journalLive + 65_536 && t.outputStart > 0; });
  await until(() => api.get(terminal.id).status === "exited", 15_000);
  const ended = api.get(terminal.id);
  expect(ended.outputEnd - ended.outputStart).toBeLessThanOrEqual(TERMINAL_SCROLLBACK.journalEnded);
  const stored = Number(new DatabaseSync(join(dir, "state.sqlite"), { readOnly: true }).prepare("SELECT SUM(length(data)) AS n FROM terminal_output WHERE terminal_id = ?").get(terminal.id)?.n);
  expect(stored).toBe(ended.outputEnd - ended.outputStart);
  const restored = new Terminals(store, spacesFor(dir), fakeWorker);
  const replay = await restored.replay(terminal.id);
  expect(replay.truncated).toBe(true);
  expect(Buffer.from(replay.data, "base64").toString("utf8")).toContain("END_OF_OUTPUT");
}, 30_000);

it("A7: an ended terminal is never deleted for its age: three weeks later it and the end of its output are still there", async () => {
  const { store, dir } = fixture({ availableMemory: () => 8 * GiB });
  const day = 24 * 3600 * 1000, now = Date.now();
  const base = { workspaceId: "ws-1", workId: "work-1", hostId: "local", cwd: dir, label: "t", shell: null, args: [], pid: null, exitCode: 0, error: null, cols: 80, rows: 24, outputStart: 0, outputEnd: 5, createdAt: now - 400 * day };
  for (const [id, status, ago] of [["old-ended", "exited", 21], ["old-interrupted", "interrupted", 365]] as const) {
    store.saveTerminal({ ...base, id, status, updatedAt: now - ago * day });
    store.appendTerminalOutput(id, 0, Buffer.from("hello"), 1024);
  }
  const reopened = new Terminals(store, spacesFor(dir), fakeWorker, { availableMemory: () => 8 * GiB });
  expect(reopened.prune(now)).toBe(0);
  for (const id of ["old-ended", "old-interrupted"]) {
    expect(reopened.has(id)).toBe(true);
    expect(Buffer.from(reopened.output(id).data, "base64").toString()).toBe("hello");
  }
  expect(TERMINAL_RETENTION).toEqual({ perWorkspace: 256 });
});

it("A7: past the 256 terminals the list shows, the oldest ended ones leave with their output", () => {
  const { api, store, dir } = fixture();
  const now = Date.now();
  for (let n = 0; n < 260; n++) {
    store.saveTerminal({ id: `t${String(n).padStart(3, "0")}`, workspaceId: "ws-1", workId: "work-1", hostId: "local", cwd: dir, label: "t", shell: null, args: [], status: "exited", pid: null, exitCode: 0, error: null, cols: 80, rows: 24, outputStart: 0, outputEnd: 1, createdAt: now - 1000 + n, updatedAt: now });
    store.appendTerminalOutput(`t${String(n).padStart(3, "0")}`, 0, Buffer.from("x"), 1024);
  }
  const reopened = new Terminals(store, spacesFor(dir), fakeWorker);
  expect(reopened.prune(now)).toBe(4);
  expect(reopened.prune(now + 400 * 24 * 3600 * 1000)).toBe(0); // age alone never removes one
  expect(reopened.list("ws-1").terminals).toHaveLength(256);
  for (const gone of ["t000", "t001", "t002", "t003"]) expect(reopened.has(gone)).toBe(false);
  void api;
});

it("A8: the state database runs WAL with synchronous=NORMAL", () => {
  const { store } = fixture();
  expect(store.diskSettings()).toMatchObject({ journalMode: "wal", synchronous: 1 });
});

it("A8: output rows are written in batches, read back at once from memory, and flushed when the terminal closes", async () => {
  const { api, store, dir } = fixture({ availableMemory: () => 8 * GiB, outputFlushMs: 60_000 });
  let writes = 0;
  const append = store.appendTerminalOutput.bind(store);
  store.appendTerminalOutput = (...args) => { writes++; return append(...args); };
  const script = "let n = 0; const tick = () => { process.stdout.write(`chunk ${n}\\n`); if (++n < 400) setTimeout(tick, 1); else process.stdout.write('ALL_WRITTEN\\n'); }; tick(); setInterval(() => {}, 1000)";
  const terminal = api.create("ws-1", { requestId: randomUUID(), shell: process.execPath, args: ["-e", script] });
  const text = () => { let at = 0; const parts: Buffer[] = []; for (;;) { const page = api.output(terminal.id, at); parts.push(Buffer.from(page.data, "base64")); if (page.end >= page.terminal.outputEnd || page.end <= at) break; at = page.end; } return Buffer.concat(parts).toString("utf8"); };
  await until(() => text().includes("ALL_WRITTEN"), 15_000);
  expect(writes).toBe(0); // all of it still in the batch (60 s window here), yet readable
  expect(text()).toContain("chunk 399\n");
  const db = new DatabaseSync(join(dir, "state.sqlite"), { readOnly: true });
  expect(Number(db.prepare("SELECT COUNT(*) AS n FROM terminal_output WHERE terminal_id = ?").get(terminal.id)?.n)).toBe(0);
  await api.close(terminal.id);
  expect(writes).toBeGreaterThan(0); expect(writes).toBeLessThan(5);
  const record = JSON.parse(String(db.prepare("SELECT json FROM terminals WHERE id = ?").get(terminal.id)?.json));
  const rows = db.prepare("SELECT start, end, data FROM terminal_output WHERE terminal_id = ? ORDER BY start").all(terminal.id) as { start: number; end: number; data: Uint8Array }[];
  expect(rows.at(-1)?.end).toBe(record.outputEnd);
  expect(Buffer.concat(rows.map((row) => Buffer.from(row.data))).toString("utf8")).toContain("ALL_WRITTEN");
  db.close();
}, 30_000);

it("A8: under the normal 200 ms batching a noisy terminal costs a handful of row writes, not one per chunk", async () => {
  const { api, store } = fixture({ availableMemory: () => 8 * GiB });
  let writes = 0, chunks = 0;
  const append = store.appendTerminalOutput.bind(store);
  store.appendTerminalOutput = (...args) => { writes++; return append(...args); };
  const script = "let n = 0; const tick = () => { process.stdout.write(`line ${n}\\n`); if (++n < 600) setTimeout(tick, 1); }; tick()";
  const terminal = api.create("ws-1", { requestId: randomUUID(), shell: process.execPath, args: ["-e", script] });
  const feed = (api as unknown as { event: (id: string, message: Record<string, unknown>) => void });
  const original = feed.event.bind(api);
  feed.event = (id, message) => { if (message.type === "data") chunks++; original(id, message); };
  await until(() => api.get(terminal.id).status === "exited", 15_000);
  expect(chunks).toBeGreaterThan(100);
  expect(writes).toBeLessThan(chunks / 5);
}, 30_000);

it("A8: a gateway killed in the middle of terminal output leaves a consistent database (record and rows agree)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-term-kill-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const here = fileURLToPath(new URL(".", import.meta.url));
  const child = join(dir, "gateway.mts");
  writeFileSync(child, `
    import { Store } from ${JSON.stringify(join(here, "store.ts"))};
    import { Terminals } from ${JSON.stringify(join(here, "terminals.ts"))};
    const dir = ${JSON.stringify(dir)};
    const space = { id: "ws-1", workId: "work-1", hostId: "local", cwd: dir, archivedAt: null, removedAt: null };
    const store = new Store(dir + "/state.sqlite");
    const api = new Terminals(store, { get: () => space, requireActive: () => space } as never, ${JSON.stringify(fakeWorker)}, { availableMemory: () => 8 * 1024 ** 3 });
    const script = "let n = 0; setInterval(() => { process.stdout.write(String(n++).padStart(8, '0') + String.fromCharCode(10)); }, 1)";
    api.create("ws-1", { requestId: "noisy", shell: process.execPath, args: ["-e", script] });
    setInterval(() => { if (api.get("noisy").outputEnd > 20000) process.stdout.write("WRITING"); }, 50);
  `);
  const gateway = spawn(process.execPath, [child], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => { gateway.stdout.on("data", (data) => { if (String(data).includes("WRITING")) resolve(); }); gateway.on("exit", () => reject(new Error("gateway exited early"))); });
  await new Promise((resolve) => setTimeout(resolve, 330)); // mid-batch on purpose
  gateway.kill("SIGKILL");
  await new Promise((resolve) => gateway.once("exit", resolve));
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  expect(db.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
  const record = JSON.parse(String(db.prepare("SELECT json FROM terminals WHERE id = 'noisy'").get()?.json));
  const rows = db.prepare("SELECT start, end, data FROM terminal_output WHERE terminal_id = 'noisy' ORDER BY start").all() as { start: number; end: number; data: Uint8Array }[];
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0]!.start).toBe(record.outputStart);
  expect(rows.at(-1)!.end).toBe(record.outputEnd);
  for (let n = 1; n < rows.length; n++) expect(rows[n]!.start).toBe(rows[n - 1]!.end);
  const lines = Buffer.concat(rows.map((row) => Buffer.from(row.data))).toString("utf8").split("\n").filter(Boolean);
  lines.forEach((line, n) => { if (n) expect(Number(line)).toBe(Number(lines[n - 1]) + 1); });
  db.close();
  // The worker the killed gateway owned exits on its closed stdin; the next start marks the run interrupted.
  const store = new Store(join(dir, "state.sqlite"));
  const reopened = new Terminals(store, spacesFor(dir), fakeWorker);
  expect(reopened.get("noisy").status).toBe("interrupted");
  expect(reopened.output("noisy").end).toBe(record.outputEnd);
  store.close();
}, 30_000);
