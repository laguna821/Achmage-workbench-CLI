import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { extractedDocument, PdfLoader } from "./pdf-loader.ts";

it("retains original reading order, pages and table-cell text without duplicating nested content", () => {
  const result = extractedDocument({ kids: [
    { type: "paragraph", "page number": 2, content: "두 번째 쪽", "bounding box": [10, 20, 200, 40], kids: [{ content: "두 번째 쪽" }] },
    { type: "table", "page number": 1, rows: [{ cells: [{ kids: [{ type: "paragraph", content: "항목" }] }, { kids: [{ content: "값" }] }] }] },
  ] }, "# Original markdown");
  expect(result.pages).toEqual([{ page: 1, text: "항목\n\n값" }, { page: 2, text: "두 번째 쪽" }]);
  expect(result.blocks).toHaveLength(3); expect(result.blocks[0]?.box).toEqual([10, 20, 200, 40]);
  expect(result.markdown).toBe("# Original markdown");
});

it("does not invent geometry for text without valid upstream coordinates", () => {
  const result = extractedDocument({ kids: [{ content: "text", "bounding box": [0, 1, Infinity, 2] }] });
  expect(result.blocks[0]?.box).toBeNull();
});

it("does not download or report OCR available before an explicit install", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-pdf-loader-")), loader = new PdfLoader(dir);
  try {
    expect(loader.status()).toMatchObject({ coreReady: false, ocrReady: false, state: "idle" });
    await expect(loader.extract(Buffer.from("%PDF-fixture"))).rejects.toThrow("먼저 설치");
  } finally { await loader.close(); rmSync(dir, { recursive: true, force: true }); }
});
