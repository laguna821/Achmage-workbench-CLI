// @vitest-environment jsdom
import { render } from "@testing-library/react";
import Markdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { REMARK_BASE } from "./plugins.ts";

function html(md: string): string {
  const { container } = render(<Markdown remarkPlugins={REMARK_BASE}>{md}</Markdown>);
  return container.innerHTML;
}

describe("REMARK_BASE emphasis next to Korean", () => {
  it("bolds when closing ** follows punctuation and precedes a letter", () => {
    expect(html("**한글(괄호)**조사")).toContain("<strong>한글(괄호)</strong>조사");
    expect(html("총 **소요 시간(30분 57초)**입니다")).toContain("<strong>소요 시간(30분 57초)</strong>입니다");
  });
  it("bolds a quoted phrase followed by a particle", () => {
    expect(html('**"따옴표"**는')).toContain('<strong>"따옴표"</strong>는');
  });
  it("italicises before a particle", () => {
    expect(html("*기울임*을")).toContain("<em>기울임</em>을");
  });
  it("keeps English bold and code literal", () => {
    expect(html("**bold** text")).toContain("<strong>bold</strong>");
    expect(html("`**x**`")).toContain("<code>**x**</code>");
  });
  it("keeps strikethrough and tables", () => {
    expect(html("~~취소선~~")).toContain("<del>취소선</del>");
    expect(html("~~한글(괄호)~~조사")).toContain("<del>한글(괄호)</del>조사");
    expect(html("|a|b|\n|-|-|\n|**가(1)**나|2|")).toContain("<table>");
    expect(html("|a|b|\n|-|-|\n|**가(1)**나|2|")).toContain("<strong>가(1)</strong>나");
  });
  it("keeps GFM autolinks, task lists and fenced code literal", () => {
    expect(html("see https://example.com/a now")).toContain('<a href="https://example.com/a">https://example.com/a</a>');
    const tasks = html("- [x] 끝\n- [ ] 남음");
    expect(tasks).toContain('type="checkbox"');
    expect(tasks).toContain("checked");
    expect(html("```\n**x**\n```")).toContain("**x**");
    expect(html("```\n**x**\n```")).not.toContain("<strong>");
  });
  it("does not throw on an unclosed bold mid-stream", () => {
    for (const cut of ["**굵게", "**굵게(1", "*기울", "~~취소", "**굵게(1)**"]) expect(() => html(cut)).not.toThrow();
    expect(html("**굵게")).toContain("**굵게");
  });
});
