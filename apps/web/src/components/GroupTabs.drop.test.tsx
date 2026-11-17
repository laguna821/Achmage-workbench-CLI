// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GroupTabs } from "./GroupTabs.tsx";
import { setPane, singleLayout, type PaneTarget } from "../panes.ts";
import { withTabs } from "../tabs.ts";
import { useDropArea } from "../panedrag.ts";

// 0.5.3 window-ux: a tab held over its strip shows a thin insertion mark between two tabs, and nothing else.

afterEach(() => { fireEvent.blur(window); cleanup(); vi.unstubAllGlobals(); });

it("draws the insertion mark before the tab the held one would go in front of; none at its own place", () => {
  vi.stubGlobal("CSS", { escape: (text: string) => text });
  vi.stubGlobal("PointerEvent", MouseEvent);
  let layout = withTabs(singleLayout("one", "w"));
  for (const id of ["two", "three"]) layout = withTabs(setPane(layout, layout.panes[0]!.id, { view: id }), layout);
  layout = withTabs(setPane(layout, layout.panes[0]!.id, { view: "one" }), layout);
  const pane = layout.panes[0]!;
  let target: PaneTarget = { paneId: pane.id, side: "center", tabIndex: 1 };
  function Area() {
    const ref = useRef<HTMLDivElement>(null);
    useDropArea({ element: () => ref.current, targetAt: () => target, drop: () => {} });
    return <div ref={ref}><GroupTabs pane={pane} head={(entry) => ({ title: entry.view, icon: null, item: null })} onSelect={() => {}} onClose={() => {}} onReorder={() => {}} onNew={() => {}} /></div>;
  }
  const view = render(<Area />);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => view.container.querySelector(".group-tabs") });
  const first = within(view.container).getByRole("tab", { name: "one" });
  fireEvent.pointerDown(first, { button: 0, clientX: 10, clientY: 10 });
  act(() => { fireEvent.pointerMove(window, { clientX: 60, clientY: 10 }); });
  const marks = view.container.querySelectorAll(".group-tab-drop");
  expect(marks).toHaveLength(1);
  expect(marks[0]!.closest<HTMLElement>("[data-tab-id]")!.textContent).toContain("three");
  expect(marks[0]!.classList.contains("before")).toBe(true);
  target = { paneId: pane.id, side: "center", tabIndex: 0 };
  act(() => { fireEvent.pointerMove(window, { clientX: 12, clientY: 10 }); });
  expect(view.container.querySelectorAll(".group-tab-drop")).toHaveLength(0);
  target = { paneId: pane.id, side: "center", tabIndex: 2 };
  act(() => { fireEvent.pointerMove(window, { clientX: 300, clientY: 10 }); });
  const end = view.container.querySelector(".group-tab-drop");
  expect(end?.classList.contains("after")).toBe(true);
  expect(end?.closest<HTMLElement>("[data-tab-id]")!.textContent).toContain("three");
  act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
  expect(view.container.querySelectorAll(".group-tab-drop")).toHaveLength(0);
});
