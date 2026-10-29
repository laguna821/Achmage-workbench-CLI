// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Transcript } from "./Transcript.tsx";
import { DocContext, type DocActions } from "./DocCards.tsx";
import { initialState } from "../state.ts";

afterEach(cleanup);
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
