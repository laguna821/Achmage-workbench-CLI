// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Vitest empties CSS imports, so the sheets are read from disk and applied through jsdom's parser.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const SHEETS = [read("../styles.css"), read("./foundation.css"), read("./navigator.css"), read("./hig-shell.css")];

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

// In two panes the sidebar's head is about 500px wide: "새로 만들기" must not stretch across it.
describe("the sidebar head's row", () => {
  it("keeps 새로 만들기 at the width it has in one column, the layout button and ⋯ at the row's end", () => {
    for (const style of SHEETS) document.head.append(Object.assign(document.createElement("style"), { textContent: style }));
    document.body.innerHTML = `<aside class="sidebar" data-layout="dual"><div class="side-head"><div class="side-head-row">
      <button class="side-new">새로 만들기</button><button class="icon-button small side-layout"></button><button class="icon-button small"></button></div></div></aside>`;
    const create = getComputedStyle(document.querySelector(".side-new")!);
    // One column: 288 − 2×12 padding − 2×28 buttons − 2×8 gaps.
    expect(create.maxWidth).toBe("192px");
    expect(getComputedStyle(document.querySelector(".side-layout")!).marginLeft).toBe("auto");
  });
});
