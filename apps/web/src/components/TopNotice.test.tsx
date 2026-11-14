// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TopNotice } from "./TopNotice.tsx";
import type { NoticeSlot } from "../top-notice.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
const done: NoticeSlot = { kind: "completion", completion: { id: "s1", provider: "codex", text: "연구 — 문서 AI · 답변 완료", others: ["s2"] } };
const shown = (slot: NoticeSlot, handlers: { onOpen?: (id: string) => void; onClose?: () => void } = {}, serial = 1) =>
  <TopNotice slot={slot} serial={serial} onOpen={handlers.onOpen ?? (() => {})} onClose={handlers.onClose ?? (() => {})} />;

it("names a completion with its engine, full text on hover, and a count of the others", () => {
  render(shown(done));
  const status = screen.getByRole("status");
  expect(status.textContent).toContain("연구 — 문서 AI · 답변 완료");
  expect(status.textContent).toContain("+1");
  expect(screen.getByTitle("연구 — 문서 AI · 답변 완료")).toBeTruthy();
});

it("announces errors as alerts, other notices as status", () => {
  render(shown({ kind: "error", text: "저장하지 못했습니다." }));
  expect(screen.getByRole("alert").textContent).toContain("저장하지 못했습니다.");
  cleanup();
  render(shown({ kind: "info", text: "복사했습니다." }));
  expect(screen.getByRole("status").textContent).toContain("복사했습니다.");
});

it("opens, runs its action or closes on its buttons", () => {
  const onOpen = vi.fn(), onClose = vi.fn(), run = vi.fn();
  render(shown(done, { onOpen, onClose }));
  fireEvent.click(screen.getByRole("button", { name: "열기" }));
  expect(onOpen).toHaveBeenCalledWith("s1");
  expect(onClose).toHaveBeenCalledTimes(1);
  cleanup();
  render(shown({ kind: "info", text: "페이지를 만들었습니다", action: { label: "보기", run } }, { onClose }));
  fireEvent.click(screen.getByRole("button", { name: "보기" }));
  expect(run).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "알림 닫기" }));
  expect(onClose).toHaveBeenCalledTimes(3);
});

it("leaves after its lifetime, but not while it is hovered or focused", () => {
  const onClose = vi.fn();
  render(shown(done, { onClose }));
  const status = screen.getByRole("status");
  fireEvent.pointerEnter(status);
  act(() => { vi.advanceTimersByTime(10_000); });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.pointerLeave(status);
  fireEvent.focus(screen.getByRole("button", { name: "열기" }));
  act(() => { vi.advanceTimersByTime(10_000); });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.blur(screen.getByRole("button", { name: "열기" }));
  act(() => { vi.advanceTimersByTime(5_900); });
  expect(onClose).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(200); });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps its clock while the app re-renders around it, and restarts it for a new notice", () => {
  const onClose = vi.fn();
  const view = render(shown(done, { onClose: () => onClose() }));
  for (let i = 0; i < 4; i++) {
    act(() => { vi.advanceTimersByTime(1_000); });
    view.rerender(shown(done, { onClose: () => onClose() }));
  }
  view.rerender(shown(done, { onClose: () => onClose() }, 2));
  act(() => { vi.advanceTimersByTime(5_000); });
  expect(onClose).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1_100); });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("a standing notice stays until its cause is gone: no clock, no close, and its two ways out do not dismiss it", () => {
  const onClose = vi.fn(), load = vi.fn(), keep = vi.fn();
  render(<TopNotice slot={{ kind: "error", text: "다른 창에서 이 작업공간의 배치를 바꿨습니다.", action: { label: "저장된 배치 불러오기", run: load } }} more={{ label: "현재 배치로 저장", run: keep }} standing serial={0} onOpen={() => {}} onClose={onClose} />);
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("배치를 바꿨습니다");
  expect(screen.queryByRole("button", { name: "알림 닫기" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "저장된 배치 불러오기" }));
  fireEvent.click(screen.getByRole("button", { name: "현재 배치로 저장" }));
  expect(load).toHaveBeenCalledTimes(1);
  expect(keep).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
});
