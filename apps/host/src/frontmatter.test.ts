import { describe, expect, it } from "vitest";
import { excerptOf, firstImage, noteDate, noteTags, parseFrontmatter, splitFrontmatter, valuesOf } from "./frontmatter.ts";

const NOTE = [
  "---",
  "title: KPF 연수: 회의 노트 (6-17-2026)",
  "aliases:",
  "  - 회의",
  '"DIKM_단계:":',
  "  - 🔵 I",
  '"종류:":',
  "  - 회의록",
  "tags: [AI_교육, '글쓰기', \"한글, HWP\"]",
  '"저자:": ',
  "date created: '2026-09-18'",
  "source:",
  "---",
  "",
  "# 제목은 발췌에 넣지 않음",
  "",
  "> [!NOTE] 첫 줄은 **강조**와 [[노트|별칭]]을 지운 글입니다.",
  "![[표지.png|300]]",
  "- 둘째 줄 `코드` 와 [링크](https://example.com) #인라인태그",
  "```",
  "#코드안태그 는 태그가 아님",
  "```",
].join("\n");

describe("front matter", () => {
  it("splits the block and keeps keys exactly as spelled (trailing colons included)", () => {
    const { yaml, body } = splitFrontmatter(NOTE);
    expect(body.startsWith("\n# 제목은")).toBe(true);
    const entries = parseFrontmatter(yaml);
    expect(entries.map(([key]) => key)).toEqual(["title", "aliases", "DIKM_단계:", "종류:", "tags", "저자:", "date created", "source"]);
    expect(valuesOf(entries, "title")).toEqual(["KPF 연수: 회의 노트 (6-17-2026)"]);
    expect(valuesOf(entries, "DIKM_단계:")).toEqual(["🔵 I"]);
    expect(valuesOf(entries, "tags")).toEqual(["AI_교육", "글쓰기", "한글, HWP"]);
    expect(entries.find(([key]) => key === "저자:")![1]).toBeNull();
    expect(entries.find(([key]) => key === "source")![1]).toBeNull();
  });

  it("reads dates as the vault writes them", () => {
    expect(noteDate("2026-08-30")).toBe(new Date(2026, 7, 30).getTime());
    expect(noteDate("2026-04-27T20:28:20+09:00")).toBe(Date.parse("2026-04-27T11:28:20Z"));
    expect(noteDate("2025-11-02T22:34:00")).toBe(new Date(2025, 10, 2, 22, 34).getTime());
    expect(noteDate("")).toBeNull();
    expect(noteDate("someday")).toBeNull();
  });

  it("makes tags from the front matter and the body, never from code", () => {
    const { yaml, body } = splitFrontmatter(NOTE);
    expect(noteTags(parseFrontmatter(yaml), body)).toEqual(["AI_교육", "글쓰기", "한글", "HWP", "인라인태그"]);
  });

  it("takes plain first lines as the excerpt and finds the first local picture", () => {
    const { body } = splitFrontmatter(NOTE);
    const excerpt = excerptOf(body);
    expect(excerpt.startsWith("첫 줄은 강조와 별칭을 지운 글입니다. 둘째 줄 코드 와 링크")).toBe(true);
    expect(excerpt).not.toContain("제목은");
    expect(firstImage(body)).toEqual({ kind: "embed", target: "표지.png" });
    expect(firstImage("![원격](https://x.org/a.png) 그리고 ![로컬](그림/b.jpg)")).toEqual({ kind: "url", target: "https://x.org/a.png" });
    expect(firstImage("![링크](https://x.org/글) 그리고 ![로컬](그림/b.jpg)")).toEqual({ kind: "link", target: "그림/b.jpg" });
    expect(firstImage('글 <img src="https://pub-x.r2.dev/1-a.png?v=2" width="300"> 끝')).toEqual({ kind: "url", target: "https://pub-x.r2.dev/1-a.png?v=2" });
    expect(firstImage('<img src="그림/c.webp">')).toEqual({ kind: "link", target: "그림/c.webp" });
    expect(firstImage("![data](data:image/png;base64,AAAA.png)")).toBeNull();
    expect(firstImage("그림 없음")).toBeNull();
  });

  it("treats a note without front matter as all body", () => {
    expect(splitFrontmatter("그냥 글\n둘째 줄")).toEqual({ yaml: null, body: "그냥 글\n둘째 줄", bodyStart: 0 });
    expect(parseFrontmatter(null)).toEqual([]);
  });
});
