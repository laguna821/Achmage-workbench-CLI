import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { appendEntry, applySpan, entryEdit, FrontmatterEditError, keyEdit, keyShapes, newNote, noteFileName, notePreview, readNote, runEdit, setBody, setEntryDone, setFrontmatterKey, verifyKeyEdit, verifySpan, yamlKey } from "./project-note.ts";

// A project note is changed the way a person would change it: one key or one line, every other byte
// as it was (other keys, their order and quoting, blank lines, line endings, the body).

const NOTE = [
  "---",
  "workbench_id: w1",
  '"DIKM_단계:":',
  "  - 🔵 I",
  "tags: [강의, 2026-2학기]",
  "aliases:",
  "단계: 진행중",
  "---",
  "",
  "# 안녕",
  "",
  "본문 첫 줄 — 그대로 남아야 한다.  ",
  "",
].join("\n");

describe("front matter keys", () => {
  it("changes one key in place and leaves every other byte alone", () => {
    const next = setFrontmatterKey(NOTE, "단계", ["보류"]);
    expect(next).toBe(NOTE.replace("단계: 진행중", "단계: 보류"));
  });

  it("keeps a list's shape: inline stays inline, block stays block, a new list key is a block", () => {
    expect(setFrontmatterKey(NOTE, "tags", ["강의", "평가"])).toContain("tags: [강의, 평가]\n");
    expect(setFrontmatterKey(NOTE, "DIKM_단계:", ["🟣 K"])).toContain('"DIKM_단계:":\n  - 🟣 K\ntags: [강의, 2026-2학기]\n');
    const added = setFrontmatterKey(NOTE, "관련", ["[[가을 특강]]"]);
    expect(added).toContain('단계: 진행중\n관련:\n  - "[[가을 특강]]"\n---\n');
    expect(added.endsWith("본문 첫 줄 — 그대로 남아야 한다.  \n")).toBe(true);
  });

  it("removes a key with null and quotes keys that need it", () => {
    expect(setFrontmatterKey(NOTE, "aliases", null)).not.toContain("aliases");
    expect(yamlKey("마감")).toBe("마감");
    expect(yamlKey("DIKM_단계:")).toBe('"DIKM_단계:"');
    expect(setFrontmatterKey(NOTE, "다음: 할 일", ["x"])).toContain('"다음: 할 일": x\n');
  });

  it("gives a note without front matter one, keeping a BOM and CRLF line endings", () => {
    expect(setFrontmatterKey("본문\n", "단계", ["할일"])).toBe("---\n단계: 할일\n---\n본문\n");
    const crlf = "﻿---\r\nworkbench_id: w1\r\n---\r\n본문\r\n";
    expect(setFrontmatterKey(crlf, "단계", ["완료"])).toBe("﻿---\r\nworkbench_id: w1\r\n단계: 완료\r\n---\r\n본문\r\n");
  });
});

