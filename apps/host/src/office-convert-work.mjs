import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WASI } from "node:wasi";
import { Docx2HwpError, HwpEngine, docxToHwp } from "../../../vendor/ieumoffice/packages/docx2hwp/src/index.ts";
import { convertLegacyDocToDocx, isLegacyDocError } from "../../../vendor/ieumoffice/packages/doc2docx/src/index.ts";
import { LegacyPptError, convertPptToPptx } from "../../../vendor/ieumoffice/packages/ppt2pptx/src/index.ts";

// The conversions IeumOffice v0.13.0 brought, run unchanged (office-convert.ts says who calls them). This
// module is the heavy half: the Word → Hangul converter (docx2hwp on Workbench's ONE Hangul engine — the
// '@rhwp/core' it imports is third_party/hop/engine.ts in every build, scripts/hwp-engine-platform.mjs),
// the legacy importers (doc2docx, ppt2pptx) and the spreadsheet engine (the xlsx engine's WebAssembly
// build, the one the Excel editor runs, here through Node's WASI). The gateway runs it in a child process
// of its own (office-convert-job.ts); tests call it in-process. JavaScript (with office-convert-work.d.mts) like
// the other gateway modules that run IeumOffice code: its sources are not written for this repository's tsc settings.

/** The Hangul engine, started once per process from the bytes of the one engine's WASM. */
let hangul = null;
function hangulEngine(wasm) {
  if (!hangul || hangul.wasm !== wasm) hangul = { wasm, engine: HwpEngine.start(readFileSync(wasm)) };
  return hangul.engine;
}

/**
 * The xlsx engine's ConvertWorkbook (.ods / .xls → .xlsx) on two files of one folder, through WASI: the
 * folder is the engine's only view of the disk ("/work"; its sheet cache "/tmp" is the same folder).
 */
export async function convertWorkbookWasm(wasm, folder, input, output) {
  const wasi = new WASI({ version: "preview1", preopens: { "/work": folder, "/tmp": folder }, returnOnExit: true });
  const module = await WebAssembly.compile(readFileSync(wasm));
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  wasi.initialize(instance);
  const engine = instance.exports;
  const body = Buffer.from(JSON.stringify({ version: 1, requestId: "convert", command: "convert_workbook", path: `/work/${input}`, targetPath: `/work/${output}` }));
  const at = engine.wb_alloc(body.length);
  new Uint8Array(engine.memory.buffer, at, body.length).set(body);
  const reply = engine.wb_handle(at, body.length);
  const answer = JSON.parse(Buffer.from(new Uint8Array(engine.memory.buffer, reply, engine.wb_reply_len())).toString("utf8"));
  if (!answer.ok) throw Object.assign(new Error(answer.error?.message ?? "workbook conversion failed"), { code: answer.error?.code ?? "failed" });
  return { sheets: answer.result?.sheets ?? 0, cells: answer.result?.cells ?? 0, formulasDropped: answer.result?.formulasDropped ?? 0 };
}

/** One job: reads `job.input`, writes `job.output` (only on success), answers what the converter said. */
export async function runConvertJob(job) {
  try {
    const input = new Uint8Array(readFileSync(job.input));
    switch (job.kind) {
      case "docx-hwp": {
        const made = await docxToHwp(input, job.format, await hangulEngine(job.hwpWasm));
        writeFileSync(job.output, made.bytes, { mode: 0o600 });
        return { ok: true, losses: made.losses.map(({ feature, kind, count }) => ({ feature, kind, count })) };
      }
      case "doc": {
        const made = await convertLegacyDocToDocx(input);
        writeFileSync(job.output, made.docx, { mode: 0o600 });
        return { ok: true, warnings: made.warnings };
      }
      case "ppt": {
        const made = await convertPptToPptx(input);
        writeFileSync(job.output, made.bytes, { mode: 0o600 });
        return { ok: true, warnings: made.warnings, slides: made.slideCount };
      }
      case "ods":
      case "xls": {
        // The engine sees one private folder: the source copied in, the workbook written beside it.
        const folder = mkdtempSync(join(tmpdir(), "wb-xlsx-convert-"));
        try {
          writeFileSync(join(folder, `source.${job.kind}`), input);
          const made = await convertWorkbookWasm(job.xlsxWasm, folder, `source.${job.kind}`, "converted.xlsx");
          writeFileSync(job.output, readFileSync(join(folder, "converted.xlsx")), { mode: 0o600 });
          return { ok: true, formulasDropped: made.formulasDropped, sheets: made.sheets };
        } finally { rmSync(folder, { recursive: true, force: true }); }
      }
    }
  } catch (error) {
    const code = error instanceof Docx2HwpError ? error.code
      : isLegacyDocError(error) || error instanceof LegacyPptError ? (error.code === "encrypted" ? "encrypted" : "failed")
        : "failed";
    // The converter's own words stay in `detail` (English, for a report); the person reads the gateway's line.
    return { ok: false, code, detail: error instanceof Error ? error.message : String(error) };
  }
}
