// Saving is safe on the rhwp 0.9.0 engine (H4b, MUST 2) — through the gateway's save step
// (prepareHwpSave: Ieum's save fixes incl. restoreSectionTails, the memo check, the fingerprint).
// (a) 0.9.0 writes the lists after a section's body (master pages, memos) itself; the app still puts
//     back the lists of the opened file a saved section lacks. Each list must be there ONCE after a
//     save of an edited two-section document, and after a second save of that saved file.
// (b) a memo's identity includes its date, which 0.9.0 reads and writes: the date listed before a
//     save is the date read back after an HWP and an HWPX save, so no save warns of a lost memo.
// (c) a password HWPX keeps its "encrypted" mark when opened with its password (the AI agent's memo
//     guard reads it), and the save of such a document stays refused (the studio's password flag).
// The lists after a body are written the way Hangul writes them, with the record helpers of Ieum's
// tests (vendor/ieumoffice/apps/hwp/tests/section-tails.test.ts, Apache-2.0).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import * as CFB from "cfb";
import { beforeAll, describe, expect, it } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/engine.ts";
import type { MemoSnapshot } from "../../../packages/contracts/src/hwp.ts";
import { hwpMemosOf } from "../../../third_party/ieumoffice/file-parse/hwp.ts";
import { lostMemoCountOf } from "../../../third_party/ieumoffice/hwp/memos.ts";
import { runSave, type SaveEditorPort } from "../../../third_party/ieumoffice/hwp/save-flow.ts";
import { sectionTailsOf } from "../../../third_party/ieumoffice/hwp/section-tails.ts";
import { newTabsOf, writeTabWidths } from "../../../third_party/ieumoffice/hwp/tab-widths.ts";
import { buildHwpx, para, text } from "./hwp-census-fixture.ts";
import { openHwpBytes, prepareHwpSave } from "./hwp-codec.ts";
import { hwpWasmPath } from "./hwp-resource.ts";
import { hwpStructureOf } from "./hwp-structure.ts";
import { FIXTURES as OWN_FIXTURES, OWN_MEMO, OWN_TEXT, PASSWORD as OWN_PASSWORD } from "../../../scripts/hwp-password-fixtures.ts";

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });

const PARA_HEADER = 66, PARA_CHAR_SHAPE = 68, PARA_LINE_SEG = 69, LIST_HEADER = 72;
function record(tag: number, level: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32LE((tag | (level << 10) | (payload.length << 20)) >>> 0);
  return Buffer.concat([head, payload]);
}
function paragraph(level: number): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0x80000001, 0); header.writeUInt16LE(1, 12); header.writeUInt16LE(1, 16);
  const line = Buffer.alloc(36);
  line.writeUInt32LE(1000, 8); line.writeUInt32LE(1000, 12); line.writeUInt32LE(850, 16);
  return Buffer.concat([record(PARA_HEADER, level, header), record(PARA_CHAR_SHAPE, level + 1, Buffer.alloc(8)), record(PARA_LINE_SEG, level + 1, line)]);
}
/** A master page beyond the first, as Hangul writes it after a section's body; `kind` tells them apart. */
function masterPage(kind: number): Buffer {
  const header = Buffer.alloc(34);
  header.writeUInt32LE(1, 0); header.writeUInt32LE(67180, 8); header.writeUInt32LE(51024, 12); header.writeUInt8(kind, 18);
  return Buffer.concat([record(LIST_HEADER, 1, header), paragraph(1)]);
}
function withTail(file: Uint8Array, section: number, ...lists: Buffer[]): Uint8Array {
  const cfb = CFB.read(Buffer.from(file), { type: "buffer" });
  const path = `/BodyText/Section${section}`, entry = CFB.find(cfb, path);
  if (!entry) throw new Error(`no stream ${path}`);
  CFB.utils.cfb_add(cfb, path, deflateRawSync(Buffer.concat([inflateRawSync(Buffer.from(entry.content as Uint8Array)), ...lists])));
  return new Uint8Array(CFB.write(cfb, { type: "buffer" }) as Buffer);
}
/** The lists after each section's body, by their keys (a master page's kind, a memo's number), in order. */
function tailKeys(file: Uint8Array): string[][] {
  const tails = sectionTailsOf(file);
  if (!tails) return [];
  return Array.from({ length: tails.sections }, (_, index) => (tails.tails.get(index) ?? []).map((list) => list.key));
}
const memos = (doc: HwpDocument): MemoSnapshot[] => JSON.parse(doc.getMemoList());
const dates = (doc: HwpDocument) => memos(doc).map((memo) => memo.date);