describe("reading a note", () => {
  it("reads keys as written (without the machine key), stage, tags, decisions and open questions", () => {
    const text = appendEntry(appendEntry(appendEntry(NOTE, "decision", "표지는 B안"), "question", "과제 마감 연장?"), "decision", "루브릭 3단계");
    const note = readNote(text);
    expect(note.id).toBe("w1");
    expect(note.properties.map(([key]) => key)).toEqual(["DIKM_단계:", "tags", "aliases", "단계"]);
    expect(note.stage).toBe("진행중");
    expect(note.tags).toEqual(["강의", "2026-2학기"]);
    expect(note.decisions.map((entry) => entry.text)).toEqual(["표지는 B안", "루브릭 3단계"]);
    expect(note.questions).toEqual([{ line: expect.any(Number), text: "과제 마감 연장?", done: false }]);
    expect(note.body.startsWith("\n# 안녕")).toBe(true);
    // The note's own words: the body without the two sections.
    expect(note.free).not.toMatch(/## 결정|표지는 B안|## 열린 질문|과제 마감/);
    expect(note.free).toContain("# 안녕");
    expect(note.problem).toBeNull();
  });

  it("says when the front matter is not closed", () => {
    expect(readNote("---\n단계: 할일\n본문\n").problem).toMatch(/닫히지 않았습니다/);
  });

  it("ignores headings inside code blocks", () => {
    const text = "---\nworkbench_id: w1\n---\n```\n## 결정\n- 코드 속\n```\n";
    expect(readNote(text).decisions).toEqual([]);
  });
});

describe("decisions and open questions", () => {
  it("makes the section when missing (decisions before open questions) and appends after the last item", () => {
    const withQuestion = appendEntry(NOTE, "question", "열린 것");
    expect(withQuestion.endsWith("본문 첫 줄 — 그대로 남아야 한다.  \n\n## 열린 질문\n- [ ] 열린 것\n")).toBe(true);
    const both = appendEntry(withQuestion, "decision", "정한 것");
    expect(both.indexOf("## 결정")).toBeLessThan(both.indexOf("## 열린 질문"));
    const more = appendEntry(both, "decision", "또 정한 것");
    expect(more).toContain("## 결정\n- 정한 것\n- 또 정한 것\n");
  });

  it("ticks an open question on its line only", () => {
    const text = appendEntry(NOTE, "question", "열린 것");
    const line = readNote(text).questions[0]!.line;
    const ticked = setEntryDone(text, line, true);
    expect(readNote(ticked).questions[0]!.done).toBe(true);
    expect(ticked.replace("- [x] 열린 것", "- [ ] 열린 것")).toBe(text);
    expect(() => setEntryDone(text, 0, true)).toThrow();
  });

  it("keeps the line endings of the file", () => {
    const crlf = "---\r\nworkbench_id: w1\r\n---\r\n본문\r\n";
    expect(appendEntry(crlf, "decision", "x")).toBe("---\r\nworkbench_id: w1\r\n---\r\n본문\r\n\r\n## 결정\r\n- x\r\n");
  });
});

describe("files", () => {
  it("replaces the body and keeps the front matter byte for byte", () => {
    expect(setBody(NOTE, "새 본문\n")).toBe(NOTE.slice(0, NOTE.indexOf("\n# 안녕")) + "새 본문\n");
  });

  it("names the file from the project name without path characters", () => {
    expect(noteFileName("1주차/강의: 소개")).toBe("1주차 강의 소개.md");
    expect(noteFileName("  ")).toBe("프로젝트.md");
    expect(noteFileName("..숨김")).toBe("숨김.md");
    expect(newNote("w1")).toBe("---\nworkbench_id: w1\n---\n");
  });
});

// A note as the user's vault has them: keys ending in a colon (single and double quoted), comments,
// a block scalar, a nested map, empty and null values, inline and block lists, CRLF line endings,
// unknown keys in their own order. Editing one value from the project page must leave every byte
// outside that value as it was, so Obsidian reads the rest exactly as before.
const VAULT = [
  "---",
  "workbench_id: w1",
  "'DIKM_단계:': 🟢 D",
  '"출처:": "[[원문 노트]]"',
  "# 사람이 단 주석",
  "summary: |",
  "  첫 줄",
  "  둘째 줄",
  "meta:",
  "  owner: 나",
  "  depth: 2",
  "종류: 강의",
  "마감일: '2026-11-20'",
  "빈값:",
  "없음: ~",
  "tags: [강의, \"AI 글쓰기\"]",
  "aliases:",
  "  - 3주차",
  "  - 슬라이드",
  "단계: 진행중   ",
  "---",
  "",
  "# 3주차",
  "",
  "본문은 \t공백까지 그대로.  ",
  "",
  "## 결정",
  "- 2026-11-12 루브릭 세 단계",
  "",
].join("\r\n");

/** The text with the lines from `start` up to `end` (exclusive) replaced: what "only this value changed" means. */
const spliceLines = (text: string, start: string, end: string, replacement: string) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  return text.slice(0, from) + replacement + text.slice(to);
};

