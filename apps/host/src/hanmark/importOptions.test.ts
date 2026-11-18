import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ALLOWED_PARSE_OPTION_KEYS, DEFAULT_IMPORT_OPTIONS, IMPORT_PRESET_IDS, normalizePageRange, toParseOptions } from "./importOptions.ts";
import { describeImportFailure, describeImportWarning } from "./messageCatalog.ts";

// Ported from HanMark tests/importFlow.test.ts ("import options (2.7.0 W3)" and the failure texts).
// The Obsidian import job itself is not ported: apps/host/src/hangul-convert.test.ts runs Workbench's.
const FORBIDDEN_OPTIONS = ["ocr", "formulaOcr", "filePath", "imageData", "inlineImages"];

describe("import options (2.7.0 W3)", () => {
  it("passes no options for the default preset so the Markdown stays Kordoc's default", () => {
    assert.deepEqual(toParseOptions(DEFAULT_IMPORT_OPTIONS), {});
  });

  it("maps each preset to documented offline parse options", () => {
    assert.deepEqual(toParseOptions({ ...DEFAULT_IMPORT_OPTIONS, preset: "text" }), { plain: true, images: false });
    assert.deepEqual(toParseOptions({ ...DEFAULT_IMPORT_OPTIONS, preset: "form" }), { keepTrailingEmptyCols: true, includeFieldPlaceholders: true, keepEmptyParagraphs: true });
    assert.deepEqual(toParseOptions({ ...DEFAULT_IMPORT_OPTIONS, preset: "exam" }), { tables: false });
  });

  it("never produces OCR, model-download, file-path, or inline-image options", () => {
    const onProgress = (): void => {};
    for (const preset of IMPORT_PRESET_IDS) {
      for (const flags of [false, true]) {
        const options = toParseOptions({ preset, pages: "1-2", images: !flags, htmlTables: flags, removeHeaderFooter: flags, dedupeRunningHeaders: flags }, { password: "secret", onProgress });
        for (const key of Object.keys(options)) {
          assert.ok(ALLOWED_PARSE_OPTION_KEYS.has(key), `${preset}: ${key} is not whitelisted`);
          assert.ok(!FORBIDDEN_OPTIONS.includes(key), `${preset}: ${key} is forbidden`);
        }
      }
    }
  });

  it("normalizes page ranges and rejects invalid ones", () => {
    assert.equal(normalizePageRange(""), "");
    assert.equal(normalizePageRange(" 1 - 3 , 5 "), "1-3,5");
    assert.equal(normalizePageRange("7-7"), "7");
    assert.equal(normalizePageRange("3-1"), null);
    assert.equal(normalizePageRange("0"), null);
    assert.equal(normalizePageRange("1,,2"), null);
    assert.equal(normalizePageRange("a"), null);
    assert.equal(toParseOptions({ ...DEFAULT_IMPORT_OPTIONS, pages: "2- 4" }).pages, "2-4");
    assert.equal(toParseOptions({ ...DEFAULT_IMPORT_OPTIONS, pages: "bad" }).pages, undefined);
  });

  it("offers a password only for formats Kordoc can decrypt", () => {
    assert.equal(describeImportFailure("ENCRYPTED", "hwpx").passwordHelps, true);
    assert.equal(describeImportFailure("ENCRYPTED", "hwp3").passwordHelps, true);
    const pdf = describeImportFailure("ENCRYPTED", "pdf");
    assert.equal(pdf.passwordHelps, false);
    assert.match(pdf.fix ?? "", /PDF 암호/);
    assert.equal(describeImportFailure("CORRUPTED", "hwpx").passwordHelps, false);
    assert.equal(describeImportFailure("SOMETHING_NEW").title, "문서를 읽는 중 오류가 났습니다.");
  });

  it("says kordoc's warnings in plain Korean and keeps an unknown one as kordoc wrote it", () => {
    assert.equal(describeImportWarning({ code: "SKIPPED_OLE", message: "x" }), "삽입된 개체(OLE)는 가져오지 않았습니다.");
    assert.equal(describeImportWarning({ code: "NEW_CODE", message: "kordoc says" }), "kordoc says");
  });
});
