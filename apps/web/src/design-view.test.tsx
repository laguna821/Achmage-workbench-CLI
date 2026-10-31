// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Artifact } from "@workbench/contracts";
import { DesignView, type DesignHandle } from "./components/docs/DesignView";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
function setup() {
  const ref = createRef<DesignHandle>();
  const result = render(<DesignView ref={ref} artifact={{ id: "design", name: "design", revision: 1 } as Artifact} onStatus={() => {}} onSelection={() => {}} onCopied={() => {}} onExported={() => {}} onError={() => {}} />);
  const source = result.container.querySelector("iframe")!.contentWindow!;
  const post = vi.spyOn(source, "postMessage").mockImplementation(() => {});
  const send = (data: unknown) => act(() => window.dispatchEvent(new MessageEvent("message", { source, origin: location.origin, data })));
  send({ type: "design:opened", revision: 1, pages: 1 });
  const request = () => {
    const promise = ref.current!.flush();
    return { promise, requestId: post.mock.calls.at(-1)![0].requestId };
  };
  return { ...result, send, request };
}
it("even a saved label waits for the exact editor acknowledgement and ignores unrelated messages", async () => {
  const { send, request } = setup();
  const first = request(); let done = false;
  void first.promise.then(() => { done = true; });
  send({ type: "design:state", state: "saved" });
  send({ type: "design:flushed", requestId: "old", revision: 1 });
  await act(async () => {});
  expect(done).toBe(false);
  send({ type: "design:flushed", requestId: first.requestId, revision: 2 });
  await expect(first.promise).resolves.toBe(2);
});
it("failed flush, unmount and timeout never fall back to the old saved revision", async () => {
  vi.useFakeTimers();
  const { send, request, unmount } = setup();
  const failed = request();
  send({ type: "design:flushed", requestId: failed.requestId, revision: null });
  await expect(failed.promise).resolves.toBeNull();
  const timeout = request();
  act(() => vi.advanceTimersByTime(30_000));
  await expect(timeout.promise).resolves.toBeNull();
  const leaving = request();
  unmount();
  await expect(leaving.promise).resolves.toBeNull();
});
