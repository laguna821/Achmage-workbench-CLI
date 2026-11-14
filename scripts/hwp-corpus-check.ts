// Corpus check for the embedded Hangul engine (H5): proves a document opens, lays out and saves
// the same with one engine build as with another. Headless Node, no browser, no network.
//
//   node scripts/hwp-corpus-check.ts run [--engine DIR] [--out FILE] [--only ID,ID] [--chars N]
//   node scripts/hwp-corpus-check.ts compare BASELINE.json CANDIDATE.json
//   npm run check:hwp   (scripts/hwp-check.ts: run + compare with baseline.json + the studio census check;
//                        the engine unit runs it before and after, and it must exit 0)
//
// DIR holds an engine build (rhwp.js + rhwp_bg.wasm); default: the one the repository ships.
// Repository documents always run; public corpus documents need HWP_CORPUS_ROOT (a checkout of
// the rhwp repository, e.g. refs-ext/rhwp-0.9.0) and are skipped with a line when it is absent.
// Exit codes — run: 0 every document checked; 1 any document or save path failed (a census that
// cannot be computed is a failure here, though the product then saves with the text unchecked); 2 any skipped (and none failed).
// compare: 0 every baseline document the same; 1 any different or failed (a field the baseline has and
// the candidate lacks counts as different); 2 any skipped; 64 usage or results of different shapes.
// Every save path reopens the saved bytes and compares them with the live document: structure census,
// characters per container kind, the whole-text hash (with the order-free digest and per-kind hashes, so
// "글자 순서만 바뀜" is told from "글자 내용 바뀜 (표 칸)"), what the engine cannot read, and every page's line breaks.
// "글자 순서만 바뀜 — 바뀐 이유를 문서별로 확인" is a difference (exit 1), never a pass: the order-free digest is
// also the same when text moved between two cells or two notes (N3-2), so explain each one with page pictures.
// The census leaves out the characters a writer does not keep (HWP_UNKEPT, T1); result schema 5.
// Nothing committed holds document text: counts, positions, hashes (page 1's salted with the text hash).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkDocument, type Engine } from "./hwp-corpus/check.ts";
import { compareResults, describeEngines, formatTable, locateDocuments, RESULT_SCHEMA, runExitCode, SAVE_PATHS, type CorpusResult, type DocResult, type Manifest } from "./hwp-corpus/compare.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "scripts/hwp-corpus/manifest.json");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const elapsed = (start: number) => Math.round(performance.now() - start);

