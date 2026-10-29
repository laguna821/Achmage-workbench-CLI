import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { baseMatcher, cleanView, plainView, type BaseDocument } from "@workbench/contracts";
import { exportBase, importBase } from "./base-interop.ts";

describe(".base interchange", () => {
  it("roundtrips all app state, including subgroup/style/unknown saved filter syntax, without conflating folders", () => {
    const original = plainView("mine", "내 연구", "board", { filter: '폴더:강의', group: { key: "folder" }, subgroup: { key: "prop:DIKM_단계:" }, sort: { key: "activity", dir: "desc" }, fields: ["thumbnail", "sessions", "prop:종류"], collapsed: ["folder=강의"], look: { colors: { "folder=강의": "#123456" }, tint: 10, border: true, heading: true } });
    const exported = exportBase(original);
    expect(exported.warnings.length).toBeGreaterThan(0);
    const imported = importBase(exported.source).entries[0]!;
    expect(imported.issues).toEqual([]);
    expect({ ...imported.view, id: "mine" }).toEqual(original);
    expect(parse(exported.source).filters).toBe("false");
  });
  it("uses externally edited standard settings instead of stale Workbench restoration data", () => {
    const exported = parse(exportBase(plainView("mine", "원래", "table")).source);
    exported.views[0].name = "Obsidian에서 변경";
    exported.views[0].groupBy = { property: "note.종류", direction: "DESC" };
    const entry = importBase(stringify(exported)).entries[0]!;
    expect(entry.view).toMatchObject({ name: "Obsidian에서 변경", group: { key: "prop:종류", reverse: true } });
    expect(entry.warnings.some((warning) => warning.includes("외부에서 수정"))).toBe(true);
  });
  it("can export and re-import a view with imported recursive filters without creating YAML aliases", () => {
    const view = importBase('filters:\n  and:\n    - note.score > 2\nviews:\n  - type: table\n    name: 재교환\n').entries[0]!.view!;
    const exported = exportBase(view);
    const restored = importBase(exported.source).entries[0]!.view!;
    expect(restored.baseFilters).toEqual(view.baseFilters);
  });
  it("applies global and view filters together, keeps typed comparisons, columns/group/sort and persisted filters", () => {
    const source = stringify({ filters: { or: ['file.hasTag("강의")', 'note.kind == "책"'] }, views: [{ type: "table", name: "단계별", filters: 'note["DIKM_단계:"] == "I" && note.score >= 2', groupBy: { property: "note.DIKM_단계:", direction: "ASC" }, order: ["file.name", "note.score"], sort: [{ property: "note.score", direction: "DESC" }] }] });
    const view = importBase(source).entries[0]!.view!;
    expect(view).toMatchObject({ fields: ["file.name", "prop:score"], group: { key: "prop:DIKM_단계:" }, sort: { key: "prop:score", dir: "desc" } });
    const persisted = cleanView("projects", JSON.parse(JSON.stringify(view)))!;
    const matches = baseMatcher(persisted.baseFilters!);
    const doc: BaseDocument = { note: { "DIKM_단계:": "I", score: 2 }, file: { tags: ["강의/가을"] } };
    expect(matches(doc)).toBe(true);
    expect(matches({ ...doc, file: { tags: [] } })).toBe(false);
    expect(matches({ ...doc, note: { ...doc.note, score: "2" } })).toBe(false);
  });
  it("reports unsupported filtering/row selection instead of dropping criteria; valid sibling views survive", () => {
    for (const patch of [{ filters: 'formula.cost > 2' }, { filters: { and: ['true', 'file.hasLink(this.file)'] } }, { groupOrder: ["A"] }, { limit: 10 }, { sort: [{ property: "file.name" }, { property: "note.score" }] }, { type: "map" }]) {
      const result = importBase(stringify({ views: [{ type: "table", name: "불가", ...patch }, { type: "list", name: "가능" }] }));
      expect(result.entries[0]!.view).toBeNull();
      expect(result.entries[0]!.issues.length).toBeGreaterThan(0);
      expect(result.entries[1]!.view?.name).toBe("가능");
    }
  });
  it("refuses oversized, duplicate or aliased input and keeps original text unmodified", () => {
    for (const source of ["x".repeat(256_001), "views: []", "views: []\nviews: []", "views: &v [{type: table}]\nx: *v"]) expect(() => importBase(source)).toThrow();
    const source = "# 원문 주석\r\nviews:\r\n  - type: table\r\n    name: 내 보기\r\n";
    expect(importBase(source).entries[0]!.view?.name).toBe("내 보기");
    expect(source.startsWith("# 원문 주석\r\n")).toBe(true);
  });
});
