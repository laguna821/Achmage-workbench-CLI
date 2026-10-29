// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { MarkdownEditor } from "./MarkdownEditor.tsx";
import { undo } from "@codemirror/commands";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("changes edit access without recreating the editor or losing its undo history and selection", () => {
  vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", () => {});
  let editor: EditorView | null = null, value = "original";
  const view = (readOnly: boolean) => <MarkdownEditor value={value} readOnly={readOnly} onChange={(text) => { value = text; }} onSelection={() => {}} onView={(next) => { editor = next; }} />;
  const screen = render(view(false)); const original = editor!, dom = original.dom;
  act(() => { original.dispatch({ changes: { from: 8, insert: " draft" }, selection: { anchor: 14 } }); });
  screen.rerender(view(true));
  expect(editor).toBe(original); expect(editor!.dom).toBe(dom);
  expect(editor!.state.selection.main.anchor).toBe(14); expect(editor!.contentDOM.getAttribute("contenteditable")).toBe("false");
  screen.rerender(view(false));
  act(() => { expect(undo(editor!)).toBe(true); });
  expect(value).toBe("original");
});
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
