import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import init, { HwpDocument } from "../../../vendor/ieumoffice/vendor/rhwp-core/rhwp.js";
import { hwpToText, hwpMemosOf } from "../../../third_party/ieumoffice/file-parse/hwp.ts";
import { hwpWasmPath } from "./hwp-resource.ts";
import { runHwpTool } from "./hwp-tool.ts";

const dirs: string[] = [];
beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(format: "hwp" | "hwpx") {
  const dir = mkdtempSync(join(tmpdir(), "wb-hwp-tool-")); dirs.push(dir);
  const doc = HwpDocument.createEmpty(); doc.createBlankDocument();
  ["등록제 시행 안내", "7월 1일부터 시행합니다.", "", "끝."].forEach((text, index) => {
    if (index) doc.splitParagraph(0, index - 1, doc.getParagraphLength(0, index - 1));
    if (text) doc.insertText(0, index, 0, text);
  });
  doc.pasteHtml(0, 2, 0, '<table><tr><td>구분</td><td>연락처</td></tr><tr><td>담당</td><td></td></tr></table>');
  doc.insertMemo(0, 0, 0, 3, JSON.stringify({ author: "검토", text: "제목 메모" }));
  const original = Buffer.from(format === "hwp" ? doc.exportHwp() : doc.exportHwpx()); doc.free();
  const path = join(dir, `한글 report.${format}`); writeFileSync(path, original);
  const ops = (list: unknown[]) => { const target = join(dir, "ops.json"); writeFileSync(target, JSON.stringify(list)); return target; };
  return { dir, path, original, ops };
}
const changes = [{ op: "replace_text", find: "7월 1일", replace: "8월 1일" }, { op: "insert_paragraphs", where: "after", anchor: "시행합니다", paragraphs: ["문의는 아래로."] }, { op: "fill_cells", table: 1, cells: [{ row: 2, col: 2, text: "담당자 확인" }] }];

describe("packaged native Hangul operations", () => {
  for (const format of ["hwp", "hwpx"] as const) it(`edits ${format} text, paragraphs and table cells while retaining memos and a backup`, async () => {
    const { path, original, ops } = fixture(format);
    const result = await runHwpTool(["apply", path, "--ops", ops(changes)]);
    expect(result).toMatchObject({ status: "ok", written: true, changed: true });
    const text = await hwpToText(readFileSync(path));
    for (const expected of ["8월 1일", "문의는 아래로.", "담당자 확인"]) expect(text).toContain(expected);
    expect(await hwpMemosOf(readFileSync(path))).toEqual(expect.arrayContaining([expect.objectContaining({ text: "제목 메모", author: "검토" })]));
    expect(readFileSync((result as { backup: string }).backup)).toEqual(original);
  });

  it("rejects an ambiguous atomic batch and a memo-destroying edit without changing the file", async () => {
    const { path, original, ops, dir } = fixture("hwpx");
    await expect(runHwpTool(["apply", path, "--ops", ops([changes[0]!, { op: "replace_text", find: "시행", replace: "실시" }])])).rejects.toThrow(/rejected/);
    expect(readFileSync(path)).toEqual(original);
    await expect(runHwpTool(["apply", path, "--ops", ops([{ op: "delete_paragraph", find: "등록제 시행 안내" }])])).rejects.toThrow(/memo/i);
    expect(readFileSync(path)).toEqual(original); expect(readdirSync(dir).filter((name) => name.endsWith(".bak"))).toEqual([]);
  });

  it("makes dry-run and reading operations non-mutating, with scoped output overwrite checks", async () => {
    const { path, original, ops, dir } = fixture("hwp");
    expect(await runHwpTool(["apply", path, "--ops", ops(changes), "--dry-run"])).toMatchObject({ written: false });
    expect(readFileSync(path)).toEqual(original);
    expect(await runHwpTool(["apply", path, "--ops", ops([{ op: "list_tables" }])])).toMatchObject({ written: false });
    expect(readFileSync(path)).toEqual(original);
    const out = join(dir, "copy.hwp"), opPath = ops(changes);
    expect(await runHwpTool(["apply", path, "--ops", opPath, "--out", out])).toMatchObject({ written: true, output: out, backup: null });
    expect(readFileSync(path)).toEqual(original); expect(existsSync(out)).toBe(true);
    const made = readFileSync(out);
    await expect(runHwpTool(["apply", path, "--ops", opPath, "--out", out])).rejects.toThrow(/already exists/);
    expect(readFileSync(out)).toEqual(made);
    expect(await runHwpTool(["read", path, "--full"])).toMatchObject({ status: "ok", text: expect.stringContaining("7월 1일") });
  });

  it("bundles the same 31-operation catalog without requiring Electron", async () => {
    // Build a real shipped Node entry, not a Vitest-only import graph.
    execFileSync(process.execPath, [resolve("scripts/build-host.mjs")]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("apps/host/dist/hwp-cli.mjs"), "catalog"], { encoding: "utf8" }));
    expect(result.catalog.ops).toHaveLength(31);
    expect(result.catalog.ops.map((op: { op: string }) => op.op)).toContain("fill_cells");
    const { path, ops } = fixture("hwpx");
    const applied = JSON.parse(execFileSync(process.execPath, [resolve("apps/host/dist/hwp-cli.mjs"), "apply", path, "--ops", ops(changes)], { encoding: "utf8" }));
    expect(applied).toMatchObject({ status: "ok", written: true });
    expect(await hwpToText(readFileSync(path))).toContain("담당자 확인");
  });
});
