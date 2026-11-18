import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/engine.ts";
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
  // a CLI process that compiles the engine's WASM first (rhwp 0.9.0: 18 MB, 2 s alone, more than 5 s beside a full run)
  }, 20_000);

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

  // H14: the document AI's new Hangul tools reach the document through the gateway's operation list (v0.13.0's hwp-edit.ts on the one engine)
  it("sets page numbers, two columns, a title box, a page border, a footer and an equation through the gateway", async () => {
    const { path, ops } = fixture("hwpx");
    const result = await runHwpTool(["apply", path, "--ops", ops([
      { op: "set_page_number", position: "bottom_center" },
      { op: "set_columns", count: 2, line: "solid" },
      { op: "insert_title_box", find: "끝.", look: "box" },
      { op: "set_page_border", line: "solid" },
      { op: "set_header_footer", kind: "footer", text: "교무처" },
      { op: "insert_paragraphs", where: "after", anchor: "시행합니다", paragraphs: ["수식 자리"] },
      { op: "insert_equations", equations: [{ find: "수식 자리", script: "x = {-b +- sqrt {b^2 - 4ac}} over {2a}" }] },
    ])]) as { status: string; written: boolean; results: { op: string; changed: boolean }[]; failures: unknown[] };
    expect(result).toMatchObject({ status: "ok", written: true, failures: [] });
    expect(result.results.map((item) => [item.op, item.changed])).toEqual([["set_page_number", true], ["set_columns", true], ["insert_title_box", true], ["set_page_border", true], ["set_header_footer", true], ["insert_paragraphs", true], ["insert_equations", true]]);
    // read back with the same engine: the section's columns, the page number, the footer, the equation
    const doc = new HwpDocument(new Uint8Array(readFileSync(path)));
    try {
      expect(JSON.parse(doc.getColumnDef(0)).count ?? JSON.parse(doc.getColumnDef(0)).columnCount).toBe(2);
      expect(doc.getHeaderFooter(0, false, 0)).toContain("교무처");
      const layout = await runHwpTool(["apply", path, "--dry-run", "--ops", ops([{ op: "check_layout" }, { op: "list_equations" }, { op: "read_page_setup" }])]) as { results: { op: string; output: string }[] };
      expect(layout.results.find((item) => item.op === "list_equations")?.output).toMatch(/sqrt/);
    } finally { doc.free(); }
  }, 60_000);

  it("refuses analyze_picture: nothing can look at a picture here", async () => {
    const { path, original, ops } = fixture("hwpx");
    await expect(runHwpTool(["apply", path, "--ops", ops([{ op: "analyze_picture", picture: 1, question: "what" }])])).rejects.toThrow(/analyze_picture is not available here/);
    expect(readFileSync(path)).toEqual(original);
  });

  it("bundles the 53-operation catalog of IeumOffice v0.13.0 without requiring Electron", async () => {
    // CI already built this exact source. Exercise that shipped entry without building it twice.
    // A standalone invocation still constructs the real bundle instead of a Vitest-only graph.
    if (process.env.WORKBENCH_HOST_BUNDLE_READY !== "1") execFileSync(process.execPath, [resolve("scripts/build-host.mjs")]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("apps/host/dist/hwp-cli.mjs"), "catalog"], { encoding: "utf8" }));
    // v0.13.0's headless list (54) without analyze_picture (no picture reader; not offered, unit hwp13)
    expect(result.catalog.ops).toHaveLength(53);
    const names = result.catalog.ops.map((op: { op: string }) => op.op);
    expect(names).toContain("fill_cells");
    // the new Hangul tools (H14): page setup, 다단, page numbers, equations, title box, page border, header / footer, layout check
    expect(names).toEqual(expect.arrayContaining(["set_page_setup", "set_columns", "set_page_number", "insert_equations", "edit_equation", "insert_title_box", "set_page_border", "set_header_footer", "check_layout", "read_page_layout"]));
    for (const name of ["analyze_picture", "web_search", "import_attachment"]) expect(names).not.toContain(name);
    expect(result.catalog.groups.flatMap((group: { ops: string[] }) => group.ops)).not.toContain("analyze_picture");
    expect(result.catalog.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    const { path, ops } = fixture("hwpx");
    const applied = JSON.parse(execFileSync(process.execPath, [resolve("apps/host/dist/hwp-cli.mjs"), "apply", path, "--ops", ops(changes)], { encoding: "utf8" }));
    expect(applied).toMatchObject({ status: "ok", written: true });
    expect(await hwpToText(readFileSync(path))).toContain("담당자 확인");
  }, 60_000);
});
