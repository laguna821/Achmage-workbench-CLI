// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResourceState, Session } from "@workbench/contracts";
import { rowState } from "../row-state.ts";
import { ResourceLine, ResourceSettingsRows, ResourcesContext } from "./ResourceManager.tsx";
import { QueuedList } from "./WorkView.tsx";

afterEach(cleanup);

const GB = 1024 ** 3, MB = 1024 ** 2;
const state = (patch: Partial<ResourceState> = {}): ResourceState => ({
  settings: { mode: "auto", manual: 4, background: true }, maxLimit: 32, limit: 4,
  running: [
    { sessionId: "a", title: "강의계획서", forced: false, kind: "conversation" },
    { sessionId: "b", title: "보고서", forced: true, kind: "conversation" },
  ],
  waiting: [
    { sessionId: "c", requestId: "rc", title: "회의록", position: 1, at: 1, kind: "conversation", phone: false },
    { sessionId: "d", requestId: null, title: "예산표", position: 2, at: 2, kind: "document", phone: false },
    { sessionId: "e", requestId: "re", title: "자료 조사", position: 3, at: 3, kind: "conversation", phone: true },
  ],
  reason: "지금 동시에 4개까지 돌리고 있습니다", pressure: false, sleepNow: 0,
  estimate: { comfortable: 12, totalBytes: 16 * GB, otherBytes: 10.6 * GB, costBytes: 450 * MB, learned: false, reading: "exact" },
  ...patch,
});

describe("설정 › AI 엔진 › 동시에 돌리는 작업", () => {
  it("자동 / 직접, one line with the estimate, 자세히 with its three numbers, the background switch", () => {
    const onChange = vi.fn();
    render(<ResourceSettingsRows state={state()} onChange={onChange} />);
    expect(screen.getByText("동시에 돌리는 작업")).toBeTruthy();
    expect(screen.getByText("이 컴퓨터에서는 약 12개까지 편하게 돌릴 수 있습니다 (어림)")).toBeTruthy();
    expect(screen.getByText("전체 메모리").nextElementSibling?.textContent).toBe("16.0 GB");
    expect(screen.getByText("다른 데 쓰는 몫").nextElementSibling?.textContent).toBe("10.6 GB");
    expect(screen.getByText("작업 하나가 쓰는 평균").nextElementSibling?.textContent).toBe("450 MB · 아직 측정 전이라 기본값");
    fireEvent.click(screen.getByRole("radio", { name: "직접" }));
    expect(onChange).toHaveBeenCalledWith({ mode: "manual" });
    fireEvent.click(screen.getByRole("switch", { name: "뒤에서 도는 작업은 천천히" }));
    expect(onChange).toHaveBeenCalledWith({ background: false });
  });
  it("직접 shows the number; a learned cost has no 기본값 note; a rough reading says so", () => {
    render(<ResourceSettingsRows state={state({ settings: { mode: "manual", manual: 3, background: true }, estimate: { ...state().estimate, learned: true, reading: "rough" } })} onChange={() => undefined} />);
    expect(screen.getByRole("button", { name: /한 번에 돌릴 작업 수/ }).textContent).toContain("3개");
    expect(screen.getByText("작업 하나가 쓰는 평균").nextElementSibling?.textContent).toBe("450 MB");
    expect(screen.getByText(/적게 알려 주어/)).toBeTruthy();
  });
});

describe("the bottom line", () => {
  it("'실행 2 · 대기 3', a click opens the list with the reason and 지금 바로 실행 per waiting conversation", async () => {
    const runNow = vi.fn(async () => undefined);
    render(<ResourceLine state={state()} onRunNow={runNow} />);
    const key = screen.getByRole("button", { name: "실행 2 · 대기 3" });
    fireEvent.click(key);
    expect(screen.getByText("지금 동시에 4개까지 돌리고 있습니다")).toBeTruthy();
    expect(screen.getByText("바로 실행")).toBeTruthy();
    const keys = screen.getAllByRole("button", { name: "지금 바로 실행" });
    // The document's AI waits in its editor: no key for it.
    expect(keys).toHaveLength(2);
    fireEvent.click(keys[0]!);
    expect(runNow).toHaveBeenCalledWith("c", "rc");
    expect(await screen.findByText("바로 시작했습니다.")).toBeTruthy();
  });
  it("is not there when nothing runs or waits; says when memory is short", () => {
    const { container } = render(<ResourceLine state={state({ running: [], waiting: [], reason: null })} onRunNow={async () => undefined} />);
    expect(container.textContent).toBe("");
    cleanup();
    render(<ResourceLine state={state({ running: [], waiting: [], pressure: true })} onRunNow={async () => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "실행 0 · 메모리 부족" }));
    expect(screen.getByText(/메모리가 부족해 새 작업을 잠시 멈췄습니다/)).toBeTruthy();
  });
});

const session = (patch: Partial<Session>): Session => ({
  id: "c", workId: "w", provider: "claude", status: "idle", purpose: "회의록", queued: [], activity: null, lastError: null, pinned: false, sort: 0,
  archivedAt: null, seenAt: null, unread: false, preview: null, previewAt: null, ...patch,
} as unknown as Session);

describe("a waiting conversation", () => {
  it("its request shows its place and why, with 지금 바로 실행; edit and drop stay", () => {
    const actions = { send: vi.fn(), runNow: vi.fn(), edit: vi.fn(), cancel: vi.fn() };
    const waiting = session({ queued: [{ id: "rc", text: "회의록 정리해 줘", refs: [], create: null, at: 1, slot: true }] });
    render(<ResourcesContext.Provider value={state()}><QueuedList session={waiting} busy={false} actions={actions} /></ResourcesContext.Provider>);
    expect(screen.getByText("대기 중 · 1번째 · 지금 동시에 4개까지 돌리고 있습니다")).toBeTruthy();
    expect(screen.getByText(/차례를 기다리는 요청 1개/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "지금 바로 실행" }));
    expect(actions.runNow).toHaveBeenCalled();
    expect(actions.send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "고치기" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "지우기" })).toBeTruthy();
  });
  it("its row carries the waiting mark (예약's clock, the word 대기 중)", () => {
    expect(rowState(session({ queued: [{ id: "rc", text: "x", refs: [], create: null, at: 1, slot: true }] }))).toMatchObject({ id: "waiting", word: "대기 중", glyph: "clock" });
    // Held (a stop or a failure kept it): 확인 필요 as before.
    expect(rowState(session({ queued: [{ id: "rc", text: "x", refs: [], create: null, at: 1, slot: true, held: true }] }))?.id).toBe("attention");
  });
});
