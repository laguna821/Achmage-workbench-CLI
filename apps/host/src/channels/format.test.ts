import { describe, expect, it } from "vitest";
import { entityProblem } from "./fake-telegram.ts";
import { contentProblem } from "./content-check.ts";
import { plain, readable, splitRich, formatted, answerFile } from "./format.ts";
import type { Mark } from "./types.ts";

// The engines' markdown as the phone shows it: the signs go, the formatting stays, and any text
// whatever comes out as a valid message (checked with the stand-in Bot API's own entity rules).

const marked = (text: string, marks: Mark[]) => marks.map((mark) => ({ type: mark.type, text: text.slice(mark.offset, mark.offset + mark.length), ...(mark.url ? { url: mark.url } : {}), ...(mark.language ? { language: mark.language } : {}) }));
const valid = (text: string, marks: Mark[]) => expect(entityProblem(text, marks.map((mark) => ({ type: TYPE[mark.type], offset: mark.offset, length: mark.length, ...(mark.url ? { url: mark.url } : {}), ...(mark.language ? { language: mark.language } : {}) })))).toBeNull();
const TYPE: Record<Mark["type"], string> = { bold: "bold", italic: "italic", strike: "strikethrough", code: "code", pre: "pre", link: "text_link", quote: "blockquote" };

