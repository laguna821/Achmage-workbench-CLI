// The office build's check that the built studio still lets the save report reach its live
// document (rhwpStudio.automation.options.dispatcher.services.wasm.doc, read by
// apps/office/src/hwp-structure-report.ts). Checked the way the report reaches it: the built
// studio runs in headless Chromium, loads a small document made here by the engine, and the
// office page's own report builder must count it exactly as the gateway does. A rebuilt studio
// that renamed any link would otherwise save without a report and nobody would notice.
// Also (H4b, rhwp 0.9.0 reads and writes memo dates, and a memo's date is part of what makes it the
// same memo across a save): the memos the studio lists — through the app's agent plugin, as a save
// lists them — carry the dates the gateway reads back from the studio's own HWP and HWPX exports,
// and the gateway's save step counts no memo lost.
//
//   node scripts/check-hwp-studio-report.ts [--studio DIR]     (run by `npm run build -w apps/office`
//   after build-hwp-studio.mjs; DIR defaults to apps/office/public/studio)
//
// Exit 0: the report works; 1: it does not (or the studio could not be run — nothing proven).
// Needs playwright-core's headless Chromium BEFORE the build: `node node_modules/playwright-core/cli.js
// install chromium --only-shell` (CI: add --with-deps; .github/workflows/release.yml installs it first).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import init, { HwpDocument, ENGINE_DIR, enginePackage } from "../third_party/hop/engine.ts";
import { hwpStructureOf } from "../apps/host/src/hwp-structure.ts";
import { prepareHwpSave } from "../apps/host/src/hwp-codec.ts";
import { hwpMemosOf } from "../third_party/ieumoffice/file-parse/hwp.ts";
import { textCountDifferences } from "../packages/contracts/src/hwp-text.ts";
import { structureDifferences, unreadDifferences } from "./hwp-corpus/compare.ts";
import { noReportLine, openStudio, repoRoot, studioDir } from "./hwp-studio-harness.ts";

const index = process.argv.indexOf("--studio");
const dir = index >= 0 ? resolve(process.argv[index + 1]!) : studioDir;
const fail = (line: string) => { console.error(`check-hwp-studio-report: ${line}`); process.exitCode = 1; };

await init({ module_or_path: readFileSync(join(repoRoot, `${ENGINE_DIR}/rhwp_bg.wasm`)) });
const doc = HwpDocument.createEmpty();
let bytes: Uint8Array, expected: ReturnType<typeof hwpStructureOf>;
try {
  doc.createBlankDocument(); doc.insertText(0, 0, 0, "보고 검사"); doc.createTable(0, 0, 5, 1, 2); doc.insertTextInCell(0, 1, 0, 0, 0, 0, "칸");
  doc.insertMemo(0, 0, 0, 2, JSON.stringify({ author: "검사", text: "메모 검사" }));
  bytes = doc.exportHwpx(); expected = hwpStructureOf(doc);
} finally { doc.free(); }

let studio: Awaited<ReturnType<typeof openStudio>> | undefined;
try {
  studio = await openStudio(dir);
  const { structure, why, exports } = await studio.load(bytes, "report-check.hwpx", ["hwp", "hwpx"]);
  if (!structure) fail(noReportLine(dir, why ?? "the studio's document is not reachable"));
  else {
    const differences = [...structureDifferences(expected, structure),
      ...(expected.chars && structure.chars ? [...textCountDifferences(expected.chars, structure.chars), ...unreadDifferences(expected.unread, structure.unread)] : [`글자 검사 못함 (${structure.textUnchecked ?? expected.textUnchecked})`]),
      ...(expected.textSha256 !== structure.textSha256 ? ["글자 내용 바뀜"] : [])];
    if (differences.length) fail(`the studio's report and the gateway's census disagree on a test document: ${differences.join("; ")}`);
    else console.log(`check-hwp-studio-report: the studio's live document is reachable and counted like the gateway's (${dir})`);
  }
  await studio.request("plugin.load", { id: "ieum-agent" }).catch(() => undefined);
  const listed = (await studio.request("plugin.invoke", { id: "ieum-agent", method: "listMemos", args: [] }) as { memos: { author: string; date: string | null; text: string; place: string }[] }).memos;
  const dates = JSON.stringify(listed.map((memo) => memo.date));
  if (listed.length !== 1 || typeof listed[0]!.date !== "string") fail(`the studio lists ${listed.length} memo(s), dates ${dates}; expected one memo with a date`);
  for (const [format, saved] of exports) {
    const read = JSON.stringify((await hwpMemosOf(saved)).map((memo) => memo.date));
    if (read !== dates) { fail(`a memo's date changes through the studio's ${format.toUpperCase()} export: listed ${dates}, read back ${read}`); continue; }
    const snapshot = listed.map((memo) => ({ ...memo, sectionIndex: null, paraIndex: null, startCharIdx: null, endCharIdx: null, path: null }));
    try { await prepareHwpSave(bytes, saved, format as "hwp" | "hwpx", { memos: snapshot }, "save", "hwpx"); }
    catch (error) { fail(`the gateway refuses the studio's ${format.toUpperCase()} export with the studio's memo list (${error instanceof Error ? error.message : String(error)})`); }
  }
  if (!process.exitCode) console.log(`check-hwp-studio-report: the studio's memo dates survive its HWP and HWPX exports and the gateway's save step (${listed.length} memo)`);
  // The engine imports no PDF (built without it): the studio's options offer no PDF import setting.
  if (enginePackage.rhwp.tag === "v0.9.0") {
    await studio.request("automation.execute", { id: "tool:options", allowDialog: true });
    if (!await studio.count("#opt-pdf-print-guidance")) fail("the studio's options dialog did not open (no PDF save section) — the PDF import check did not run");
    else if (await studio.count("[name='opt-pdf-import-layout']")) fail("the studio's options dialog offers the PDF import setting though the engine imports no PDF (scripts/hwp-studio-090.mjs workbench-pdf-import-setting)");
    else console.log("check-hwp-studio-report: the studio offers no PDF import (options dialog without the PDF import setting)");
  }
} catch (error) {
  fail(`could not run the built studio to check its report (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); nothing is proven. This check needs playwright-core's headless Chromium; install it once with: node node_modules/playwright-core/cli.js install chromium --only-shell`);
} finally { await studio?.close(); }
