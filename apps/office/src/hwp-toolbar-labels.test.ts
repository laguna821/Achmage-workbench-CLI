// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { installToolbarLabels } from "../../../third_party/hop/toolbar-labels.ts";

const VIEW = `<div id="menu-bar"><div class="menu-item open" data-menu="view"><span class="menu-title">보기</span><div class="menu-dropdown">
  <div class="md-item" data-cmd="view:toggle-grid"><span class="md-label">격자 보기</span></div>
  <div class="md-sub"><span class="md-label">도구 상자</span><div class="md-sub-panel"><div class="md-item" data-cmd="view:toolbox-basic">기본</div></div></div>
  <div class="md-item" data-cmd="view:zoom-in">확대</div>
</div></div></div><div id="icon-toolbar"><button class="tb-btn"><span class="tb-label">붙이기</span></button></div>`;

afterEach(() => { localStorage.clear(); document.body.innerHTML = ""; delete document.documentElement.dataset.toolbarLabels; });

it("offers HOP's 도구 상자 라벨 표시 in 보기 right after the toolbox submenu, on by default", () => {
  document.body.innerHTML = VIEW;
  const stop = installToolbarLabels(document);
  const item = document.querySelector<HTMLElement>('[data-wb-cmd="wb-toolbar-labels"]')!;
  expect(item.previousElementSibling?.classList.contains("md-sub")).toBe(true);
  expect(item.getAttribute("role")).toBe("menuitemcheckbox");
  expect(item.getAttribute("aria-checked")).toBe("true");
  expect(document.documentElement.dataset.toolbarLabels).toBe("shown");
  // not a studio command: the studio's dispatcher never sees it
  expect(item.hasAttribute("data-cmd")).toBe(false);
  stop();
  expect(document.querySelector('[data-wb-cmd="wb-toolbar-labels"]')).toBeNull();
  expect(document.documentElement.dataset.toolbarLabels).toBeUndefined();
});

it("hides and shows the labels, remembers the choice and closes the menu", () => {
  document.body.innerHTML = VIEW;
  const keys: string[] = [];
  document.addEventListener("keydown", (event) => keys.push(event.key));
  const stop = installToolbarLabels(document);
  const item = () => document.querySelector<HTMLElement>('[data-wb-cmd="wb-toolbar-labels"]')!;
  item().click();
  expect(document.documentElement.dataset.toolbarLabels).toBe("hidden");
  expect(item().getAttribute("aria-checked")).toBe("false");
  expect(localStorage.getItem("hop.toolbar-labels")).toBe("hidden");
  expect(keys).toEqual(["Escape"]);
  stop();
  // a new studio window starts with the remembered choice
  document.body.innerHTML = VIEW;
  const again = installToolbarLabels(document);
  expect(document.documentElement.dataset.toolbarLabels).toBe("hidden");
  item().click();
  expect(document.documentElement.dataset.toolbarLabels).toBe("shown");
  expect(localStorage.getItem("hop.toolbar-labels")).toBe("shown");
  again();
});
