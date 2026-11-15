// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { restoreSurfaceFocus } from "./menu-navigation.ts";

afterEach(() => { document.body.innerHTML = ""; });

// Skin 2 fix 1, found by the focus-return walk: a row's ⋯ (and +) shows only while the row is under the hand
// or holds the keyboard; once its menu took the focus the ⋯ was hidden, focus() on it did nothing and
// the focus fell to the page's body. The focus goes back to the nearest focusable thing that holds it: its row.
it("gives the focus to the opener's row when the opener itself can no longer take it", () => {
  document.body.innerHTML = `<div class="side-row" tabindex="-1" data-list-row=""><span>강의 준비</span><button class="row-more">⋯</button></div><div class="menu"><button>이름 바꾸기</button></div>`;
  const more = document.querySelector<HTMLButtonElement>(".row-more")!;
  const menu = document.querySelector<HTMLElement>(".menu")!;
  menu.querySelector("button")!.focus();
  more.focus = () => {}; // hidden: the browser refuses the focus
  restoreSurfaceFocus(more, menu);
  expect(document.activeElement).toBe(document.querySelector(".side-row"));
});
