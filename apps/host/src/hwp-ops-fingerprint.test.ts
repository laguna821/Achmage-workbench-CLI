import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";
import { hwpWasmPath } from "./hwp-resource.ts";
import { notesWithBreaks, withControlCharacters } from "./hwp-census-fixture.ts";

// The document AI's headless editor, with an export that drops what the session still holds
// (what an engine regression would do). Everything after the export is the real gateway code.
const exported = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array }));
vi.mock("../../../vendor/ieumoffice/packages/cli/src/formats/hwp-edit.ts", () => ({
  hwpCatalog: () => [],
  openHwpForEdit: async (bytes: Uint8Array) => ({ doc: new HwpDocument(new Uint8Array(bytes)) }),
  applyHwpOps: async () => ({ results: [{ changed: true }] }),
  saveHwpSession: async () => ({ bytes: exported.bytes, tailsLost: false, memosLost: 0 }),
  closeHwpSession: (session: { doc: HwpDocument }) => session.doc.free(),
}));
const { editHwp } = await import("./hwp-ops.mjs");

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });
function document(table: boolean) {
  const doc = HwpDocument.createEmpty(); doc.createBlankDocument(); doc.insertText(0, 0, 0, "문서 AI 편집");
  if (table) doc.createTable(0, 0, 0, 2, 2);
  try { return doc.exportHwpx(); } finally { doc.free(); }
}

describe("document AI saves carry the editor's structure", () => {
  it("refuses an AI edit whose export lost a table the editing session still holds", async () => {
    exported.bytes = document(false);
    const refused = await editHwp(document(true), "hwpx", [{ op: "noop" }]).then(() => null, (error: unknown) => error as Error & { detail?: unknown });
    // Its own, true message in the tool's error form: nothing written, session discarded, do not retry, tell the user.
    expect(refused?.message).toMatch(/^Not saved: the saved document would lose [^.]*표 1→0[^.]*\. Nothing was written and the editing session was discarded\. Do not retry or change the file another way; tell the user what would be lost\.$/);
    expect(refused?.message).not.toMatch(/편집 내용은 유지/);
    expect(refused?.detail).toMatchObject({ code: "hwp_content_loss", lost: expect.arrayContaining(["표 1→0"]) });
  });

  it("saves when the export holds what the session holds", async () => {
    exported.bytes = document(true);
    await expect(editHwp(document(true), "hwpx", [{ op: "noop" }])).resolves.toMatchObject({ changed: true });
  });

  // N2-1: the document AI's save of a document with a tab and a line break in its notes.
  it("saves an AI edit of a document whose notes hold a tab and a line break", async () => {
    const bytes = await notesWithBreaks();
    exported.bytes = bytes;
    await expect(editHwp(bytes, "hwpx", [{ op: "noop" }])).resolves.toMatchObject({ changed: true });
  });
  // N3-1 / T1: an HWPX holding carriage returns as character references; the engine's HWPX export drops them.
  it("saves an AI edit of an HWPX holding carriage returns, and still refuses an emptied cell", async () => {
    const original = await withControlCharacters();
    const exportOf = (bytes: Uint8Array) => { const doc = new HwpDocument(bytes); try { return doc.exportHwpx(); } finally { doc.free(); } };
    exported.bytes = exportOf(original);
    await expect(editHwp(original, "hwpx", [{ op: "noop" }])).resolves.toMatchObject({ changed: true });
    exported.bytes = exportOf(await withControlCharacters(""));
    const refused = await editHwp(original, "hwpx", [{ op: "noop" }]).then(() => null, (error: unknown) => error as Error & { detail?: unknown });
    expect(refused?.detail).toMatchObject({ code: "hwp_content_loss", lost: expect.arrayContaining([`표 칸 글자 ${"성명 홍길동".length}→0`]) });
  });
});