describe("a vault note round trip", () => {
  it("changes only the edited value of a scalar key, keeping its shape", () => {
    // A list-kind property written to a key that is a scalar stays a scalar with one value.
    const next = setFrontmatterKey(VAULT, "종류", ["세미나"], { list: true });
    expect(next).toBe(spliceLines(VAULT, "종류: 강의", "마감일:", "종류: 세미나\r\n"));
    expect(setFrontmatterKey(VAULT, "마감일", ["2026-11-27"])).toBe(spliceLines(VAULT, "마감일:", "빈값:", "마감일: '2026-11-27'\r\n"));
  });

  it("keeps a key's own spelling, single-quoted keys ending in a colon included", () => {
    const next = setFrontmatterKey(VAULT, "DIKM_단계:", ["🔵 I"]);
    expect(next).toBe(spliceLines(VAULT, "'DIKM_단계:'", '"출처:"', "'DIKM_단계:': 🔵 I\r\n"));
    expect(setFrontmatterKey(VAULT, "출처:", ["[[다른 노트]]"])).toBe(spliceLines(VAULT, '"출처:"', "# 사람이", '"출처:": "[[다른 노트]]"\r\n'));
  });

  it("keeps a list a list, inline or block, even with one value left", () => {
    expect(setFrontmatterKey(VAULT, "aliases", ["3주차"])).toBe(spliceLines(VAULT, "aliases:", "단계:", "aliases:\r\n  - 3주차\r\n"));
    expect(setFrontmatterKey(VAULT, "tags", ["강의"])).toBe(spliceLines(VAULT, "tags:", "aliases:", "tags: [강의]\r\n"));
  });

  it("fills an empty key in place and leaves the unknown keys, comments and block values alone", () => {
    const next = setFrontmatterKey(VAULT, "빈값", ["채움"]);
    expect(next).toBe(spliceLines(VAULT, "빈값:", "없음:", "빈값: 채움\r\n"));
    expect(readNote(next).properties.map(([key]) => key)).toEqual(readNote(VAULT).properties.map(([key]) => key));
  });

  it("adds a new key last, before the closing line, and removes one without touching its neighbours", () => {
    expect(setFrontmatterKey(VAULT, "중요도", ["높음"])).toBe(VAULT.replace("단계: 진행중   \r\n---", "단계: 진행중   \r\n중요도: 높음\r\n---"));
    expect(setFrontmatterKey(VAULT, "meta", null)).toBe(spliceLines(VAULT, "meta:", "종류:", ""));
  });

  it("stays YAML a vault reads: every edit parses, keeps the other keys' values and the key order", () => {
    const yamlOf = (text: string) => parseYaml(text.slice(text.indexOf("\n") + 1, text.indexOf("\r\n---", 4))) as Record<string, unknown>;
    const before = yamlOf(VAULT);
    let text = VAULT;
    text = setFrontmatterKey(text, "DIKM_단계:", ["🔵 I"]);
    text = setFrontmatterKey(text, "종류", ["세미나"], { list: true });
    text = setFrontmatterKey(text, "tags", ["강의", "AI 글쓰기", "평가"]);
    text = setFrontmatterKey(text, "중요도", ["높음"]);
    text = setBody(text, "\r\n새 본문\r\n");
    const after = yamlOf(text);
    expect(Object.keys(after)).toEqual([...Object.keys(before), "중요도"]);
    expect(after).toMatchObject({ "DIKM_단계:": "🔵 I", "출처:": "[[원문 노트]]", summary: before.summary, meta: before.meta, 종류: "세미나", 마감일: "2026-11-20", tags: ["강의", "AI 글쓰기", "평가"], aliases: ["3주차", "슬라이드"], 중요도: "높음" });
  });

  it("writes a new body with the front matter byte for byte, and the same body leaves the file as it was", () => {
    // The body is everything after the closing `---` line, its first blank line included.
    const head = VAULT.slice(0, VAULT.indexOf("---\r\n\r\n# 3주차") + 5);
    expect(setBody(VAULT, "새 본문\r\n")).toBe(head + "새 본문\r\n");
    expect(setBody(VAULT, readNote(VAULT).body)).toBe(VAULT);
  });
});

describe("a list's preview line", () => {
  it("is the note's first own words, without headings, marks or links", () => {
    expect(notePreview("\n## 목표\n\n- [ ] **형성평가** 루브릭을 [[가을 특강|특강]]에 붙인다\n둘째 줄\n")).toBe("형성평가 루브릭을 특강에 붙인다");
    expect(notePreview("> [!NOTE] 질문에서 시작하는 [글쓰기](https://example.com) 수업\n")).toBe("질문에서 시작하는 글쓰기 수업");
    expect(notePreview("---\n| 주차 | 내용 |\n```\ncode\n```\n끝 줄\n")).toBe("끝 줄");
    expect(notePreview("# 제목만\n\n")).toBeNull();
    expect(notePreview("가".repeat(200))).toBe(`${"가".repeat(139)}…`);
  });
});

