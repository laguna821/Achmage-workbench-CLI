import { describe, expect, it } from "vitest";
import { plainExcerpt } from "./plain-excerpt.ts";

/** The highlighted words, to check that the marks moved with the words. */
const marked = (text: string, needle: string) => {
  const ranges: [number, number][] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) ranges.push([at, at + needle.length]);
  const result = plainExcerpt(text, ranges);
  return { ...result, words: result.ranges.map(([from, to]) => result.text.slice(from, to)) };
};

describe("plainExcerpt: search excerpts without Markdown marks", () => {
  it("bold, italics, strike and highlight lose their marks; the match still lands on its word", () => {
    const result = marked("이번 주는 **중간고사** 대비 ~~휴강~~ ==공지== *복습*", "중간고사");
    expect(result.text).toBe("이번 주는 중간고사 대비 휴강 공지 복습");
    expect(result.words).toEqual(["중간고사"]);
  });

  it("headings, quotes, lists and tasks at a line's start", () => {
    expect(plainExcerpt("## 3주차 강의\n> 참고: 교재 2장\n- 출석 확인\n1. 과제 안내\n- [x] 자료 올리기").text).toBe("3주차 강의\n참고: 교재 2장\n출석 확인\n과제 안내\n자료 올리기");
    expect(plainExcerpt("> [!note] 메모\n본문").text).toBe("메모\n본문");
  });

  it("a heading mark inside a flattened excerpt goes, a tag or C# stays", () => {
    expect(plainExcerpt("…끝난 문단 ## 다음 절 #태그 C# 수업").text).toBe("…끝난 문단 다음 절 #태그 C# 수업");
  });

  it("links read as their words; pictures go", () => {
    const result = marked("[강의 계획서](https://example.invalid/plan.pdf)를 보고 [[3주차 노트|지난 주 노트]]와 [[교재]] 확인 ![그림](a.png)![[b.png]]", "계획서");
    expect(result.text).toBe("강의 계획서를 보고 지난 주 노트와 교재 확인 ");
    expect(result.words).toEqual(["계획서"]);
  });

  it("code stays readable: only the backticks go, what is inside stays exactly", () => {
    const result = marked("명령 `npm run __build__ *all*` 실행 ```bash", "__build__");
    expect(result.text).toBe("명령 npm run __build__ *all* 실행 ");
    expect(result.words).toEqual(["__build__"]);
  });

  it("HTML tags and backslash escapes", () => {
    expect(plainExcerpt("<b>굵게</b> 1\\*2 \\# 제목 아님").text).toBe("굵게 1*2 # 제목 아님");
  });

  it("a match that covered marks shrinks to its words; matches across marks stay one", () => {
    const text = "**중간**고사";
    expect(plainExcerpt(text, [[0, 8]])).toEqual({ text: "중간고사", ranges: [[0, 4]] });
    expect(plainExcerpt("**", [[0, 2]])).toEqual({ text: "", ranges: [] });
  });

  it("text without marks is returned unchanged, ranges too", () => {
    const text = "…수업 자료를 정리했습니다 - 3장부터 5장까지, 2*3=6, snake_case_name";
    expect(plainExcerpt(text, [[1, 3]])).toEqual({ text, ranges: [[1, 3]] });
  });
});
