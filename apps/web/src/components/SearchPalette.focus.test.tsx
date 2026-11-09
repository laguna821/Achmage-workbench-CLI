// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppearanceContext, NEUTRAL_LOOK, type AppearanceApi } from "../appearance.ts";
import { initialState } from "../state.ts";
import type { Api } from "../api.ts";
import { SearchPalette } from "./SearchPalette.tsx";

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => { Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() }); });
afterEach(() => {
  cleanup(); document.body.replaceChildren(); vi.restoreAllMocks();
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll); else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
function setup() {
  document.body.innerHTML = '<div class="pane"><div class="transcript"></div><textarea aria-label="원래 입력">작성 중인 원문</textarea><input aria-label="명령 대상" /></div>';
  const opener = screen.getByLabelText("원래 입력") as HTMLTextAreaElement, scroller = document.querySelector<HTMLElement>(".transcript")!, destination = screen.getByLabelText("명령 대상");
  opener.focus(); opener.setSelectionRange(2, 5); scroller.scrollTop = 420;
  const run = vi.fn(() => destination.focus()), api = {} as Api;
  function Harness() {
    const [open, setOpen] = useState(true);
    return <AppearanceContext.Provider value={{ appTheme: "light", lookOf: () => NEUTRAL_LOOK.light } as unknown as AppearanceApi}>
      {open && <SearchPalette api={api} state={initialState} commands={[{ id: "open", label: "대상 열기", icon: "file", run }]} onClose={() => setOpen(false)} onOpenSession={vi.fn()} onOpenHit={vi.fn()} onOpenWork={vi.fn()} onOpenDoc={vi.fn()} />}
    </AppearanceContext.Provider>;
  }
  render(<Harness />);
  return { opener, scroller, destination, run, input: screen.getByRole("textbox", { name: "찾을 말" }) };
}
it("restores the original caret and reading scroll when Escape cancels search", () => {
  const f = setup(); f.scroller.scrollTop = 900;
  fireEvent.keyDown(f.input, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "찾기" })).toBeNull();
  expect(document.activeElement).toBe(f.opener); expect(f.opener.selectionStart).toBe(2); expect(f.opener.selectionEnd).toBe(5);
  expect(f.scroller.scrollTop).toBe(420); expect(f.run).not.toHaveBeenCalled();
});
it("leaves focus and scrolling with the opened command instead of returning to the origin", async () => {
  const f = setup(); f.scroller.scrollTop = 900;
  fireEvent.change(f.input, { target: { value: ">대상" } });
  await act(async () => { fireEvent.keyDown(f.input, { key: "Enter" }); });
  expect(f.run).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(f.destination); expect(f.scroller.scrollTop).toBe(900);
});
it("does not close during IME composition and restores on outside dismissal", () => {
  const f = setup();
  fireEvent.compositionStart(f.input); fireEvent.keyDown(f.input, { key: "Escape", isComposing: true });
  expect(screen.getByRole("dialog", { name: "찾기" })).toBeTruthy();
  fireEvent.compositionEnd(f.input);
  fireEvent.pointerDown(document.querySelector(".palette-backdrop")!);
  expect(document.activeElement).toBe(f.opener);
});