// Review round 1: a property edit replaces only that value's own text, never changes its shape, and
// refuses what the page cannot edit safely (block scalars, folded scalars, maps, anchors, comments).
describe("values the page must not reshape", () => {
  const refused = (text: string, key: string, values: string[] | null = ["새 값"], how = {}) => {
    try {
      setFrontmatterKey(text, key, values, how);
    } catch (error) {
      return error instanceof FrontmatterEditError ? error.code : "other";
    }
    return "written";
  };

  it("refuses a block scalar with a blank line (it used to write invalid YAML)", () => {
    const text = "---\nsummary: |\n  첫 줄\n\n  셋째 줄\nnext: x\n---\n";
    expect(refused(text, "summary")).toBe("opaque");
    // Removing it whole still leaves valid YAML and the next key.
    const removed = setFrontmatterKey(text, "summary", null);
    expect(removed).toBe("---\nnext: x\n---\n");
    expect(parseYaml(removed.slice(4, removed.indexOf("\n---", 4)))).toEqual({ next: "x" });
  });

  it("refuses multi-line strings and maps rather than turning them into lists", () => {
    expect(refused(VAULT, "summary")).toBe("opaque");
    expect(refused(VAULT, "meta")).toBe("opaque");
    expect(refused("---\n목표: 아주 긴 문장이\n  다음 줄로 이어짐\n---\n", "목표")).toBe("opaque");
    expect(refused("---\nfolded: >-\n  한 줄\n---\n", "folded")).toBe("opaque");
    expect(refused("---\nbase: &a x\n---\n", "base")).toBe("opaque");
    // A comment line in a block list is outside every item's span: the list stays editable, the comment as written.
    expect(setFrontmatterKey("---\ntags:\n  # 주석\n  - a\n---\n", "tags", ["b"], { list: true })).toBe("---\ntags:\n  # 주석\n  - b\n---\n");
    expect(refused("---\nmap: {a: 1}\n---\n", "map")).toBe("opaque");
  });

  it("keeps a scalar a scalar: two values for it are refused, not reshaped", () => {
    expect(refused(VAULT, "종류", ["강의", "세미나"], { list: true })).toBe("shape");
  });

  it("keeps a trailing comment and the quoting style where the new value allows it", () => {
    expect(setFrontmatterKey("---\n종류: 강의 # 주석\n---\n", "종류", ["세미나"])).toBe("---\n종류: 세미나 # 주석\n---\n");
    expect(setFrontmatterKey(VAULT, "마감일", ["2026-11-27"])).toContain("마감일: '2026-11-27'\r\n");
    expect(setFrontmatterKey('---\na: "x"\n---\n', "a", ["y"])).toBe('---\na: "y"\n---\n');
  });

  it("says each key's shape, so the page offers an editor only where it is safe", () => {
    expect(keyShapes(VAULT)).toMatchObject({ "DIKM_단계:": "scalar", summary: "opaque", meta: "opaque", 종류: "scalar", 빈값: "empty", 없음: "empty", tags: "flow", aliases: "block", 단계: "scalar" });
  });

  it("refuses a write when anything but the edited key would read differently", () => {
    const before = "---\na: 1\nb: 2\n---\n";
    expect(() => verifyKeyEdit(before, "---\na: 3\nb: 2\n---\n", "a")).not.toThrow();
    expect(() => verifyKeyEdit(before, "---\na: 3\nb: 5\n---\n", "a")).toThrow(FrontmatterEditError);
    expect(() => verifyKeyEdit(before, "---\na: 3\nb: [2\n---\n", "a")).toThrow(FrontmatterEditError);
    expect(() => verifyKeyEdit(before, "---\nb: 2\na: 3\n---\n", "a")).toThrow(FrontmatterEditError);
  });

  it("calls front matter a vault cannot read a problem (bad indentation, duplicate keys)", () => {
    expect(readNote("---\na: 1\n  b: : 2\n---\n").problem).toMatch(/YAML/);
    expect(readNote("---\na: 1\na: 2\n---\n").problem).toMatch(/YAML/);
    expect(readNote(VAULT).problem).toBeNull();
  });
});