/** An HWP of two sections, each with a memo the engine writes, and a master page Hangul wrote after each body. */
async function twoSectionsWithLists(): Promise<Uint8Array> {
  const doc = new HwpDocument(await buildHwpx(text("첫 구역"), [para(text("본문 하나"))], [{ first: text("둘째 구역"), body: [para(text("본문 둘"))] }]));
  try {
    expect(doc.getSectionCount()).toBe(2);
    expect(JSON.parse(doc.insertMemo(0, 1, 0, 2, JSON.stringify({ author: "검토", text: "첫 메모" })))).toMatchObject({ ok: true });
    expect(JSON.parse(doc.insertMemo(1, 1, 0, 2, JSON.stringify({ author: "검토", text: "둘째 메모" })))).toMatchObject({ ok: true });
    return withTail(withTail(doc.exportHwp(), 0, masterPage(4)), 1, masterPage(5));
  } finally { doc.free(); }
}
/** Opens `original`, types into both sections, saves through the gateway's save step. */
async function editAndSave(original: Uint8Array, format: "hwp" | "hwpx", originalFormat: "hwp" | "hwpx" = "hwp") {
  const doc = new HwpDocument((await openHwpBytes(original, originalFormat)).bytes);
  try {
    doc.insertText(0, 1, 0, "고침 "); doc.insertText(1, 1, 0, "또 고침 ");
    const exported = format === "hwp" ? doc.exportHwp() : doc.exportHwpx();
    const saved = await prepareHwpSave(original, exported, format, { memos: memos(doc), structure: hwpStructureOf(doc) }, "save", originalFormat);
    return { saved: new Uint8Array(saved), listed: memos(doc) };
  } finally { doc.free(); }
}

