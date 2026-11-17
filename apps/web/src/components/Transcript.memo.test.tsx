// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TranscriptItem } from "@workbench/contracts";
import { Transcript } from "./Transcript.tsx";
import { DocContext, type DocActions } from "./DocCards.tsx";
import { initialState } from "../state.ts";

// A1 (perf G1): a token of the streaming answer, or any render of the view above (a key typed, an event of another
// conversation), redraws nothing of the finished turns. Counted through each answer's message actions.
const drawnFor = vi.hoisted(() => new Map<string, number>());
vi.mock("./pkm/MessageActions.tsx", () => ({ MessageActions: ({ itemId }: { itemId: string }) => { drawnFor.set(itemId, (drawnFor.get(itemId) ?? 0) + 1); return null; } }));
afterEach(() => { cleanup(); drawnFor.clear(); });

const finished = (count: number): TranscriptItem[] => Array.from({ length: count }, (_, index) => [
  { kind: "user", id: `u${index}`, text: `요청 ${index}`, at: index * 2 },
  { kind: "assistant", id: `a${index}`, text: `답 ${index}`, streaming: false, at: index * 2 + 1 },
] as TranscriptItem[]).flat();
const view = (items: TranscriptItem[], extra: { onAnswer?: () => void } = {}) => <DocContext.Provider value={{ state: initialState, actions: {} as DocActions }}><section className="pane"><Transcript sessionId="m" items={items} provider="claude" running loading={false} onAnswer={extra.onAnswer ?? (() => {})} /></section></DocContext.Provider>;

it("a streamed token redraws the streaming turn only", () => {
  const base = finished(5);
  const streaming = (text: string) => [...base, { kind: "user", id: "u5", text: "새 요청", at: 20 }, { kind: "assistant", id: "a5", text, streaming: true, at: 21 }] as TranscriptItem[];
  const screen = render(view(streaming("가")));
  const before = new Map(drawnFor);
  screen.rerender(view(streaming("가나")));
  screen.rerender(view(streaming("가나다")));
  for (let index = 0; index < 5; index += 1) expect(drawnFor.get(`a${index}`)).toBe(before.get(`a${index}`));
  expect(drawnFor.get("a5")).toBeGreaterThan(before.get("a5")!);
});

it("a render of the view above with the same items (new callbacks too) redraws no turn", () => {
  const items = finished(5);
  const screen = render(view(items));
  const before = new Map(drawnFor);
  screen.rerender(view(items, { onAnswer: () => {} }));
  screen.rerender(view([...items], { onAnswer: () => {} }));
  expect(drawnFor).toEqual(before);
});
