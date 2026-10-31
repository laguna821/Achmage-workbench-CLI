import { readFileSync } from "node:fs";
import init, { HwpDocument } from "../../../vendor/ieumoffice/vendor/rhwp-core/rhwp.js";
import { openHwpBytes, hwpFormat } from "./hwp-codec.ts";
import { hwpWasmPath } from "./hwp-resource.ts";

let ready;
/** The same Ieum rhwp engine as the editor, for saved revisions and folder thumbnails. */
export async function hangulPages(path, format) {
  const { bytes } = await openHwpBytes(readFileSync(path), hwpFormat(format));
  await (ready ??= init({ module_or_path: readFileSync(hwpWasmPath()) }).catch(error => { ready = undefined; throw error; }));
  const doc = new HwpDocument(bytes);
  try {
    return Array.from({ length: doc.pageCount() }, (_, index) => {
      const page = index + 1, svg = doc.renderPageSvg(index);
      const viewBox = /viewBox="[\d. -]+ ([\d.]+) ([\d.]+)"/.exec(svg);
      return { page, width: Number(viewBox?.[1]) || 794, height: Number(viewBox?.[2]) || 1123, svg };
    });
  } finally { doc.free(); }
}
