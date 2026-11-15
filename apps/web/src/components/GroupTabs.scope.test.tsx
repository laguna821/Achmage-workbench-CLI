// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GroupTabs, type TabScope } from "./GroupTabs.tsx";
import type { Pane } from "../panes.ts";
import type { PaneHead } from "./Panes.tsx";

// Project tabs (2026-11-15): the strip is the chosen project's tabs and nothing else. No project chosen
// (home): no tab at all. The ⌄ list still reaches everything that is open; its count is this project's
// overflow only, so other projects' tabs are no longer announced.

beforeEach(() => { vi.stubGlobal("CSS", { escape: (text: string) => text }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type View = { kind: "work" } | { kind: "new" };
const tab = (id: string, workId: string | null, kind: View["kind"] = "work") => ({ id, view: { kind } as View, workId, sessionId: kind === "work" ? id : null });
/** One pane: home, three conversations of 강의 (A), two of 연구 (B). */
const pane = (active: string): Pane<View> => {
  const tabs = [tab("home", "A", "new"), tab("a1", "A"), tab("a2", "A"), tab("a3", "A"), tab("b1", "B"), tab("b2", "B")];
  const shown = tabs.find((entry) => entry.id === active)!;
  return { id: "a", view: shown.view, workId: shown.workId, sessionId: shown.sessionId, activeTabId: active, tabs };
};
const head = (shown: Pane<View>): PaneHead => ({ title: shown.view.kind === "new" ? "홈" : shown.sessionId ?? "", icon: null, item: null, home: shown.view.kind === "new" });
const names = (id: string) => ({ A: "강의", B: "연구" })[id] ?? id;
const scope = (workId: string | null, all = false, onShowAll = () => {}): TabScope => ({ workId, all, projectName: names, onShowAll });
const strip = (active: string, at: TabScope, onSelect = () => {}) => <GroupTabs pane={pane(active)} head={head} onSelect={onSelect} onClose={() => {}} onReorder={() => {}} onNew={() => {}} scope={at} />;
const onStrip = () => screen.queryAllByRole("tab").map((entry) => entry.textContent);

it("no project chosen: the strip shows no tab; the quiet + stays and the other tabs are one list away", async () => {
  const onSelect = vi.fn();
  render(strip("home", scope(null), onSelect));
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(screen.getByRole("button", { name: "새로 만들기" })).toBeTruthy();
  // The bare chevron: no count of other projects' tabs.
  const more = screen.getByRole("button", { name: "열린 탭 목록" });
  expect(more.textContent).toBe("");
  fireEvent.click(more);
  const list = await screen.findByRole("menu", { name: "열린 탭" });
  expect(within(list).getByRole("menuitemcheckbox", { name: "모든 프로젝트의 탭 보기" })).toBeTruthy();
  fireEvent.click(within(list).getByRole("menuitem", { name: /강의 · a2/ }));
  expect(onSelect).toHaveBeenCalledWith("a2");
});

it("no project chosen and nothing else open: no tab and no list key, only the +", () => {
  const only: Pane<View> = { id: "a", view: { kind: "new" }, workId: null, sessionId: null, activeTabId: "home", tabs: [tab("home", null, "new")] };
  render(<GroupTabs pane={only} head={head} onSelect={() => {}} onClose={() => {}} onReorder={() => {}} onNew={() => {}} scope={scope(null)} />);
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: /열린 탭 목록/ })).toBeNull();
  expect(screen.getByRole("button", { name: "새로 만들기" })).toBeTruthy();
});

it("a project chosen: only its tabs — no home tab, no other project's tab; the key counts nothing of theirs", async () => {
  const view = render(strip("a2", scope("A")));
  expect(onStrip()).toEqual(["a1", "a2", "a3"]);
  const more = screen.getByRole("button", { name: "열린 탭 목록" });
  expect(more.textContent).toBe("");
  fireEvent.click(more);
  const list = await screen.findByRole("menu", { name: "열린 탭" });
  // Still reachable: home, and the other project's tabs under their heading.
  expect(within(list).getByRole("menuitemradio", { name: "홈" })).toBeTruthy();
  expect(within(list).getByText("다른 프로젝트 (열려 있고 계속 실행 중)")).toBeTruthy();
  expect(within(list).getByRole("menuitem", { name: /연구 · b1/ })).toBeTruthy();
  view.rerender(strip("b2", scope("B")));
  expect(onStrip()).toEqual(["b1", "b2"]);
});

it("the count is this project's overflow only", () => {
  // Room for one tab: the active one stays, the project's other two go to the list.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(160);
  render(strip("a2", scope("A")));
  const more = screen.getByRole("button", { name: "열린 탭 목록, 2개 더" });
  expect(more.textContent).toBe("2개 더");
});

it("모든 프로젝트의 탭 보기 on: every tab is on the strip, as before", () => {
  render(strip("a2", scope("A", true)));
  expect(onStrip()).toEqual(["홈", "a1", "a2", "a3", "연구b1", "연구b2"]);
  expect(screen.getByRole("button", { name: "열린 탭 목록" })).toBeTruthy();
});