describe("(a) the lists after a section's body are saved once on 0.9.0", () => {
  it("an edited two-section HWP keeps each master page and each memo list once, also after a second save", async () => {
    const original = await twoSectionsWithLists();
    const kept = tailKeys(original);
    // a master page after each body; the engine writes every memo list after the LAST section's body
    expect(kept.map((keys) => keys.length)).toEqual([1, 3]);
    expect(kept.flat().filter((key) => key.startsWith("page:"))).toHaveLength(2);
    expect(kept.flat().filter((key) => key.startsWith("memo:"))).toHaveLength(2);

    const first = await editAndSave(original, "hwp");
    expect(tailKeys(first.saved)).toEqual(kept);
    const reopened = new HwpDocument(first.saved);
    try { expect(memos(reopened)).toHaveLength(2); } finally { reopened.free(); }

    const second = await editAndSave(first.saved, "hwp");
    expect(tailKeys(second.saved)).toEqual(kept);
    for (const keys of tailKeys(second.saved)) expect(new Set(keys).size).toBe(keys.length);
  });

  it("the engine itself now writes the lists of a changed section (why the app's put-back must not add a second copy)", async () => {
    const original = await twoSectionsWithLists();
    const doc = new HwpDocument(original);
    try {
      doc.insertText(0, 1, 0, "고침 ");
      // 0.8.7 wrote the changed section without the master page it read; 0.9.0 keeps it (edwardkim/rhwp#7899)
      expect(tailKeys(doc.exportHwp())).toEqual(tailKeys(original));
    } finally { doc.free(); }
  });

  // Review M5: the recovery path (the gateway's `repair` → prepareHwpSave "recovery", the draft a view
  // keeps when its writer lease expired) on a document WITH master pages and memo lists. Ieum's three
  // recovery-main tests stop at 0.8.7's precondition (lists dropped), so this is the case on 0.9.0.
  it("the recovery draft of an edited two-section HWP keeps each master page and each memo list once, also when recovered twice", async () => {
    const original = await twoSectionsWithLists();
    const kept = tailKeys(original);
    const recover = async (from: Uint8Array) => {
      const doc = new HwpDocument((await openHwpBytes(from, "hwp")).bytes);
      try {
        doc.insertText(0, 1, 0, "복구 "); doc.insertText(1, 1, 0, "또 복구 ");
        return new Uint8Array(await prepareHwpSave(from, doc.exportHwp(), "hwp", { memos: memos(doc), structure: hwpStructureOf(doc) }, "recovery"));
      } finally { doc.free(); }
    };
    const first = await recover(original);
    expect(tailKeys(first)).toEqual(kept);
    const second = await recover(first);
    expect(tailKeys(second)).toEqual(kept);
    for (const keys of tailKeys(second)) expect(new Set(keys).size).toBe(keys.length);
    const reopened = new HwpDocument(second);
    try {
      expect(reopened.getSectionCount()).toBe(2);
      expect(memos(reopened).map((memo) => memo.text)).toEqual(["첫 메모", "둘째 메모"]);
      expect(reopened.getTextRange(0, 1, 0, 3)).toBe("복구 ");
    } finally { reopened.free(); }
  });

  it("the same document saved as HWPX keeps its memos once", async () => {
    const original = await twoSectionsWithLists();
    const { saved } = await editAndSave(original, "hwpx");
    const reopened = new HwpDocument(saved);
    try {
      expect(reopened.getSectionCount()).toBe(2);
      expect(memos(reopened)).toHaveLength(2);
    } finally { reopened.free(); }
    // and an HWPX opened and saved again as HWPX
    const again = await editAndSave(saved, "hwpx", "hwpx");
    const twice = new HwpDocument(again.saved);
    try { expect(memos(twice)).toHaveLength(2); } finally { twice.free(); }
  });
});

describe("(b) a memo's date survives a save, so no save warns of a lost memo", () => {
  it("the date listed before an HWP and an HWPX save is the date read back", async () => {
    const original = await twoSectionsWithLists();
    for (const format of ["hwp", "hwpx"] as const) {
      const { saved, listed } = await editAndSave(original, format);
      expect(listed.every((memo) => typeof memo.date === "string" && memo.date.length > 0)).toBe(true);
      const read = await hwpMemosOf(saved);
      expect(read.map((memo) => memo.date)).toEqual(listed.map((memo) => memo.date));
      expect(await lostMemoCountOf({ saved, original: null, memos: listed })).toBe(0);
    }
  });

  it("a memo typed now gets a date that the HWP and HWPX writers keep to the second", async () => {
    const doc = HwpDocument.createEmpty();
    try {
      doc.createBlankDocument(); doc.insertText(0, 0, 0, "메모를 달 글");
      doc.insertMemo(0, 0, 0, 3, JSON.stringify({ author: "나", text: "새 메모" }));
      const [date] = dates(doc);
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      for (const bytes of [doc.exportHwp(), doc.exportHwpx()]) {
        const again = new HwpDocument(bytes);
        try { expect(dates(again)).toEqual([date]); } finally { again.free(); }
      }
    } finally { doc.free(); }
  });

  it("memos written by Hangul (Ieum's fixtures) keep their dates, an empty one included", async () => {
    for (const name of ["memo.hwp", "memo.hwpx", "memo-short-header-tail.hwp"]) {
      const original = readFileSync(resolve("vendor/ieumoffice/apps/hwp/tests/fixtures", name));
      const doc = new HwpDocument(original);
      try {
        const listed = dates(doc);
        for (const bytes of [doc.exportHwp(), doc.exportHwpx()]) {
          const again = new HwpDocument(bytes);
          try { expect(dates(again)).toEqual(listed); } finally { again.free(); }
        }
        const format = name.endsWith("x") ? "hwpx" : "hwp";
        // the gateway's own save of the unchanged document: no memo counted lost
        await expect(prepareHwpSave(original, format === "hwp" ? doc.exportHwp() : doc.exportHwpx(), format, { memos: memos(doc), structure: hwpStructureOf(doc) })).resolves.toBeInstanceOf(Buffer);
      } finally { doc.free(); }
    }
  });
});