async function loadEngine(dir: string): Promise<{ engine: Engine; wasmSha256: string; version: string }> {
  const wasm = readFileSync(join(dir, "rhwp_bg.wasm"));
  const mod = await import(pathToFileURL(join(dir, "rhwp.js")).href);
  await mod.default({ module_or_path: wasm });
  const pkg = existsSync(join(dir, "package.json")) ? JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) : {};
  return { engine: mod as Engine, wasmSha256: sha256(wasm), version: String(pkg.version ?? "unknown") };
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function run(args: string[]) {
  const engineDir = resolve(option(args, "--engine") ?? join(repoRoot, "third_party/hop/rhwp-core"));
  const out = option(args, "--out"), only = option(args, "--only")?.split(","), chars = Number(option(args, "--chars") ?? 40);
  const manifestText = readFileSync(manifestPath, "utf8"), manifest = JSON.parse(manifestText) as Manifest;
  const corpusRoot = process.env.HWP_CORPUS_ROOT && existsSync(process.env.HWP_CORPUS_ROOT) ? resolve(process.env.HWP_CORPUS_ROOT) : undefined;
  const corpusMissing = `HWP_CORPUS_ROOT is ${process.env.HWP_CORPUS_ROOT ? "not a folder" : "not set"}`;
  const located = locateDocuments(manifest, { repoRoot, corpusRoot, corpusMissing }).filter((item) => !only || only.includes(item.entry.id));
  if (!corpusRoot) console.log(`skip: ${corpusMissing} — ${located.filter((item) => item.skip).length} public corpus documents are skipped`);
  const { engine, wasmSha256, version } = await loadEngine(engineDir);
  const codec = JSON.parse(readFileSync(join(repoRoot, "third_party/hop/rhwp-core/package.json"), "utf8")) as { rhwp: { wasmSha256: string } };
  if (codec.rhwp.wasmSha256 !== wasmSha256) console.log("note: the engine under test is not the repository's; the save step's own checks (hwp-codec.ts) still parse with the repository's engine");
  const started = performance.now(), docs: DocResult[] = [];
  for (const { entry, file, skip } of located) {
    const base: DocResult = { id: entry.id, path: entry.path, format: entry.format, status: "skipped" };
    let result: DocResult;
    if (skip || !file) result = { ...base, reason: skip ?? "없음" };
    else if (!existsSync(file)) result = { ...base, reason: `파일 없음: ${entry.root}/${entry.path}` };
    else {
      const bytes = readFileSync(file);
      result = bytes.length !== entry.size || sha256(bytes) !== entry.sha256
        ? { ...base, status: "failed", reason: "manifest의 sha256과 다른 파일" }
        : await checkDocument(engine, file, base, chars);
    }
    docs.push(result);
    const saves = result.save ? ` save=${Object.values(result.save).map((item) => item.status).join("/")}${Object.values(result.save).some((item) => item.differences.length) ? " (round-trip differences)" : ""}` : "";
    console.log(`${result.status.padEnd(7)} ${entry.id}${result.pages !== undefined ? ` pages=${result.pages}` : ""}${result.ms !== undefined ? ` ${result.ms}ms` : ""}${saves}${result.reason ? ` — ${result.reason}` : ""}`);
  }
  const result: CorpusResult = {
    schema: RESULT_SCHEMA, engine: { dir: engineDir.startsWith(repoRoot) ? engineDir.slice(repoRoot.length + 1) : engineDir, wasmSha256, version },
    codecWasmSha256: codec.rhwp.wasmSha256, startedAt: new Date().toISOString(), node: process.version, ms: elapsed(started),
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    corpus: { manifestSha256: sha256(Buffer.from(manifestText)), corpusRoot: !!corpusRoot, documents: docs.length, skipped: docs.filter((doc) => doc.status === "skipped").length },
    docs,
  };
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  const count = (status: DocResult["status"]) => docs.filter((doc) => doc.status === status).length;
  const pages = docs.reduce((sum, doc) => sum + (doc.pages ?? 0), 0);
  console.log(`documents ${docs.length}: ok ${count("ok")}, failed ${count("failed")}, skipped ${count("skipped")}; pages ${pages}; ${(result.ms / 1000).toFixed(1)}s; peak RSS ${result.peakRssMb} MB`);
  for (const [path, name] of Object.entries(SAVE_PATHS)) {
    const saves = docs.flatMap((doc) => (doc.save?.[path] ? [doc.save[path]] : []));
    const has = (pattern: RegExp) => saves.filter((item) => item.differences.some((line) => pattern.test(line))).length;
    console.log(`  ${path} (${name}): ok ${saves.filter((item) => item.status === "ok").length}, refused ${saves.filter((item) => item.status === "refused").length}, failed ${saves.filter((item) => item.status === "failed").length}, reopened with differences ${saves.filter((item) => item.differences.length).length} (text content ${has(/^글자 내용 바뀜/)}, text order only (to explain) ${has(/^글자 순서만 바뀜/)}, characters ${has(/ 글자 \d+→\d+$/)}, unread ${has(/^읽지 못하는 개체/)}, line breaks ${has(/줄 나눔 바뀜$/)})`);
  }
  return runExitCode(docs);
}

async function main(args: string[]) {
  if (args[0] === "run") return run(args.slice(1));
  if (args[0] === "compare" && args[1] && args[2]) {
    const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as CorpusResult;
    const base = read(args[1]), candidate = read(args[2]);
    const { rows, exitCode } = compareResults(base, candidate);
    console.log([...describeEngines(base, candidate), formatTable(rows)].join("\n"));
    return exitCode;
  }
  console.error("usage: node scripts/hwp-corpus-check.ts run [--engine DIR] [--out FILE] [--only ID,ID] [--chars N]\n       node scripts/hwp-corpus-check.ts compare BASELINE.json CANDIDATE.json");
  return 64;
}

process.exitCode = await main(process.argv.slice(2));
