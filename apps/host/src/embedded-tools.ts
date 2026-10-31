import type { ToolStatus } from "@workbench/contracts";
import { hwpWasmPath } from "./hwp-resource.ts";
import { hbSubsetWasmPath, pdfiumWasmPath } from "./pdf-resource.mjs";
import { shipped } from "./resources.ts";

/** Report the same checked resources the embedded editors actually use. */
export function embeddedDocumentTools(): { hwp: ToolStatus; pdf: ToolStatus } {
  const check = (resource: () => string, bundled: boolean): ToolStatus => {
    try { return { available: true, bundled, version: null, path: resource(), busy: false, message: null }; }
    catch (error) { return { available: false, bundled, version: null, path: null, busy: false, message: String(error) }; }
  };
  return {
    hwp: check(hwpWasmPath, Boolean(shipped("web/office/studio/build.json"))),
    pdf: check(() => { hbSubsetWasmPath(); return pdfiumWasmPath(); }, Boolean(shipped("web/office/pdf-runtime/pdfium.wasm"))),
  };
}
