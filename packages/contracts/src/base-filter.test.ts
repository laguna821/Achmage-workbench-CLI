import { describe, expect, it } from "vitest";
import { baseMatcher, cleanBaseFilter, type BaseDocument } from "./base-filter.ts";
import { cleanView } from "./home-views.ts";

const doc: BaseDocument = { note: { "DIKM_단계:": "🔵 I", tags: ["강의/가을"], count: 2, enabled: false, empty: null, title: "원문 노트", list: ["한 개"] }, file: { name: "강의.md", folder: "수업/2026", ext: "md", tags: ["강의/가을", "inline"] } };
describe("inert Bases filters", () => {
  it("combines global-style nested AND/OR/NOT and preserves colon keys", () => {
    const test = baseMatcher({ and: ['note["DIKM_단계:"] == "🔵 I"', { or: ['count >= 2', 'enabled == true'] }, { not: ['file.ext != "md"', 'note.empty != null'] }] });
    expect(test(doc)).toBe(true);
    expect(test({ ...doc, note: { ...doc.note, count: 1 } })).toBe(false);
  });
  it("keeps scalar/list/null/boolean/numeric distinctions and safe list/string helpers", () => {
    for (const expression of ['note.list != "한 개"', 'list(note.list).contains("한 개")', 'list(note.title).contains("원문 노트")', 'note.title.startsWith("원문") && !note.title.endsWith("나중")', 'count != "2"', 'enabled == false', 'missing.isEmpty()', 'note.empty == null']) expect(baseMatcher(expression)(doc), expression).toBe(true);
    expect(baseMatcher('count > "1"')(doc)).toBe(false);
    expect(baseMatcher('note.list == "한 개"')(doc)).toBe(false);
  });
  it("reads real file folders and hierarchical tags", () => {
    expect(baseMatcher('file.inFolder("수업") && file.hasTag("강의")')(doc)).toBe(true);
    expect(baseMatcher('file.inFolder("업")')(doc)).toBe(false);
    expect(baseMatcher('file.hasTag("in")')(doc)).toBe(false);
  });
  it("rejects unknown formulas, functions, malicious expressions and excessive nesting", () => {
    for (const source of ['formula.cost > 2', 'this.file.name == "x"', 'window.alert(1)', 'note.title.constructor("return process")()', 'count + 1 > 2', 'note.enabled = true', 'file.hasLink("x")', 'file.noSuchField', '(' .repeat(40) + 'true' + ')'.repeat(40)]) expect(() => baseMatcher(source), source).toThrow();
    expect(cleanBaseFilter({ and: ["true"], or: ["false"] })).toBeNull();
    expect(cleanBaseFilter({ and: Array(130).fill("true") })).toBeNull();
    expect(cleanView("projects", { id: "bad", baseFilters: { unknown: [] } })!.baseFilters).toBe("false");
  });
});