describe("markdown as the phone shows it", () => {
  it("shows the owner's first answer without stars", () => {
    const { text, marks } = readable("**GPT-6 기반 Codex 에이전트**입니다.\n\n- **개발:** 코드 작성\n- **문서:** 보고서");
    expect(text).toBe("GPT-6 기반 Codex 에이전트입니다.\n\n• 개발: 코드 작성\n• 문서: 보고서");
    expect(marked(text, marks)).toEqual([{ type: "bold", text: "GPT-6 기반 Codex 에이전트" }, { type: "bold", text: "개발:" }, { type: "bold", text: "문서:" }]);
    valid(text, marks);
  });

  it("reads Korean emphasis that runs into the next word, italics and inline code; ~~ is shown as typed", () => {
    const { text, marks } = readable("**굵게**입니다, *기울임*과 ~~지움~~, `npm test`");
    expect(text).toBe("굵게입니다, 기울임과 ~~지움~~, npm test");
    expect(marked(text, marks)).toEqual([{ type: "bold", text: "굵게" }, { type: "italic", text: "기울임" }, { type: "code", text: "npm test" }]);
  });

  it("leaves what is not formatting as it is: file names, unbalanced stars, < and &", () => {
    for (const source of [
      "my_file_name.py 를 고쳤습니다", "**닫히지 않은 별", "a < b && c > d <b>태그</b>", "2 * 3 = 6", "snake_case_name", "foo_bar_ 다음", "* 혼자인 별",
      "__init__.py 를 고쳤습니다", "_private_var 와 __dunder__", "2*3*4 = 24", "a*b*c", "1~~2~~3", "C:\\Users\\me\\[draft]_v1.txt", "\\d+\\.\\d+",
      "1) 첫째", ">>> python", "#", "___", "| a |\n|---|", "a | b\n|x",
    ]) {
      const { text, marks } = readable(source);
      expect({ source, text: text.replace(/^• /, "* "), marks }).toEqual({ source, text: source, marks: [] });
    }
  });

  it("makes a heading a bold line, a list a bullet list, a quote a quote, a rule a line", () => {
    const { text, marks } = readable("## 결과\n1. 첫째\n2. 둘째\n  - 안쪽\n- [x] 끝남\n> 인용한 말\n> 둘째 줄\n\n---\n끝");
    expect(text).toBe("결과\n1. 첫째\n2. 둘째\n  ◦ 안쪽\n• [x] 끝남\n인용한 말\n둘째 줄\n\n──────\n끝");
    expect(marked(text, marks)).toEqual([{ type: "bold", text: "결과" }, { type: "quote", text: "인용한 말\n둘째 줄" }]);
  });

  it("keeps a code block whole, with its language, and closes one the length limit cut open", () => {
    const fenced = readable("실행:\n```bash\nnpm run *build*\n```\n끝");
    expect(fenced.text).toBe("실행:\nnpm run *build*\n끝");
    expect(marked(fenced.text, fenced.marks)).toEqual([{ type: "pre", text: "npm run *build*", language: "bash" }]);
    const cut = readable("코드:\n```ts\nconst a = 1;\nconst b = **2**;");
    expect(cut.text).toBe("코드:\nconst a = 1;\nconst b = **2**;");
    expect(marked(cut.text, cut.marks)).toEqual([{ type: "pre", text: "const a = 1;\nconst b = **2**;", language: "ts" }]);
  });

  it("reads a line with backticks on both ends as inline code, not as a fence (all of its text kept)", () => {
    for (const [source, code] of [["```npm install --save my_pkg```", "npm install --save my_pkg"], ["```js const x```", "js const x"]] as const) {
      const { text, marks } = readable(source);
      expect(text).toBe(code);
      expect(marked(text, marks)).toEqual([{ type: "code", text: code }]);
    }
    const middle = readable("먼저\n```npm test```\n그다음 **끝**");
    expect(middle.text).toBe("먼저\nnpm test\n그다음 끝");
    expect(marked(middle.text, middle.marks)).toEqual([{ type: "code", text: "npm test" }, { type: "bold", text: "끝" }]);
  });

  it("keeps a line with | above a --- rule as written (not a table), and a table with no rows keeps its header", () => {
    expect(readable("성공 12건 | 실패 0건\n---\n자세한 건 로그에.").text).toBe("성공 12건 | 실패 0건\n──────\n자세한 건 로그에.");
    expect(readable("a | b\n---").text).toBe("a | b\n──────");
    const empty = readable("| 항목 | 값 |\n|---|---|");
    expect(empty.text).toBe("항목 · 값");
    expect(marked(empty.text, empty.marks)).toEqual([{ type: "bold", text: "항목 · 값" }]);
  });

  it("links http(s) addresses only; anything else stays as written", () => {
    const { text, marks } = readable("[문서](https://example.com/a_b) 와 [로컬](file:///etc/passwd) 그리고 <https://example.org>");
    expect(text).toBe("문서 와 [로컬](file:///etc/passwd) 그리고 https://example.org");
    expect(marked(text, marks)).toEqual([{ type: "link", text: "문서", url: "https://example.com/a_b" }]);
    // An address keeps its own parentheses; one with a space or a title is shown as written.
    const wiki = readable("[위키](https://ko.wikipedia.org/wiki/A_(B)) 끝");
    expect(wiki.text).toBe("위키 끝");
    expect(marked(wiki.text, wiki.marks)).toEqual([{ type: "link", text: "위키", url: "https://ko.wikipedia.org/wiki/A_(B)" }]);
    for (const source of ["[x](https://x.com/a b)", "[x](<https://x.com/a b>)", "[x](https://x.com \"제목\")"]) expect(readable(source)).toEqual({ text: source, marks: [] });
  });

  it("writes a link's address after its words where the link cannot be a link (inside a quote), and in the plain version", () => {
    const quoted = readable("> 보세요 [문서](https://a.example/d) 여기");
    expect(quoted.text).toBe("보세요 문서 (https://a.example/d) 여기");
    expect(marked(quoted.text, quoted.marks)).toEqual([{ type: "quote", text: "보세요 문서 (https://a.example/d) 여기" }]);
    const linked = readable("[문서](https://a.example/d) 끝");
    expect(plain(linked)).toBe("문서 (https://a.example/d) 끝");
  });

  it("turns a table into its header as a bold line and a bullet per row, every cell once", () => {
    const { text, marks } = readable("| 항목 | 상태 | 비고 |\n|---|:---:|---|\n| 예산 | **끝남** | 3쪽 |\n| 일정 | 진행 | |");
    expect(text).toBe("항목 · 상태 · 비고\n• 예산 · 끝남 · 3쪽\n• 일정 · 진행");
    expect(marked(text, marks)).toEqual([{ type: "bold", text: "항목 · 상태 · 비고" }, { type: "bold", text: "끝남" }]);
  });

  it("drops formatting the messenger would refuse to nest (code inside a quote or a link, a quote in a quote)", () => {
    const { text, marks } = readable("> `코드` 와 **굵게**\n\n**[링크 `x`](https://a.example)**");
    valid(text, marks);
    expect(marked(text, marks).map((mark) => mark.type).sort()).toEqual(["bold", "bold", "link", "quote"]);
  });

  it("counts offsets in UTF-16 units (emoji and Hangul)", () => {
    const { text, marks } = readable("😀 **한글**");
    expect(text).toBe("😀 한글");
    expect(marks).toEqual([{ type: "bold", offset: 3, length: 2 }]);
  });

  it("is total: any text gives a message the stand-in Bot API accepts, with all of its content (hard inputs)", () => {
    for (const source of HARD) {
      const { text, marks } = readable(source);
      if (text.trim()) valid(text, marks);
      keeps(source, [{ text, marks }]);
      keeps(source, [{ text: plain({ text, marks }), marks: [] }], marks);
    }
  });

  it(`is total over ${GENERATED} generated inputs (seeded): valid, every character kept in order, formatted, plain and cut alike`, () => {
    const random = seeded(20261113);
    for (let round = 0; round < GENERATED; round += 1) {
      const source = Array.from({ length: 1 + Math.floor(random() * 30) }, () => PIECES[Math.floor(random() * PIECES.length)]).join("");
      const { text, marks } = readable(source);
      if (text.trim()) valid(text, marks);
      keeps(source, [{ text, marks }]);
      keeps(source, [{ text: plain({ text, marks }), marks: [] }], marks);
      const parts = splitRich(text, marks, 40 + Math.floor(random() * 60));
      for (const part of parts) valid(part.text, part.marks);
      keeps(source, parts);
      keeps(source, parts.map((part) => ({ text: plain(part), marks: [] })), marks);
    }
  });
});

