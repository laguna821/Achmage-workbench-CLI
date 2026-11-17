// @vitest-environment jsdom
// Coordinator's gate 1 (office-ai-live): a document tab closed while a 문서 AI turn runs live in its editor keeps its
// view mounted off screen — the same view, never remounted — until the turn ends; opened again meanwhile, the tab comes
// back attached to that same view (no second editor on the document); the view is released on every ending.
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PaneLayout } from "./Panes.tsx";
import { settleLayout } from "../companion-desk.ts";
import { closePane, setPane, splitPane, singleLayout, type Layout, type Pane, type PaneContent } from "../panes.ts";
import { closeTab, contentKey, findTab, tabsOf } from "../tabs.ts";
import { TabClosed, useKeepOnClose } from "../tab-sleep.ts";
import { useContext } from "react";

beforeEach(() => { vi.stubGlobal("CSS", { escape: (text: string) => text }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); mounts.clear(); holders.clear(); closedSeen.clear(); });

type View = { kind: "document"; artifactId: string } | { kind: "new" };
type L = Layout<View>;
const HOME: PaneContent<View> = { view: { kind: "new" }, workId: null, sessionId: null };
const doc = (id: string): PaneContent<View> => ({ view: { kind: "document", artifactId: id }, workId: "w", sessionId: null });
const settle = (changed: L, previous: L) => settleLayout(changed, previous, { home: HOME });
const open = (layout: L, content: PaneContent<View>): L => {
  const target = findTab(layout, contentKey(content))?.pane.id ?? layout.focus;
  return settle({ ...setPane(layout, target, content), focus: target }, layout);
};
const nameOf = (pane: Pick<Pane<View>, "view">) => pane.view.kind === "document" ? pane.view.artifactId : "홈";

/** Every mount of a stand-in editor gets a new number (a remount = a new frame = a lost turn). */
const mounts = new Map<string, number[]>();
let next = 0;
const holders = new Map<string, (hold: boolean) => void>();
const closedSeen = new Map<string, boolean>();
function Editor({ name }: { name: string }) {
  const [instance] = useState(() => ++next);
  const [hold, setHold] = useState(false);
  holders.set(name, setHold);
  useKeepOnClose(hold);
  closedSeen.set(name, useContext(TabClosed));
  useEffect(() => { mounts.set(name, [...(mounts.get(name) ?? []), instance]); return () => { mounts.set(name, (mounts.get(name) ?? []).filter((id) => id !== instance)); }; }, [name, instance]);
  return <div data-editor={name} />;
}
const screenOf = (layout: L) => <PaneLayout layout={layout} enabled onResize={() => {}} onFocus={() => {}} onClose={() => {}} onMove={() => {}} onSplit={() => {}} onDrop={() => {}}
  head={(pane) => ({ title: nameOf(pane), icon: null, item: null })} scope={() => ({ theme: "light", bubble: "none", frame: false, glow: "none", style: {} })} effectOf={() => "split" as const}
  render={(pane) => <Editor name={nameOf(pane)} />} />;
const hold = (name: string, value: boolean) => act(() => { holders.get(name)!(value); });

function setup() {
  let layout = open(open(settle(singleLayout<View>(HOME.view, null), singleLayout<View>(HOME.view, null)), doc("B")), doc("A"));
  const screen = render(screenOf(layout));
  const show = (change: (current: L) => L) => { layout = change(layout); screen.rerender(screenOf(layout)); return layout; };
  const tabOf = (name: string) => layout.panes.flatMap((pane) => tabsOf(pane).map((tab) => ({ pane, tab }))).find(({ tab }) => nameOf(tab) === name);
  const close = (name: string) => { const found = tabOf(name)!; show((current) => settle(closeTab(current, found.pane.id, found.tab.id, HOME), current)); };
  return { screen, show, tabOf, close, layout: () => layout };
}

it("a closed tab with a live turn keeps its editor mounted (same one, hidden) until the turn ends, then lets it go", () => {
  const t = setup();
  expect(mounts.get("A")).toHaveLength(1);
  const first = mounts.get("A")![0];
  hold("A", true);
  t.close("A");
  expect(t.tabOf("A")).toBeUndefined();
  expect(mounts.get("A")).toEqual([first]);
  expect(closedSeen.get("A")).toBe(true);
  const kept = t.screen.container.querySelector<HTMLElement>('[data-tab-kept="closed"]')!;
  expect(kept.hidden).toBe(true);
  // The turn ended (finished, failed, stopped, engine died, stopped for no sign of life: all end the same way).
  hold("A", false);
  expect(mounts.get("A")).toEqual([]);
  expect(t.screen.container.querySelector('[data-tab-kept="closed"]')).toBeNull();
});

it("without a live turn, closing a tab unmounts its editor at once (as before)", () => {
  const t = setup();
  t.close("A");
  expect(mounts.get("A")).toEqual([]);
});

it("opened again while its turn runs: the same tab and the same editor come back (no second editor)", () => {
  const t = setup();
  const first = mounts.get("A")![0];
  const id = t.tabOf("A")!.tab.id;
  hold("A", true);
  t.close("A");
  t.show((current) => open(current, doc("A")));
  expect(t.tabOf("A")!.tab.id).toBe(id);
  expect(mounts.get("A")).toEqual([first]);
  expect(closedSeen.get("A")).toBe(false);
  expect(t.screen.container.querySelector('[data-tab-kept="closed"]')).toBeNull();
  // Its turn ends later: the tab is open, so its editor stays.
  hold("A", false);
  expect(mounts.get("A")).toEqual([first]);
});

it("closing the whole pane keeps it too; the other pane's editors are untouched", () => {
  const t = setup();
  const first = mounts.get("A")![0];
  hold("A", true);
  const paneOfA = t.tabOf("A")!.pane.id;
  t.show((current) => settle(splitPane(current, paneOfA, "right", doc("C"), null), current));
  t.show((current) => settle(closePane(current, paneOfA), current));
  expect(t.tabOf("A")).toBeUndefined();
  expect(mounts.get("A")).toEqual([first]);
  hold("A", false);
  expect(mounts.get("A")).toEqual([]);
  expect(mounts.get("C")).toHaveLength(1);
});
