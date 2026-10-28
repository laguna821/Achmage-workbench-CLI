import { describe, expect, it } from "vitest";
import { DIKM_STAGES, fillTemplate, localStamp, templateChoices, yamlValue } from "./pages.ts";

// A template shaped like the vault's DIKM note template (choice lists, quoted keys with a trailing
// colon, empty values with a trailing space) and a Templater command in the body.
const TEMPLATE = [
  "---",
  "title: ",
  "aliases: ",
  '"DIKM_단계:":',
  "  - 🟢 D",
  "  - 🔵 I",
  "  - 🟣 K",
  "  - 🟠 M",
  "  - ⬜ 보류",
  '"종류:":',
  "  - 노트",
  "  - 아이디어",
  "tags: ",
  '"저자:": ',
  '"관련문서:": ',
  "date created: ",
  "source:",
  "---",
  "",
  "## 📝 Summary or Key Trigger",
  "> 계기 <% tp.date.now(\"YYYY-MM-DD\") %>",
  "",
].join("\n");

describe("page templates", () => {
  it("fills only title and date created, sets choice fields to what was picked, and keeps every other byte", () => {
    const page = fillTemplate(TEMPLATE, { title: "AI 수업: 1주차", date: "2026-10-28T22:00:00+09:00", choices: { "DIKM_단계:": ["🔵 I"], "종류:": [] } });
    expect(page).toBe(
      [
        "---",
        'title: "AI 수업: 1주차"',
        "aliases: ",
        '"DIKM_단계:":',
        "  - 🔵 I",
        '"종류:":',
        "tags: ",
        '"저자:": ',
        '"관련문서:": ',
        "date created: 2026-10-28T22:00:00+09:00",
        "source:",
        "---",
        "",
        "## 📝 Summary or Key Trigger",
        "> 계기 <% tp.date.now(\"YYYY-MM-DD\") %>",
        "",
      ].join("\n"),
    );
  });

  it("leaves choice fields nobody was asked about as they are, keeps CRLF and copies templates without front matter", () => {
    const crlf = TEMPLATE.replace(/\n/g, "\r\n");
    const page = fillTemplate(crlf, { title: "제목", date: "2026-10-28" });
    expect(page.split("\r\n")).toHaveLength(crlf.split("\r\n").length);
    expect(page).toContain("title: 제목\r\n");
    expect(page).toContain('"종류:":\r\n  - 노트\r\n  - 아이디어\r\n');
    expect(fillTemplate("# 앞머리 없는 템플릿\n<% tp.file.title %>\n", { title: "x", date: "y" })).toBe("# 앞머리 없는 템플릿\n<% tp.file.title %>\n");
  });

  it("finds choice fields (DIKM stages offered even when a template lists none)", () => {
    expect(templateChoices(TEMPLATE)).toEqual([
      { key: "DIKM_단계:", options: DIKM_STAGES },
      { key: "종류:", options: ["노트", "아이디어"] },
    ]);
    const empty = ["---", "title:", '"DIKM_단계:":', '"종류:":', "date created:", "---", ""].join("\n");
    expect(templateChoices(empty)).toEqual([{ key: "DIKM_단계:", options: DIKM_STAGES }]);
    const filled = fillTemplate(empty, { title: "t", date: "d", choices: { "DIKM_단계:": ["🟢 D", "⬜ 보류"] } });
    expect(filled).toBe(["---", "title: t", '"DIKM_단계:":', "  - 🟢 D", "  - ⬜ 보류", '"종류:":', "date created: d", "---", ""].join("\n"));
  });

  it("quotes a filled value only when YAML needs it, and stamps the local time with its offset", () => {
    expect(yamlValue("수업 설계")).toBe("수업 설계");
    for (const value of ["a: b", "#태그", "- 목록", "true", "123", " 앞 공백", "[괄호]"]) expect(yamlValue(value)).toBe(JSON.stringify(value));
    expect(localStamp(Date.UTC(2026, 9, 28, 13, 0, 0))).toMatch(/^2026-10-28T\d{2}:00:00[+-]\d{2}:\d{2}$/);
  });
});
