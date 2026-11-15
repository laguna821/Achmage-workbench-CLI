// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import type { SequencedEvent, Session } from "@workbench/contracts";
import { CompletionNotifications, ShownPanels, ShownPanelsContext, completionSurface, sessionsOnScreen, useShownPanel, visibleSessionIds } from "./completion-notifications.ts";
import { singleLayout, splitPane, type Layout } from "./panes.ts";

const session = { id: "child", provider: "codex", purpose: "문서 AI", muted: false, archivedAt: null } as Session;
const event = (status = "completed", id = "end-1") => ({ type: "item.upserted", sessionId: "child", item: { kind: "turnEnd", id, status }, seq: 7, at: 10 }) as SequencedEvent;
it("announces a completed hidden document turn without requiring a rendered running status", () => {
  const notifications = new CompletionNotifications();
  expect(notifications.take(event(), session, "연구", true)).toMatchObject({ body: "연구 — 문서 AI", session });
  expect(notifications.take(event(), session, "연구", true)).toBeNull();
  expect(notifications.take(event("completed", "end-2"), session, "연구", true)).not.toBeNull();
});
it("does not call a stopped/failed turn a completed reply, or bypass notification preferences", () => {
  const notifications = new CompletionNotifications();
  for (const status of ["interrupted", "failed"]) expect(notifications.take(event(status), session, "연구", true)).toBeNull();
  expect(notifications.take(event("completed", "muted"), { ...session, muted: true }, "연구", true)).toBeNull();
  expect(notifications.take(event("completed", "disabled"), session, "연구", false)).toBeNull();
});

type View = { kind: "work" | "document" | "browser" };
const work: View = { kind: "work" }, doc: View = { kind: "document" };
// Pane a shows `main` with `bg` in a tab behind it; pane b a document of the project whose chat is `docMain`.
const conversations: Layout<View> = { focus: "a", panes: [
  { id: "a", view: work, workId: "w2", sessionId: "main", activeTabId: "t-main", tabs: [{ id: "t-bg", view: work, workId: "w1", sessionId: "bg" }, { id: "t-main", view: work, workId: "w2", sessionId: "main" }] },
  { id: "b", view: doc, workId: "w1", sessionId: "docMain", activeTabId: "t-doc", tabs: [{ id: "t-doc", view: doc, workId: "w1", sessionId: "docMain" }] },
] };
const onScreen = (layout: Layout<View>, options: { narrow?: boolean; panels?: string[] } = {}) =>
  sessionsOnScreen(layout, { narrow: options.narrow ?? false, sessionOf: (pane) => pane.sessionId ?? undefined, panels: options.panels ?? [] });

it("announces only what the user cannot already see", () => {
  const shown = onScreen(conversations, { panels: ["webAgent", "docAgent"] });
  const surface = (id: string, windowShown = true) => completionSurface(id, visibleSessionIds(shown, windowShown));
  expect(surface("main")).toBe("inline"); // active tab of a pane
  expect(surface("bg")).toBe("toast"); // tab behind it
  expect(surface("webAgent")).toBe("inline"); // a web page's AI column beside it
  expect(surface("docAgent")).toBe("inline"); // a document's AI column beside it
  expect(surface("docMain")).toBe("toast"); // a document pane does not show its project chat
  expect(surface("sidebarOnly")).toBe("toast");
  expect(surface("main", false)).toBe("toast"); // window hidden or unfocused
});

it("does not count a conversation its companion lies over (a document filling the tab in a narrow pane)", () => {
  // The app tells which panes' conversations are covered by leaving their session out.
  const covered = sessionsOnScreen(conversations, { narrow: false, sessionOf: (pane) => (pane.id === "a" ? undefined : pane.sessionId ?? undefined), panels: [] });
  expect(completionSurface("main", visibleSessionIds(covered, true))).toBe("toast");
});

it("counts only the focused pane while the panes are collapsed into one", () => {
  const layout = splitPane(singleLayout<View>(work, "w1"), "a", "right", { view: work, workId: "w2", sessionId: "right" }, "left");
  expect([...onScreen(layout)].sort()).toEqual(["left", "right"]);
  expect([...onScreen({ ...layout, focus: "a" }, { narrow: true })]).toEqual(["left"]);
});

it("keeps the sessions panels report while they are mounted", () => {
  const panels = new ShownPanels();
  const Panel = ({ id }: { id: string | null }) => { useShownPanel(id); return null; };
  const view = render(<ShownPanelsContext.Provider value={panels}><Panel id="docAgent" /><Panel id={null} /></ShownPanelsContext.Provider>);
  expect(panels.ids()).toEqual(["docAgent"]);
  view.rerender(<ShownPanelsContext.Provider value={panels}><Panel id="webAgent" /><Panel id={null} /></ShownPanelsContext.Provider>);
  expect(panels.ids()).toEqual(["webAgent"]);
  view.unmount();
  expect(panels.ids()).toEqual([]);
});
