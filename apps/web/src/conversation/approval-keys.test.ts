// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { approvalKeyApplies } from "./approval-keys.ts";

// The window as the app draws it: top bar, left sidebar, two panes (this conversation and another),
// the right sidebar, and an open menu.
const WINDOW = `
  <header class="topbar"><button id="topbar-button">⋯</button></header>
  <aside class="sidebar"><div id="left-row" role="treeitem" tabindex="0">슬라이드 정리</div></aside>
  <div class="pane" data-pane-active="true">
    <div class="transcript-wrap" id="mine">
      <div class="transcript" id="mine-region" tabindex="0">
        <div class="approval-card" id="card" role="alert"><pre id="card-detail">ls -la</pre><button id="allow">허용</button></div>
        <article class="turn-request"><button id="fork">이 요청 전으로</button></article>
      </div>
    </div>
    <div class="composer"><textarea id="composer"></textarea></div>
  </div>
  <div class="pane" data-pane-active="false">
    <div class="transcript-wrap" id="other"><div class="transcript" id="other-region" tabindex="0"></div></div>
  </div>
  <aside class="right-sidebar">
    <div role="tablist"><button role="tab" id="tab">개요</button></div>
    <button class="outline-row" id="row">2 도입부</button>
    <div role="separator" tabindex="0" id="edge"></div>
    <a href="https://ctl.example.ac.kr" id="link">안내</a>
  </aside>
  <div class="ui-menu" role="menu"><div role="menuitem" id="menuitem" tabindex="-1">이름 바꾸기</div></div>
`;

const at = (id: string) => (id === "body" ? document.body : document.getElementById(id)!);
const mine = () => document.getElementById("mine");

afterEach(() => { document.body.innerHTML = ""; });

describe("Enter / Esc answer the waiting approval only where they are meant for it", () => {
  it.each([
    ["nothing focused (the page)", "body", true],
    ["the conversation itself", "mine-region", true],
    ["the approval card's text", "card-detail", true],
    ["a button on the approval card", "allow", false],
    ["a button in the conversation", "fork", false],
    ["the conversation's input", "composer", false],
    ["the right sidebar's tab", "tab", false],
    ["an outline row", "row", false],
    ["the right sidebar's resize edge", "edge", false],
    ["a web page link in 연결", "link", false],
    ["the left sidebar", "left-row", false],
    ["the top bar", "topbar-button", false],
    ["another pane's conversation", "other-region", false],
    ["an open menu", "menuitem", false],
  ])("%s → %s", (_, id, applies) => {
    document.body.innerHTML = WINDOW;
    expect(approvalKeyApplies({ target: at(id as string) }, mine())).toBe(applies);
  });

  it("not while an input method composes, for a held (repeating) key, nor when something already handled the key", () => {
    document.body.innerHTML = WINDOW;
    expect(approvalKeyApplies({ target: document.body, isComposing: true }, mine())).toBe(false);
    expect(approvalKeyApplies({ target: document.body, keyCode: 229 }, mine())).toBe(false);
    expect(approvalKeyApplies({ target: document.body, defaultPrevented: true }, mine())).toBe(false);
    // A held key repeats: approving one request must not approve the next one that appears.
    expect(approvalKeyApplies({ target: document.body, repeat: true }, mine())).toBe(false);
    expect(approvalKeyApplies({ target: document.getElementById("mine-region"), repeat: true }, mine())).toBe(false);
  });

  it("from the page only for the conversation in the focused pane, and not under a modal", () => {
    document.body.innerHTML = WINDOW;
    expect(approvalKeyApplies({ target: document.body }, document.getElementById("other"))).toBe(false);
    document.body.insertAdjacentHTML("beforeend", "<dialog open></dialog>");
    expect(approvalKeyApplies({ target: document.body }, mine())).toBe(false);
  });
});
