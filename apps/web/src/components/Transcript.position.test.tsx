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
