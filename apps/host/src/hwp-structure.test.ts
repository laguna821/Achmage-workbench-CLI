import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";
import { hwpStructureOf, lostStructure, validStructure, type HwpStructure } from "./hwp-structure.ts";
import { hwpWasmPath } from "./hwp-resource.ts";

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });
type Counted = HwpStructure & { chars: NonNullable<HwpStructure["chars"]> };
const base = (): Counted => ({ sections: 2, paragraphs: [5, 3], objects: { cold: 2, secd: 2, tbl: 3, "gso:그림": 1 }, fields: { clickhere: 2 }, memos: 2, numberings: 1, styles: 20, fonts: ["함초롬돋움", "함초롬바탕"], chars: { body: 300, cell: 838, textbox: 0, footnote: 0, endnote: 0, header: 4, footer: 0, memo: 2 }, textSha256: "a".repeat(64), unread: { "header-object": 1 } });

describe("Hangul save fingerprint comparison", () => {
  it("finds nothing lost when the saved document holds the same or more", () => {
    expect(lostStructure(base(), base())).toEqual([]);
    const more = { ...base(), paragraphs: [6, 3], objects: { ...base().objects, tbl: 4, eqed: 1 }, memos: 3, fonts: [...base().fonts, "맑은 고딕"], chars: { ...base().chars, body: 301 }, textSha256: "b".repeat(64) };
    expect(lostStructure(base(), more)).toEqual([]);
  });

  it("names each loss in short Korean: tables, sections, memos, fields, fonts, text", () => {
    const saved = { ...base(), sections: 1, paragraphs: [5], objects: { cold: 1, secd: 1, tbl: 2, "gso:그림": 1 }, fields: { clickhere: 1 }, memos: 0, fonts: ["함초롬돋움"], chars: { ...base().chars, body: 250, cell: 0 } };
    const lost = lostStructure(base(), saved);
    expect(lost).toEqual(expect.arrayContaining(["구역 2→1", "표 3→2", "메모 2→0", "필드 2→1", "글꼴 함초롬바탕", "본문 글자 300→250", "표 칸 글자 838→0"]));
    expect(lostStructure(base(), { ...base(), objects: { ...base().objects, "gso:그림": 0 } })).toEqual(["그림 1→0"]);
  });

  it("counts a field that changed its type as kept (the save fixes restore field kinds)", () => {
    expect(lostStructure(base(), { ...base(), fields: { clickhere: 1, formula: 1 } })).toEqual([]);
  });

  it("counts a real document's tables, memos and fonts", () => {
    const doc = HwpDocument.createEmpty();
    try {
      doc.createBlankDocument(); doc.insertText(0, 0, 0, "지문 검사");
      const before = hwpStructureOf(doc);
      doc.createTable(0, 0, 0, 2, 2);
      doc.insertMemo(0, 0, 0, 2, JSON.stringify({ author: "검토자", text: "메모" }));
      const after = hwpStructureOf(doc);
      expect(after.objects.tbl).toBe((before.objects.tbl ?? 0) + 1);
      expect(after.memos).toBe(before.memos + 1);
      expect(after.fonts.length).toBeGreaterThan(0);
      expect(lostStructure(after, before)).toEqual(expect.arrayContaining(["표 1→0", "메모 1→0"]));
    } finally { doc.free(); }
  });

  it("counts page-number settings once per paragraph that holds them, in either format", () => {
    const control = (para: number, ctrlId = "pgnp") => ({ ctrlId, list: 0, para });
    const source = (controls: object[]) => ({
      getSectionCount: () => 1, getParagraphCount: () => 1, getParagraphLength: () => 0, getControls: () => JSON.stringify(controls),
      getFieldList: () => "[]", getMemoList: () => "[]", getDocumentInfo: () => "{}", getNumberingList: () => "[]", getStyleList: () => "[]",
      getTextRange: () => "", getCursorModel: () => "{}", getCellParagraphLengthByPath: () => 0, getTextInCellByPath: () => "", getFootnoteInfo: () => "{}", getHeaderFooter: () => "{}", getHeaderFooterPictureProperties: () => "{}", getTableProperties: () => "{}",
    });
    const hwp = hwpStructureOf(source([control(0), control(91), control(91), control(91), control(188), control(2, "tbl"), control(2, "tbl")]));
    const hwpx = hwpStructureOf(source([control(0), control(91), control(188), control(2, "tbl"), control(2, "tbl")]));
    expect(hwp.objects).toEqual({ pgnp: 3, tbl: 2 });
    expect(lostStructure(hwp, hwpx)).toEqual([]);
    expect(lostStructure(hwp, hwpStructureOf(source([control(0), control(91), control(2, "tbl"), control(2, "tbl")])))).toEqual(["쪽 번호 3→2"]);
  });

  it("accepts only a bounded, well-formed structure from a save request", () => {
    expect(validStructure(base())).toBe(true);
    expect(validStructure({ ...base(), sections: -1 })).toBe(false);
    expect(validStructure({ ...base(), paragraphs: "5" })).toBe(false);
    expect(validStructure({ ...base(), objects: { tbl: 1.5 } })).toBe(false);
    expect(validStructure({ ...base(), fonts: Array.from({ length: 5000 }, (_, i) => `f${i}`) })).toBe(false);
    expect(validStructure({ ...base(), paragraphs: Array.from({ length: 20_000 }, () => 1) })).toBe(false);
    // the unread counts go with the text census: required with it, bounded, absent without it
    expect(validStructure({ ...base(), unread: undefined })).toBe(false);
    expect(validStructure({ ...base(), unread: { caption: -1 } })).toBe(false);
  });

  it("names a drop of what the census cannot read, never a rise, and only when both sides could count", () => {
    expect(lostStructure(base(), { ...base(), unread: {} })).toEqual(["읽지 못하는 개체: 머리말 안 표·글상자 등 1→0"]);
    expect(lostStructure(base(), { ...base(), unread: { "header-object": 2, "footer-extra": 1 } })).toEqual([]);
    expect(lostStructure(base(), { ...base(), chars: undefined, textSha256: undefined, unread: undefined, textUnchecked: "글자 검사 못함 (머리말·꼬리말: Error)" })).toEqual([]);
  });
});
