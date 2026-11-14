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
