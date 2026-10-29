import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTemplate, inferType, keyStyle, normalizeValues, parseDate, propertyRows, templateFromMarkdown, vaultPropertyTypes } from "./project-properties.ts";
import { setFrontmatterKey } from "./project-note.ts";

// Properties as Obsidian has them: kinds, the values each kind writes, templates from a note.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date(2026, 9, 29, 15, 42);

describe("dates typed by a person", () => {
  it("read as YYYY-MM-DD in the forms people type them, and refuse what is not a day", () => {
    expect(parseDate("2026-10-29", NOW)).toBe("2026-10-29");
    expect(parseDate("2026.10.3", NOW)).toBe("2026-10-03");
    expect(parseDate("10-29-2026", NOW)).toBe("2026-10-29");
    expect(parseDate("11/2", NOW)).toBe("2026-11-02");
    expect(parseDate("2026년 12월 1일", NOW)).toBe("2026-12-01");
    expect(parseDate("오늘", NOW)).toBe("2026-10-29");
    expect(parseDate("내일", NOW)).toBe("2026-10-30");
    expect(parseDate("2026-02-30", NOW)).toBeNull();
    expect(parseDate("다음 주", NOW)).toBeNull();
  });
});

describe("a value in its kind", () => {
  it("is written the way Obsidian writes that kind", () => {
    expect(normalizeValues("date", ["10-29-2026"], NOW)).toEqual(["2026-10-29"]);
    expect(normalizeValues("datetime", ["2026-10-29 9:05"], NOW)).toEqual(["2026-10-29T09:05"]);
    expect(normalizeValues("datetime", ["지금"], NOW)).toEqual(["2026-10-29T15:42"]);
    expect(normalizeValues("number", ["1,200"], NOW)).toEqual(["1200"]);
    expect(normalizeValues("checkbox", ["예"], NOW)).toEqual(["true"]);
    expect(normalizeValues("tags", ["#강의 2026-2학기, #강의"], NOW)).toEqual(["강의", "2026-2학기"]);
    expect(normalizeValues("links", ["가을 특강", "[[안녕]]"], NOW)).toEqual(["[[가을 특강]]", "[[안녕]]"]);
    expect(() => normalizeValues("date", ["언젠가"], NOW)).toThrow(/날짜로 읽지 못했습니다/);
    expect(() => normalizeValues("number", ["열둘"], NOW)).toThrow(/숫자가 아닙니다/);
  });

  it("goes into the YAML as a list, a bare number or true/false, or a plain value", () => {
    const base = "---\nworkbench_id: w1\n---\n본문\n";
    expect(setFrontmatterKey(base, "종류", ["강의"], keyStyle("list"))).toBe("---\nworkbench_id: w1\n종류:\n  - 강의\n---\n본문\n");
    expect(setFrontmatterKey(base, "회차", ["12"], keyStyle("number"))).toBe("---\nworkbench_id: w1\n회차: 12\n---\n본문\n");
    expect(setFrontmatterKey(base, "공개", ["true"], keyStyle("checkbox"))).toBe("---\nworkbench_id: w1\n공개: true\n---\n본문\n");
    expect(setFrontmatterKey(base, "마감일", ["2026-11-02"], keyStyle("date"))).toBe("---\nworkbench_id: w1\n마감일: 2026-11-02\n---\n본문\n");
    expect(setFrontmatterKey(base, "목표", [], keyStyle("text"))).toBe("---\nworkbench_id: w1\n목표:\n---\n본문\n");
  });

  it("is read from its value when nothing names its kind", () => {
    expect(inferType("단계", ["진행중"])).toBe("stage");
    expect(inferType("tags", ["a"])).toBe("tags");
    expect(inferType("관련", ["[[가을 특강]]"])).toBe("links");
    expect(inferType("공개", ["true"])).toBe("checkbox");
    expect(inferType("회차", ["3"])).toBe("number");
    expect(inferType("date created", ["2026-10-15T09:00:00+09:00"])).toBe("datetime");
    expect(inferType("마감", ["2026-11-02"])).toBe("date");
    expect(inferType("종류:", ["인사이트", "자기반성"])).toBe("list");
    expect(inferType("목표", ["한 줄"])).toBe("text");
  });
});

describe("templates", () => {
  it("keep known kinds, each name once, the stage as the stage, and no machine key", () => {
    expect(
      cleanTemplate([
        { key: "단계", type: "text" },
        { key: "workbench_id", type: "text" },
        { key: "목표", type: "stage" },
        { key: "목표", type: "list" },
        { key: "  ", type: "text" },
        { key: "회차", type: "nonsense", hint: " 몇 번째 " },
      ]),
    ).toEqual([
      { key: "단계", type: "stage" },
      { key: "목표", type: "text" },
      { key: "회차", type: "text", hint: "몇 번째" },
    ]);
  });

  it("come from a note template's front matter, with the vault's kinds first", () => {
    const markdown = ['---', 'title: "{{title}}"', "aliases: []", '"DIKM_단계:":', "  - 🟢 D", '"종류:": []', "tags: []", "date created: 2026-10-01T09:00", "source: []", "---", "본문"].join("\n");
    const fields = templateFromMarkdown(markdown, new Map([["source", "list"]]));
    expect(fields).toEqual([
      { key: "aliases", type: "list" },
      { key: "DIKM_단계:", type: "text" },
      { key: "종류:", type: "text" },
      { key: "tags", type: "tags" },
      { key: "date created", type: "datetime" },
      { key: "source", type: "list" },
    ]);
    expect(() => templateFromMarkdown("본문만", new Map())).toThrow(/속성\(YAML/);
  });

  it("show their fields first, empty until filled, then the note's other keys", () => {
    const rows = propertyRows(
      [
        { key: "단계", type: "stage" },
        { key: "목표", type: "text", hint: "한 줄" },
      ],
      [
        ["workbench_id", ["w1"]],
        ["날짜", ["10-29-2026"]],
        ["단계", ["할일"]],
      ],
      (key, values) => inferType(key, values),
    );
    expect(rows).toEqual([
      { key: "단계", type: "stage", values: ["할일"], present: true, fromTemplate: true },
      { key: "목표", type: "text", values: [], present: false, fromTemplate: true, hint: "한 줄" },
      { key: "날짜", type: "text", values: ["10-29-2026"], present: true, fromTemplate: false },
    ]);
  });

  it("take the kinds the vault's Obsidian gives names (.obsidian/types.json, read only)", () => {
    const vault = mkdtempSync(join(tmpdir(), "wb-types-"));
    dirs.push(vault);
    mkdirSync(join(vault, ".obsidian"));
    writeFileSync(join(vault, ".obsidian", "types.json"), JSON.stringify({ types: { "DIKM_단계:": "multitext", "date created": "datetime", 회차: "number", odd: "unknown" } }));
    expect([...vaultPropertyTypes(vault)]).toEqual([
      ["DIKM_단계:", "list"],
      ["date created", "datetime"],
      ["회차", "number"],
    ]);
    expect(vaultPropertyTypes(null).size).toBe(0);
    expect(vaultPropertyTypes(join(vault, "none")).size).toBe(0);
  });
});
