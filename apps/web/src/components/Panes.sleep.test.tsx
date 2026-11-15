// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PaneLayout } from "./Panes.tsx";
import { GroupTabs } from "./GroupTabs.tsx";
import { settleLayout } from "../companion-desk.ts";
import { setPane, singleLayout, type Layout, type Pane, type PaneContent, type PaneTab } from "../panes.ts";
import { activateTab, contentKey, drawnLayout, findTab, lastTabOf, scopeOf, stripScopes, tabsOf } from "../tabs.ts";
import { TAB_SLEEP_MS, useKeepAwake } from "../tab-sleep.ts";

// Tab sleep, applied (0.5.1): the views of tabs that have been off screen for ten minutes are unmounted, the tabs stay.
// Data safety first: a view with unsaved edits is asked to save through its tab's leave path and sleeps only once that
// answered saved; a save that fails, is refused or would need the person stays mounted with what was typed.

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("CSS", { escape: (text: string) => text }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); files.clear(); editors.clear(); savers.clear(); saves.length = 0; atWork.clear(); held.clear(); });

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

/** The saved text of each document (the file), and what each mounted editor holds. */
const files = new Map<string, string>();
const editors = new Map<string, { text: string }>();
/** A document's save-on-leave path, where it has one (the tab's leave guard); every call is recorded. */
const savers = new Map<string, () => Promise<void>>();
const saves: string[] = [];
const atWork = new Set<string>();
const held = new Set<string>();
const nameOf = (pane: Pick<Pane<View>, "view" | "sessionId">) => pane.view.kind === "document" ? pane.view.artifactId : pane.view.kind === "new" ? "홈" : pane.sessionId ?? "";

/** A stand-in editor: it opens the saved text; what is typed lives in the mounted view only. */
function Editor({ name }: { name: string }) {
  const [text, setText] = useState(() => files.get(name) ?? "");
  const now = useRef({ text }); now.current.text = text;
  useEffect(() => { editors.set(name, now.current); return () => { editors.delete(name); }; }, [name]);
  useKeepAwake(held.has(name));
  return <textarea aria-label={name} value={text} onChange={(event) => setText(event.target.value)} />;
}
const head = (pane: Pane<View>) => ({ title: nameOf(pane), icon: null, item: null, home: pane.view.kind === "new" });
const sleep = {
  unsaved: (tab: PaneTab<View>) => { const editor = editors.get(nameOf(tab)); return Boolean(editor && editor.text !== (files.get(nameOf(tab)) ?? "")); },
  atWork: (tab: PaneTab<View>) => atWork.has(nameOf(tab)),
  before: (tab: PaneTab<View>) => { const saver = savers.get(nameOf(tab)); return saver ? () => { saves.push(nameOf(tab)); return saver(); } : null; },
};
const screenOf = (layout: L) => {
  const scopes = stripScopes(layout, scopeOf(layout), false);
  return <PaneLayout layout={layout} drawn={drawnLayout(layout)} enabled sleep={sleep} onResize={() => {}} onFocus={() => {}} onClose={() => {}} onMove={() => {}} onSplit={() => {}} onDrop={() => {}}
    head={head} scope={() => ({ theme: "light", bubble: "none", frame: false, glow: "none", style: {} })} effectOf={() => "split" as const}
    render={(pane) => <Editor name={nameOf(pane)} />}
    tabBar={(pane) => <GroupTabs pane={pane} head={head} onSelect={() => {}} onClose={() => {}} onReorder={() => {}} onNew={() => {}} scope={{ workId: scopes[pane.id]!.workId, all: false, projectName: (id) => id, onShowAll: () => {} }} />} />;
};
const editorOf = (container: HTMLElement, name: string) => container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${name}"]`);
const pass = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const MIN = 60_000;
/** A saver as the app's leave guard is: it writes what the editor holds and resolves, or rejects and writes nothing. */
const savesTo = (name: string) => async () => { files.set(name, editors.get(name)!.text); };

