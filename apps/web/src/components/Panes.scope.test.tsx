// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PaneLayout } from "./Panes.tsx";
import { GroupTabs } from "./GroupTabs.tsx";
import { settleLayout } from "../companion-desk.ts";
import { setPane, singleLayout, splitPane, type Layout, type Pane, type PaneContent } from "../panes.ts";
import { activateTab, contentKey, drawnLayout, findTab, lastTabOf, scopeOf, stripScopes } from "../tabs.ts";

// Project tabs (2026-11-15): a pane that holds no tab of the window's project is not drawn — its
// neighbours take the room — but it stays mounted exactly as a tab behind another is: an editor in it
// keeps what was typed, a web page in it is told it is not on screen.

beforeEach(() => { vi.stubGlobal("CSS", { escape: (text: string) => text }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type View = { kind: "work" } | { kind: "document"; artifactId: string } | { kind: "new" };
type L = Layout<View>;
const HOME: PaneContent<View> = { view: { kind: "new" }, workId: null, sessionId: null };
const chat = (id: string, workId: string): PaneContent<View> => ({ view: { kind: "work" }, workId, sessionId: id });
const doc = (id: string, workId: string): PaneContent<View> => ({ view: { kind: "document", artifactId: id }, workId, sessionId: null });
const settle = (changed: L, previous: L) => settleLayout(changed, previous, { home: HOME });
const open = (layout: L, content: PaneContent<View>): L => {
  const target = findTab(layout, contentKey(content))?.pane.id ?? layout.focus;
  return settle({ ...setPane(layout, target, content), focus: target }, layout);
};
const choose = (layout: L, workId: string): L => {
  const found = lastTabOf(layout, workId)!;
  return settle(activateTab(layout, found.pane.id, found.tab.id), layout);
};

/** What the app's editors registry holds (doc-editors.ts): the documents whose mounted editor reports unsaved edits. */
const unsaved = new Set<string>();
const seen: { name: string; active: boolean }[] = [];
/** A stand-in editor: its text lives in the mounted view only, and it reports unsaved edits while mounted. */
function Editor({ name, active }: { name: string; active: boolean }) {
  const [text, setText] = useState("");
  useEffect(() => { if (text) unsaved.add(name); return () => { unsaved.delete(name); }; }, [name, text]);
  seen.push({ name, active });
  return <textarea aria-label={name} value={text} onChange={(event) => setText(event.target.value)} />;
}
const nameOf = (pane: Pick<Pane<View>, "view" | "sessionId">) => pane.view.kind === "document" ? pane.view.artifactId : pane.view.kind === "new" ? "홈" : pane.sessionId ?? "";
const head = (pane: Pane<View>) => ({ title: `${nameOf(pane)}${unsaved.has(nameOf(pane)) ? " · 저장 안 됨" : ""}`, icon: null, item: null, home: pane.view.kind === "new" });
const screenOf = (layout: L) => {
  const scopes = stripScopes(layout, scopeOf(layout), false);
  return <PaneLayout layout={layout} drawn={drawnLayout(layout)} enabled onResize={() => {}} onFocus={() => {}} onClose={() => {}} onMove={() => {}} onSplit={() => {}} onDrop={() => {}}
    head={head} scope={() => ({ theme: "light", bubble: "none", frame: false, glow: "none", style: {} })} effectOf={() => "split" as const}
    render={(pane, info) => <Editor name={nameOf(pane)} active={info.active} />}
    tabBar={(pane) => <GroupTabs pane={pane} head={head} onSelect={() => {}} onClose={() => {}} onReorder={() => {}} onNew={() => {}} scope={{ workId: scopes[pane.id]!.workId, all: false, projectName: (id) => id, onShowAll: () => {} }} />} />;
};
const editorOf = (container: HTMLElement, name: string) => container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${name}"]`);
const visible = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("section.pane:not([hidden])")];

/** Project 1: a conversation on the left, a document on the right. Project 2: one conversation, in the left pane. */
function twoProjects() {
  let layout = settle(singleLayout<View>({ kind: "new" }, null), singleLayout<View>({ kind: "new" }, null));
  layout = open(layout, chat("대화 1", "P1"));
  const left = layout.focus;
  layout = settle(splitPane(layout, left, "right", doc("보고서", "P1"), null), layout);
  const right = layout.focus;
  return { one: layout, left, right };
}

it("a pane with no tab of the window's project is not drawn: no split, no divider, the neighbour alone", () => {
  const { one, left, right } = twoProjects();
  const view = render(screenOf(one));
  expect(visible(view.container).map((pane) => pane.dataset.pane).sort()).toEqual([left, right].sort());
  expect(view.container.querySelectorAll(".pane-divider")).toHaveLength(1);
  const two = open({ ...one, focus: left }, chat("대화 2", "P2"));
  view.rerender(screenOf(two));
  expect(visible(view.container).map((pane) => pane.dataset.pane)).toEqual([left]);
  expect(view.container.querySelectorAll(".pane-divider")).toHaveLength(0);
  expect(view.container.querySelector(".panes")!.classList.contains("two")).toBe(false);
  // One pane on screen: no pane head, and its strip is project 2's one tab.
  expect(visible(view.container)[0]!.querySelector(".pane-head")).toBeNull();
  expect(within(visible(view.container)[0]!).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["대화 2"]);
  // The pane out of sight is told it is not on screen (a web page there is not shown over the window).
  expect(seen.filter((entry) => entry.name === "보고서").at(-1)!.active).toBe(false);
  const hiddenPane = view.container.querySelector<HTMLElement>(`section.pane[data-pane="${right}"]`)!;
  expect(hiddenPane.hidden).toBe(true);
  expect(hiddenPane.dataset.tabActive).toBe("false");
});

it("no project chosen: only home is drawn, with no tab on its strip", () => {
  const { one, left } = twoProjects();
  const view = render(screenOf(one));
  const atHome = open(one, HOME);
  view.rerender(screenOf(atHome));
  expect(visible(view.container).map((pane) => pane.dataset.pane)).toEqual([left]);
  expect(within(visible(view.container)[0]!).queryAllByRole("tab")).toHaveLength(0);
});

it("unsaved edits in project 1 are there after project 2 and back, and its tab still says unsaved", () => {
  unsaved.clear();
  const { one, left, right } = twoProjects();
  const view = render(screenOf(one));
  const editor = editorOf(view.container, "보고서")!;
  fireEvent.change(editor, { target: { value: "저장하지 않은 문장" } });
  view.rerender(screenOf(one));
  expect(within(visible(view.container).find((pane) => pane.dataset.pane === right)!).getByRole("tab", { name: /보고서 · 저장 안 됨/ })).toBeTruthy();
  // Project 2 has one conversation, in the left pane: the document's pane is not drawn.
  const two = open({ ...one, focus: left }, chat("대화 2", "P2"));
  view.rerender(screenOf(two));
  expect(visible(view.container).map((pane) => pane.dataset.pane)).toEqual([left]);
  expect(editorOf(view.container, "보고서")).toBe(editor);
  expect(unsaved.has("보고서")).toBe(true);
  // Home, then back to project 1: the same editor, the same text, the tab still unsaved, the split back.
  const atHome = open(two, HOME);
  view.rerender(screenOf(atHome));
  const back = choose(atHome, "P1");
  view.rerender(screenOf(back));
  expect(visible(view.container).map((pane) => pane.dataset.pane).sort()).toEqual([left, right].sort());
  expect(editorOf(view.container, "보고서")).toBe(editor);
  expect(editor.value).toBe("저장하지 않은 문장");
  expect(editor.closest("section")!.hidden).toBe(false);
  expect(within(editor.closest("section")!).getByRole("tab", { name: /보고서 · 저장 안 됨/ })).toBeTruthy();
});

it("a pane never shown is not mounted until its project is chosen (as a tab never looked at)", () => {
  const { one, left } = twoProjects();
  // A stored layout read while home is on screen: project 1's document pane has not been drawn yet.
  const atHome = open({ ...one, focus: left }, HOME);
  const view = render(screenOf(atHome));
  expect(editorOf(view.container, "보고서")).toBeNull();
  view.rerender(screenOf(choose(atHome, "P1")));
  expect(editorOf(view.container, "보고서")).not.toBeNull();
});