describe("(c) a password document is never saved without its password", () => {
  // Hancom's public test files (refs-ext/rhwp-0.9.0/samples); their password is in their name.
  const samples = process.env.HWP_CORPUS_ROOT ? resolve(process.env.HWP_CORPUS_ROOT, "samples") : resolve("../../refs-ext/rhwp-0.9.0/samples");
  const passwordHwpx = resolve(samples, "HWP5-password-123456.hwpx");
  const passwordHwp = resolve(samples, "hwp3-sample16-hwp5-2024-password-123456.hwp");
  const present = (() => { try { readFileSync(passwordHwpx); readFileSync(passwordHwp); return true; } catch { return false; } })();

  it.skipIf(!present)("a password HWPX opened with its password says it is protected, as a password HWP does", () => {
    for (const file of [passwordHwpx, passwordHwp]) {
      const doc = HwpDocument.openWithPassword(readFileSync(file), "123456");
      try { expect(JSON.parse(doc.getDocumentInfo()).encrypted).toBe(true); } finally { doc.free(); }
    }
  });

  // Review M7: Workbench's OWN password documents (scripts/hwp-password-fixtures.ts: our words, one memo,
  // exported by the engine with a password), so the promise has a test where refs-ext is absent (CI).
  for (const format of ["hwp", "hwpx"] as const) {
    it(`our own password ${format.toUpperCase()}: refused without its password, opens with it, protected, its memo read-only, its save refused`, async () => {
      const bytes = readFileSync(OWN_FIXTURES[format]);
      expect(() => new HwpDocument(bytes)).toThrow();
      expect(() => HwpDocument.openWithPassword(bytes, "wrong-0000")).toThrow();
      const doc = HwpDocument.openWithPassword(bytes, OWN_PASSWORD);
      try {
        expect(JSON.parse(doc.getDocumentInfo()).encrypted).toBe(true);
        expect(doc.getTextRange(0, 0, 0, OWN_TEXT.length)).toBe(OWN_TEXT);
        const [memo] = memos(doc);
        expect(memos(doc)).toHaveLength(1);
        expect(memo).toMatchObject({ author: OWN_MEMO.author, text: OWN_MEMO.text });
        // memos of a password document are read-only (patch 0021): no change, no new memo, no removal
        const id = (JSON.parse(doc.getMemoList()) as { id: number }[])[0]!.id;
        expect(typeof id).toBe("number");
        // the engine refuses by throwing (or returning) {"ok":false,"code":"memo_read_only",…}
        const refusal = (attempt: () => string) => { try { return attempt(); } catch (error) { return String(error); } };
        for (const tried of [refusal(() => doc.setMemoText(id, "바꾼 메모")), refusal(() => doc.insertMemo(0, 0, 0, 2, JSON.stringify({ author: "나", text: "새 메모" }))), refusal(() => doc.removeMemo(id))]) {
          expect(tried).toContain('"ok":false');
          expect(tried).toContain("memo_read_only");
        }
        expect(memos(doc)).toMatchObject([{ author: OWN_MEMO.author, text: OWN_MEMO.text }]);
        // the save step refuses before anything is exported (the studio's flag follows the open with a password)
        const calls: string[] = [];
        const editor = { isPasswordProtected: async () => JSON.parse(doc.getDocumentInfo()).encrypted === true, exportHwp: async () => { calls.push("exportHwp"); return doc.exportHwp(); }, exportHwpx: async () => { calls.push("exportHwpx"); return doc.exportHwpx(); } } as unknown as SaveEditorPort;
        const api = { beginSave: async () => { calls.push("beginSave"); return { ok: true }; }, newTabs: async () => [], commitSave: async () => { calls.push("commitSave"); return { ok: true }; }, abortSave: () => { calls.push("abortSave"); } } as never;
        expect(await runSave(editor, api, "save")).toEqual({ kind: "failed", reason: "protected" });
        expect(await runSave(editor, api, "saveAs")).toEqual({ kind: "failed", reason: "protected" });
        expect(calls).toEqual(["abortSave", "abortSave"]);
      } finally { doc.free(); }
    });
  }

  it("the save of a document the studio opened with a password is refused before anything is exported", async () => {
    const calls: string[] = [];
    const editor = { isPasswordProtected: async () => true, exportHwp: async () => { calls.push("exportHwp"); return new Uint8Array(); }, exportHwpx: async () => { calls.push("exportHwpx"); return new Uint8Array(); } } as unknown as SaveEditorPort;
    const api = { beginSave: async () => { calls.push("beginSave"); return { ok: false, reason: "write", error: "" }; }, newTabs: async () => [], commitSave: async () => { calls.push("commitSave"); return { ok: true }; }, abortSave: () => { calls.push("abortSave"); } } as never;
    expect(await runSave(editor, api, "save")).toEqual({ kind: "failed", reason: "protected" });
    expect(await runSave(editor, api, "saveAs")).toEqual({ kind: "failed", reason: "protected" });
    expect(calls).toEqual(["abortSave", "abortSave"]);
  });
});

