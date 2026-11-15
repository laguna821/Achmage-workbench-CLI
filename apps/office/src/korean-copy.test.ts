import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { KOREAN_COPY } from "./korean-copy.ts";
import { applyKoreanCopy } from "../korean-copy-plugin.ts";

// The editors' copy list (design review): each vendored string is replaced at build time, once,
// in plain Korean; the vendored source stays as it is.
it("each entry finds its text exactly once in the vendored file", () => {
  for (const entry of KOREAN_COPY) {
    const code = readFileSync(`vendor/ieumoffice/${entry.file}`, "utf8");
    expect(code.split(entry.from).length - 1, `${entry.file}: ${entry.from.slice(0, 40)}`).toBe(1);
  }
});

it("what a teacher reads afterwards has no English ribbon words, no 스킬, 진단 로그 or middle dots", () => {
  for (const entry of KOREAN_COPY) expect(entry.to, entry.from).not.toMatch(/ · |스킬|진단 로그|Fill Form|Form Design|Insert text|로드했습니다/);
});

it("is applied by the build and fails loudly when the vendored text changed", () => {
  const file = `/x/vendor/ieumoffice/${KOREAN_COPY[0]!.file}`;
  const code = readFileSync(`vendor/ieumoffice/${KOREAN_COPY[0]!.file}`, "utf8");
  expect(applyKoreanCopy(file, code)).toContain("열린 문서를 바로 고치는 AI 도우미");
  expect(() => applyKoreanCopy(file, "nothing")).toThrow(/vendored text changed/);
  expect(applyKoreanCopy("/x/other.ts", "x")).toBeNull();
  expect(readFileSync("apps/office/vite.config.ts", "utf8")).toContain("koreanCopy()");
});