/**
 * Project 1: a conversation (`talk`: it in front), then a document opened over it (`one`). Then project 2's
 * conversation is opened (`two`): project 1 is off screen. `shown`: the screen after showing those in turn.
 */
function twoProjects() {
  const talk = open(settle(singleLayout<View>({ kind: "new" }, null), singleLayout<View>({ kind: "new" }, null)), chat("대화 1", "P1"));
  const one = open(talk, doc("보고서", "P1"));
  const two = open(one, chat("대화 2", "P2"));
  const shown = (...layouts: L[]) => { const view = render(screenOf(layouts[0]!)); for (const layout of layouts.slice(1)) view.rerender(screenOf(layout)); return view; };
  return { talk, one, two, shown };
}

it("ten minutes off screen: the views of the other project's tabs are unmounted, the tabs stay — and coming back mounts them again", async () => {
  files.set("보고서", "저장된 글");
  const { talk, one, two, shown } = twoProjects();
  const view = shown(talk, one);
  expect(editorOf(view.container, "보고서")!.value).toBe("저장된 글");
  expect(editorOf(view.container, "대화 1")).not.toBeNull();
  view.rerender(screenOf(two));
  await pass(TAB_SLEEP_MS - MIN);
  // Not yet: hidden, mounted.
  expect(editorOf(view.container, "보고서")).not.toBeNull();
  await pass(2 * MIN);
  expect(editorOf(view.container, "보고서")).toBeNull();
  expect(editorOf(view.container, "대화 1")).toBeNull();
  expect(view.container.querySelectorAll("section.pane")).toHaveLength(1);
  // The layout is untouched: both tabs are still project 1's, in their pane.
  expect(two.panes.flatMap(tabsOf).map(nameOf)).toEqual(expect.arrayContaining(["대화 1", "보고서", "대화 2"]));
  // Back in project 1: its strip shows both tabs, the document in front is mounted again from what was saved.
  const back = choose(two, "P1");
  view.rerender(screenOf(back));
  expect(within(view.container.querySelector<HTMLElement>("section.pane:not([hidden])")!).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["대화 1", "보고서"]);
  expect(editorOf(view.container, "보고서")!.value).toBe("저장된 글");
  // The conversation behind it is mounted when it is shown, as a tab restored at start is.
  expect(editorOf(view.container, "대화 1")).toBeNull();
});

it("DATA SAFETY: typed and unsaved, with no way to save — the view is still mounted and the text is there, however long it is off screen", async () => {
  const { one, two } = twoProjects();
  const view = render(screenOf(one));
  fireEvent.change(editorOf(view.container, "보고서")!, { target: { value: "고치던 글" } });
  view.rerender(screenOf(two));
  await pass(6 * TAB_SLEEP_MS);
  expect(editorOf(view.container, "보고서")!.value).toBe("고치던 글");
  expect(saves).toEqual([]);
  // Nothing of it was written anywhere.
  expect(files.has("보고서")).toBe(false);
  view.rerender(screenOf(choose(two, "P1")));
  expect(editorOf(view.container, "보고서")!.value).toBe("고치던 글");
});

it("unsaved edits: the editor's save-on-leave path is called once, it saves, the view is unmounted — and waking shows the saved text", async () => {
  const { one, two } = twoProjects();
  savers.set("보고서", savesTo("보고서"));
  const view = render(screenOf(one));
  fireEvent.change(editorOf(view.container, "보고서")!, { target: { value: "고치던 글" } });
  view.rerender(screenOf(two));
  await pass(TAB_SLEEP_MS - MIN);
  // Nothing is saved before the tab is due.
  expect(saves).toEqual([]);
  expect(files.has("보고서")).toBe(false);
  await pass(2 * MIN);
  expect(saves).toEqual(["보고서"]);
  expect(files.get("보고서")).toBe("고치던 글");
  expect(editorOf(view.container, "보고서")).toBeNull();
  await pass(3 * TAB_SLEEP_MS);
  expect(saves).toEqual(["보고서"]);
  view.rerender(screenOf(choose(two, "P1")));
  expect(editorOf(view.container, "보고서")!.value).toBe("고치던 글");
});

