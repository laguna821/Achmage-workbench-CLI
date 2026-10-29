import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ObsidianMarkdown, obsidianComponents, pictureSize } from "./obsidian.tsx";

const html = (markdown: string) => renderToStaticMarkup(<ObsidianMarkdown components={obsidianComponents({})}>{markdown}</ObsidianMarkdown>);

describe("callouts", () => {
  it("draws `> [!NOTE] 제목` as a callout with its title, icon and content", () => {
    const out = html("> [!NOTE] 회의 메모\n> 본문 첫 줄\n>\n> 둘째 문단");
    expect(out).toContain('<div class="callout" data-callout="note" data-kind="note">');
    expect(out).toContain('<div class="callout-title"><span class="callout-icon" aria-hidden="true"><svg');
    expect(out).toContain('<span class="callout-title-inner">회의 메모</span>');
    expect(out).toContain('<div class="callout-content"><p>본문 첫 줄</p>');
    expect(out).toContain("<p>둘째 문단</p>");
    expect(out).not.toContain("[!NOTE]");
    expect(out).not.toContain("<blockquote");
  });

  it("names an untitled callout by its kind and maps aliases to Obsidian's colours", () => {
    const out = html("> [!caution]\n> 조심");
    expect(out).toContain('data-callout="caution" data-kind="warning"');
    expect(out).toContain('<span class="callout-title-inner">Caution</span>');
    expect(out).toContain("<p>조심</p>");
  });

  it("folds with - (shut) and + (open)", () => {
    const shut = html("> [!tip]- 접힌 팁\n> 안쪽");
    expect(shut).toContain('<details class="callout" data-callout="tip" data-kind="tip"><summary class="callout-title">');
    expect(shut).not.toContain("open");
    expect(html("> [!tip]+ 펼친 팁\n> 안쪽")).toContain('<details class="callout" data-callout="tip" data-kind="tip" open="">');
  });

  it("keeps a custom kind's name (spaces too), nested callouts, and marks in the title", () => {
    const out = html("> [!full sermon] **주일** 설교\n> 바깥\n>\n> > [!quote] 인용\n> > 안쪽");
    expect(out).toContain('data-callout="full sermon" data-kind="note"');
    expect(out).toContain('<span class="callout-title-inner"><strong>주일</strong> 설교</span>');
    expect(out).toContain('data-callout="quote" data-kind="quote"');
    expect(out.match(/class="callout"/g)).toHaveLength(2);
  });

  it("leaves a plain quote a quote", () => {
    expect(html("> 그냥 인용")).toContain("<blockquote>\n<p>그냥 인용</p>\n</blockquote>");
  });
});

describe("Obsidian marks", () => {
  it("highlights ==text==, not inside code", () => {
    const out = html("이건 ==중요== 하고 `==코드==`는 그대로");
    expect(out).toContain("<mark>중요</mark>");
    expect(out).toContain("<code>==코드==</code>");
  });

  it("makes #tags pills (nested ones too), but not C# or #123", () => {
    const out = html("회의 #프로젝트/워크벤치 와 (#AI_교육) 그리고 C# 과 #123");
    expect(out).toContain('<span class="md-tag">#프로젝트/워크벤치</span>');
    expect(out).toContain('<span class="md-tag">#AI_교육</span>');
    expect(out).toContain("C# 과 #123");
  });

  it("hides ^block-ids at the end of a line", () => {
    const out = html("이 문단은 남는다 ^abc-12\n\n다음 문단");
    expect(out).toContain("<p>이 문단은 남는다</p>");
    expect(out).not.toContain("^abc");
  });

  it("keeps task lists, footnotes (ids made safe, links to match) and Mermaid code", () => {
    const out = html("- [ ] 할 일\n\n글[^1]\n\n[^1]: 각주\n\n```mermaid\ngraph TD; A-->B\n```");
    expect(out).toContain('<input type="checkbox" disabled=""/>');
    expect(out).toContain('href="#fn-1"');
    expect(out).toContain('id="user-content-fn-1"');
    expect(out).toContain('<code class="language-mermaid">');
  });
});

describe("HTML in notes", () => {
  it("draws the HTML notes carry: pictures with their width, details, line breaks", () => {
    const out = html('<img src="https://pub-x.r2.dev/a.png" alt="표지" width="300" loading="lazy">\n\n<details><summary>더 보기</summary>\n\n속 내용\n\n</details>\n\n한 줄<br>두 줄');
    expect(out).toContain('<img src="https://pub-x.r2.dev/a.png" alt="표지" width="300"/>');
    expect(out).toContain("<details><summary>더 보기</summary>");
    expect(out).toContain("<p>속 내용</p>");
    expect(out).toContain("한 줄<br/>두 줄");
  });

  it("drops what could run or restyle the app: scripts, styles, handlers, javascript: links, frames", () => {
    const out = html(
      '<script>window.ran = 1</script>\n\n<style>body { display: none }</style>\n\n<img src="x.png" onerror="window.ran = 2">\n\n<a href="javascript:alert(1)">눌러</a> <iframe src="https://x.org"></iframe> <span style="position:fixed">글</span>',
    );
    expect(out).not.toMatch(/script|window\.ran|display: none|onerror|javascript:|iframe|position:fixed/);
    expect(out).toContain("눌러");
    expect(out).toContain("<span>글</span>");
  });
});

describe("embeds and pictures", () => {
  it("turns a paragraph holding only a vault-embed link into the place for that note", () => {
    const out = html("[수업 설계](vault-embed:20.%20Information%2F%EC%88%98%EC%97%85.md#%EB%AA%A9%ED%91%9C)");
    expect(out).toContain('<div class="note-embed">수업 설계</div>');
    const custom = renderToStaticMarkup(
      <ObsidianMarkdown components={obsidianComponents({}, { embed: ({ path, heading }) => <b>{`${path}|${heading}`}</b> })}>{"[수업](vault-embed:20.%20I%2F%EC%88%98%EC%97%85.md#%EB%AA%A9%ED%91%9C)"}</ObsidianMarkdown>,
    );
    expect(custom).toContain("<b>20. I/수업.md|목표</b>");
  });

  it("reads Obsidian's size after | in a picture's text, the HTML's own size first", () => {
    expect(pictureSize("표지|300")).toEqual({ alt: "표지", width: 300, height: undefined });
    expect(pictureSize("|300x200")).toEqual({ alt: "", width: 300, height: 200 });
    expect(pictureSize("그림 | 설명")).toEqual({ alt: "그림 | 설명", width: undefined, height: undefined });
    expect(pictureSize("표지|300", "120", undefined)).toEqual({ alt: "표지", width: 120, height: undefined });
  });
});
