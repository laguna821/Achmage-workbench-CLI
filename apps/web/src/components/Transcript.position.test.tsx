// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Transcript } from "./Transcript.tsx";
import { DocContext, type DocActions } from "./DocCards.tsx";
import { initialState } from "../state.ts";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("restores a reader's position after async loading and does not record hidden-tab scroll resets", () => {
  const changed = vi.fn();
  const view = (loading: boolean) => <DocContext.Provider value={{ state: initialState, actions: {} as DocActions }}><section className="pane"><Transcript sessionId="session" items={[]} provider="codex" running={false} loading={loading} onAnswer={() => {}} position={{ top: 80, follow: false }} onPosition={changed} /></section></DocContext.Provider>;
  const screen = render(view(true));
  const scroller = screen.container.querySelector<HTMLElement>(".transcript")!;
  Object.defineProperties(scroller, { clientHeight: { value: 100, configurable: true }, scrollHeight: { value: 500, configurable: true } });
  screen.rerender(view(false));
  expect(scroller.scrollTop).toBe(80);
  fireEvent.scroll(scroller);
  expect(changed).toHaveBeenLastCalledWith({ top: 80, follow: false });
  screen.container.querySelector("section")!.hidden = true;
  scroller.scrollTop = 0; fireEvent.scroll(scroller);
  expect(changed).toHaveBeenCalledTimes(1);
});

it("keeps the request band stable when a compact pane makes its mounted height smaller than the scroll trigger", () => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("transcript") ? 200 : 0; });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("transcript") ? 1000 : 0; });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("turn-request") ? 90 : 0; });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("turn-pin") ? 28 : this.classList.contains("turn-request") ? 40 : this.classList.contains("turn") ? 500 : 0;
  });
  const view = render(<DocContext.Provider value={{ state: initialState, actions: {} as DocActions }}><section className="pane"><Transcript sessionId="compact-band" items={[{ kind: "user", id: "u", text: "요청", at: 1 }, { kind: "assistant", id: "a", text: "긴 답변", streaming: false, at: 2 }]} provider="codex" running={false} loading={false} onAnswer={() => {}} position={{ top: 100, follow: false }} /></section></DocContext.Provider>);
  expect(view.container.querySelector(".turn-pin")).toBeTruthy();
  const scroller = view.container.querySelector<HTMLElement>(".transcript")!;
  fireEvent.scroll(scroller);
  expect(view.container.querySelector(".turn-pin")).toBeTruthy();
});

it("puts 맨 아래로 on a band of its own under the conversation, inside the reading column — never over the words", () => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("transcript") ? 200 : 0; });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("transcript") ? 1000 : 0; });
  const view = render(<DocContext.Provider value={{ state: initialState, actions: {} as DocActions }}><section className="pane"><Transcript sessionId="jump" items={[{ kind: "user", id: "u", text: "요청", at: 1 }, { kind: "assistant", id: "a", text: "긴 답변", at: 2, streaming: false }]} provider="codex" running={false} loading={false} onAnswer={() => {}} /></section></DocContext.Provider>);
  const scroller = view.container.querySelector<HTMLElement>(".transcript")!;
  // At the end: nothing.
  scroller.scrollTop = 800; fireEvent.scroll(scroller);
  expect(view.container.querySelector(".jump-band")).toBeNull();
  // Scrolled up: the band, after the scroller (not inside it), holding the column and the button.
  fireEvent.wheel(scroller, { deltaY: -40 });
  scroller.scrollTop = 100; fireEvent.scroll(scroller);
  const band = view.container.querySelector<HTMLElement>(".jump-band")!;
  expect(band).toBeTruthy();
  expect(scroller.contains(band)).toBe(false);
  expect(band.parentElement).toBe(scroller.parentElement);
  const button = band.querySelector<HTMLButtonElement>(".jump-band-inner > button")!;
  expect(button.textContent).toContain("맨 아래로");
  expect(view.container.querySelector(".to-bottom")).toBeNull();
  // jsdom has no scrollTo: stand in for it on this scroller.
  scroller.scrollTo = ((options: ScrollToOptions) => { scroller.scrollTop = options.top ?? 0; }) as typeof scroller.scrollTo;
  fireEvent.click(button);
  expect(scroller.scrollTop).toBe(1000);
});