it("a save that fails: the view stays mounted with the typed text, and is asked again only once per interval", async () => {
  const { one, two } = twoProjects();
  savers.set("보고서", async () => { throw new Error("문서를 저장하지 못해 이동하지 않았습니다."); });
  const view = render(screenOf(one));
  fireEvent.change(editorOf(view.container, "보고서")!, { target: { value: "고치던 글" } });
  view.rerender(screenOf(two));
  await pass(TAB_SLEEP_MS + MIN);
  expect(saves).toEqual(["보고서"]);
  expect(editorOf(view.container, "보고서")!.value).toBe("고치던 글");
  // No tight loop: nothing more until a whole interval has passed since it was asked.
  await pass(TAB_SLEEP_MS - 2 * MIN);
  expect(saves).toEqual(["보고서"]);
  await pass(3 * MIN);
  expect(saves).toEqual(["보고서", "보고서"]);
  expect(editorOf(view.container, "보고서")!.value).toBe("고치던 글");
  expect(files.has("보고서")).toBe(false);
  // Once the save works (the conflict was settled, the disk came back), the next time it is asked it sleeps.
  savers.set("보고서", savesTo("보고서"));
  await pass(TAB_SLEEP_MS);
  expect(files.get("보고서")).toBe("고치던 글");
  expect(editorOf(view.container, "보고서")).toBeNull();
});

it("a save that would need the person (a conflict, a read-only file): refused by the leave path — still mounted, and no dialog is opened over the other project", async () => {
  const { one, two } = twoProjects();
  savers.set("보고서", async () => { throw new Error("문서의 저장 충돌을 해결한 뒤 이동해 주세요. 편집 내용은 현재 탭에 있습니다."); });
  const view = render(screenOf(one));
  fireEvent.change(editorOf(view.container, "보고서")!, { target: { value: "고치던 글" } });
  view.rerender(screenOf(two));
  await pass(TAB_SLEEP_MS + MIN);
  expect(saves).toEqual(["보고서"]);
  expect(editorOf(view.container, "보고서")!.value).toBe("고치던 글");
  expect(document.querySelector('[role="dialog"], [role="alertdialog"], dialog')).toBeNull();
  // What is on screen is project 2's conversation alone, as it was.
  expect([...view.container.querySelectorAll<HTMLElement>("section.pane:not([hidden])")].map((pane) => pane.querySelector("textarea")!.getAttribute("aria-label"))).toEqual(["대화 2"]);
});

it("a save that is still on its way when the person comes back to the tab: the view stays", async () => {
  const { one, two } = twoProjects();
  let finish = () => {};
  savers.set("보고서", () => new Promise<void>((resolve) => { finish = () => { files.set("보고서", editors.get("보고서")!.text); resolve(); }; }));
  const view = render(screenOf(one));
  fireEvent.change(editorOf(view.container, "보고서")!, { target: { value: "고치던 글" } });
  view.rerender(screenOf(two));
  await pass(TAB_SLEEP_MS + MIN);
  expect(saves).toEqual(["보고서"]);
  view.rerender(screenOf(choose(two, "P1")));
  await act(async () => { finish(); });
  await pass(MIN);
  expect(editorOf(view.container, "보고서")!.value).toBe("고치던 글");
});