describe("(d) a tab is where the editor showed it after a save (the app's tab widths, rhwp 0.9.0)", () => {
  // 0.9.0 lays a reopened tab out by its own tab-stop arithmetic, not by the width stored in the file
  // (Ieum's tab-widths test, which writes a stand-in width of 6000, flips for that reason). The app
  // writes the width the editor itself measured (the studio's measureTab: the caret before and after
  // the tab), so what a person sees must not move: measured here the same way, written with the app's
  // writer, reopened.
  for (const format of ["hwp", "hwpx"] as const) {
    it(`keeps the tab's place through an ${format.toUpperCase()} save`, () => {
      const doc = HwpDocument.createEmpty();
      try {
        doc.createBlankDocument(); doc.insertText(0, 0, 0, "앞\t뒤 글자");
        const x = (d: HwpDocument, offset: number) => (JSON.parse(d.getCursorRect(0, 0, offset)) as { x: number }).x;
        const live = { before: x(doc, 1), after: x(doc, 2) };
        const bytes = format === "hwp" ? doc.exportHwp() : doc.exportHwpx();
        const spots = newTabsOf(bytes, format);
        expect(spots).toHaveLength(1); // both engines still write a new tab without a width: the app's writer is still needed
        const written = writeTabWidths(bytes, format, spots.map((spot) => ({ ...spot, width: Math.round((live.after - live.before) * 75), type: 0, fill: 0 })));
        expect(written.written).toBe(1);
        expect(newTabsOf(written.bytes, format)).toEqual([]);
        const back = new HwpDocument(written.bytes);
        try {
          expect(Math.abs(x(back, 1) - live.before)).toBeLessThan(1);
          expect(Math.abs(x(back, 2) - live.after)).toBeLessThan(1);
        } finally { back.free(); }
      } finally { doc.free(); }
    });
  }
});
