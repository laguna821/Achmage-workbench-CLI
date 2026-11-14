// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TranscriptItem } from "@workbench/contracts";
import { captureReadingAnchor, reconcileReadingAnchor } from "./reading-anchor.ts";
import { Transcript } from "../components/Transcript.tsx";
import { DocContext, type DocActions } from "../components/DocCards.tsx";
import { initialState } from "../state.ts";
import { restoreLayout, singleLayout } from "../panes.ts";

let geometry: Record<string, [number, number]>;
let height: number;
let resized: () => void;
beforeEach(() => {
  geometry = {}; height = 1200; resized = () => {};
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) { return this.classList.contains("transcript") ? 200 : 0; });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) { return this.classList.contains("transcript") ? height : 0; });
  const scrollPositions = new WeakMap<Element, number>();
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) { return scrollPositions.get(this) ?? 0; });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (this: Element, top: number) {
    scrollPositions.set(this, Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight)));
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const row = geometry[this.dataset.readingId ?? ""];
    const top = document.querySelector<HTMLElement>(".transcript")?.scrollTop ?? 0;
    return row ? new DOMRect(0, row[0] - top, 600, row[1]) : new DOMRect(0, 0, 600, 200);
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = function (options) { if (typeof options === "object") this.scrollTop = options.top ?? 0; };
  vi.stubGlobal("CSS", { escape: (text: string) => text });
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const user = (id: string): TranscriptItem => ({ kind: "user", id, text: `요청 ${id}`, at: 1 });
const reply = (id: string, text = `답변 ${id}`): TranscriptItem => ({ kind: "assistant", id, text, at: 2, streaming: false });
const view = (items: TranscriptItem[], extra: Partial<ComponentProps<typeof Transcript>> = {}) => <DocContext.Provider value={{ state: initialState, actions: {} as DocActions }}>
  <Transcript sessionId="reading-anchor" provider="codex" items={items} running={false} loading={false} onAnswer={() => {}} {...extra} />
</DocContext.Provider>;

it("preserves the real transcript message and offset through prepend, resize and disclosure", () => {
  geometry = { u1: [0, 80], a1: [80, 200], u2: [310, 80], a2: [400, 500] };
  const items = [user("u1"), reply("a1"), user("u2"), reply("a2")];
  const ui = render(view(items, { position: { top: 322, follow: false } }));
  const scroll = ui.container.querySelector<HTMLElement>(".transcript")!;
  expect(captureReadingAnchor(scroll)).toEqual({ messageId: "u2", offsetPx: 12 });
  geometry = { old: [0, 100], oldAnswer: [100, 100], u1: [200, 80], a1: [280, 200], u2: [510, 80], a2: [600, 500] };
  ui.rerender(view([user("old"), reply("oldAnswer"), ...items]));
  expect(scroll.scrollTop).toBe(522);
  geometry.u2 = [590, 80]; geometry.a2 = [680, 500]; height += 80;
  act(() => resized());
  expect(scroll.scrollTop).toBe(602);
  expect(captureReadingAnchor(scroll)).toEqual({ messageId: "u2", offsetPx: 12 });
  // A nested disclosure resizes the same observed content, without an items update.
  geometry.u2 = [710, 80]; geometry.a2 = [800, 500]; height += 120;
  act(() => resized()); expect(scroll.scrollTop).toBe(722);
  expect(reconcileReadingAnchor({ messageId: "missing", offsetPx: 12 }, [])).toBeNull();
});

it("follows output only near the bottom and keeps a reader above the stream", () => {
  geometry = { q: [0, 80], answer: [80, 1120] };
  const ui = render(view([user("q"), reply("answer")], { sessionId: "following" }));
  const scroll = ui.container.querySelector<HTMLElement>(".transcript")!;
  scroll.scrollTop = 300; fireEvent.wheel(scroll, { deltaY: -100 }); fireEvent.scroll(scroll);
  height = 1600; geometry.answer = [80, 1520]; act(() => resized());
  expect(scroll.scrollTop).toBe(300);
  scroll.scrollTop = 1385; fireEvent.scroll(scroll);
  height = 1700; geometry.answer = [80, 1620]; act(() => resized());
  expect(scroll.scrollTop).toBe(1500);
});

