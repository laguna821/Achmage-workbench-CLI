// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneLayout } from "./Panes.tsx";
import { GroupTabs } from "./GroupTabs.tsx";
import { singleLayout, splitPane, type Pane } from "../panes.ts";

// Zooming a pane opens it out from its cell and restoring settles it back, never scaling text; a
// pane holding a native web view snaps and the view is re-placed at once. Opening a tab widens it
// in, closing one slides the tabs whose place changed into the gap. With reduced motion nothing moves.

type Call = { element: HTMLElement; frames: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean };
let calls: Call[] = [];
let reduce = false;

beforeEach(() => {
  calls = [];
  reduce = false;
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value(this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
      const call: Call = { element: this, frames, options, cancelled: false };
      calls.push(call);
      return { cancel() { call.cancelled = true; }, finish() {}, onfinish: null, oncancel: null } as unknown as Animation;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value(this: HTMLElement) {
      return calls.filter((call) => call.element === this && !call.cancelled).map((call) => ({ cancel() { call.cancelled = true; } }));
    },
  });
  window.matchMedia = ((query: string) => ({ matches: reduce && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

const props = {
  enabled: true, onResize: () => {}, onFocus: () => {}, onClose: () => {}, onMove: () => {}, onSplit: () => {}, onDrop: () => {},
  head: (pane: { view: string }) => ({ title: pane.view, icon: null, item: null }),
  scope: () => ({ theme: "light", bubble: "none", frame: false, glow: "off", style: {} }),
  effectOf: () => "split" as const,
  render: (pane: { view: string }) => <p>{pane.view}</p>,
};

const scaled = (call: Call) => call.frames.some((frame) => /scale/.test(String(frame.transform ?? "")));
const insetOf = (frame: Keyframe) => /inset\(([\d.]+)px ([\d.]+)px ([\d.]+)px ([\d.]+)px/.exec(String(frame.clipPath))!.slice(1).map(Number);

describe("pane zoom", () => {
  const layout = splitPane(singleLayout("doc-a", "w1"), "a", "right", { view: "doc-b", workId: "w1", sessionId: null }, null);
  const focusedIn = (container: HTMLElement) => container.querySelector<HTMLElement>(`.pane[data-pane="${layout.focus}"]`)!;

  it("opens the pane out from its cell by a clip, then settles it back with a short move and fade, never scaling", () => {
    const rendered = render(<PaneLayout {...props} layout={layout} />);
    expect(calls).toHaveLength(0);

    rendered.rerender(<PaneLayout {...props} layout={layout} maximized />);
    const grow = calls.find((call) => call.element === focusedIn(rendered.container))!;
    const [top, right, bottom, left] = insetOf(grow.frames[0]!);
    expect(left).toBeGreaterThan(400); // the right-hand cell: clipped from the left at first
    expect([top, right, bottom]).toEqual([0, 0, 0]);
    expect(insetOf(grow.frames.at(-1)!)).toEqual([0, 0, 0, 0]);
    expect(grow.options.duration).toBe(220);

    calls = [];
    rendered.rerender(<PaneLayout {...props} layout={layout} />);
    const back = calls.find((call) => call.element === focusedIn(rendered.container))!;
    expect(back.frames[0]).toMatchObject({ opacity: 0.6, transform: "translate(-24px, 0px)" }); // from the side the whole view was
    expect(back.frames.at(-1)).toMatchObject({ opacity: 1, transform: "none" });
    const other = calls.find((call) => call.element !== focusedIn(rendered.container));
    expect(other?.frames[0]).toMatchObject({ opacity: 0 });
    expect(calls.some(scaled)).toBe(false);
  });

  it("restoring mid-zoom cancels the opening first", () => {
    const rendered = render(<PaneLayout {...props} layout={layout} />);
    rendered.rerender(<PaneLayout {...props} layout={layout} maximized />);
    const grow = calls.find((call) => call.element === focusedIn(rendered.container))!;
    rendered.rerender(<PaneLayout {...props} layout={layout} />);
    expect(grow.cancelled).toBe(true);
    expect(calls.filter((call) => call.element === focusedIn(rendered.container) && !call.cancelled)).toHaveLength(1);
  });

  it("snaps a pane that holds a native web view and re-places the view right away", () => {
    const onPresent = vi.fn();
    const web = { ...props, render: (pane: { view: string }) => pane.view === "doc-b" ? <div className="browser-viewport" /> : <p>{pane.view}</p> };
    const rendered = render(<PaneLayout {...web} layout={layout} onPresent={onPresent} />);
    expect(onPresent).not.toHaveBeenCalled();
    rendered.rerender(<PaneLayout {...web} layout={layout} onPresent={onPresent} maximized />);
    expect(onPresent).toHaveBeenCalledTimes(1);
    rendered.rerender(<PaneLayout {...web} layout={layout} onPresent={onPresent} />);
    expect(onPresent).toHaveBeenCalledTimes(2);
    const browserPane = rendered.container.querySelector(".browser-viewport")!.closest<HTMLElement>(".pane");
    expect(calls.some((call) => call.element === browserPane)).toBe(false);
  });

  it("does not move with reduced motion", () => {
    reduce = true;
    const rendered = render(<PaneLayout {...props} layout={layout} />);
    rendered.rerender(<PaneLayout {...props} layout={layout} maximized />);
    rendered.rerender(<PaneLayout {...props} layout={layout} />);
    expect(calls).toHaveLength(0);
  });
});

describe("tab open and close", () => {
  const tab = (id: string) => ({ id, view: id, workId: "w1", sessionId: null });
  let paneId = 0;
  beforeEach(() => { paneId += 1; });
  const pane = (ids: string[]): Pane<string> => ({ id: `p${paneId}`, view: ids[0]!, workId: "w1", sessionId: null, tabs: ids.map(tab), activeTabId: ids[0]! }) as Pane<string>;
  const tabProps = { head: (entry: { view: string }) => ({ title: entry.view, icon: null, item: null }), onSelect: () => {}, onClose: () => {}, onReorder: () => {}, onNew: () => {} };
  // Where the strip sits on screen: changed by zoom, sidebar, divider, resize or scroll.
  let screenShift = 0;

  beforeEach(() => {
    screenShift = 0;
    // Each tab is 100px wide, laid out in DOM order within the strip.
    const index = (element: HTMLElement) => {
      const row = element.closest<HTMLElement>("[data-tab-id]");
      return row ? Array.from(row.parentElement!.children).indexOf(row) : 0;
    };
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) { return index(this) * 100; });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const left = screenShift + index(this) * 100;
      return { left, top: 0, width: 100, height: 28, right: left + 100, bottom: 28, x: left, y: 0, toJSON() {} } as DOMRect;
    });
  });

  it("widens a new tab in, also when the new tab's view mounts its own copy of the bar", () => {
    const rendered = render(<section><GroupTabs {...tabProps} pane={pane(["t1", "t2"])} /></section>);
    expect(calls).toHaveLength(0);
    rendered.rerender(<>
      <section hidden><GroupTabs {...tabProps} pane={pane(["t1", "t2", "t3"])} /></section>
      <section><GroupTabs key="t3" {...tabProps} pane={pane(["t1", "t2", "t3"])} /></section>
    </>);
    const opened = calls.find((call) => call.element.dataset.tabId === "t3")!;
    expect(opened.element.closest("[hidden]")).toBeNull();
    expect(opened.frames[0]).toMatchObject({ width: "0px" });
    expect(opened.frames.at(-1)).toMatchObject({ width: "100px" });
    expect(opened.options.duration).toBe(120);
    expect(calls.filter((call) => call.element.dataset.tabId !== "t3")).toHaveLength(0);
  });

  it("slides only the tabs whose place changed, even after the strip moved on screen", () => {
    const rendered = render(<GroupTabs {...tabProps} pane={pane(["t1", "t2", "t3"])} />);
    screenShift = 720; // e.g. the pane was zoomed: the bar moved, the tabs did not change
    rendered.rerender(<GroupTabs {...tabProps} pane={pane(["t1", "t2", "t3"])} />);
    rendered.rerender(<GroupTabs {...tabProps} pane={pane(["t1", "t3"])} />);
    expect(calls.some((call) => call.element.dataset.tabId === "t1")).toBe(false);
    const slid = calls.find((call) => call.element.dataset.tabId === "t3")!;
    expect(slid.frames[0]).toMatchObject({ transform: "translateX(100px)" });
    expect(slid.frames.at(-1)).toMatchObject({ transform: "none" });
    expect(calls).toHaveLength(1);
  });

  // Each tab's view carries its own copy of the bar (Panes.tsx): closing the shown tab removes the
  // shown copy, and the next tab's copy (already mounted and hidden, or new) takes over.
  for (const successor of ["mounted", "new"] as const) {
    it(`closing the active tab slides the tabs after it into the gap (next copy ${successor})`, () => {
      const copy = (ids: string[], key: string, hidden: boolean) => <section key={key} hidden={hidden}><GroupTabs {...tabProps} pane={pane(ids)} /></section>;
      const all = ["t1", "t2", "t3"];
      const rendered = render(<>{[successor === "mounted" ? copy(all, "t3", true) : null, copy(all, "t2", false)]}</>);
      expect(calls).toHaveLength(0);
      rendered.rerender(<>{[copy(["t1", "t3"], "t3", false)]}</>);
      const shownRows = rendered.container.querySelectorAll<HTMLElement>("section:not([hidden]) [data-tab-id]");
      const slid = calls.filter((call) => call.element.isConnected);
      expect(slid).toHaveLength(1);
      expect(slid[0]!.element).toBe(shownRows[1]);
      expect(slid[0]!.element.dataset.tabId).toBe("t3");
      expect(slid[0]!.frames[0]).toMatchObject({ transform: "translateX(100px)" }); // by the closed tab's width
      expect(slid[0]!.frames.at(-1)).toMatchObject({ transform: "none" });
      expect(calls.some((call) => call.element.dataset.tabId === "t1")).toBe(false);
    });
  }

  it("forgets a pane's tab places once the pane is gone", async () => {
    const first = render(<GroupTabs {...tabProps} pane={pane(["t1", "t2", "t3"])} />);
    first.unmount();
    await Promise.resolve();
    render(<GroupTabs {...tabProps} pane={pane(["t1", "t3"])} />);
    expect(calls).toHaveLength(0);
  });

  it("does not move with reduced motion", () => {
    reduce = true;
    const rendered = render(<GroupTabs {...tabProps} pane={pane(["t1", "t2", "t3"])} />);
    rendered.rerender(<GroupTabs {...tabProps} pane={pane(["t1", "t3"])} />);
    rendered.rerender(<GroupTabs {...tabProps} pane={pane(["t1", "t3", "t4"])} />);
    expect(calls).toHaveLength(0);
  });
});
