import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { beforeAll, expect, it } from "vitest";
import initOld, { HwpDocument as OldDocument } from "../../../vendor/ieumoffice/vendor/rhwp-core/rhwp.js";
import init, { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";
import { hwpWasmPath } from "./hwp-resource.ts";

beforeAll(async () => {
  await initOld({ module_or_path: readFileSync(resolve("vendor/ieumoffice/vendor/rhwp-core/rhwp_bg.wasm")) });
  await init({ module_or_path: readFileSync(hwpWasmPath()) });
});

it("uses HOP physical margins for generated HWPX without version.xml and preserves them on save", () => {
  const blank = OldDocument.createEmpty(); blank.createBlankDocument(); blank.insertText(0, 0, 0, "한글 생성 문서 HOP MARGIN");
  const files = unzipSync(blank.exportHwpx()); blank.free();
  delete files["version.xml"]; delete files["META-INF/rhwp-hwp5-origin"];
  files["Contents/header.xml"] = strToU8(strFromU8(files["Contents/header.xml"]!)
    .replace(/<hp:switch>.*?<hp:default>(.*?)<\/hp:default><\/hp:switch>/gs, "$1")
    .replace(/<hc:left value="[^"]*"/g, '<hc:left value="2000"'));
  const bytes = zipSync(files), old = new OldDocument(bytes), doc = new HwpDocument(bytes);
  try {
    expect(JSON.parse(old.getParaPropertiesAt(0, 0)).marginLeft).toBeCloseTo(1000 / 75, 1);
    expect(JSON.parse(doc.getParaPropertiesAt(0, 0)).marginLeft).toBeCloseTo(2000 / 75, 1);
    const saved = new HwpDocument(doc.exportHwpx());
    try {
      expect(JSON.parse(saved.getParaPropertiesAt(0, 0)).marginLeft).toBeCloseTo(2000 / 75, 1);
      expect(saved.getTextFileUnicode()).toBe(doc.getTextFileUnicode());
    } finally { saved.free(); }
  } finally { old.free(); doc.free(); }
});

it("retains every original Ieum engine method when HOP exports are added", () => {
  const before = Object.getOwnPropertyNames(OldDocument.prototype).filter(name => name !== "constructor");
  expect(before.filter(name => !(name in HwpDocument.prototype))).toEqual([]);
  expect(typeof HwpDocument.prototype.setHopPaginationRules).toBe("function");
});
