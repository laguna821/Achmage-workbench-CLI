// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Artifact, EditorGrant } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { OfficeEditor, type OfficeHandle } from "./OfficeEditor.tsx";

// jsdom has no IntersectionObserver: a stand-in the test drives (an editor's pane shown or hidden).
const observers: { callback: IntersectionObserverCallback; target: Element | null }[] = [];
class FakeObserver {
  private readonly entry: { callback: IntersectionObserverCallback; target: Element | null };
  constructor(callback: IntersectionObserverCallback) { this.entry = { callback, target: null }; observers.push(this.entry); }
  observe(target: Element) { this.entry.target = target; }
  disconnect() { this.entry.target = null; }
  unobserve() { this.entry.target = null; }
  takeRecords() { return []; }
}
const intersect = (target: Element, isIntersecting: boolean) => {
  for (const observer of observers) if (observer.target === target) observer.callback([{ target, isIntersecting } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); observers.length = 0; });

it("tells the editor page whether its frame is on screen, so a hidden one rests (A10)", async () => {
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  const api = { editorGrant: vi.fn(async () => ({ token: "t", sessionId: "s", origin: "http://office.test", url: "http://office.test/docs" }) as EditorGrant) } as unknown as Api;
  const artifact = { id: "doc", name: "test.xlsx", format: "xlsx", revision: 1, path: "/test.xlsx", sha256: "x" } as Artifact;
  const props = { api, artifact, sessionId: "s", onStatus: vi.fn(), onNotice: vi.fn(), onPrepareAi: async () => {}, onNewSession: async () => "s", onAiSettings: vi.fn() };
  const ref = createRef<OfficeHandle>();
  const view = (hidden = false) => <section data-theme="light"><OfficeEditor {...props} ref={ref} hidden={hidden} /></section>;
  const screen = render(view());
  await act(async () => {});
  const frame = screen.container.querySelector("iframe")!;
  const sent = vi.spyOn(frame.contentWindow!, "postMessage");
  const shownMessages = () => sent.mock.calls.map(([value]) => value as { type: string; shown?: boolean }).filter((value) => value.type === "office:shown").map((value) => value.shown);
  const message = async (data: unknown) => act(async () => {
    window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame.contentWindow, data }));
  });
  await message({ type: "office:ready" });
  // Shown at start: the page starts shown, nothing to say.
  expect(shownMessages()).toEqual([]);
  // Its pane hidden (another tab in front, another project on screen): it rests.
  await act(async () => intersect(frame, false));
  expect(shownMessages()).toEqual([false]);
  // Hidden again by the view (no change: not said twice), then shown.
  screen.rerender(view(true));
  expect(shownMessages()).toEqual([false]);
  await act(async () => intersect(frame, true));
  expect(shownMessages()).toEqual([false]);
  screen.rerender(view(false));
  expect(shownMessages()).toEqual([false, true]);
  // An editor that opens behind another tab is told at once after its init.
  await act(async () => intersect(frame, false));
  await message({ type: "office:ready" });
  expect(shownMessages()).toEqual([false, true, false, false]);
});
