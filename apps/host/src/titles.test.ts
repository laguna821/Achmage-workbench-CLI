import { describe, expect, it } from "vitest";
import { adaptTitle, titleFor, tokens } from "./titles.ts";

const run = (turns: string[]) => {
  let title: string | null = null;
  const history: string[] = [];
  return turns.map((turn) => {
    history.push(turn);
    title = adaptTitle(history, title);
    return title;
  });
};

describe("adaptive titles (no model call)", () => {
  it("drops josa and request endings, keeping action nouns", () => {
    expect(tokens("mcp로 영어로 학생이 평가가 결과를 회의의 민주주의는 2주차의 자료가").map((token) => token.word)).toEqual([
      "mcp", "영어", "학생", "평가", "결과", "회의", "민주주의", "2주차", "자료",
    ]);
    expect(tokens("문서를 정리해줘 계획을 세워보자").map((token) => `${token.word}${token.action ? "*" : ""}`)).toEqual(["문서", "정리*", "계획"]);
  });

  it("names a session from the opening request as a short noun phrase", () => {
    expect(titleFor(["미디어 리터러시 과목 업데이트 계획을 세워보자"])).toBe("미디어 리터러시 과목 업데이트 계획");
    expect(titleFor(["논문 초록을 영어로 번역해줘"])).toBe("논문 초록 영어 번역");
  });

  it("follows the theme that keeps coming back, and stays put on passing topics", () => {
    expect(run(["회의록 정리해줘", "이번 학기 수업 계획서 초안 써줘", "수업 계획서 평가 기준 추가", "수업 계획서 주차별 내용 다듬어줘"]).at(-1)).toBe("수업 계획서");
    const stable = run(["논문 초록을 영어로 번역해줘", "초록 번역에서 용어를 학술적으로 다듬어줘", "참고문헌 형식도 APA로 정리해줘"]);
    expect(new Set(stable).size).toBe(1);
  });
});
