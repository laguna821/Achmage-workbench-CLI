// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Vitest empties CSS imports, so the sheets are read from disk and applied through jsdom's parser.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const SHEETS = [read("../styles.css"), read("./foundation.css"), read("./hig-chat.css"), read("./search.css")];
afterEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });

// U38 finding 2: the search palette's titles and preview text sat at 15/17 px, off the type ladder
// that the capture invariant `틀 글자는 사다리 위` checks (styles.css :root, 12 13 14 16 18 20 23 26).
const LADDER = [12, 13, 14, 16, 18, 20, 23, 26];
// jsdom leaves var() unresolved: a token is read from :root (the last definition wins), rem at 16 px.
const px = (value: string): number => {
  const token = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (token) return px(getComputedStyle(document.documentElement).getPropertyValue(token[1]!));
  return value.trim().endsWith("rem") ? parseFloat(value) * 16 : parseFloat(value);
};
it("the search palette's result title, preview head (and its place) and preview text sit on the type ladder", () => {
  for (const style of SHEETS) document.head.append(Object.assign(document.createElement("style"), { textContent: style }));
  document.body.innerHTML = `<div class="palette"><div class="palette-list"><span class="palette-title">루브릭</span></div>
    <div class="palette-preview"><div class="palette-preview-head">루브릭 초안<span class="muted"> · 강의</span></div>
    <div class="palette-preview-hit current">채점 기준</div>
    <div class="search-source"><div class="search-source-line"><span class="search-source-number">12</span><span>본문</span></div></div></div></div>`;
  const sizes = [".palette-title", ".palette-preview-head", ".palette-preview-head .muted", ".palette-preview-hit.current", ".search-source-number"]
    .map((selector) => [selector, px(getComputedStyle(document.querySelector(selector)!).fontSize)] as const);
  expect(sizes.filter(([, size]) => !LADDER.includes(size))).toEqual([]);
});
