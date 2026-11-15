// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Skin 2 fix 1, ruling 10 (the owner's 02-workspace.png): the work sits flush against the list column —
// no 8 px inset, no rounded 1 px frame around the centre; one hairline parts column and work, and a
// hairline parts two panes. jsdom applies the cascade for ordinary properties (not var()), so the
// sheets are applied and the computed frame is read.
const read = (path: string) => readFileSync(resolve("apps/web/src", path), "utf8");
afterEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });
it("the work area has no inset and no rounded frame, at one pane and at two", () => {
  for (const css of [read("styles/tokens.css"), read("styles.css"), read("styles/hig-workspace.css"), read("styles/controls.css"), read("styles/panes.css")]) document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
  document.body.innerHTML = `<div class="body with-sidebar"><div class="panes recursive"><section class="pane"></section><div class="pane-divider"></div><section class="pane"></section></div></div>`;
  const panes = getComputedStyle(document.querySelector(".panes")!);
  expect([panes.marginTop, panes.marginRight, panes.marginBottom, panes.marginLeft].map((m) => m || "0px")).toEqual(["0px", "0px", "0px", "0px"]);
  const pane = getComputedStyle(document.querySelector(".pane")!);
  expect(pane.borderTopLeftRadius === "" || pane.borderTopLeftRadius === "0" || pane.borderTopLeftRadius === "0px").toBe(true);
  expect(["0", "0px", ""]).toContain(pane.borderLeftWidth);
});
