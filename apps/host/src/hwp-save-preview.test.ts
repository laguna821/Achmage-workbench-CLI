// H10 (IeumOffice v0.13.0, decision 0146; unit hwp13): a save writes the document's preview as it is now (PrvText /
// PrvImage) over the one the engine carried from the opened file, so text deleted since does not stay in the file. The
// editor's preview travels in the save's JSON prefix (packages/contracts/src/hwp.ts) and the gateway passes it into
// Ieum's applySaveFixes; a recovery copy keeps what the export has; a missing preview picture is written blank.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import init from "../../../third_party/hop/engine.ts";
import { encodeHwpSave, hwpPreviewWire, HWP_PREVIEW_IMAGE_MAX } from "../../../packages/contracts/src/hwp.ts";
import { entryData, zipEntries } from "../../../third_party/ieumoffice/hwp/tab-widths.ts";
import { decodeHwpSave, prepareHwpSave, savePreviewOf } from "./hwp-codec.ts";
import { hwpWasmPath } from "./hwp-resource.ts";

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });
const fixture = () => new Uint8Array(readFileSync(resolve("apps/host/src/channels/fixtures/강의계획서.hwpx")));
const part = (bytes: Uint8Array, name: string) => {
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), parts = zipEntries(zip)!;
  return entryData(zip, parts.entries.find((entry) => entry.name === name)!)!;
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("the saved file's preview is the document as it is now", () => {
  it("travels in the save's prefix: text, and the picture as base64", () => {
    const wire = hwpPreviewWire({ text: "새 첫 줄\r\n둘째 줄", image: PNG });
    const { metadata, bytes } = decodeHwpSave(Buffer.from(encodeHwpSave({ preview: wire }, new Uint8Array([7, 8, 9]))));
    expect([...bytes]).toEqual([7, 8, 9]);
    expect(savePreviewOf(metadata.preview)).toEqual({ text: "새 첫 줄\r\n둘째 줄", image: PNG });
    // the editor could not make one → null → a blank one is written (never the stale one); absent → as the engine wrote it
    expect(savePreviewOf(null)).toEqual({ text: "", image: null });
    expect(savePreviewOf(undefined)).toBeUndefined();
    expect(hwpPreviewWire(null)).toBeNull();
    // a picture over the cap goes as none
    expect(hwpPreviewWire({ text: "x", image: new Uint8Array(HWP_PREVIEW_IMAGE_MAX + 1) })?.image).toBeNull();
  });

  it("refuses a malformed preview", () => {
    for (const preview of [{ text: 3, image: null }, { text: "x", image: "not base64!" }, { text: "x", image: 5 }, "x"]) {
      expect(() => decodeHwpSave(Buffer.from(encodeHwpSave({ preview } as never, new Uint8Array([1]))))).toThrow(/미리 보기/);
    }
  });

  it("a save writes the editor's preview text; a recovery copy keeps the export's", async () => {
    const original = fixture();
    const stale = part(original, "Preview/PrvText.txt").toString("utf8");
    expect(stale.length).toBeGreaterThan(0);
    const saved = await prepareHwpSave(original, original, "hwpx", { preview: hwpPreviewWire({ text: "지금 문서의 첫 줄", image: null }) });
    expect(part(saved, "Preview/PrvText.txt").toString("utf8")).toBe("지금 문서의 첫 줄");
    const recovery = await prepareHwpSave(original, original, "hwpx", { preview: hwpPreviewWire({ text: "지금 문서의 첫 줄", image: null }) }, "recovery");
    expect(part(recovery, "Preview/PrvText.txt").toString("utf8")).toBe(stale);
    // no preview sent (an older page): the file's stays as the engine wrote it
    const plain = await prepareHwpSave(original, original, "hwpx", {});
    expect(part(plain, "Preview/PrvText.txt").toString("utf8")).toBe(stale);
  });
});
