// @vitest-environment jsdom
import { useRef } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { paneDrag, useDropArea } from "./panedrag.ts";

afterEach(() => { fireEvent.blur(window); cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("handles desktop mouse-only drag and coalesces normal Pointer plus Mouse streams", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const drop = vi.fn();
  function Target() {
    const ref = useRef<HTMLDivElement>(null);
    useDropArea({ element: () => ref.current, targetAt: () => ({ paneId: "a", side: "bottom" }), drop });
    const press = (event: { button: number; clientX: number; clientY: number }) => paneDrag.press({ item: { kind: "tab", id: "doc-tab" }, label: "Document" }, event);
    return <div ref={ref}><button onPointerDown={press} onMouseDown={press}>Move</button></div>;
  }
  const screen = render(<Target />), button = screen.getByRole("button");
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => button });
  fireEvent.mouseDown(button, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.mouseMove(window, { clientX: 100, clientY: 100 });
  fireEvent.mouseUp(window, { button: 0, clientX: 100, clientY: 100 });
  expect(drop).toHaveBeenCalledExactlyOnceWith({ kind: "tab", id: "doc-tab" }, { paneId: "a", side: "bottom" });
  drop.mockClear();
  fireEvent.pointerDown(button, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.mouseDown(button, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(window, { clientX: 100, clientY: 100 });
  fireEvent.mouseMove(window, { clientX: 100, clientY: 100 });
  fireEvent.pointerUp(window, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.mouseUp(window, { button: 0, clientX: 100, clientY: 100 });
  expect(drop).toHaveBeenCalledTimes(1);
});
