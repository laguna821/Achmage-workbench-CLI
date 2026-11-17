import { describe, expect, it } from "vitest";
import { particle, withParticle } from "./korean.ts";

describe("particle(): the one helper for 이/가, 을/를, 은/는, 와/과, (으)로", () => {
  it("Hangul: by the last syllable's final consonant", () => {
    expect(withParticle("강의안", "을/를")).toBe("강의안을");
    expect(withParticle("노트", "을/를")).toBe("노트를");
    expect(withParticle("강의안", "이/가")).toBe("강의안이");
    expect(withParticle("노트", "이/가")).toBe("노트가");
    expect(withParticle("프로젝트", "은/는")).toBe("프로젝트는");
    expect(withParticle("문서", "와/과")).toBe("문서와");
    expect(withParticle("대화방", "와/과")).toBe("대화방과");
  });

  it("(으)로: ㄹ takes 로 like no final consonant", () => {
    expect(withParticle("서울", "으로/로")).toBe("서울로");
    expect(withParticle("폴더", "으로/로")).toBe("폴더로");
    expect(withParticle("강의안", "으로/로")).toBe("강의안으로");
  });

  it("digits as read in Korean (일 ㄹ, 삼 ㅁ, 육 ㄱ, 칠·팔 ㄹ, 영 ㅇ; 이 사 오 구 none)", () => {
    expect(withParticle("0.5.3", "으로/로")).toBe("0.5.3으로");
    expect(withParticle("0.5.2", "이/가")).toBe("0.5.2가");
    expect(withParticle("3주차 1", "을/를")).toBe("3주차 1을");
    expect(withParticle("버전 7", "으로/로")).toBe("버전 7로");
    expect(withParticle("10", "이/가")).toBe("10이");
    expect(withParticle("r4", "을/를")).toBe("r4를");
  });

  it("Latin letters where the reading is settled: extensions and capitals letter by letter, known names", () => {
    expect(withParticle("강의안.md", "을/를")).toBe("강의안.md를");
    expect(withParticle("보고서.pdf", "이/가")).toBe("보고서.pdf가");
    expect(withParticle("표.xlsx", "을/를")).toBe("표.xlsx를");
    expect(withParticle("자료.html", "을/를")).toBe("자료.html을");
    expect(withParticle("URL", "이/가")).toBe("URL이");
    expect(withParticle("Claude", "와/과")).toBe("Claude와");
    expect(withParticle("Codex", "이/가")).toBe("Codex가");
    expect(withParticle("Slack", "으로/로")).toBe("Slack으로");
    expect(withParticle("Telegram", "은/는")).toBe("Telegram은");
    expect(withParticle("@wb_class_bot", "을/를")).toBe("@wb_class_bot을");
  });

  it("anything else gets the written-out form", () => {
    expect(particle("Sesame", "이/가")).toBe("(이)가");
    expect(particle("Sesame", "을/를")).toBe("을(를)");
    expect(particle("Sesame", "은/는")).toBe("은(는)");
    expect(particle("Sesame", "와/과")).toBe("와(과)");
    expect(particle("Sesame", "으로/로")).toBe("(으)로");
    expect(particle("", "이/가")).toBe("(이)가");
    expect(particle("🙂", "을/를")).toBe("을(를)");
  });

  it("looks through closing quotes and brackets", () => {
    expect(withParticle("「강의안」", "을/를")).toBe("「강의안」을");
    expect(withParticle("「노트」", "이/가")).toBe("「노트」가");
    expect(withParticle("(3주차)", "으로/로")).toBe("(3주차)로");
  });
});
