// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStreamingText } from "./streaming-text.ts";

describe("useStreamingText (A3: a streaming answer's Markdown is parsed at most every ~100 ms)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it("while streaming, shows a new text at most every 100 ms, the latest one at the end of the wait", () => {
    const { result, rerender } = renderHook(({ text, live }) => useStreamingText(text, live, 100), { initialProps: { text: "가", live: true } });
    expect(result.current).toBe("가");
    rerender({ text: "가나", live: true });
    // The first change after a quiet moment is shown at once.
    expect(result.current).toBe("가나");
    act(() => { vi.advanceTimersByTime(30); });
    rerender({ text: "가나다", live: true });
    rerender({ text: "가나다라", live: true });
    expect(result.current).toBe("가나");
    act(() => { vi.advanceTimersByTime(69); });
    expect(result.current).toBe("가나");
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe("가나다라");
  });

  it("the end of the stream shows the whole text at once (the same text the finished answer draws)", () => {
    const { result, rerender } = renderHook(({ text, live }) => useStreamingText(text, live, 100), { initialProps: { text: "가", live: true } });
    rerender({ text: "가나", live: true });
    act(() => { vi.advanceTimersByTime(10); });
    rerender({ text: "가나다", live: true });
    expect(result.current).toBe("가나");
    rerender({ text: "가나다 끝", live: false });
    expect(result.current).toBe("가나다 끝");
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current).toBe("가나다 끝");
  });

  it("a finished answer is its text, every time", () => {
    const { result, rerender } = renderHook(({ text, live }) => useStreamingText(text, live, 100), { initialProps: { text: "끝난 답", live: false } });
    expect(result.current).toBe("끝난 답");
    rerender({ text: "고친 답", live: false });
    expect(result.current).toBe("고친 답");
  });
});