it("something at work in the tab, or a view that says it holds something of its own: awake, and not asked to save", async () => {
  const { talk, one, two, shown } = twoProjects();
  savers.set("보고서", savesTo("보고서"));
  atWork.add("보고서"); held.add("대화 1");
  const view = shown(talk, one);
  fireEvent.change(editorOf(view.container, "보고서")!, { target: { value: "고치던 글" } });
  view.rerender(screenOf(two));
  await pass(3 * TAB_SLEEP_MS);
  expect(editorOf(view.container, "보고서")!.value).toBe("고치던 글");
  expect(editorOf(view.container, "대화 1")).not.toBeNull();
  expect(saves).toEqual([]);
  // The work ends: the next time round the document saves and sleeps. The conversation still holds its own.
  atWork.clear();
  await pass(TAB_SLEEP_MS);
  expect(editorOf(view.container, "보고서")).toBeNull();
  expect(editorOf(view.container, "대화 1")).not.toBeNull();
});

it("the ten minutes count from when the tab left the screen, not from when it was opened", async () => {
  const { one, two } = twoProjects();
  const view = render(screenOf(one));
  // An hour on screen, nothing drawn again in between.
  await pass(60 * MIN);
  view.rerender(screenOf(two));
  await pass(TAB_SLEEP_MS - MIN);
  expect(editorOf(view.container, "보고서")).not.toBeNull();
  // Looked at again before it was due, then left: ten minutes anew.
  view.rerender(screenOf(choose(two, "P1")));
  await pass(MIN);
  view.rerender(screenOf(two));
  await pass(TAB_SLEEP_MS - MIN);
  expect(editorOf(view.container, "보고서")).not.toBeNull();
  await pass(2 * MIN);
  expect(editorOf(view.container, "보고서")).toBeNull();
});

it("in the project on screen the six most recently shown tabs stay mounted; its older ones sleep", async () => {
  let layout = settle(singleLayout<View>({ kind: "new" }, null), singleLayout<View>({ kind: "new" }, null));
  const view = render(screenOf(layout));
  for (let index = 1; index <= 8; index += 1) {
    layout = open(layout, doc(`문서 ${index}`, "P1"));
    view.rerender(screenOf(layout));
    await pass(MIN);
  }
  await pass(2 * TAB_SLEEP_MS);
  const mounted = [...view.container.querySelectorAll("textarea")].map((element) => element.getAttribute("aria-label")).sort();
  expect(mounted).toEqual(["문서 3", "문서 4", "문서 5", "문서 6", "문서 7", "문서 8"]);
});

it("without the app's say (no `sleep` given) nothing is ever unmounted", async () => {
  const { one, two } = twoProjects();
  const plain = (layout: L) => <PaneLayout layout={layout} drawn={drawnLayout(layout)} enabled onResize={() => {}} onFocus={() => {}} onClose={() => {}} onMove={() => {}} onSplit={() => {}} onDrop={() => {}}
    head={head} scope={() => ({ theme: "light", bubble: "none", frame: false, glow: "none", style: {} })} effectOf={() => "split" as const} render={(pane) => <Editor name={nameOf(pane)} />} />;
  const view = render(plain(one));
  view.rerender(plain(two));
  await pass(6 * TAB_SLEEP_MS);
  expect(editorOf(view.container, "보고서")).not.toBeNull();
});

