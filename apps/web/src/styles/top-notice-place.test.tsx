// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Vitest empties CSS imports, so the sheets are read from disk and applied through jsdom's parser.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const SHEETS = [read("../styles.css"), read("./foundation.css"), read("./hig-shell.css")];
afterEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });

// U38: the standing layout notice (two long buttons, stays until answered) was drawn in the title's
// slot and, at 1000–1280 px, over 기기 연결 / 새로 만들기. It has its own row under the top bar's
// controls, across the whole width; the title stays readable beside it.
it("the standing layout notice has its own row under the top bar, and the title is not faded for it", () => {
  for (const style of SHEETS) document.head.append(Object.assign(document.createElement("style"), { textContent: style }));
  document.body.innerHTML = `<header class="topbar has-standing-notice"><div class="topbar-left"></div><button class="topbar-title">회의록</button>
    <div class="top-notice layout-problem" data-kind="error"><span class="top-notice-text">다른 창에서 이 작업공간의 배치를 바꿨습니다.</span></div><div class="topbar-right"></div></header>`;
  const notice = getComputedStyle(document.querySelector(".top-notice")!);
  expect(notice.gridRow).toMatch(/^2/);
  expect(notice.gridColumn.replace(/\s/g, "")).toBe("1/-1");
  expect(getComputedStyle(document.querySelector(".topbar")!).height).not.toBe("48px");
  expect(getComputedStyle(document.querySelector(".topbar-title")!).opacity).not.toBe("0");
});
