import { describe, expect, it } from "vitest";
import { PREAMBLE_VERSION, phonePreamble } from "./preamble.ts";

describe("the phone preamble, version 2 (unit 7)", () => {
  it("names workbench-credential for what only the person has, and to end the turn after asking", () => {
    const text = phonePreamble(2);
    expect(text).toContain("workbench-credential need");
    expect(text).toContain("[자동 이어 하기]");
    expect(text).toContain("값은 당신에게 보이지 않습니다");
  });

  it("tells a request accepted under version 1 (it waited in a queue) what it was told then", () => {
    expect(phonePreamble(1)).not.toContain("workbench-credential");
    expect(phonePreamble(1)).toContain("무엇이 왜 필요한지 한 줄로 적고 거기서 턴을 마치세요");
    expect(phonePreamble(99, "엔진 문장.")).toBe(phonePreamble(PREAMBLE_VERSION, "엔진 문장."));
  });
});

describe("the phone preamble, version 3 (unit 14)", () => {
  const ENGINE = "이 대화는 Workbench에서 Claude로 실행됩니다. 모델: claude-opus-9 · 엔진 기본값. 노력: 높음 (high) · 기본값.";
  it("is version 2 and the engine's model line; a request kept under version 2 is told only version 2", () => {
    expect(phonePreamble(3, ENGINE)).toBe(`${phonePreamble(2)}\n- ${ENGINE} 어떤 엔진·모델이냐고 물으면 이대로 답하세요(추측하거나 "확인되지 않았다"고 하지 마세요).`);
    expect(phonePreamble(2, ENGINE)).toBe(phonePreamble(2));
    expect(phonePreamble(1, ENGINE)).toBe(phonePreamble(1));
    expect(phonePreamble(3, ENGINE)).toContain("workbench-credential need");
  });
});

describe("the phone preamble, version 4 (unit 9, fix round 1 I8)", () => {
  const ENGINE = "이 대화는 Workbench에서 Codex로 실행됩니다. 모델: gpt-x · 엔진 기본값. 노력: 보통.";
  it("asks for a one-time code, an approval in another app and a mail link with step, never need (nothing of them is stored)", () => {
    expect(PREAMBLE_VERSION).toBe(4);
    const text = phonePreamble(4, ENGINE);
    expect(text).toContain("2단계 인증번호, 다른 앱에서의 승인, 메일로 온 로그인 링크는 need가 아니라 workbench-credential step 으로 요청하세요");
    expect(text).toContain("workbench-credential need");
    expect(text).not.toMatch(/2단계 인증, API 키/);
    expect(text.endsWith(`- ${ENGINE} 어떤 엔진·모델이냐고 물으면 이대로 답하세요(추측하거나 "확인되지 않았다"고 하지 마세요).`)).toBe(true);
    expect(phonePreamble(4)).toContain("workbench-credential step");
  });

  it("a request kept under version 3 is told version 3's words", () => {
    expect(phonePreamble(3, ENGINE)).toContain("로그인, 2단계 인증, API 키");
    expect(phonePreamble(3, ENGINE)).not.toContain("workbench-credential step");
  });
});
