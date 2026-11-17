// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Composer } from "./components/Composer.tsx";

// A pane's content follows the PANE's width (up to nine panes share a window), not the window's.
// jsdom has no layout: each pane says its width through clientWidth, and a stand-in
// ResizeObserver lets the test resize it.
const observed: { target: Element; tell: () => void }[] = [];
class FakeResizeObserver {
  private readonly tell: () => void;
  constructor(tell: () => void) { this.tell = tell; }
  observe(target: Element) { observed.push({ target, tell: this.tell }); }
  unobserve() {}
  disconnect() {}
}
const paneOf = (width: number) => {
  const pane = document.createElement("div");
  pane.className = "pane";
  Object.defineProperty(pane, "clientWidth", { configurable: true, get: () => width });
  document.body.append(pane);
  return pane;
};
const resize = (pane: HTMLElement, width: number) => {
  Object.defineProperty(pane, "clientWidth", { configurable: true, get: () => width });
  act(() => observed.filter((entry) => entry.target === pane).forEach((entry) => entry.tell()));
};
const composer = (container: HTMLElement) => render(
  <Composer draftKey="pane" placeholder="입력" busy={false} onSend={async () => true}
    left={<button type="button">모드</button>} target={<button type="button">엔진 고르기</button>} />,
  { container },
);
const right = () => document.querySelector(".composer-right")!;

beforeEach(() => {
  // The window is wide (a 2560 px desktop window): no window-width query matches.
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; observed.length = 0; localStorage.clear(); vi.unstubAllGlobals(); });

describe("the composer in a pane", () => {
  it("folds its secondary keys into the tools key in a narrow pane of a wide window; the send key and the engine stay reachable", () => {
    composer(paneOf(420));
    expect(screen.getByRole("button", { name: "보내기" })).toBeTruthy();
    expect(right().textContent).not.toContain("엔진 고르기");
    // Folded, not removed: inside 도구, as at a narrow window.
    expect(document.querySelector(".composer-tools-controls")?.textContent).toContain("엔진 고르기");
    expect(document.querySelector(".composer-tools-controls")?.textContent).toContain("모드");
  });

  it("keeps them in the bar in a wide pane, and follows the pane when it is resized", () => {
    const pane = paneOf(1100);
    composer(pane);
    expect(right().textContent).toContain("엔진 고르기");
    expect(document.querySelector(".composer-tools")).toBeNull();
    resize(pane, 600);
    expect(right().textContent).not.toContain("엔진 고르기");
    resize(pane, 744);
    expect(right().textContent).toContain("엔진 고르기");
  });

  it("beside a web page or document, the conversation's column decides (it is narrower than its pane)", () => {
    const pane = paneOf(1104);
    const beside = document.createElement("div");
    beside.className = "beside";
    beside.dataset.fit = "beside";
    const chat = document.createElement("section");
    chat.className = "beside-chat";
    Object.defineProperty(chat, "clientWidth", { configurable: true, get: () => 360 });
    beside.append(chat);
    pane.append(beside);
    composer(chat);
    expect(right().textContent).not.toContain("엔진 고르기");
    expect(document.querySelector(".composer-tools-controls")?.textContent).toContain("엔진 고르기");
    // The page closed: the column is the whole pane again.
    beside.dataset.fit = "single";
    resize(chat, 1104);
    expect(right().textContent).toContain("엔진 고르기");
  });

  it("outside a pane, the window still decides", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(max-width: 743px)", addEventListener() {}, removeEventListener() {} }));
    const loose = document.createElement("div");
    document.body.append(loose);
    composer(loose);
    expect(right().textContent).not.toContain("엔진 고르기");
  });
});
