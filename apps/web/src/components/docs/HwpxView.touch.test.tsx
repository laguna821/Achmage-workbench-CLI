// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Api } from "../../api.ts";
import type { Artifact } from "@workbench/contracts";
import { HwpxView, pinchZoom, swipeStep } from "./HwpxView.tsx";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const touchScreen = (yes: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({ matches: yes && query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {} }));
const pages = [1, 2, 3].map((page) => ({ page, width: 595, height: 842, svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${page}</text></svg>` }));
const api = { pages: vi.fn(async () => ({ revision: 2, pages })) } as unknown as Api;
const artifact = { id: "doc-1" } as Artifact;
const mount = async () => { await act(async () => { render(<HwpxView api={api} artifact={artifact} revision={2} />); }); };

it("swipe and pinch arithmetic", () => {
  expect(swipeStep(-120, 10, 200)).toBe(1);
  expect(swipeStep(120, 10, 200)).toBe(-1);
  expect(swipeStep(-30, 0, 200)).toBe(0);      // too short
  expect(swipeStep(-120, 110, 200)).toBe(0);   // mostly vertical: a scroll
  expect(swipeStep(-120, 0, 1500)).toBe(0);    // too slow: a drag
  expect(pinchZoom(1, 100, 200)).toBe(2);
  expect(pinchZoom(2, 100, 50)).toBe(1);
  expect(pinchZoom(3, 100, 400)).toBe(4);
  expect(pinchZoom(1, 0, 100)).toBe(1);
});

it("a PC (fine pointer) keeps every page in one scrolling column", async () => {
  touchScreen(false);
  await mount();
  expect(screen.getAllByRole("img").map((image) => image.getAttribute("alt"))).toEqual(["1쪽", "2쪽", "3쪽"]);
});

it("a touch screen reads one page at a time: swipe to turn, buttons too, pinch to zoom, double-tap back", async () => {
  touchScreen(true);
  await mount();
  expect(screen.getAllByRole("img").map((image) => image.getAttribute("alt"))).toEqual(["1쪽"]);
  const stage = screen.getByRole("group", { name: "1쪽 / 3쪽" });
  const swipe = (from: number, to: number) => { fireEvent.pointerDown(stage, { pointerId: 1, clientX: from, clientY: 300 }); fireEvent.pointerUp(stage, { pointerId: 1, clientX: to, clientY: 305 }); };
  swipe(300, 100);
  expect(screen.getByRole("img").getAttribute("alt")).toBe("2쪽");
  swipe(100, 300);
  expect(screen.getByRole("img").getAttribute("alt")).toBe("1쪽");
  fireEvent.click(screen.getByRole("button", { name: "다음 쪽" }));
  fireEvent.click(screen.getByRole("button", { name: "다음 쪽" }));
  expect(screen.getByRole("img").getAttribute("alt")).toBe("3쪽");
  expect((screen.getByRole("button", { name: "다음 쪽" }) as HTMLButtonElement).disabled).toBe(true);
  // Pinch: two fingers from 100 px apart to 250 px apart.
  const at = screen.getByRole("group");
  fireEvent.pointerDown(at, { pointerId: 1, clientX: 100, clientY: 300 });
  fireEvent.pointerDown(at, { pointerId: 2, clientX: 200, clientY: 300 });
  fireEvent.pointerMove(at, { pointerId: 2, clientX: 350, clientY: 300 });
  fireEvent.pointerUp(at, { pointerId: 2, clientX: 350, clientY: 300 });
  fireEvent.pointerUp(at, { pointerId: 1, clientX: 100, clientY: 300 });
  expect(at.getAttribute("data-zoom")).toBe("2.5");
  expect((screen.getByRole("img") as HTMLImageElement).style.width).toBe("250%");
  // Zoomed, a sideways drag pans; it does not turn the page.
  fireEvent.pointerDown(at, { pointerId: 3, clientX: 300, clientY: 300 });
  fireEvent.pointerUp(at, { pointerId: 3, clientX: 100, clientY: 300 });
  expect(screen.getByRole("img").getAttribute("alt")).toBe("3쪽");
  fireEvent.click(screen.getByRole("button", { name: "원래 크기" }));
  expect(at.getAttribute("data-zoom")).toBe("1");
  // Double-tap zooms to 2×.
  for (let i = 0; i < 2; i++) { fireEvent.pointerDown(at, { pointerId: 4, clientX: 200, clientY: 300 }); fireEvent.pointerUp(at, { pointerId: 4, clientX: 201, clientY: 300 }); }
  expect(at.getAttribute("data-zoom")).toBe("2");
  // Keys turn pages too.
  fireEvent.keyDown(at, { key: "ArrowLeft" });
  expect(screen.getByRole("img").getAttribute("alt")).toBe("2쪽");
});