// Part 3: a web page sleeps as a browser discards a background tab — its native page is released first.
it("a web page's tab: its page is released first (once), then its view is unmounted and the tab stays; refused while in use, it stays mounted", async () => {
  type Web = View | { kind: "browser"; pageId: string };
  const released: string[] = [];
  let refuse = true;
  const web: PaneContent<Web> = { view: { kind: "browser", pageId: "page-1" }, workId: "P1", sessionId: null };
  const home = { home: { view: { kind: "new" }, workId: null, sessionId: null } as PaneContent<Web> };
  const first = settleLayout(singleLayout<Web>({ kind: "new" }, null), singleLayout<Web>({ kind: "new" }, null), home);
  const one = settleLayout({ ...setPane(first, first.focus, web), focus: first.focus }, first, home);
  const two = settleLayout({ ...setPane(one, one.focus, { view: { kind: "work" }, workId: "P2", sessionId: "대화 2" }), focus: one.focus }, one, home);
  const screen = (layout: Layout<Web>) => <PaneLayout layout={layout} drawn={drawnLayout(layout)} enabled={false} onResize={() => {}} onFocus={() => {}} onClose={() => {}} onMove={() => {}} onSplit={() => {}} onDrop={() => {}}
    sleep={{ unsaved: () => false, atWork: (tab) => tab.view.kind === "new", before: (tab) => tab.view.kind === "browser" ? async () => { released.push(tab.view.kind === "browser" ? tab.view.pageId : ""); if (refuse) throw new Error("쓰고 있는 웹 페이지입니다."); } : null }}
    head={() => ({ title: "", icon: null, item: null })} scope={() => ({ theme: "light", bubble: "none", frame: false, glow: "none", style: {} })} effectOf={() => "split" as const}
    render={(pane) => <p data-view={pane.view.kind} />} />;
  const view = render(screen(one));
  view.rerender(screen(two));
  await pass(TAB_SLEEP_MS + MIN);
  // In use: asked once, refused, still mounted.
  expect(released).toEqual(["page-1"]);
  expect(view.container.querySelector('[data-view="browser"]')).not.toBeNull();
  refuse = false;
  await pass(TAB_SLEEP_MS);
  expect(released).toEqual(["page-1", "page-1"]);
  expect(view.container.querySelector('[data-view="browser"]')).toBeNull();
  expect(two.panes.flatMap(tabsOf).some((tab) => tab.view.kind === "browser")).toBe(true);
  await pass(3 * TAB_SLEEP_MS);
  expect(released).toHaveLength(2);
  // Shown again: its view is mounted again (the page's view restores the page itself).
  view.rerender(screen(activateTab(two, two.focus, tabsOf(two.panes[0]!).find((tab) => tab.view.kind === "browser")!.id)));
  expect(view.container.querySelector('[data-view="browser"]')).not.toBeNull();
});

// Round 2: the number of tabs asleep right now, for the app's memory readout.
it("tells the app how many tabs are asleep: up as views are taken down, down as one is shown again or its tab is closed; a tab never shown is not counted", async () => {
  const { talk, one, two } = twoProjects();
  const counts: number[] = [];
  const onSleeping = (count: number) => { counts.push(count); };
  const withCount = (layout: L) => <PaneLayout layout={layout} drawn={drawnLayout(layout)} enabled sleep={sleep} onSleeping={onSleeping} onResize={() => {}} onFocus={() => {}} onClose={() => {}} onMove={() => {}} onSplit={() => {}} onDrop={() => {}}
    head={head} scope={() => ({ theme: "light", bubble: "none", frame: false, glow: "none", style: {} })} effectOf={() => "split" as const} render={(pane) => <Editor name={nameOf(pane)} />} />;
  const view = render(withCount(talk));
  view.rerender(withCount(one));
  view.rerender(withCount(two));
  expect(counts.at(-1)).toBe(0);
  await pass(TAB_SLEEP_MS + MIN);
  // 대화 1 and 보고서 were shown and are asleep now (the home tab was never shown: not counted).
  expect(counts.at(-1)).toBe(2);
  const back = choose(two, "P1");
  view.rerender(withCount(back));
  expect(counts.at(-1)).toBe(1);
  // The sleeping conversation's tab is closed: nothing of it is asleep any more.
  const pane = back.panes[0]!, sleeper = tabsOf(pane).find((tab) => nameOf(tab) === "대화 1")!;
  view.rerender(withCount(settle({ ...back, panes: [{ ...pane, tabs: tabsOf(pane).filter((tab) => tab.id !== sleeper.id), recentTabIds: (pane.recentTabIds ?? []).filter((id) => id !== sleeper.id) }] }, back)));
  expect(counts.at(-1)).toBe(0);
});
