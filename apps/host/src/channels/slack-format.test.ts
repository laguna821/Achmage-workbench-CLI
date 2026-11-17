import { describe, expect, it } from "vitest";
import { hasWideTable, readable, TABLE_IN_FILE } from "./format.ts";
import { mrkdwn, mrkdwnParts, unescapeSlack } from "./slack-format.ts";

// Markdown → Slack mrkdwn (audit #132): what each construct becomes, and two properties over random
// markdown: nothing the model wrote becomes a mention, a ping or a link of its own, and code goes
// byte for byte.

const slack = (markdown: string) => mrkdwn(readable(markdown, { tables: "pre" }));

describe("markdown as Slack shows it", () => {
  it("bold, italic, inline code; a sign touching a letter gets a zero-width space so Slack formats it", () => {
    expect(slack("이것은 **중요**합니다")).toBe("이것은 *중요*​합니다");
    expect(slack("a *b* c")).toBe("a _b_ c");
    expect(slack("run `npm test` now")).toBe("run `npm test` now");
    expect(slack("***both***")).toMatch(/^(\*_both_\*|_\*both\*_)$/);
  });

  it("a fenced block goes between ``` lines without its language, its content as written (escaped only as Slack needs)", () => {
    const out = slack("앞\n\n```ts\nif (a < b && c > d) { x = `y`; }\n```\n\n뒤");
    expect(out).toBe("앞\n\n```\nif (a &lt; b &amp;&amp; c &gt; d) { x = `y`; }\n```\n\n뒤");
    expect(out).not.toContain("ts\n");
  });

  it("links: only http(s) as <address|words>; any other address stays text, written out", () => {
    expect(slack("[학교](https://hallym.ac.kr/a?b=1&c=2)")).toBe("<https://hallym.ac.kr/a?b=1&amp;c=2|학교>");
    expect(slack("[메일](mailto:a@b.c)")).toBe("메일 (mailto:a@b.c)");
    // Words that look like another address never hide the one opened (security review M1): the real one is written after them.
    expect(slack("[<https://evil.example>](https://good.example)")).toBe("https://evil.example (<https://good.example>)");
  });

  it("M1: a link's words never show one address while it opens another; invisible and direction characters go", () => {
    expect(slack("[https://bank.example/login](https://evil.example/login)")).toBe("https://bank.example/login (<https://evil.example/login>)");
    expect(slack("[\u202eelpmaxe.knab//:sptth](https://evil.example)")).toBe("elpmaxe.knab//:sptth (<https://evil.example>)");
    expect(slack("[bank.example](https://evil.example)")).toBe("bank.example (<https://evil.example>)");
    expect(slack("[www.bank](https://evil.example)")).toBe("www.bank (<https://evil.example>)");
    // The words are the address it opens: the address alone.
    expect(slack("[HTTPS://Lib.Example.ac.kr/list/](https://lib.example.ac.kr/list)")).toBe("<https://lib.example.ac.kr/list>");
    expect(slack("[목\u200b록](https://lib.example.ac.kr/list)")).toBe("<https://lib.example.ac.kr/list|목록>");
  });

  it("M1 property: whenever a link's shown words hold a host-like string, it is the host opened, or the opened address is shown too", () => {
    const next = random(1312026);
    const TEXTS = ["보기", "bank.example", "https://bank.example/login", "\u202eelpmaxe.knab//:sptth", "www.x", "evil.example", "a\u200bb.com", "자료 lib.example.ac.kr", "click", "README.md", "HTTPS://EVIL.EXAMPLE/", "\u2066good.example\u2069"];
    const URLS = ["https://evil.example/", "https://bank.example/login", "https://lib.example.ac.kr/list", "http://a.b.c/d?e=1&f=2"];
    const HOST = /[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;
    for (let round = 0; round < 2000; round += 1) {
      const words = Array.from({ length: 1 + Math.floor(next() * 3) }, () => TEXTS[Math.floor(next() * TEXTS.length)]!).join(" ");
      const url = URLS[Math.floor(next() * URLS.length)]!;
      const out = slack(`앞 [${words}](${url}) 뒤`);
      for (const match of out.matchAll(/<([^|>]+)\|([^>]*)>/g)) {
        const opened = new URL(unescapeSlack(match[1]!)).host.toLowerCase();
        const shown = unescapeSlack(match[2]!).replace(/\p{Cf}/gu, "");
        for (const host of shown.match(HOST) ?? []) expect(host.toLowerCase(), out).toBe(opened);
      }
      // A link that is not made still shows the address it would open.
      if (!/<[^|>]+\|/.test(out)) expect(unescapeSlack(out), out).toContain(url);
    }
  });

  it("headings as bold lines, lists as lines, quotes as > lines", () => {
    expect(slack("## 바꾼 점\n\n- 하나\n- 둘\n\n1. 첫째\n2. 둘째")).toBe("*바꾼 점*\n\n• 하나\n• 둘\n\n1. 첫째\n2. 둘째");
    expect(slack("> 인용 **굵게**\n> 둘째 줄")).toBe("> 인용 *굵게*\n> 둘째 줄");
  });

  it("a table as an aligned monospace block (Hangul counted two columns); a wide one keeps the bullet lines", () => {
    expect(slack("| 장 | 내용 |\n|---|---|\n| 1 | 질문 |\n| 2–4 | **사례** |")).toBe("```\n장  | 내용\n----+-----\n1   | 질문\n2–4 | 사례\n```");
    const wide = `| 이름 | 설명 |\n|---|---|\n| 가 | ${"아주 긴 설명 ".repeat(8)} |`;
    expect(slack(wide)).toMatch(/^\*이름 · 설명\*\n• 가 · 아주 긴 설명/);
  });

  it("0.5.4: when the whole answer goes as a file, a table too wide for the block is one line saying so; a narrow one stays a block", () => {
    const wide = `| 이름 | 설명 |\n|---|---|\n| 가 | ${"아주 긴 설명 ".repeat(8)} |`;
    const narrow = "| 장 | 내용 |\n|---|---|\n| 1 | 질문 |";
    const filed = (markdown: string) => mrkdwn(readable(markdown, { tables: "pre", wide: "file" }));
    expect(filed(`앞 문단\n\n${wide}\n\n뒤 문단`)).toBe(`앞 문단\n\n${TABLE_IN_FILE}\n\n뒤 문단`);
    expect(filed(narrow)).toBe("```\n장 | 내용\n---+-----\n1  | 질문\n```");
    expect(hasWideTable(wide)).toBe(true);
    expect(hasWideTable(narrow)).toBe(false);
    expect(hasWideTable(`\`\`\`\n${wide}\n\`\`\``)).toBe(false); // inside a code block it is code, not a table
    // Telegram (no table style) is unchanged: bullet lines, whatever the width.
    expect(readable(wide, { wide: "file" }).text).toMatch(/^이름 · 설명\n• 가 · 아주 긴 설명/);
  });

  it("&, < and > are escaped everywhere: no mention, ping, channel tag or hidden link from the model's text", () => {
    expect(slack("<!channel> <@U123> <#C1|일반> <https://a.example|b> & **<!here>**")).toBe("&lt;!channel&gt; &lt;@U123&gt; &lt;#C1|일반&gt; https://a.example|b &amp; *&lt;!here&gt;*");
  });

  it("long answers split on paragraph borders, each part within the limit after signs and escapes; a code block cut goes on fenced in the next", () => {
    const code = Array.from({ length: 200 }, (_, line) => `line ${line} <&>`).join("\n");
    const markdown = `${"문단 **굵게** 글. ".repeat(80)}\n\n\`\`\`\n${code}\n\`\`\`\n\n끝`;
    const { text, marks } = readable(markdown, { tables: "pre" });
    const parts = mrkdwnParts(text, marks, 3000);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(3000);
    // The code, put back together from the parts' blocks, is the source's.
    const blocks = parts.flatMap((part) => [...part.matchAll(/```\n([\s\S]*?)\n```/g)].map((match) => unescapeSlack(match[1]!)));
    expect(blocks.join("\n")).toBe(code);
  });
});

/** A small seeded generator, so a failure repeats. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}
const PIECES = [
  "글", "한국어 문장", "word", " ", " ", "\n", "\n\n", "**", "*", "`", "_", "~~", "&", "<", ">", "|", "<!channel>", "<!here>", "<@U0123>", "<#C0123|general>",
  "<https://a.example|b>", "[보기](https://ok.example/p?x=1&y=2)", "[x](javascript:alert(1))", "[메일](mailto:a@b.c)", "<https://auto.example>",
  "\n```js\nconst a = b < c && `t`;\n<!channel>\n```\n", "`<@U9> & co`", "\n| 가 | 나 |\n|---|---|\n| <!here> | `x<y` |\n", "\n> 인용 <@U1>\n", "\n- 항목 <!everyone>\n", "\n# 제목 <#C9>\n", "src/*.ts", "2*3*4",
];

describe("properties over random markdown", () => {
  it("every < in the output opens a link this wrote (to an http(s) address); code goes byte for byte", () => {
    const next = random(20261117);
    for (let round = 0; round < 600; round += 1) {
      const markdown = Array.from({ length: 1 + Math.floor(next() * 14) }, () => PIECES[Math.floor(next() * PIECES.length)]!).join("");
      const { text, marks } = readable(markdown, { tables: "pre" });
      const parts = mrkdwnParts(text, marks, round % 3 === 0 ? 40 : 3000);
      for (const part of parts) {
        for (const match of part.matchAll(/</g)) expect(part.slice(match.index), markdown).toMatch(/^<https?:\/\/[^\s<>|]+\|[^<>]*>/);
        expect(part, markdown).not.toMatch(/<[!@#]/);
      }
      if (round % 3 === 0) continue;
      // Every code stretch of the readable text appears whole in what Slack shows (escapes undone).
      const shown = unescapeSlack(parts.join("\n"));
      // (A message's own leading and trailing spaces are not sent, as on every path: a stretch at an edge is compared without them.)
      for (const mark of marks.filter((entry) => entry.type === "code" || entry.type === "pre")) {
        let content = text.slice(mark.offset, mark.offset + mark.length);
        if (!text.slice(0, mark.offset).trim()) content = content.trimStart();
        if (!text.slice(mark.offset + mark.length).trim()) content = content.trimEnd();
        expect(shown, markdown).toContain(content);
      }
    }
  });
});