// The note's own words are edited run by run: a run is a stretch of the body outside the
// `## 결정` / `## 열린 질문` sections; replacing one leaves every other byte as it was.
describe("the note's words, run by run", () => {
  const NOTE_WITH_SECTIONS = "---\nworkbench_id: w\n---\n머리말\n\n## 결정\n- 2026-11-12 정함\n\n## 메모\n아래 메모\n";

  it("splits the body into runs around the decision and question sections", () => {
    const runs = readNote(NOTE_WITH_SECTIONS).runs;
    // The blank line after the decision list belongs to that section.
    expect(runs.map((run) => run.text)).toEqual(["머리말\n\n", "## 메모\n아래 메모\n"]);
    for (const run of runs) expect(NOTE_WITH_SECTIONS.slice(run.start, run.end)).toBe(run.text);
  });

  it("replaces one run and keeps the front matter, the sections and the other run byte for byte", () => {
    const [first, second] = readNote(NOTE_WITH_SECTIONS).runs;
    const span = runEdit(NOTE_WITH_SECTIONS, 1, second!.text, "## 메모\n고친 메모\n");
    const next = applySpan(NOTE_WITH_SECTIONS, span);
    expect(next).toBe(NOTE_WITH_SECTIONS.replace("아래 메모", "고친 메모"));
    expect(next.slice(0, second!.start)).toBe(NOTE_WITH_SECTIONS.slice(0, second!.start));
    verifySpan(NOTE_WITH_SECTIONS, next, span, { kind: "body" });
    expect(() => runEdit(NOTE_WITH_SECTIONS, 0, "다른 글", "x")).toThrow(FrontmatterEditError);
    void first;
  });

  it("round-trips CRLF, a BOM and a missing final newline exactly", () => {
    for (const text of ["\uFEFF---\r\nworkbench_id: w\r\n---\r\n본문\r\n둘째 줄", "본문만\r\n없는 끝줄", "\uFEFF본문"]) {
      const run = readNote(text).runs[0]!;
      expect(text.slice(run.start, run.end)).toBe(run.text);
      expect(applySpan(text, runEdit(text, 0, run.text, run.text))).toBe(text);
      expect(text.startsWith("\uFEFF")).toBe(run.start >= 1);
    }
  });

  it("gives an empty note one empty run where new words go: before the sections", () => {
    const text = "---\nworkbench_id: w\n---\n## 결정\n- 정함\n";
    const runs = readNote(text).runs;
    expect(runs[0]).toEqual({ start: text.indexOf("## 결정"), end: text.indexOf("## 결정"), text: "" });
  });
});

// Review round 2.
describe("list items keep their own text", () => {
  it("adds to a flow list without unquoting an item that holds a comma", () => {
    const text = '---\na: ["x, y", z]\n---\n';
    const next = setFrontmatterKey(text, "a", ["x, y", "z", "w"], { list: true });
    expect(next).toBe('---\na: ["x, y", z, w]\n---\n');
    expect(parseYaml(next.slice(4, next.indexOf("\n---", 4)))).toEqual({ a: ["x, y", "z", "w"] });
  });

  it("quotes a new flow item only when it needs it, and removes exactly one item", () => {
    expect(setFrontmatterKey("---\na: [x, 'y']\n---\n", "a", ["x", "y", "p, q"], { list: true })).toBe("---\na: [x, 'y', \"p, q\"]\n---\n");
    // An item goes with its own separator (the one after it), nothing else moves.
    expect(setFrontmatterKey('---\na: ["x, y",  z,w]\n---\n', "a", ["x, y", "w"], { list: true })).toBe('---\na: ["x, y",  w]\n---\n');
  });

  it("keeps each block item line as written when another is added or removed", () => {
    const text = "---\ntags:\n    -   'a b'\n    -   \"c\"\n---\n";
    expect(setFrontmatterKey(text, "tags", ["a b", "c", "d"], { list: true })).toBe("---\ntags:\n    -   'a b'\n    -   \"c\"\n    -   d\n---\n");
    expect(setFrontmatterKey(text, "tags", ["c"], { list: true })).toBe("---\ntags:\n    -   \"c\"\n---\n");
  });

  it("refuses a write whose edited key would not read as intended", () => {
    expect(() => verifyKeyEdit("---\na: [x]\n---\n", "---\na: [x, y, w]\n---\n", "a", ["x, y", "w"])).toThrow(FrontmatterEditError);
    expect(() => verifyKeyEdit("---\na: [x]\n---\n", '---\na: ["x, y", w]\n---\n', "a", ["x, y", "w"])).not.toThrow();
    expect(() => verifyKeyEdit("---\nn: 1\n---\n", "---\nn: 3\n---\n", "n", ["3"])).not.toThrow();
    expect(() => verifyKeyEdit("---\nn: 1\n---\n", "---\n---\n", "n", null)).not.toThrow();
  });

  it("marks a block list written at column 0 as not editable", () => {
    expect(keyShapes("---\na:\n- x\n- y\nb: 1\n---\n")).toMatchObject({ a: "opaque", b: "scalar" });
  });
});

