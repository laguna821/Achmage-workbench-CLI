// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GroupTabs } from "./GroupTabs.tsx";
import type { Pane } from "../panes.ts";
import type { PaneHead } from "./Panes.tsx";

// The strip watches the active tab's width (its title arrives late). A tab that is no longer the
// active one must not be watched any more: its resize would snap the strip back and undo a scroll.

const watched = new Set<Element>();
beforeEach(() => {
  watched.clear();
  vi.stubGlobal("ResizeObserver", class { observe(element: Element) { watched.add(element); } unobserve(element: Element) { watched.delete(element); } disconnect() { watched.clear(); } });
  vi.stubGlobal("CSS", { escape: (text: string) => text });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type View = { kind: "work" };
const pane = (active: string): Pane<View> => ({
  id: "a", view: { kind: "work" }, workId: "w", sessionId: active, activeTabId: active,
  tabs: ["one", "two", "three"].map((id) => ({ id, view: { kind: "work" }, workId: "w", sessionId: id })),
});
const head = (shown: Pane<View>): PaneHead => ({ title: shown.sessionId ?? "", item: null } as PaneHead);
const strip = (active: string) => <GroupTabs pane={pane(active)} head={head} onSelect={() => {}} onClose={() => {}} onReorder={() => {}} onNew={() => {}} />;
const tabs = () => [...watched].filter((element) => element.hasAttribute("data-tab-id")).map((element) => element.getAttribute("data-tab-id"));

it("watches only the active tab: an earlier active tab is let go", () => {
  const view = render(strip("one"));
  expect(tabs()).toEqual(["one"]);
  view.rerender(strip("two"));
  expect(tabs()).toEqual(["two"]);
  view.rerender(strip("three"));
  expect(tabs()).toEqual(["three"]);
  // The strip itself stays watched throughout.
  expect([...watched].some((element) => element.getAttribute("role") === "tablist")).toBe(true);
});
