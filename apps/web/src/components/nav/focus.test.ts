import { describe, expect, it } from "vitest";
import { initialOf, namePrefix } from "./focus.ts";

describe("type-ahead names (Hangul included)", () => {
  it("matches letters, syllables and first consonants", () => {
    expect(namePrefix("논문 리뷰 메모", "논")).toBe(true);
    expect(namePrefix("논문 리뷰 메모", "ㄴ")).toBe(true);
    expect(namePrefix("논문 리뷰 메모", "ㄴㅁ")).toBe(true);
    expect(namePrefix("논문 리뷰 메모", "ㄱ")).toBe(false);
    expect(namePrefix("Style guide", "st")).toBe(true);
    expect(initialOf("강")).toBe("ㄱ");
  });
});
