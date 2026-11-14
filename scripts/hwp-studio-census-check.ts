// Proves the studio's structure report (H9b) and the gateway's census agree, document by document.
// The built studio (apps/office/public/studio: its own engine build, its own loading path) runs in
// headless Chromium; each corpus document is loaded the way the app loads it (the gateway's
// openHwpBytes, then the studio's loadFile), counted in the page by apps/office/src/hwp-structure-report.ts,
// and counted in Node by the gateway's hwpStructureOf. Then the studio's own exports (same format
// and the other format) go through the gateway's save step WITH the studio's report: none may be refused.
//
//   HWP_CORPUS_ROOT=<rhwp checkout> node scripts/hwp-studio-census-check.ts [--only ID,ID] [--out FILE]
//
// Compared: the structure census, the characters of every container kind, what the census cannot
// read (unread counts) and the whole-text hash.
// Part of `npm run check:hwp` (scripts/hwp-check.ts), which the engine unit runs before and after.
//
// Exit codes: 0 every document agrees and every save is accepted; 1 any disagreement, refusal or
// failure; 2 any document skipped (no corpus root). Run through ux/run-isolated.sh.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import init, { HwpDocument } from "../third_party/hop/rhwp-core/rhwp.js";
import { openHwpBytes, prepareHwpSave } from "../apps/host/src/hwp-codec.ts";
import { hwpStructureOf, type HwpStructure } from "../apps/host/src/hwp-structure.ts";
import { engineJson, textCountDifferences } from "../packages/contracts/src/hwp-text.ts";
import { locateDocuments, structureDifferences, unreadDifferences, type Manifest } from "./hwp-corpus/compare.ts";
import { openStudio, repoRoot, studioDir, type Studio } from "./hwp-studio-harness.ts";

const option = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const only = option("--only")?.split(","), out = option("--out");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
type Row = { id: string; status: "agree" | "differ" | "refused" | "failed" | "skipped"; details: string[]; studio?: HwpStructure; gateway?: HwpStructure };
/** Every way the studio's count and the gateway's differ: structure, characters per kind, text hash. */
/** A text census that could not be computed (on either side) is a disagreement here, though the product then saves (S1). */
const disagreements = (gateway: HwpStructure, studio: HwpStructure) => [
  ...structureDifferences(gateway, studio),
  ...(gateway.chars && studio.chars ? [...textCountDifferences(gateway.chars, studio.chars), ...unreadDifferences(gateway.unread, studio.unread)] : []),
  ...[["게이트웨이", gateway], ["스튜디오", studio] as const].flatMap(([side, item]) => (item as HwpStructure).textUnchecked ? [`${side} ${(item as HwpStructure).textUnchecked}`] : []),
  ...(gateway.textSha256 !== studio.textSha256 ? ["글자 내용 바뀜"] : []),
];

await init({ module_or_path: readFileSync(join(repoRoot, "third_party/hop/rhwp-core/rhwp_bg.wasm")) });
const build_ = JSON.parse(readFileSync(join(studioDir, "build.json"), "utf8")) as { wasmSha256: string; engineVersion: string };
const codec = JSON.parse(readFileSync(join(repoRoot, "third_party/hop/rhwp-core/package.json"), "utf8")) as { version: string; rhwp: { wasmSha256: string } };
console.log(`studio engine ${build_.engineVersion} wasm ${build_.wasmSha256}`);
console.log(`gateway engine ${codec.version} wasm ${codec.rhwp.wasmSha256}${build_.wasmSha256 === codec.rhwp.wasmSha256 ? "" : "  ← 다른 빌드: 보고와 검사가 다른 엔진으로 셈"}`);

const manifest = JSON.parse(readFileSync(join(repoRoot, "scripts/hwp-corpus/manifest.json"), "utf8")) as Manifest;
const corpusRoot = process.env.HWP_CORPUS_ROOT && existsSync(process.env.HWP_CORPUS_ROOT) ? resolve(process.env.HWP_CORPUS_ROOT) : undefined;
const located = locateDocuments(manifest, { repoRoot, corpusRoot }).filter((item) => !only || only.includes(item.entry.id));
const rows: Row[] = [];
let studioPage: Studio | undefined;
const started = performance.now();
try {
  studioPage = await openStudio();
  for (const { entry, file, skip } of located) {
    if (skip || !file || !existsSync(file)) { rows.push({ id: entry.id, status: "skipped", details: [skip ?? "파일 없음"] }); continue; }
    const original = readFileSync(file);
    if (sha256(original) !== entry.sha256) { rows.push({ id: entry.id, status: "failed", details: ["manifest의 sha256과 다른 파일"] }); continue; }
    try {
      // As the app: the gateway opens the revision (tracked-change repair included), the studio loads those bytes.
      const opened = (await openHwpBytes(original, entry.format)).bytes;
      const other = entry.format === "hwp" ? "hwpx" : "hwp";
      const { structure: studio, exports } = await studioPage.load(opened, entry.path.split("/").pop()!, [entry.format, other]);
      const doc = new HwpDocument(new Uint8Array(opened));
      let gateway: HwpStructure, memos: unknown;
      try { gateway = hwpStructureOf(doc); memos = engineJson(doc.getMemoList()); } finally { doc.free(); }
      if (!studio) { rows.push({ id: entry.id, status: "failed", details: ["스튜디오가 문서 구조를 내주지 않음"] }); continue; }
      const details = disagreements(gateway, studio);
      const saves: string[] = [];
      for (const format of [entry.format, other] as const) {
        try {
          const check: { text?: "checked" | "unchecked" } = {};
          await prepareHwpSave(original, exports.get(format)!, format, { memos: memos as never, structure: studio }, "save", entry.format, { check });
          if (check.text !== "checked") saves.push(`${format === entry.format ? "같은 형식" : "다른 형식"} 저장: 글자 검사 못함`);
        } catch (error) { saves.push(`${format === entry.format ? "같은 형식" : "다른 형식"} 저장 거절: ${message(error)}`); }
      }
      rows.push({ id: entry.id, status: details.length ? "differ" : saves.length ? "refused" : "agree", details: [...details, ...saves], ...(details.length ? { studio, gateway } : {}) });
    } catch (error) {
      rows.push({ id: entry.id, status: "failed", details: [message(error)] });
    }
    const row = rows.at(-1)!;
    console.log(`${row.status.padEnd(7)} ${entry.id}${row.details.length ? ` — ${row.details.join("; ")}` : ""}`);
  }
} finally {
  await studioPage?.close();
}
const count = (status: Row["status"]) => rows.filter((row) => row.status === status).length;
console.log(`documents ${rows.length}: agree ${count("agree")}, differ ${count("differ")}, refused ${count("refused")}, failed ${count("failed")}, skipped ${count("skipped")}; ${((performance.now() - started) / 1000).toFixed(1)}s`);
if (out) writeFileSync(out, `${JSON.stringify({ studio: build_, gateway: { version: codec.version, wasmSha256: codec.rhwp.wasmSha256 }, rows }, null, 1)}\n`);
process.exitCode = count("differ") || count("refused") || count("failed") ? 1 : count("skipped") ? 2 : 0;