const GENERATED = 400;
/** Shapes that lost content or changed it before (review C1, C2, I2, M1–M3) and their neighbours. */
const HARD = [
  "```npm install --save my_pkg```", "```js const x```", "앞\n```npm test```\n뒤", "```python title=x\nprint(1)\n```",
  "성공 12건 | 실패 0건\n---\n자세한 건 로그에.", "a | b\n---", "상태: 완료 | 남은 일: 없음\n\n---\n끝", "| 항목 | 값 |\n|---|---|", "| a |\n|---|\n| b |",
  "__init__.py 를 고쳤습니다", "2*3*4 = 24", "a*b*c", "1~~2~~3", "~~지움~~", "my_file_name.py", "_private_var", "foo_bar_ 다음",
  "[위키](https://ko.wikipedia.org/wiki/A_(B))", "[x](https://x.com/a b)", "[x](<https://x.com/a b>)", "[x](https://x.com \"제목\")",
  "C:\\Users\\me\\[draft]_v1.txt", "\\d+\\.\\d+", "\\*별\\*", "1) 첫째", ">>> python", "#", "# ", "+ 3 = 5", "- 5도", "- [x] 끝남",
  "```", "```\n```", "**", "* * *", "___", "> [링크](https://a.example) 안", "**[링크 `x`](https://a.example)**", "😀 **한글** `코드`",
  "`a ``b`` c`", "<https://example.org>", "[](https://a.example)", "[ ](https://a.example)", "*기울임*과 **굵게**입니다",
];
const PIECES = ["*", "**", "***", "_", "__", "~~", "`", "``", "```", "```js", "[", "](", ")", "(", "<", ">", "&", "\\", "#", "# ", "- ", "1) ", "> ", "|", " | ", "---", "\n", "\n", " ", " ", "가나", "word", "x", "2", "😀", "https://a.example/p_(q)", "[링크](https://a.example)", "C:\\dir\\f.txt", "__init__"];
/** A small seeded generator (mulberry32): the same cases on every run. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const keeps = (source: string, parts: { text: string; marks: Mark[] }[], shown?: Mark[]) => expect({ source, problem: contentProblem(source, parts, shown) }).toEqual({ source, problem: null });

describe("cutting a formatted text into messages", () => {
  it("cuts the text, not the markup: each part at most the limit, every mark inside its part", () => {
    const source = `머리말 **굵게**\n\n\`\`\`\n${Array.from({ length: 60 }, (_, index) => `line ${index} *x*`).join("\n")}\n\`\`\`\n\n끝 **맺음**`;
    const { text, marks } = readable(source);
    const parts = splitRich(text, marks, 200);
    expect(parts.length).toBeGreaterThan(3);
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(200);
      expect(part.text).toBe(part.text.trim());
      valid(part.text, part.marks);
    }
    // The code block goes on as code in every part it reaches.
    expect(parts.filter((part) => part.marks.some((mark) => mark.type === "pre")).length).toBeGreaterThan(2);
    expect(parts.map((part) => part.text).join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
    expect(marked(parts.at(-1)!.text, parts.at(-1)!.marks).at(-1)).toEqual({ type: "bold", text: "맺음" });
  });

  it("never cuts inside an emoji, and keeps a mark over a cut on both sides", () => {
    const text = `${"가".repeat(9)}😀${"나".repeat(20)}`;
    const parts = splitRich(text, [{ type: "bold", offset: 0, length: text.length }], 10);
    expect(parts[0]!.text).toBe("가".repeat(9));
    expect(parts[1]!.text.startsWith("😀")).toBe(true);
    parts.forEach((part, index) => expect(part.marks).toEqual([{ type: "bold", offset: 0, length: part.text.length, ...(index < parts.length - 1 ? { continues: true } : {}) }]));
  });
});

// Re-review 1 (R1-C1, R1-I1, R1-I3): the exact text a person receives. Stars in paths, globs, pointers
// and powers are data; so are a link's address when something else in the answer was hidden, and the
// long answer's file when a hidden value was split by markup.
describe("stars that are not emphasis stay as typed (exact text)", () => {
  it.each([
    ["src/*.ts 와 test/*.ts 를 봤습니다"],
    ["apps/*/src, packages/*/src"],
    ["src/**/*.ts 와 lib/**/*.js"],
    ["f(*a) 와 g(*b)"],
    ["(*p)++ 후 (*q)--"],
    ["x**2 + y**2"],
    ["2**10 = 1024, 2**20 = 1048576"],
    ["a**b**c"],
    ["int *p, *q; 그리고 char **argv"],
    ["SELECT * FROM t WHERE a * b > 1"],
  ])("%s", (source) => {
    const { text, marks } = readable(source);
    expect(text).toBe(source);
    expect(marks.filter((mark) => mark.type === "bold" || mark.type === "italic")).toEqual([]);
  });

  it("real emphasis is still emphasis, also against Hangul and inside brackets and quotes", () => {
    expect(readable("이것은 **굵게**입니다").text).toBe("이것은 굵게입니다");
    expect(readable("한글**굵게**와 *기울임* 그리고 (**괄호 안**)").text).toBe("한글굵게와 기울임 그리고 (괄호 안)");
    expect(readable("**개발:** 코드 수정").text).toBe("개발: 코드 수정");
    expect(readable("- **문서:** Markdown").text).toContain("문서: Markdown");
  });
});

