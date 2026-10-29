import { describe, expect, it } from "vitest";
import { appendEntry, newNote, noteFileName, readNote, setBody, setEntryDone, setFrontmatterKey, yamlKey } from "./project-note.ts";

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
