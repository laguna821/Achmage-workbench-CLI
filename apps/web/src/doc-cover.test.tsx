// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { COVER_MARK_MS, coverFit, coverKind, useCover } from "./doc-cover.ts";
import { DocCover } from "./components/docs/DocCover.tsx";

// The document as its tab's placeholder (doc-pages-first, point 1).

const asked: string[] = [];
beforeEach(() => {
  asked.length = 0;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} disconnect() {} };
  URL.createObjectURL = vi.fn((blob: Blob) => `blob:${(blob as Blob & { tag?: string }).tag ?? "x"}`);
  URL.revokeObjectURL = vi.fn();
  // The gateway: r3 of "doc" has its picture, r4 not yet.
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    asked.push(path);
    const revision = Number(/revision=(\d+)/.exec(path)?.[1]);
    if (path.includes("/cover-image")) { const blob = new Blob(["png"]) as Blob & { tag?: string }; blob.tag = `r${revision}`; return { ok: true, blob: async () => blob }; }
    return { ok: true, json: async () => ({ revision, cover: revision === 3 ? { page: 1, width: 1190, height: 1684 } : null }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("shows a picture only for Word, PowerPoint and Hangul (Excel's printed page is not its grid; PDF opens fast)", () => {
  expect(["docx", "pptx", "hwpx", "hwp", "xlsx", "pdf", "markdown"].map((format) => coverKind(format as never))).toEqual(["docx", "pptx", "hwpx", "hwpx", null, null, null]);
});

it("the placeholder is keyed by the revision: a revision without its own picture shows none, never an older one's", async () => {
  const { result, rerender } = renderHook(({ revision }) => useCover("doc", revision, "docx", true), { initialProps: { revision: 3 } });
  await waitFor(() => expect(result.current?.url).toBe("blob:r3"));
  // Saved: r4 is opened. r3's picture is not shown for it, not even for a moment.
  rerender({ revision: 4 });
  expect(result.current).toBeNull();
  await act(async () => { await Promise.resolve(); });
  expect(result.current).toBeNull();
  expect(asked.filter((path) => path.includes("revision=4"))).toEqual(["/api/artifacts/doc/cover?revision=4"]);
});

it("is not asked for when not wanted (an editor already shown, another kind)", async () => {
  renderHook(() => useCover("doc2", 3, "docx", false));
  renderHook(() => useCover("doc3", 3, "xlsx", true));
  await act(async () => { await Promise.resolve(); });
  expect(asked).toEqual([]);
});

it("fits the page where the editor draws it (boxes measured in WebKitGTK at 1440×900: frame 1368 wide)", () => {
  // Word: A4 at 100 % (1190 px at 144 dpi = 794 CSS px), 304 px from the frame's left, 156 from its top.
  expect(coverFit("docx", { width: 1368, height: 641 }, { width: 1190, height: 1684 })).toMatchObject({ left: 304, top: 156, width: 794 });
  // PowerPoint: a 16:9 slide fitted to the height left (measured 611 × 343 at 457, 178).
  const slide = coverFit("pptx", { width: 1368, height: 690 }, { width: 1920, height: 1080 });
  expect(Math.abs(slide.left - 457)).toBeLessThanOrEqual(2);
  expect(slide.top).toBe(178);
  expect(Math.abs(slide.width - 611)).toBeLessThanOrEqual(4);
  // Hangul: the page at 100 % (its size in CSS px), 297 from the left, 150 from the top (the toolbar is 140 px since the HOP look; measured y 360 − frame 210).
  expect(coverFit("hwpx", { width: 1368, height: 690 }, { width: 794, height: 1123 })).toMatchObject({ left: 297, top: 150, width: 794 });
  // At 1000×800 (frame 928 wide): Word's ribbon wraps (+7 px), Hangul's studio fits the page to the width (measured 889 px at 30, 166).
  expect(coverFit("docx", { width: 928, height: 590 }, { width: 1190, height: 1684 })).toMatchObject({ left: 84 + 0, top: 163, width: 794 });
  expect(coverFit("hwpx", { width: 928, height: 590 }, { width: 794, height: 1123 })).toMatchObject({ left: 30, top: 151, width: 889 });
  // A narrow pane: the page shrinks to the width, keeping its ratio.
  const narrow = coverFit("docx", { width: 600, height: 800 }, { width: 1190, height: 1684 });
  expect(narrow.width).toBeLessThan(600);
  expect(Math.abs(narrow.height / narrow.width - 1684 / 1190)).toBeLessThan(0.01);
});

it("adds the quiet 여는 중 mark only after 0.6 s, and a click before the editor is ready is answered", () => {
  vi.useFakeTimers();
  render(<DocCover cover={{ artifactId: "doc", revision: 3, url: "blob:r3", width: 1190, height: 1684 }} kind="docx" name="강의.docx" />);
  expect(screen.queryByRole("status")).toBeNull();
  act(() => { vi.advanceTimersByTime(COVER_MARK_MS - 50); });
  expect(screen.queryByRole("status")).toBeNull();
  act(() => { vi.advanceTimersByTime(100); });
  expect(screen.getByRole("status").textContent).toBe("여는 중");
  fireEvent.pointerDown(screen.getByLabelText("강의.docx · 편집기를 여는 중"));
  expect(screen.getByRole("status").textContent).toBe("편집기를 여는 중입니다. 곧 입력할 수 있습니다.");
});

it("a key typed on the page before the editor is ready is answered too", () => {
  render(<DocCover cover={{ artifactId: "doc", revision: 3, url: "blob:r3", width: 1190, height: 1684 }} kind="hwpx" name="계획.hwpx" />);
  fireEvent.keyDown(screen.getByLabelText("계획.hwpx · 편집기를 여는 중"), { key: "가" });
  expect(screen.getByRole("status").textContent).toContain("편집기를 여는 중입니다");
});