/** A conversation 1000px long in a 200px view whose position clamps as a browser clamps it (jsdom keeps any number). Its own id: where a conversation was read is kept per id. */
function longConversation(sessionId: string, onPosition: (position: { top: number; follow: boolean }) => void) {
  const size = { content: 1000 };
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("transcript") ? 200 : 0; });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("transcript") ? size.content : 0; });
  // What the app does on every position it is told: the tab's state changes and the conversation renders again.
  const view = (answer: string) => <DocContext.Provider value={{ state: initialState, actions: {} as DocActions }}><section className="pane"><Transcript sessionId={sessionId} items={[{ kind: "user", id: "u", text: "요청", at: 1 }, { kind: "assistant", id: "a", text: answer, at: 2, streaming: false }]} provider="claude" running={false} loading={false} onAnswer={() => {}} onPosition={onPosition} /></section></DocContext.Provider>;
  const screen = render(view("긴 답변"));
  const scroller = screen.container.querySelector<HTMLElement>(".transcript")!;
  let top = 0;
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = Math.min(Math.max(0, value), size.content - 200); } });
  let renders = 0;
  const again = () => screen.rerender(view(`긴 답변 ${renders += 1}`));
  /** The browser moved the view (the reader did, or the content got shorter): the position, its scroll event, the render that follows. */
  const moveTo = (value: number) => { scroller.scrollTop = value; fireEvent.scroll(scroller); again(); };
  again();
  fireEvent.scroll(scroller);
  return { scroller, size, again, moveTo };
}

it("lets a reader at the end move up in small steps: a touchpad, a finger and a slowly dragged scroll bar move a few pixels at a time, and the render after each step does not pull them back to the end", () => {
  const changed = vi.fn();
  const { scroller, moveTo } = longConversation("small-steps", changed);
  expect(scroller.scrollTop).toBe(800);
  // A touchpad (or a wheel the browser animates): 6px a step.
  fireEvent.wheel(scroller, { deltaY: -6 });
  moveTo(794);
  expect(scroller.scrollTop).toBe(794);
  expect(changed).toHaveBeenLastCalledWith({ top: 794, follow: false });
  // A finger: 10px a step.
  fireEvent.touchMove(scroller);
  moveTo(784);
  expect(scroller.scrollTop).toBe(784);
  // The scroll bar, dragged slowly: no wheel, key or touch event, only the position moves.
  moveTo(779);
  expect(scroller.scrollTop).toBe(779);
  expect(changed).toHaveBeenLastCalledWith({ top: 779, follow: false });
});

it("lets a reader leave the end with the scroll bar alone, in a step smaller than the end's margin", () => {
  const changed = vi.fn();
  const { scroller, moveTo } = longConversation("bar-alone", changed);
  moveTo(795);
  expect(scroller.scrollTop).toBe(795);
  expect(changed).toHaveBeenLastCalledWith({ top: 795, follow: false });
});

it("keeps following the end for a reader who is at the end: when the content gets shorter, when it grows, and after coming back down", () => {
  const changed = vi.fn();
  const { scroller, size, again, moveTo } = longConversation("follows", changed);
  // The content got shorter (a finished answer drawn again): the browser clamps the position — a move up that is not the reader's.
  size.content = 900;
  moveTo(800);
  expect(scroller.scrollTop).toBe(700);
  expect(changed).toHaveBeenLastCalledWith({ top: 700, follow: true });
  // It grows: the view goes with it.
  size.content = 1200;
  again();
  expect(scroller.scrollTop).toBe(1000);
  fireEvent.scroll(scroller);
  // The reader goes up, then comes back down into the end's margin: following again.
  fireEvent.wheel(scroller, { deltaY: -120 });
  moveTo(880);
  expect(changed).toHaveBeenLastCalledWith({ top: 880, follow: false });
  moveTo(990);
  expect(changed).toHaveBeenLastCalledWith({ top: 990, follow: true });
  size.content = 1300;
  again();
  expect(scroller.scrollTop).toBe(1100);
});

it("leaves the view with a reader who takes the scroll bar while an answer is written: a render that comes before the bar's scroll event does not put it back at the end", () => {
  const changed = vi.fn();
  const { scroller, size, again } = longConversation("bar-during-answer", changed);
  // A 15px scroll bar at the right of a 300px column.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("transcript") ? 315 : 0; });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("transcript") ? 300 : 0; });
  // A press on the words, or beside them, is not the bar: following goes on.
  fireEvent.pointerDown(scroller.querySelector(".turn-answer")!, { clientX: 120 });
  fireEvent.pointerDown(scroller, { clientX: 120 });
  size.content = 1100;
  again();
  expect(scroller.scrollTop).toBe(900);
  fireEvent.scroll(scroller);
  // The bar: pressed, dragged up — and the answer grows (a render) before the bar's scroll event comes.
  fireEvent.pointerDown(scroller, { clientX: 307 });
  scroller.scrollTop = 500;
  size.content = 1200;
  again();
  expect(scroller.scrollTop).toBe(500);
  fireEvent.scroll(scroller);
  expect(changed).toHaveBeenLastCalledWith({ top: 500, follow: false });
});
