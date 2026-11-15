// @vitest-environment jsdom
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GroupTabs } from "./GroupTabs.tsx";
import { setPane, singleLayout } from "../panes.ts";
import { withTabs } from "../tabs.ts";
import { ROW_STATES, type RowStateId } from "../row-state.ts";

// A tab's mark is the conversation's one state (row-state.ts), after its title, with the word in its name.

afterEach(cleanup);

it("marks what asks, fails, runs or answered behind; 완료 and a new answer on screen say nothing", () => {
  vi.stubGlobal("CSS", { escape: (text: string) => text });
  let layout = withTabs(singleLayout("on-screen-new", "w"));
  for (const id of ["ask", "fail", "run", "behind-new", "done"]) layout = withTabs(setPane(layout, layout.panes[0]!.id, { view: id }), layout);
  layout = withTabs(setPane(layout, layout.panes[0]!.id, { view: "on-screen-new" }), layout);
  const of: Record<string, RowStateId> = { ask: "attention", fail: "failed", run: "running", "behind-new": "unseen", done: "done", "on-screen-new": "unseen" };
  const head = (entry: { view: string }) => ({ title: entry.view, icon: null, item: null, state: ROW_STATES[of[entry.view]!] });
  const view = render(<GroupTabs pane={layout.panes[0]!} head={head} onSelect={() => {}} onClose={() => {}} onReorder={() => {}} onNew={() => {}} />);
  const tab = (name: RegExp) => within(view.container).getByRole("tab", { name });
  expect(tab(/^ask, 확인 필요$/).querySelector('.state-mark[data-state="attention"]')).not.toBeNull();
  expect(tab(/^fail, 실패$/).querySelector('.state-mark[data-state="failed"]')).not.toBeNull();
  expect(tab(/^run, 진행 중$/).querySelector('.state-mark[data-state="running"]')).not.toBeNull();
  expect(tab(/^behind-new, 새 답$/).querySelector('.state-mark[data-state="unseen"]')).not.toBeNull();
  expect(tab(/^done$/).querySelector(".state-mark")).toBeNull();
  expect(tab(/^on-screen-new$/).querySelector(".state-mark")).toBeNull();
  vi.unstubAllGlobals();
});

// Skin 2 fix 1 (ruling 3): closing the 지금 tab must never leave an empty centre — its close key shows
// only while another tab is open in the pane.
it("the 지금 tab has no close key while it is the pane's only tab; with another tab it can close", () => {
  vi.stubGlobal("CSS", { escape: (text: string) => text });
  const head = (entry: { view: string }) => ({ title: entry.view === "home" ? "지금" : entry.view, icon: null, item: null, home: entry.view === "home" });
  const lone = withTabs(singleLayout("home", "w"));
  const view = render(<GroupTabs pane={lone.panes[0]!} head={head} onSelect={() => {}} onClose={() => {}} onReorder={() => {}} onNew={() => {}} />);
  expect(within(view.container).queryByRole("button", { name: "지금 탭 닫기" })).toBeNull();
  cleanup();
  const two = withTabs(setPane(lone, lone.panes[0]!.id, { view: "강의안" }), lone);
  const again = render(<GroupTabs pane={two.panes[0]!} head={head} onSelect={() => {}} onClose={() => {}} onReorder={() => {}} onNew={() => {}} />);
  expect(within(again.container).getByRole("button", { name: "지금 탭 닫기" })).toBeTruthy();
  vi.unstubAllGlobals();
});
