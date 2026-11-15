import { describe, expect, it } from "vitest";
import { choiceLabel, clock, cutAt, parseCommand, shapeAnswer, takeChoices } from "./shape.ts";

describe("the words the channel takes as commands", () => {
  const cases: [text: string, command: string | null][] = [
    ["메뉴", "menu"], [" 메뉴 ", "menu"], ["/menu", "menu"],
    ["멈춰", "stop"], ["정지", "stop"], ["stop", "stop"], ["STOP", "stop"], ["/stop", "stop"], ["/stop@wb_7k3q9x_bot", "stop"],
    ["새 대화", "new"], ["/new", "new"],
    ["상태", "status"],
    ["잠금", "lock"],
    // Inside a sentence they are words for the AI.
    ["멈춰 줘", null], ["회의 상태 정리해 줘", null], ["메뉴 추천해 줘", null], ["새 대화 만들지 말고 여기서", null], ["잠금 화면 캡처해 줘", null], ["", null],
  ];
  it.each(cases)("%j → %s", (text, command) => {
    expect(parseCommand(text)?.command ?? null).toBe(command);
  });

  it("reads the one-time value of a pairing link", () => {
    expect(parseCommand("/start abcDEF_123-xyz0123456789")).toEqual({ command: "start", value: "abcDEF_123-xyz0123456789" });
    expect(parseCommand("/start")).toEqual({ command: "start", value: "" });
    expect(parseCommand("/start a b")).toBeNull();
  });
});

describe("a choice line at the end of an answer", () => {
  it("is taken off the answer and becomes its choices", () => {
    expect(takeChoices("표를 어디에 넣을까요?\n\n[[선택: 본문 끝 | 새 문서 | 넣지 않기]]")).toEqual({ text: "표를 어디에 넣을까요?", choices: ["본문 끝", "새 문서", "넣지 않기"] });
    expect(takeChoices("답\n[[선택: 예|아니요]]  \n")).toEqual({ text: "답", choices: ["예", "아니요"] });
  });

  it("is left alone when it is not the last line, has one choice, or more than four", () => {
    for (const text of ["[[선택: 가 | 나]]\n그리고 설명", "끝\n[[선택: 하나뿐]]", "끝\n[[선택: 1 | 2 | 3 | 4 | 5]]", "선택지가 없는 답"]) {
      expect(takeChoices(text)).toEqual({ text, choices: [] });
    }
  });

  it("keeps a long choice whole (it is what gets sent) and shortens only its button", () => {
    expect(takeChoices("끝\n[[선택: 짧게 | 열두 글자를 훌쩍 넘는 아주 긴 선택지]]").choices).toEqual(["짧게", "열두 글자를 훌쩍 넘는 아주 긴 선택지"]);
    expect(choiceLabel("짧게")).toBe("짧게");
    expect(choiceLabel("열두 글자를 훌쩍 넘는 아주 긴 선택지")).toBe("열두 글자를 훌쩍 넘는…");
  });
});

describe("an answer shaped for a small screen", () => {
  it("is sent whole when it is 900 characters or less", () => {
    const text = "3학년 27명을 「명단-3학년.xlsx」로 저장했습니다.\n\n한 일\n· 명단 읽음\n· 3학년만 남김\n\n가정한 것: 가장 최근 엑셀";
    expect(shapeAnswer(text)).toEqual({ text, more: false, choices: [] });
  });

  it("shows the opening paragraphs of a longer answer and says there is more", () => {
    const first = "강의계획서 초안을 만들었습니다.";
    const second = "한 일\n· 지난 학기 구조 참고\n· 주차별 주제 맞춤";
    const long = "가".repeat(1200);
    const shaped = shapeAnswer([first, second, long].join("\n\n"));
    expect(shaped.more).toBe(true);
    expect(shaped.text).toBe(`${first}\n\n${second}`);
    expect(shaped.text.length).toBeLessThanOrEqual(900);
  });

  it("cuts a single long paragraph at 900 characters, at a line or sentence end when there is one", () => {
    const sentence = "문장 하나입니다. ";
    const shaped = shapeAnswer(sentence.repeat(200));
    expect(shaped.more).toBe(true);
    expect(shaped.text.length).toBeLessThanOrEqual(901);
    expect(shaped.text.endsWith("문장 하나입니다.…")).toBe(true);
    expect(shapeAnswer("가".repeat(2000)).text).toBe(`${"가".repeat(900)}…`);
  });

  it("keeps the choices of a long answer", () => {
    const shaped = shapeAnswer(`${"나".repeat(1500)}\n[[선택: 계속 | 그만]]`);
    expect(shaped.choices).toEqual(["계속", "그만"]);
    expect(shaped.text).not.toContain("선택:");
  });

  it("says so when the engine ended without words", () => {
    expect(shapeAnswer("   ")).toEqual({ text: "끝났습니다. (AI가 남긴 말이 없습니다)", more: false, choices: [] });
  });
});

describe("elapsed time", () => {
  it.each([[0, "0:00"], [5_400, "0:05"], [72_000, "1:12"], [3_725_000, "62:05"]])("%d ms → %s", (ms, text) => {
    expect(clock(ms)).toBe(text);
  });
});

describe("cutting text for a limit", () => {
  // Hangul written as jamo (as some keyboards and file names send it), a family emoji joined by ZWJ, and a flag.
  const jamo = "한글".normalize("NFD");
  const family = "👨\u200d👩\u200d👧\u200d👦";
  const flag = "🇰🇷";
  const whole = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
  const intact = (cut: string, from: string) => {
    expect(cut.length).toBeGreaterThan(0);
    expect(from.startsWith(cut)).toBe(true);
    // The cut ends where a character ends: its characters are characters of the original.
    const original = whole(from);
    expect(whole(cut)).toEqual(original.slice(0, whole(cut).length));
    expect(cut).not.toMatch(/[\uD800-\uDBFF]$/);
  };

  it("never cuts inside a surrogate pair, a combining sequence, a joined emoji or a flag", () => {
    for (const text of [`a${"😀".repeat(20)}`, `가${jamo.repeat(10)}`, `a${family.repeat(5)}`, `a${flag.repeat(10)}`, `${"한".repeat(3)}${family}${flag}${jamo}`]) {
      for (let limit = 1; limit < text.length; limit += 1) {
        const cut = cutAt(text, limit);
        expect(cut.length).toBeLessThanOrEqual(limit);
        if (cut) intact(cut, text);
      }
      expect(cutAt(text, text.length)).toBe(text);
    }
  });

  it("keeps the opening of a long answer whole at 900", () => {
    for (const tail of [family, flag, jamo, "😀"]) {
      const text = `${"가".repeat(899)}${tail.repeat(20)}`;
      const shaped = shapeAnswer(text);
      expect(shaped.more).toBe(true);
      intact(shaped.text.replace(/…$/, ""), text);
    }
  });

  it("shortens a choice's button without breaking its last character", () => {
    for (const tail of [family, flag, jamo, "😀"]) {
      const choice = `${"가".repeat(11)}${tail}${tail}`;
      intact(choiceLabel(choice).replace(/…$/, ""), choice);
    }
  });
});
