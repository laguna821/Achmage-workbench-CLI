import assert from "node:assert/strict";
import { describe, it } from "vitest";
import JSZip from "jszip";
import { adaptMarkdownForKordoc } from "./markdownAdapter.ts";
import { generateWithCore } from "./core-fixture.ts";

// Ported from HanMark tests/markdownAdapterFootnotes.test.ts. Workbench has no in-process kordoc: the
// HWPX case runs the app's one kordoc (the bundled core runner) instead of `markdownToHwpx`.
async function sectionXml(markdown: string): Promise<string> {
  const archive = await JSZip.loadAsync(await generateWithCore(markdown));
  const section = archive.file("Contents/section0.xml");
  assert.ok(section, "generated HWPX must contain section0.xml");
  return section.async("text");
}

describe("adaptMarkdownForKordoc footnotes", () => {
  it("keeps consecutive footnote definitions on separate lines", () => {
    const result = adaptMarkdownForKordoc(`본문 첫째[^1]와 둘째[^2].

[^1]: 첫째 설명
[^2]: 둘째 설명
`);
    assert.match(result.markdown, /^\[\^1\]: 첫째 설명$/m);
    assert.match(result.markdown, /^\[\^2\]: 둘째 설명$/m);
    assert.ok(!result.warnings.some((warning) => warning.code === "footnote-undefined"));
  });

  it("folds lazy, indented, and indented-paragraph continuations into one definition line", () => {
    const result = adaptMarkdownForKordoc(`참조[^a] 그리고 참조[^b].

[^a]: 첫 줄
이어지는 줄
[^b]: 둘째 정의
    들여쓴 이어짐

    다음 문단도 같은 각주

다음 본문 문단입니다.
`);
    assert.match(result.markdown, /^\[\^a\]: 첫 줄 이어지는 줄$/m);
    assert.match(result.markdown, /^\[\^b\]: 둘째 정의 들여쓴 이어짐 다음 문단도 같은 각주$/m);
    assert.match(result.markdown, /^다음 본문 문단입니다\.$/m);
  });

  it("still joins soft-wrapped prose and leaves fenced code untouched", () => {
    const result = adaptMarkdownForKordoc([
      "첫 줄이",
      "이어집니다.",
      "",
      "```",
      "[^x]: 코드 속 정의",
      "이 줄은 그대로",
      "```",
      "",
    ].join("\n"));
    assert.match(result.markdown, /^첫 줄이 이어집니다\.$/m);
    assert.match(result.markdown, /^\[\^x\]: 코드 속 정의\n이 줄은 그대로$/m);
  });

  it("warns only for references without a definition", () => {
    const result = adaptMarkdownForKordoc("있음[^ok] 없음[^missing]\n\n[^ok]: 정의\n");
    const undefinedWarning = result.warnings.find((warning) => warning.code === "footnote-undefined");
    assert.ok(undefinedWarning, "missing definition must be reported");
    assert.match(undefinedWarning.message, /\[\^missing\]/);
    assert.doesNotMatch(undefinedWarning.message, /\[\^ok\]/);
  });

  it("produces one real HWPX footnote per referenced definition", async () => {
    const adapted = adaptMarkdownForKordoc(`가[^1] 나[^2] 다[^3]

[^1]: 하나
[^2]: 둘
이어서 쓴 둘
[^3]: 셋
`);
    const xml = await sectionXml(adapted.markdown);
    assert.equal(xml.match(/<hp:footNote\b/g)?.length, 3);
    assert.match(xml, /둘 이어서 쓴 둘/);
    assert.doesNotMatch(xml, /\[\^[123]\]/);
  });
});
