import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, expect, it } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";
import { prepareHwpSave } from "./hwp-codec.ts";
import { hwpWasmPath } from "./hwp-resource.ts";

// The in-editor view may measure with the faces it draws (canvas metrics); that part is checked on
// screen and, with Hancom's own fonts, only on a PC that has them (see the H2 report).
// A real form in 함초롬바탕, 함초롬돋움 and HY견고딕 (what a Hancom-made document carries).
const FIXTURE = readFileSync("apps/host/src/channels/fixtures/강의계획서.hwpx");
const faces = (bytes: Uint8Array) => [...new Set([...strFromU8(unzipSync(bytes)["Contents/header.xml"]!).matchAll(/face="([^"]+)"/g)].map(match => match[1]))].sort();
/** Pages and, per page, the lines (distinct baselines) and their first characters. */
function layout(doc: HwpDocument) {
  return Array.from({ length: doc.pageCount() }, (_, page) => {
    const runs = (JSON.parse(doc.getPageTextLayout(page)) as { runs: { text: string; y: number }[] }).runs;
    const lines = new Map<number, string>();
    for (const run of runs) { const y = Math.round(run.y * 10) / 10; lines.set(y, (lines.get(y) ?? "") + run.text); }
    return [...lines.values()].map(text => text.slice(0, 6));
  });
}

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });

it("keeps the document's own font names through an edit and a save: only the display substitutes", async () => {
  expect(faces(FIXTURE)).toEqual(["HY견고딕", "함초롬돋움", "함초롬바탕"]);
  // The editor substitutes only in what it draws (hwp-fonts.test.ts). An edit and the gateway's save path keep every name of the original, and add no substitute name.
  const doc = new HwpDocument(FIXTURE);
  try {
    doc.insertText(0, 1, 0, "고침 ");
    const saved = await prepareHwpSave(FIXTURE, doc.exportHwpx(), "hwpx", {});
    expect(faces(saved)).toEqual(["HY견고딕", "함초롬돋움", "함초롬바탕"]);
    expect(faces(saved).some(name => /Noto|Pretendard/.test(name))).toBe(false);
    const reopened = new HwpDocument(saved);
    try { expect(reopened.getTextFileUnicode()).toContain("고침 "); } finally { reopened.free(); }
  } finally { doc.free(); }
});

it("lays out the fixed document to fixed pages and lines whatever fonts the PC has (saved pagination)", () => {
  // The saved pagination (export, print, the gateway's page pictures, the messenger's first page)
  // uses the engine's stored metrics: no installed-font catalogue reaches it, so the bundled
  // fallback cannot move a line. Baseline of the fixed document:
  const expected = [["2026학년", "1. 강의 ", "본 강의는 ", "2. 주차별", "주차주제과제", "1주연구 질", "2주면담 설", "3주참여 관", "", "3. 평가", "- 출석 1", "- 과제 4", "- 기말 보"]];
  const doc = new HwpDocument(FIXTURE);
  try {
    expect(doc.canvasMetricsActive()).toBe(false);
    expect(layout(doc)).toEqual(expected);
  } finally { doc.free(); }
});
