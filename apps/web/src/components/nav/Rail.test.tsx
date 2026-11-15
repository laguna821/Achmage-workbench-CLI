// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Rail } from "./Rail.tsx";

// The rail (N1): six places with short labels, one lit; Alt+1…6 and ↑↓ reach them from the keyboard.
afterEach(cleanup);

const rail = (onPlace = vi.fn(), lit: Parameters<typeof Rail>[0]["lit"] = "projects", compact = false) =>
  render(<Rail lit={lit} attention={2} running={3} compact={compact} searchHint="찾기 (Ctrl+K)" onPlace={onPlace} onRunning={() => {}} settings={<button type="button">설정</button>} />);

it("names its six places in order, lights one, and counts what waits on 지금", () => {
  rail();
  const nav = screen.getByRole("navigation", { name: "전역 탐색" });
  expect([...nav.querySelectorAll("[data-rail]")].map((key) => key.getAttribute("data-rail"))).toEqual(["now", "projects", "docs", "activity", "search", "vault", "running"]);
  expect(screen.getByRole("button", { name: "프로젝트" }).getAttribute("aria-current")).toBe("page");
  expect(nav.querySelectorAll("[aria-current]").length).toBe(1);
  expect(screen.getByRole("button", { name: "지금, 확인 필요 2개" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /진행 중 3개/ })).toBeTruthy();
});

it("Alt+1 … Alt+6 go to the places; ↑↓ move between them; Enter chooses", () => {
  const onPlace = vi.fn();
  rail(onPlace);
  fireEvent.keyDown(window, { code: "Digit1", key: "1", altKey: true });
  fireEvent.keyDown(window, { code: "Digit5", key: "5", altKey: true });
  fireEvent.keyDown(window, { code: "Digit6", key: "6", altKey: true });
  expect(onPlace.mock.calls.map(([place]) => place)).toEqual(["now", "search", "vault"]);
  const projects = screen.getByRole("button", { name: "프로젝트" });
  projects.focus();
  fireEvent.keyDown(projects, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "문서" }));
  fireEvent.click(document.activeElement!);
  expect(onPlace).toHaveBeenLastCalledWith("docs");
});

it("keeps its labels on a narrow window (always shown), the names in the tooltips too", () => {
  rail(vi.fn(), "now", true);
  expect(screen.getByRole("button", { name: "프로젝트" }).querySelector(".rail-label")!.textContent).toBe("프로젝트");
  expect(screen.getByRole("button", { name: "프로젝트" }).getAttribute("title")).toMatch(/^프로젝트: /);
});

// The owner, 2026-11-14 late evening: "프로젝트 아이콘 제일 왼쪽에 있는 아이콘도 노트에 연필 있는 아이콘이랑 깔맞춤
// 해야할거 같아" — the rail's 프로젝트 draws the project rows' glyph (a note with a pen), not a folder;
// 문서 stays a plain file, so no other rail place looks like it.
it("draws 프로젝트 with the project rows' glyph (a note with a pen), distinct from 문서", async () => {
  const { Icon } = await import("../Icon.tsx");
  rail();
  const drawn = (place: string) => document.querySelector(`[data-rail="${place}"] .rail-icon svg`)!.innerHTML;
  const own = render(<Icon name="project" size={20} />).container.querySelector("svg")!.innerHTML;
  expect(drawn("projects")).toBe(own);
  const others = ["now", "docs", "activity", "search", "vault"].map(drawn);
  expect(others).not.toContain(own);
});

// Technical review K1: with a document of the project open, Alt+1…5 also switch the work modes; both
// listeners ran (Alt+5 = 읽기 AND the search palette). The work modes take the key first (capture phase,
// workmodes.ts) and the rail leaves a key already taken.
it("leaves an Alt+digit that another listener already took", async () => {
  const { renderHook } = await import("@testing-library/react");
  const { useWorkModeKeys } = await import("../../workmodes.ts");
  const onMode = vi.fn();
  renderHook(() => useWorkModeKeys(true, onMode));
  const onPlace = vi.fn();
  rail(onPlace);
  fireEvent.keyDown(window, { code: "Digit5", key: "5", altKey: true });
  expect(onMode).toHaveBeenCalledTimes(1);
  expect(onPlace).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { code: "Digit6", key: "6", altKey: true });
  expect(onPlace).toHaveBeenCalledWith("vault");
});