it("does not undo a move the browser has not reported yet when the conversation re-renders", () => {
  geometry = { q: [0, 80], answer: [80, 1120] };
  const items = [user("q"), reply("answer")];
  const ui = render(view(items, { sessionId: "unreported" }));
  const scroll = ui.container.querySelector<HTMLElement>(".transcript")!;
  scroll.scrollTop = 300; fireEvent.wheel(scroll, { deltaY: -100 }); fireEvent.scroll(scroll);
  // Back to the top (a key, the scroll bar, a script); the scroll event comes a frame later.
  scroll.scrollTop = 0;
  ui.rerender(view(items, { sessionId: "unreported", running: true }));
  expect(scroll.scrollTop).toBe(0);
  fireEvent.scroll(scroll);
  height = 1300; geometry.answer = [80, 1220]; act(() => resized());
  expect(scroll.scrollTop).toBe(0);
});

it("keeps the final answer, failed tools, plan and approval visible while details are folded, and mounts a searched tool", () => {
  const items: TranscriptItem[] = [user("q"),
    { kind: "tool", id: "tool", tool: "command", title: "원고 변환", detail: null, output: "실패 원문 로그", status: "failed", at: 2 },
    { kind: "plan", id: "plan", steps: [{ text: "남은 결과 확인", status: "pending" }], at: 3 },
    { kind: "approval", id: "approval", title: "저장 확인", detail: null, reason: null, decision: null, at: 4 },
    reply("final", "최종 답변을 읽습니다."),
    { kind: "turnEnd", id: "end", status: "failed", durationMs: 100, at: 5 },
  ];
  const ui = render(view(items, { sessionId: "details" }));
  expect(screen.getByText("최종 답변을 읽습니다.")).toBeTruthy();
  expect(screen.getByText("실패 · 원고 변환")).toBeTruthy();
  expect(screen.getByText("남은 결과 확인")).toBeTruthy();
  expect(screen.getByRole("button", { name: /허용/ })).toBeTruthy();
  expect(screen.queryByText("실패 원문 로그")).toBeNull();
  ui.rerender(view(items, { sessionId: "details", focusItem: { itemId: "tool", nonce: 1 } }));
  expect(screen.getByText("실패 원문 로그")).toBeTruthy();
  expect(ui.container.querySelector('[data-item-id="tool"]')?.classList.contains("flash")).toBe(true);
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
});

it("restores stable tab IDs and both old scroll positions and new message anchors", () => {
  const fallback = singleLayout("chat", "project");
  const raw = { version: 2, focus: "pane", panes: [{ id: "pane", view: "chat", workId: "project", sessionId: "session", activeTabId: "tab", tabs: [
    { id: "tab", view: "chat", workId: "project", sessionId: "session", ui: { chatScroll: { top: 322, follow: false, anchor: { messageId: "u2", offsetPx: 12 } } } },
  ] }] };
  const isView = (value: unknown): value is string => typeof value === "string";
  const restored = restoreLayout(raw, isView, fallback);
  expect(restored.panes[0]?.tabs?.[0]).toMatchObject({ id: "tab", ui: { chatScroll: { top: 322, follow: false, anchor: { messageId: "u2", offsetPx: 12 } } } });
  const old = { ...raw, panes: [{ ...raw.panes[0]!, tabs: [{ ...raw.panes[0]!.tabs[0]!, ui: { chatScroll: { top: 100, follow: false } } }] }] };
  expect(restoreLayout(old, isView, fallback).panes[0]?.tabs?.[0]?.ui?.chatScroll).toEqual({ top: 100, follow: false });
});
