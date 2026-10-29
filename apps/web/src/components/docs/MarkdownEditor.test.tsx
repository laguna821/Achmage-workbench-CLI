// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { MarkdownEditor } from "./MarkdownEditor.tsx";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("restores the actual CodeMirror selection and captures a last change before the tab becomes hidden", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  let editor: EditorView | null = null;
  const changed = vi.fn();
  const screen = render(<section className="pane"><MarkdownEditor value="01234567890123456789" onChange={() => {}} onSelection={() => {}} position={{ cursor: { anchor: 5, head: 9 } }} onPosition={changed} onView={(view) => { editor = view; }} /></section>);
  expect(editor!.state.selection.main.anchor).toBe(5);
  expect(editor!.state.selection.main.head).toBe(9);
  act(() => { editor!.dispatch({ selection: { anchor: 13, head: 17 } }); });
  screen.container.querySelector("section")!.hidden = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(130); });
  expect(changed).toHaveBeenLastCalledWith({ cursor: { anchor: 13, head: 17 }, scroll: { top: 0, left: 0 } });
});
