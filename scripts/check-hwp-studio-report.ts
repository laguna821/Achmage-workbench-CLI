// The office build's check that the built studio still lets the save report reach its live
// document (rhwpStudio.automation.options.dispatcher.services.wasm.doc, read by
// apps/office/src/hwp-structure-report.ts). Checked the way the report reaches it: the built
// studio runs in headless Chromium, loads a small document made here by the engine, and the
// office page's own report builder must count it exactly as the gateway does. A rebuilt studio
// that renamed any link would otherwise save without a report and nobody would notice.
//
//   node scripts/check-hwp-studio-report.ts [--studio DIR]     (run by `npm run build -w apps/office`
//   after build-hwp-studio.mjs; DIR defaults to apps/office/public/studio)
//
// Exit 0: the report works; 1: it does not (or the studio could not be run — nothing proven).
// Needs playwright-core's headless Chromium BEFORE the build: `node node_modules/playwright-core/cli.js
// install chromium --only-shell` (CI: add --with-deps; .github/workflows/release.yml installs it first).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import init, { HwpDocument } from "../third_party/hop/rhwp-core/rhwp.js";
import { hwpStructureOf } from "../apps/host/src/hwp-structure.ts";
import { textCountDifferences } from "../packages/contracts/src/hwp-text.ts";
import { structureDifferences, unreadDifferences } from "./hwp-corpus/compare.ts";
import { noReportLine, openStudio, repoRoot, studioDir } from "./hwp-studio-harness.ts";

const index = process.argv.indexOf("--studio");
const dir = index >= 0 ? resolve(process.argv[index + 1]!) : studioDir;
const fail = (line: string) => { console.error(`check-hwp-studio-report: ${line}`); process.exitCode = 1; };

await init({ module_or_path: readFileSync(join(repoRoot, "third_party/hop/rhwp-core/rhwp_bg.wasm")) });
const doc = HwpDocument.createEmpty();
let bytes: Uint8Array, expected: ReturnType<typeof hwpStructureOf>;
try {
  doc.createBlankDocument(); doc.insertText(0, 0, 0, "보고 검사"); doc.createTable(0, 0, 5, 1, 2); doc.insertTextInCell(0, 1, 0, 0, 0, 0, "칸");
  bytes = doc.exportHwpx(); expected = hwpStructureOf(doc);
} finally { doc.free(); }

let studio: Awaited<ReturnType<typeof openStudio>> | undefined;
try {
  studio = await openStudio(dir);
  const { structure, why } = await studio.load(bytes, "report-check.hwpx", []);
  if (!structure) fail(noReportLine(dir, why ?? "the studio's document is not reachable"));
  else {
    const differences = [...structureDifferences(expected, structure),
      ...(expected.chars && structure.chars ? [...textCountDifferences(expected.chars, structure.chars), ...unreadDifferences(expected.unread, structure.unread)] : [`글자 검사 못함 (${structure.textUnchecked ?? expected.textUnchecked})`]),
      ...(expected.textSha256 !== structure.textSha256 ? ["글자 내용 바뀜"] : [])];
    if (differences.length) fail(`the studio's report and the gateway's census disagree on a test document: ${differences.join("; ")}`);
    else console.log(`check-hwp-studio-report: the studio's live document is reachable and counted like the gateway's (${dir})`);
  }
} catch (error) {
  fail(`could not run the built studio to check its report (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); nothing is proven. This check needs playwright-core's headless Chromium; install it once with: node node_modules/playwright-core/cli.js install chromium --only-shell`);
} finally { await studio?.close(); }
