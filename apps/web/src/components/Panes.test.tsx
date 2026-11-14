// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PaneLayout } from "./Panes.tsx";
import { GroupTabs } from "./GroupTabs.tsx";
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

it("marks an unseen answer on its background tab and on the head of its pane", () => {
  // Pane a: "seen" on screen, "fresh" answered behind it. Pane b: nothing new.
  const base = splitPane(withTabs(singleLayout("seen", "w1")), "a", "right", { view: "other", workId: "w2", sessionId: null }, null);
  const layout = withTabs(setPane(base, "a", { view: "fresh" }), base);
  const pane = layout.panes.find((entry) => entry.id === "a")!;
  const back = (id: string) => setPane(layout, "a", { view: id });
  const head = (entry: { view: string }) => ({ title: entry.view, icon: null, item: null, unseen: entry.view === "fresh" });
  const props = {
    enabled: true, onResize: () => {}, onFocus: () => {}, onClose: () => {}, onMove: () => {}, onSplit: () => {}, onDrop: () => {}, head,
    scope: () => ({ theme: "light", bubble: "none", frame: false, glow: "none", style: {} }), effectOf: () => "split" as const,
    render: () => null, tabBar: (group: typeof pane) => <GroupTabs pane={group} head={head} onSelect={() => {}} onClose={() => {}} onReorder={() => {}} onNew={() => {}} />,
  };
  // Show "seen" in front: the fresh answer waits in the tab behind it.
  const front = withTabs(back("seen"), layout);
  const view = render(<PaneLayout {...props} layout={front} />);
  const visible = view.container.querySelector<HTMLElement>('section.pane[data-pane="a"]:not([hidden])')!;
  // A badge on the icon box, so the tab and the head keep their width.
  expect(visible.querySelector(".pane-head .pane-head-icon > .new-badge")).not.toBeNull();
  const fresh = within(visible).getByRole("tab", { name: /fresh · 새 답/ });
  expect(fresh.querySelector(".badged > .new-badge")).not.toBeNull();
  expect([...fresh.children].some((child) => child.classList.contains("new-badge") || child.classList.contains("new-dot"))).toBe(false);
  expect(within(visible).getByRole("tab", { name: "seen" }).querySelector(".new-badge")).toBeNull();
  const other = view.container.querySelector<HTMLElement>('section.pane[data-pane]:not([data-pane="a"]):not([hidden])')!;
  expect(other.querySelector(".new-badge")).toBeNull();
});

it("never badges the tab on screen, even when its conversation lags behind as unseen", () => {
  const layout = withTabs(singleLayout("fresh", "w1"));
  const head = (entry: { view: string }) => ({ title: entry.view, icon: null, item: null, unseen: true });
  const view = render(<GroupTabs pane={layout.panes[0]!} head={head} onSelect={() => {}} onClose={() => {}} onReorder={() => {}} onNew={() => {}} />);
  expect(view.getByRole("tab", { name: "fresh" }).querySelector(".new-badge")).toBeNull();
});

it("a maximized pane picks another pane from the shared menu, without starting a pane drag", () => {
  const two = splitPane(singleLayout("doc-a", "w1"), "a", "right", { view: "doc-b", workId: "w1", sessionId: null }, null);
  const focused: string[] = [];
  const props = {
    enabled: true, onResize: () => {}, onFocus: (id: string) => focused.push(id), onClose: () => {}, onMove: () => {}, onSplit: () => {}, onDrop: () => {},
    head: (pane: { view: string }) => ({ title: pane.view, icon: null, item: null }),
    scope: () => ({ theme: "light", bubble: "none", frame: false, glow: "none", style: {} }), effectOf: () => "split" as const,
    render: (pane: { view: string }) => <p>{pane.view}</p>,
  };
  const rendered = render(<PaneLayout {...props} layout={two} maximized onMaximize={() => {}} />);
  const trigger = rendered.getByRole("button", { name: "표시할 칸" });
  expect(rendered.container.querySelector("select")).toBeNull();
  fireEvent.click(trigger);
  const other = rendered.getByRole("option", { name: /doc-b/ });
  fireEvent.pointerDown(other);
  fireEvent.mouseDown(other);
  fireEvent.click(other);
  expect(focused.at(-1)).toBe(two.panes.find(pane => pane.view === "doc-b")!.id);
  expect(rendered.queryByRole("listbox")).toBeNull();
});
