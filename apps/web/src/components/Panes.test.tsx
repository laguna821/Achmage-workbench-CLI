// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PaneLayout } from "./Panes.tsx";
import { movePane, singleLayout, splitPane } from "../panes.ts";
import { setPane } from "../panes.ts";
import { activeTab, moveTab, withTabs } from "../tabs.ts";

afterEach(cleanup);
it("preserves mounted editor inputs when a pane moves into a nested split", () => {
  const first = singleLayout("doc-a", "w1");
  const second = splitPane(first, "a", "right", { view: "doc-b", workId: "w1", sessionId: null }, "s1");
  const third = splitPane(second, "a", "bottom", { view: "doc-c", workId: "w1", sessionId: null }, null);
  const props = {
    enabled: true, onResize: () => {}, onFocus: () => {}, onClose: () => {}, onMove: () => {}, onSplit: () => {}, onDrop: () => {},
    head: (pane: { view: string }) => ({ title: pane.view, icon: null, item: null }),
    scope: () => ({ theme: "light", bubble: "none", frame: false, glow: "none", style: {} }),
    effectOf: () => "split" as const,
    render: (pane: { id: string; view: string }) => <input aria-label={pane.view} defaultValue={pane.id} />,
  };
  const rendered = render(<PaneLayout {...props} layout={third} />);
  const input = rendered.getByLabelText("doc-a") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "unsaved editor state" } });
  rendered.rerender(<PaneLayout {...props} layout={movePane(third, "a", { paneId: second.focus, side: "bottom" })} />);
  expect(rendered.getByLabelText("doc-a")).toBe(input);
  expect(input.value).toBe("unsaved editor state");
});

it("retains the same mounted input and iframe when switching and moving a tab between groups", () => {
  const first = withTabs(singleLayout("doc-a", "w1"));
  const tab = activeTab(first.panes[0]!);
  const props = {
    enabled: true, onResize: () => {}, onFocus: () => {}, onClose: () => {}, onMove: () => {}, onSplit: () => {}, onDrop: () => {},
    head: (pane: { view: string }) => ({ title: pane.view, icon: null, item: null }),
    scope: () => ({ theme: "light", bubble: "none", frame: false, glow: "none", style: {} }), effectOf: () => "split" as const,
    render: (pane: { view: string }) => <><input aria-label={pane.view} /><iframe title={`${pane.view}-editor`} /></>,
  };
  const rendered = render(<PaneLayout {...props} layout={first} />);
  const input = rendered.getByLabelText("doc-a") as HTMLInputElement, frame = rendered.getByTitle("doc-a-editor");
  fireEvent.change(input, { target: { value: "kept edit and undo owner" } });
  const second = withTabs(setPane(first, "a", { view: "doc-b" }), first);
  rendered.rerender(<PaneLayout {...props} layout={second} />);
  expect(input.closest("section")?.hidden).toBe(true);
  rendered.rerender(<PaneLayout {...props} layout={moveTab(second, tab.id, { paneId: "a", side: "bottom" })} />);
  expect(rendered.getByLabelText("doc-a")).toBe(input);
  expect(rendered.getByTitle("doc-a-editor")).toBe(frame);
  expect(input.value).toBe("kept edit and undo owner");
  expect(input.closest("section")?.hidden).toBe(false);
});