describe("a run never breaks the section after it", () => {
  const ONLY = "---\nworkbench_id: x\n---\n## 결정\n- 2026-11-12 정함\n\n## 열린 질문\n- [ ] 언제?\n";
  const write = (text: string, runIndex: number, typed: string) => {
    const run = readNote(text).runs[runIndex]!;
    const span = runEdit(text, runIndex, run.text, typed);
    const next = applySpan(text, span);
    verifySpan(text, next, span, { kind: "body" });
    return next;
  };

  it("writes the first words of a note with only sections on their own lines before the heading", () => {
    const next = write(ONLY, 0, "첫 문장");
    expect(next).toBe(ONLY.replace("## 결정", "첫 문장\n\n## 결정"));
    expect(readNote(next).decisions.map((entry) => entry.text)).toEqual(["2026-11-12 정함"]);
  });

  it("keeps the separator before the heading when the last paragraph is retyped without it", () => {
    const text = "---\nworkbench_id: x\n---\n문단\n\n## 결정\n- a\n";
    expect(write(text, 0, "새 문단")).toBe(text.replace("문단\n\n", "새 문단\n\n"));
    expect(write(text, 0, "새 문단\n\n\n")).toBe(text.replace("문단\n\n", "새 문단\n\n"));
    const tight = "---\nworkbench_id: x\n---\n문단\n## 결정\n- a\n";
    expect(write(tight, 0, "새 문단")).toBe(tight.replace("문단\n", "새 문단\n"));
  });

  it("uses the file's own line ending, and leaves a last run (nothing after it) as typed", () => {
    const crlf = ONLY.replace(/\n/g, "\r\n");
    expect(write(crlf, 0, "첫 문장")).toBe(crlf.replace("## 결정", "첫 문장\r\n\r\n## 결정"));
    const tail = "---\nworkbench_id: x\n---\n## 결정\n- a\n\n## 메모\n끝";
    const memo = readNote(tail).runs.at(-1)!;
    expect(applySpan(tail, runEdit(tail, readNote(tail).runs.length - 1, memo.text, "## 메모\n고친 끝"))).toBe("---\nworkbench_id: x\n---\n## 결정\n- a\n\n## 메모\n고친 끝");
  });

  it("refuses a run that would change the sections (a typed ## 결정 heading), leaving the text as it was", () => {
    const text = "---\nworkbench_id: x\n---\n문단\n\n## 결정\n- a\n";
    expect(() => write(text, 0, "## 결정\n- 가짜\n")).toThrow(FrontmatterEditError);
  });
});

