import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { KOREAN_COPY } from "./korean-copy.ts";
import { VENDOR_FIXES } from "./vendor-fixes.ts";
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
  expect(applyKoreanCopy(file, code)).toContain("문서 AI 열기");
  expect(() => applyKoreanCopy(file, "nothing")).toThrow(/vendored text changed/);
  expect(applyKoreanCopy("/x/other.ts", "x")).toBeNull();
  expect(readFileSync("apps/office/vite.config.ts", "utf8")).toContain("koreanCopy()");
});

it("the editors with their own AI panel never call it a second AI: no 'AI 도우미' or 'AI 어시스턴트' left in their Korean (one-doc-ai)", () => {
  const files = ["apps/docs/src/renderer/i18n/ai/ko.ts", "apps/docs/src/renderer/i18n/ribbon/ko.ts", "apps/slides/src/renderer/i18n/ai/ko.ts", "apps/slides/src/renderer/i18n/app/ko.ts", "apps/slides/src/renderer/i18n/ribbon/ko.ts", "apps/sheets/src/renderer/i18n/ai/ko.ts", "apps/html/src/renderer/i18n/ai/ko.ts", "packages/ui/src/strings-ai-subscription/ko.ts"];
  for (const file of files) {
    const code = readFileSync(`vendor/ieumoffice/${file}`, "utf8");
    const after = applyKoreanCopy(`/x/vendor/ieumoffice/${file}`, code) ?? code;
    expect(after, file).not.toMatch(/AI 도우미|AI 어시스턴트/);
  }
  // PDF and Markdown keep every language in one file: the Korean block's keys are checked.
  for (const file of ["apps/pdf/src/renderer/i18n/strings.ts", "apps/markdown/src/renderer/i18n/strings.ts"]) {
    const after = applyKoreanCopy(`/x/vendor/ieumoffice/${file}`, readFileSync(`vendor/ieumoffice/${file}`, "utf8"))!;
    expect(after, file).not.toMatch(/'AI 도우미|'AI 어시스턴트/);
  }
});

it("the vendored-behaviour fixes find their text exactly once and are applied by the same plugin (one-doc-ai)", () => {
  for (const entry of VENDOR_FIXES) {
    const code = readFileSync(`vendor/ieumoffice/${entry.file}`, "utf8");
    expect(code.split(entry.from).length - 1, entry.file).toBe(1);
    expect(applyKoreanCopy(`/x/vendor/ieumoffice/${entry.file}`, code)).toContain(entry.to);
  }
});

it("the PDF editor reads Korean: no English left in its Korean table once the copy is applied, except marks that hold no words (office-leftovers point 5)", async () => {
  // A path in a variable: the vendored editor's sources stay out of the app's type check.
  const vendored = "../../../vendor/ieumoffice/apps/pdf/src/renderer/i18n/strings.ts";
  const { strings } = await import(/* @vite-ignore */ vendored) as { strings: { en: Record<string, string>; ko: Record<string, string> } };
  const { PDF_FORM_KO, PDF_CERT_KO } = await import("./korean-copy.ts");
  // What the copy entries put in (each is checked above to find its text once and to be applied by the build).
  const ko: Record<string, string> = { ...(strings.ko as Record<string, string>), ...PDF_FORM_KO, ...PDF_CERT_KO };
  for (const entry of KOREAN_COPY.filter((e) => e.file.startsWith("apps/pdf/src/renderer/i18n/"))) {
    const one = /^(\w+): '(.*)',$/.exec(entry.to);
    if (one) ko[one[1]!] = one[2]!;
  }
  const english = Object.keys(strings.en).filter((key) => {
    const value = ko[key] ?? (strings.en as Record<string, string>)[key]!;
    return !/[가-힣]/.test(value) && /[A-Za-z]{2,}/.test(value.replace(/\{\w+\}/g, ""));
  });
  expect(english).toEqual([]);
  // The same words as the other editors: no 페이지 in what this unit added (쪽), no middle dots.
  for (const value of [...Object.values(PDF_FORM_KO), ...Object.values(PDF_CERT_KO)]) expect(value).not.toMatch(/ · /);
});
