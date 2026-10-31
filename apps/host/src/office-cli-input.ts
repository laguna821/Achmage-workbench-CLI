import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { csvToXlsxBufferForOpen, decodeCsvBuffer } from "../../../vendor/ieumoffice/packages/xlsx-gateway/src/gateway/csv-import.ts";
import { convertLegacyWorkbook } from "../../../vendor/ieumoffice/apps/sheets/src/main/legacy-import.ts";
import type { IeumOffice } from "./ieumoffice.ts";
import { HttpError } from "./errors.ts";

/** The native CLI fixes this source and owns dataDir for one invocation. The
 * original importers make a disposable XLSX; the original file keeps its type
 * and bytes. This is not a general API accepting paths from document pages. */
export class OfficeCliInput {
  private prepared?: Promise<{ path: string }>;
  private input: string;
  private dataDir: string;
  private ieum: IeumOffice;
  constructor(input: string, dataDir: string, ieum: IeumOffice) { this.input = input; this.dataDir = dataDir; this.ieum = ieum; }

  prepare = () => this.prepared ??= this.convert();

  private async convert(): Promise<{ path: string }> {
    const extension = extname(this.input).toLowerCase();
    if (extension !== ".csv" && extension !== ".xls") return { path: this.input };
    const dir = mkdtempSync(join(this.dataDir, "office-source-"));
    const target = join(dir, `${basename(this.input, extname(this.input))}.xlsx`);
    if (extension === ".csv") {
      if (statSync(this.input).size > 32 * 1024 * 1024) throw new HttpError(413, "csv_limit", "CSV 파일이 너무 큽니다.");
      // Match the Korean editor's open path, including legacy Excel encoding,
      // delimiter detection and leading-zero text preservation.
      const imported = await csvToXlsxBufferForOpen(decodeCsvBuffer(readFileSync(this.input), "euc-kr"), "Sheet1");
      writeFileSync(target, imported.buffer, { flag: "wx", mode: 0o600 });
    } else {
      const result = await convertLegacyWorkbook({ convertWorkbook: async ({ path, targetPath }) => {
        const result = await this.ieum.run(["convert", path, "--to", "xlsx", "--out", targetPath], [dirname(path), dir], 60_000);
        if (result.status !== "ok") throw new Error(result.message ?? "원본 Excel 변환이 완료되지 않았습니다.");
        return result;
      } }, this.input, target, "euc-kr");
      if (result === "html-no-table") throw new HttpError(422, "xls_no_table", "Excel 파일에 표가 없습니다.");
      if (result === "html-too-large") throw new HttpError(413, "xls_limit", "HTML 형식의 Excel 파일이 너무 큽니다.");
    }
    return { path: target };
  }
}