describe("what leaves when something in the answer was hidden", () => {
  const scrub = (text: string) => text.replaceAll("zz-secret-format-0001", "[비밀: 도서관]");
  it("a link's address is written out, not dropped", () => {
    const out = formatted("둘째 [문서](https://docs.example/b) 와 zz-secret-format-0001", scrub);
    expect(out.marks).toBeUndefined();
    expect(out.text).toContain("https://docs.example/b");
    expect(out.text).toContain("[비밀: 도서관]");
    expect(out.text).not.toContain("zz-secret-format-0001");
  });
  it("the long answer's file never carries a value the markup had split", () => {
    const split = "키는 zz-secret-**format-0001** 입니다\n\n```\ncode\n```";
    const file = answerFile(split, scrub);
    expect(file).not.toContain("format-0001");
    expect(file).toContain("[비밀: 도서관]");
    // Signs that are data (a star after a letter is not emphasis) must not hide a value from the redactor either.
    expect(answerFile("키는 zz-secret-format**-0001** 입니다", scrub)).not.toMatch(/format\**-0001/);
    // A value with underscores of its own, split by stars after a letter.
    const under = (text: string) => text.replaceAll("zz_secret_pass_0010", "[비밀: 포털]");
    expect(answerFile("zz_secret**_pass_0010** 입니다", under)).toBe("[비밀: 포털] 입니다");
    expect(formatted("zz_secret**_pass_0010** 입니다", under).text).toBe("[비밀: 포털] 입니다");
    expect(formatted("키는 zz-secret-format**-0001** 입니다", scrub).text).not.toMatch(/format\**-0001/);
    expect(formatted("키는 zz-secret-format**-0001** 입니다", scrub).text).toContain("[비밀: 도서관]");
    // Nothing hidden: the file is the markdown as written.
    const calm = "## 제목\n\n**굵게** 와 `code`";
    expect(answerFile(calm, scrub)).toBe(calm);
  });
});
