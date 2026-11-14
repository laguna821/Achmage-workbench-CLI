// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Attachment } from "@workbench/contracts";

const cache = vi.hoisted(() => ({ retain: vi.fn(() => ({ promise: new Promise<string>(() => {}), release: () => {} })) }));
vi.mock("../api.ts", async (original) => ({ ...(await original<typeof import("../api.ts")>()), retainAttachmentUrl: cache.retain }));
import { MessageImage } from "./Attachments.tsx";

// U38 finding 6: a thumbnail in view stayed "그림" when its IntersectionObserver never reported it.
// Visibility is also checked from the layout: once when it is mounted, when the transcript's layout
// changes or it scrolls, and once more shortly after — not only on the observer's callback.
const picture = { id: "p1", name: "칠판.png", mime: "image/png", size: 10 } as Attachment;
let observed: { root: Element | Document | null | undefined }[] = [];
beforeEach(() => {
  observed = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("IntersectionObserver", class { constructor(_callback: unknown, options?: IntersectionObserverInit) { observed.push({ root: options?.root }); } observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  cache.retain.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const laidOut = (top: number) => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const rect = this.classList.contains("transcript") ? { top: 0, bottom: 800, left: 0, right: 1000 } : { top, bottom: top + 120, left: 40, right: 200 };
    return { ...rect, x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top, toJSON() {} } as DOMRect;
  });
};

it("a thumbnail laid out in the transcript's view loads although the observer never reports it", async () => {
  laidOut(317);
  render(<div className="transcript"><MessageImage attachment={picture} gallery={[]} /></div>);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(cache.retain).toHaveBeenCalled();
  expect(screen.queryByText("그림")).toBeNull();
  // The observer watches the transcript's scroller, not the window.
  expect(observed.at(-1)?.root).toBe(document.querySelector(".transcript"));
});

it("a thumbnail far below the view waits for its turn", async () => {
  laidOut(5000);
  render(<div className="transcript"><MessageImage attachment={picture} gallery={[]} /></div>);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(cache.retain).not.toHaveBeenCalled();
  expect(screen.getByText("그림")).toBeTruthy();
});
