import { readFileSync } from "node:fs";
import { buildBlankDocx } from "../../../vendor/ieumoffice/packages/docx-engine/src/blank.ts";
import { createBlankPptx } from "../../../vendor/ieumoffice/packages/pptx-engine/src/blank.ts";
import { blankXlsxBuffer } from "../../../vendor/ieumoffice/packages/xlsx-gateway/src/gateway/csv-import.ts";
import { createXmindDocument } from "../../../vendor/ieumoffice/packages/xmind-engine/src/create.ts";
import { blankPdfBuffer } from "../../../vendor/ieumoffice/apps/pdf/src/main/blank-pdf.ts";
import initHwp, { HwpDocument } from "../../../vendor/ieumoffice/vendor/rhwp-core/rhwp.js";
import { hwpWasmPath } from "./hwp-resource.ts";

let hwpReady;
/** Use the original blank builders and the same HWP WASM already shipped for editing. */
export async function blankOfficeBytes(format) {
  switch (format) {
    case "docx": return Buffer.from(await buildBlankDocx());
    case "pptx": return Buffer.from(await createBlankPptx());
    case "xlsx": return blankXlsxBuffer();
    case "pdf": return blankPdfBuffer();
    case "xmind": return Buffer.from(await (await createXmindDocument({ sheetTitle: "시트 1", rootTitle: "중심 주제" })).save());
    case "markdown": case "html": return Buffer.alloc(0);
    case "hwpx": {
      await (hwpReady ??= initHwp({ module_or_path: readFileSync(hwpWasmPath()) }).catch((error) => { hwpReady = undefined; throw error; }));
      const doc = HwpDocument.createEmpty();
      try { doc.createBlankDocument(); return Buffer.from(doc.exportHwpx()); } finally { doc.free(); }
    }
    default: throw new Error("지원하지 않는 새 문서 형식입니다.");
  }
}
