// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TranscriptItem } from "@workbench/contracts";
import { Transcript } from "./Transcript.tsx";
import { DocContext, type DocActions } from "./DocCards.tsx";
import { initialState } from "../state.ts";
import { jumpInNote } from "../conversation/outline.ts";

// A2 (perf G1): a long conversation draws its last 40 turns; "이전 대화 보기" adds 40 more above; a search hit, a
// link to a message, the outline and a saved reading place reach any turn (it is drawn first).
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const turns = (count: number): TranscriptItem[] => Array.from({ length: count }, (_, index) => [
  { kind: "user", id: `u${index}`, text: `요청 ${index}`, at: index * 2 },
  { kind: "assistant", id: `a${index}`, text: `답 ${index}`, streaming: false, at: index * 2 + 1 },
] as TranscriptItem[]).flat();
const view = (props: Partial<Parameters<typeof Transcript>[0]> = {}) => <DocContext.Provider value={{ state: initialState, actions: {} as DocActions }}><section className="pane"><Transcript sessionId="long" items={turns(100)} provider="codex" running={false} loading={false} onAnswer={() => {}} {...props} /></section></DocContext.Provider>;
const drawn = (container: HTMLElement) => [...container.querySelectorAll("section.turn [data-item-id^='a']")].map((element) => element.getAttribute("data-item-id"));

it("draws the last 40 turns, and 40 more above at each 이전 대화 보기 until the first", () => {
  const screen = render(view());
  expect(drawn(screen.container)).toHaveLength(40);
  expect(drawn(screen.container)[0]).toBe("a60");
  const more = () => screen.getByRole("button", { name: /이전 대화 보기/ });
  fireEvent.click(more());
  expect(drawn(screen.container)[0]).toBe("a20");
  fireEvent.click(more());
  expect(drawn(screen.container)).toHaveLength(100);
  expect(screen.queryByRole("button", { name: /이전 대화 보기/ })).toBeNull();
});

it("a short conversation is drawn whole, with no 이전 대화 보기", () => {
  const screen = render(view({ items: turns(12) }));
  expect(drawn(screen.container)).toHaveLength(12);
  expect(screen.queryByRole("button", { name: /이전 대화 보기/ })).toBeNull();
});

it("a search hit (원문 위치 이동, a link to a message) in an undrawn turn draws it, then brings it into view", () => {
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  const done = vi.fn();
  const screen = render(view({ focusItem: { itemId: "a3", nonce: 1 }, onFocusDone: done }));
  expect(screen.container.querySelector("[data-item-id='a3']")).toBeTruthy();
  expect(scrolled).toHaveBeenCalled();
  expect(done).toHaveBeenCalled();
});

it("a hit that arrives later for an undrawn turn draws it too", () => {
  Element.prototype.scrollIntoView = vi.fn();
  const screen = render(view());
  expect(screen.container.querySelector("[data-item-id='a5']")).toBeNull();
  screen.rerender(view({ focusItem: { itemId: "a5", nonce: 1 }, onFocusDone: () => {} }));
  expect(screen.container.querySelector("[data-item-id='a5']")).toBeTruthy();
});

it("the outline's jump to an undrawn request draws it and goes there", () => {
  const screen = render(view());
  const scroller = screen.container.querySelector<HTMLElement>(".transcript")!;
  const to = vi.fn();
  scroller.scrollTo = to as never;
  act(() => { jumpInNote("chat:long", "u2"); });
  expect(screen.container.querySelector("[data-item-id='a2']")).toBeTruthy();
  expect(to).toHaveBeenCalled();
});

it("a saved reading place anchored on an early message draws from there", () => {
  const screen = render(view({ sessionId: "kept", position: { top: 400, follow: false, anchor: { messageId: "a10", offsetPx: 0 } } }));
  expect(drawn(screen.container)[0]).toBe("a9");
});

it("a saved place without a message to anchor it draws everything (as before)", () => {
  const screen = render(view({ sessionId: "kept-top", position: { top: 400, follow: false } }));
  expect(drawn(screen.container)).toHaveLength(100);
});
