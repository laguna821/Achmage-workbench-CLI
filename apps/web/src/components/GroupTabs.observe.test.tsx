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

// N1: the strip shows the current project's tabs; another project's are one list away (still open).
// Project tabs (2026-11-15): a tab of no project is off the strip too, and the ⌄ key counts nothing of theirs.
it("shows the current project's tabs, lists the others under 다른 프로젝트, and names a tab from another project only while all are shown", async () => {
  const { fireEvent, screen, within } = await import("@testing-library/react");
  const mixed: Pane<View> = {
    id: "a", view: { kind: "work" }, workId: "A", sessionId: "a1", activeTabId: "a1",
    tabs: [{ id: "a1", view: { kind: "work" }, workId: "A", sessionId: "a1" }, { id: "b1", view: { kind: "work" }, workId: "B", sessionId: "b1" }, { id: "h", view: { kind: "work" }, workId: null, sessionId: "h" }],
  };
  const names = (id: string) => ({ A: "강의", B: "연구" })[id] ?? id;
  const onSelect = vi.fn();
  const view = render(<GroupTabs pane={mixed} head={head} onSelect={onSelect} onClose={() => {}} onReorder={() => {}} onNew={() => {}} scope={{ workId: "A", all: false, projectName: names, onShowAll: () => {} }} />);
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["a1"]);
  // No overflow of its own: the bare chevron (the "N개 더" count is the project's own overflow: GroupTabs.scope.test.tsx).
  const more = screen.getByRole("button", { name: "열린 탭 목록" });
  expect(more.textContent).toBe("");
  fireEvent.click(more);
  const list = await screen.findByRole("menu", { name: "열린 탭" });
  fireEvent.click(within(list).getByRole("menuitem", { name: /연구 · b1/ }));
  expect(onSelect).toHaveBeenCalledWith("b1");
  // 모든 프로젝트의 탭 보기: a tab of another project than the pane's says that project on the tab.
  view.rerender(<GroupTabs pane={mixed} head={head} onSelect={onSelect} onClose={() => {}} onReorder={() => {}} onNew={() => {}} scope={{ workId: "B", all: true, projectName: names, onShowAll: () => {} }} />);
  expect(screen.getAllByRole("tab")[0]!.querySelector(".group-tab-project")!.textContent).toBe("강의");
});

// Skin 2 · B, item 5: two panes, two projects. Each pane's strip follows its OWN active tab's project
// (not one global project), and when the panes hold different projects each pane names its project
// (quietly, before the tabs). One project on screen: no label.
it("a pane names its project before its tabs when panes show different projects; its strip follows its own tab", async () => {
  const { screen } = await import("@testing-library/react");
  const { paneScopes } = await import("../tabs.ts");
  const { singleLayout, splitPane } = await import("../panes.ts");
  const { withTabs } = await import("../tabs.ts");
  type W = { kind: "work" } | { kind: "new" };
  const one = withTabs(singleLayout<W>({ kind: "work" }, "A"));
  const two = withTabs(splitPane(one, "a", "right", { view: { kind: "work" }, workId: "B", sessionId: "b1" }, null), one);
  const scopes = paneScopes(two, "A");
  expect(Object.values(scopes)).toEqual([{ workId: "A", named: true }, { workId: "B", named: true }]);
  expect(Object.values(paneScopes(one, "A"))).toEqual([{ workId: "A", named: false }]);
  // A pane on home (no project) keeps the current project's strip and names nothing of its own.
  const home = withTabs(splitPane(one, "a", "right", { view: { kind: "new" }, workId: "A", sessionId: null }, null), one);
  expect(Object.values(paneScopes({ ...home, panes: home.panes.map((pane, index) => index ? { ...pane, tabs: pane.tabs!.map((tab) => ({ ...tab, workId: null })) } : pane) }, "A"))).toEqual([{ workId: "A", named: false }, { workId: "A", named: false }]);
  const mixed: Pane<View> = {
    id: "b", view: { kind: "work" }, workId: "B", sessionId: "b1", activeTabId: "b1",
    tabs: [{ id: "a1", view: { kind: "work" }, workId: "A", sessionId: "a1" }, { id: "b1", view: { kind: "work" }, workId: "B", sessionId: "b1" }],
  };
  const names = (id: string) => ({ A: "강의", B: "연구" })[id] ?? id;
  const { container } = render(<GroupTabs pane={mixed} head={head} onSelect={() => {}} onClose={() => {}} onReorder={() => {}} onNew={() => {}} scope={{ workId: "B", label: "연구", all: false, projectName: names, onShowAll: () => {} }} />);
  const label = container.querySelector(".group-tabs-project")!;
  expect(label.textContent).toBe("연구");
  expect(label.nextElementSibling?.getAttribute("role")).toBe("tablist");
  expect(screen.getByRole("navigation").getAttribute("aria-label")).toBe("연구 탭");
  // The strip is this pane's project: its own tab carries no other-project mark; A's tab is one list away.
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["b1"]);
});
