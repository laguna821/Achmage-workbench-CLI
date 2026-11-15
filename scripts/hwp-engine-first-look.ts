// First look at a second Hangul engine build beside the shipped one (H4 part A): every Hangul
// document of the repository's fixtures (and, with --samples, every .hwp/.hwpx under a folder such
// as a checkout of the rhwp repository) is opened with BOTH engines in Node, and per document the
// script records: opens (yes/no), page count, and whether the HWP and the HWPX export open again
// (with their page counts). Early warning only — not the corpus check (scripts/hwp-corpus-check.ts)
// and not wired into any build or test. Headless, no network, documents are read in place.
//
//   node scripts/hwp-engine-first-look.ts [--old DIR] [--new DIR] [--samples DIR] [--out FILE]
//                                         [--timeout MS] [--only SUBSTRING]
//
// DIR holds an engine build (rhwp.js + rhwp_bg.wasm); --old defaults to third_party/hop/rhwp-core,
// --new to third_party/hop/rhwp-core-0.9.0. Documents run in a worker thread with a time limit per
// document (default 60 s); a worker per engine is reused across documents and replaced after a time-out, a
// crash or an engine error, so one document that hangs or breaks the engine does not stop the run.
// Nothing that is written holds document text: file names, sizes, sha256, counts and error KINDS
// (the engine's own messages can quote a document, so they are never kept).
// Exit code: 0 always when the run completes (it is a report, not a gate); 64 usage.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

type Side = { opens: boolean; pages?: number; error?: string; hwp?: Reopen; hwpx?: Reopen; ms?: number };
type Reopen = { reopens: boolean; pages?: number; error?: string };
type Row = { name: string; size: number; sha256: string; old: Side; new: Side };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kindOf = (error: unknown) => (error instanceof Error ? error.name : typeof error === "string" ? "engine error" : typeof error);

async function inWorker() {
  const { engineDir } = workerData as { engineDir: string };
  const mod = await import(pathToFileURL(join(engineDir, "rhwp.js")).href);
  await mod.default({ module_or_path: readFileSync(join(engineDir, "rhwp_bg.wasm")) });
  parentPort!.on("message", (file: string) => parentPort!.postMessage(checkOne(mod, file)));
  parentPort!.postMessage("ready");
}

function checkOne(mod: any, file: string): Side {
  const start = performance.now();
  const side: Side = { opens: false };
  let doc: { pageCount(): number; exportHwp(): Uint8Array; exportHwpx(): Uint8Array; free(): void } | undefined;
  try {
    doc = new mod.HwpDocument(new Uint8Array(readFileSync(file)));
    side.opens = true;
    side.pages = doc!.pageCount();
  } catch (error) {
    side.error = `open (${kindOf(error)})`;
  }
  if (doc) {
    for (const format of ["hwp", "hwpx"] as const) {
      const reopen: Reopen = { reopens: false };
      try {
        const bytes = format === "hwp" ? doc.exportHwp() : doc.exportHwpx();
        try {
          const back = new mod.HwpDocument(bytes);
          reopen.reopens = true;
          reopen.pages = back.pageCount();
          back.free();
        } catch (error) {
          reopen.error = `reopen (${kindOf(error)})`;
        }
      } catch (error) {
        reopen.error = `export (${kindOf(error)})`;
      }
      side[format] = reopen;
    }
    doc.free();
  }
  side.ms = Math.round(performance.now() - start);
  return side;
}

/** One live worker per engine, reused across documents; replaced after a time-out, a crash or any engine error. */
class EngineWorker {
  private worker?: Worker;
  private ready?: Promise<void>;
  private readonly engineDir: string;
  constructor(engineDir: string) { this.engineDir = engineDir; }
  private start() {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { engineDir: this.engineDir }, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
    this.worker = worker;
    this.ready = new Promise((done, fail) => {
      worker.once("message", () => done());
      worker.once("error", fail);
    });
  }
  stop() { void this.worker?.terminate(); this.worker = undefined; }
  async check(file: string, timeout: number): Promise<Side> {
    if (!this.worker) this.start();
    try { await this.ready; } catch (error) { this.stop(); return { opens: false, error: `worker (${kindOf(error)})` }; }
    const worker = this.worker!;
    const side = await new Promise<Side>((done) => {
      let settled = false;
      const onMessage = (result: Side) => finish(result);
      const onError = (error: unknown) => finish({ opens: false, error: `worker (${kindOf(error)})` });
      const onExit = (code: number) => finish({ opens: false, error: `worker exit ${code}` });
      const finish = (result: Side) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        worker.off("message", onMessage).off("error", onError).off("exit", onExit);
        done(result);
      };
      const timer = setTimeout(() => finish({ opens: false, error: `timeout ${timeout} ms` }), timeout);
      worker.on("message", onMessage).on("error", onError).on("exit", onExit);
      worker.postMessage(file);
    });
    // An engine that threw (a Rust panic aborts inside WASM) or ran out of time is not reused.
    if (!side.opens || side.error || side.hwp?.error || side.hwpx?.error) this.stop();
    return side;
  }
}

function hangulFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== ".git") walk(path); }
      else if (entry.isFile() && /\.hwpx?$/i.test(entry.name)) out.push(path);
    }
  };
  walk(dir);
  return out.sort();
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const reopenText = (reopen?: Reopen) => (!reopen ? "-" : reopen.reopens ? `yes (${reopen.pages})` : `no: ${reopen.error}`);

async function main(args: string[]) {
  if (args.includes("--help")) {
    console.error("usage: node scripts/hwp-engine-first-look.ts [--old DIR] [--new DIR] [--samples DIR] [--out FILE] [--timeout MS] [--only SUBSTRING]");
    return 64;
  }
  const oldDir = resolve(option(args, "--old") ?? join(repoRoot, "third_party/hop/rhwp-core"));
  const newDir = resolve(option(args, "--new") ?? join(repoRoot, "third_party/hop/rhwp-core-0.9.0"));
  const samples = option(args, "--samples");
  const timeout = Number(option(args, "--timeout") ?? 60000);
  const only = option(args, "--only");
  const roots: { base: string; label: string; files: string[] }[] = [
    { base: repoRoot, label: "repo", files: [
      ...hangulFiles(join(repoRoot, "vendor/ieumoffice/apps/hwp/tests/fixtures")),
      ...hangulFiles(join(repoRoot, "apps/host/src/channels/fixtures")),
      ...hangulFiles(join(repoRoot, "third_party/skills/hallym-kordoc/core/templates")),
    ] },
  ];
  if (samples) roots.push({ base: resolve(samples), label: "samples", files: hangulFiles(resolve(samples)) });
  const rows: Row[] = [];
  const oldEngine = new EngineWorker(oldDir), newEngine = new EngineWorker(newDir);
  const total = roots.reduce((sum, root) => sum + root.files.length, 0);
  let index = 0;
  for (const root of roots) {
    for (const file of root.files) {
      index += 1;
      const name = `${root.label}:${relative(root.base, file)}`;
      if (only && !name.includes(only)) continue;
      const bytes = readFileSync(file);
      const row: Row = {
        name, size: statSync(file).size, sha256: createHash("sha256").update(bytes).digest("hex"),
        old: await oldEngine.check(file, timeout), new: await newEngine.check(file, timeout),
      };
      rows.push(row);
      const flag = row.old.opens !== row.new.opens || row.old.pages !== row.new.pages ? " *" : "";
      console.log(`[${index}/${total}] ${name} old=${row.old.opens ? row.old.pages : "no"} new=${row.new.opens ? row.new.pages : "no"}${flag}`);
    }
  }
  oldEngine.stop(); newEngine.stop();
  const sha = (dir: string) => createHash("sha256").update(readFileSync(join(dir, "rhwp_bg.wasm"))).digest("hex");
  const result = { schema: 1, old: { dir: relative(repoRoot, oldDir), wasmSha256: sha(oldDir) }, new: { dir: relative(repoRoot, newDir), wasmSha256: sha(newDir) }, startedAt: new Date().toISOString(), node: process.version, rows };
  const out = option(args, "--out");
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  const count = (pick: (row: Row) => boolean) => rows.filter(pick).length;
  const differing = rows.filter((row) => row.old.opens !== row.new.opens || row.old.pages !== row.new.pages
    || !!row.old.hwp?.reopens !== !!row.new.hwp?.reopens || !!row.old.hwpx?.reopens !== !!row.new.hwpx?.reopens);
  console.log(`\ndocuments ${rows.length}; opens old ${count((row) => row.old.opens)} / new ${count((row) => row.new.opens)}; ` +
    `HWP reopens old ${count((row) => !!row.old.hwp?.reopens)} / new ${count((row) => !!row.new.hwp?.reopens)}; ` +
    `HWPX reopens old ${count((row) => !!row.old.hwpx?.reopens)} / new ${count((row) => !!row.new.hwpx?.reopens)}; ` +
    `page count differs ${count((row) => row.old.opens && row.new.opens && row.old.pages !== row.new.pages)}`);
  console.log("\n| document | opens old/new | pages old → new | HWP reopen old / new | HWPX reopen old / new |\n|---|---|---|---|---|");
  for (const row of differing) {
    console.log(`| ${row.name} | ${row.old.opens ? "yes" : `no: ${row.old.error}`} / ${row.new.opens ? "yes" : `no: ${row.new.error}`} | ${row.old.pages ?? "-"} → ${row.new.pages ?? "-"} | ${reopenText(row.old.hwp)} / ${reopenText(row.new.hwp)} | ${reopenText(row.old.hwpx)} / ${reopenText(row.new.hwpx)} |`);
  }
  return 0;
}

if (isMainThread) process.exitCode = await main(process.argv.slice(2));
else await inWorker();