// Review round 3: an edit is exactly one declared span of the current bytes.
describe("one declared span", () => {
  const apply = (text: string, span: ReturnType<typeof keyEdit>) => applySpan(text, span!);

  it("adds to a block list after an item that has its own comment, keeping that item as written", () => {
    const text = '---\na:\n  - "q" # why\n  - r\n---\n';
    const span = keyEdit(text, "a", { add: "s" });
    expect(apply(text, span)).toBe('---\na:\n  - "q" # why\n  - r\n  - s\n---\n');
    expect(span!.end - span!.start).toBe(0);
  });

  it("keeps tags written with # as written when another is added, removed or renamed", () => {
    const flow = '---\ntags: ["#회의", 강의]\n---\n';
    expect(apply(flow, keyEdit(flow, "tags", { add: "새값" }))).toBe('---\ntags: ["#회의", 강의, 새값]\n---\n');
    expect(apply(flow, keyEdit(flow, "tags", { remove: "강의" }))).toBe('---\ntags: ["#회의"]\n---\n');
    const block = "---\ntags:\n  - \"#회의\"\n  - a b\n---\n";
    expect(apply(block, keyEdit(block, "tags", { add: "c" }))).toBe("---\ntags:\n  - \"#회의\"\n  - a b\n  - c\n---\n");
    expect(apply(block, keyEdit(block, "tags", { rename: ["a b", "d"] }))).toBe("---\ntags:\n  - \"#회의\"\n  - d\n---\n");
  });

  it("splits a single-quoted flow item with a comma correctly", () => {
    const text = "---\na: ['x, y', z]\n---\n";
    expect(apply(text, keyEdit(text, "a", { add: "w" }))).toBe("---\na: ['x, y', z, w]\n---\n");
    expect(apply(text, keyEdit(text, "a", { remove: "z" }))).toBe("---\na: ['x, y']\n---\n");
  });

  it("keeps a scalar's trailing comment when its value is emptied", () => {
    const text = "---\na: x # c\n---\n";
    expect(apply(text, keyEdit(text, "a", { set: [] }))).toBe("---\na: # c\n---\n");
  });

  it("refuses a list change that is more than one item (a reorder)", () => {
    expect(() => keyEdit("---\na: [x, y]\n---\n", "a", { set: ["y", "x"] })).toThrow(FrontmatterEditError);
  });

  it("writes the first words of a properties-only note without a final newline on their own line", () => {
    const text = "---\nworkbench_id: x\n---";
    const span = runEdit(text, 0, "", "첫 문장");
    const next = applySpan(text, span);
    expect(next).toBe("---\nworkbench_id: x\n---\n첫 문장");
    expect(readNote(next).problem).toBeNull();
    verifySpan(text, next, span, { kind: "body" });
  });

  it("adds a decision to a properties-only note without a final newline on its own lines", () => {
    const text = "---\nworkbench_id: x\n---";
    const span = entryEdit(text, "decision", "2026-11-12 정함");
    const next = applySpan(text, span);
    expect(next).toBe("---\nworkbench_id: x\n---\n## 결정\n- 2026-11-12 정함\n");
    verifySpan(text, next, span, { kind: "body", section: "decision" });
  });

  it("refuses a result that is not the declared span, or that touches the front matter from the body", () => {
    const text = "---\nworkbench_id: x\n---\n본문\n";
    const span = runEdit(text, 0, "본문\n", "새 본문\n");
    expect(() => verifySpan(text, "---\nworkbench_id: y\n---\n새 본문\n", span, { kind: "body" })).toThrow(FrontmatterEditError);
    expect(() => verifySpan(text, applySpan(text, span) + "꼬리", span, { kind: "body" })).toThrow(FrontmatterEditError);
  });
});

// Review round 4 (I5): each of these fails when its one guard line is removed.
describe("the guard's two quiet branches", () => {
  it("refuses a body edit that would give a note without front matter one (a typed --- block)", () => {
    const text = "본문\n";
    const span = runEdit(text, 0, "본문\n", "---\nk: v\n---\n본문\n");
    expect(() => verifySpan(text, applySpan(text, span), span, { kind: "body" })).toThrow(/속성 부분이 바뀌어/);
    // With a BOM before the words, too.
    const bom = "\uFEFF본문\n";
    const second = runEdit(bom, 0, "본문\n", "---\nk: v\n---\n본문\n");
    expect(() => verifySpan(bom, applySpan(bom, second), second, { kind: "body" })).toThrow(/속성 부분이 바뀌어/);
  });

  it("refuses a key edit whose span lies outside the front matter, even when every key still reads the same", () => {
    const text = "---\nworkbench_id: x\nk: v\n---\n본문\n";
    const at = text.indexOf("본문");
    const span = { start: at, end: at + 2, replacement: "다른 말" };
    const after = applySpan(text, span);
    expect(after).toBe("---\nworkbench_id: x\nk: v\n---\n다른 말\n");
    expect(() => verifySpan(text, after, span, { kind: "key", key: "k", intended: ["v"] })).toThrow(/속성이 아닌 곳/);
    // The closing line is outside too.
    const close = text.indexOf("---\n본문");
    expect(() => verifySpan(text, text, { start: close, end: close + 3, replacement: "---" }, { kind: "key", key: "k", intended: ["v"] })).toThrow(/속성이 아닌 곳/);
  });
});
