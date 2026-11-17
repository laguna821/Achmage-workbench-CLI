// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { Artifact, HistoryEvent, HistoryPage, Session, Work } from "@workbench/contracts";
import { initialState, type State } from "../../state.ts";
import { ActivityHistory, HISTORY_SETTLE, historyPulse } from "./ActivityHistory.tsx";
import type { NavShared } from "./shared.ts";
import { chooseOption } from "../ui/select-testing.ts";

// 활동 › 기록 on screen: a page from the gateway as day groups of lines, the filters and the project
// asked of the gateway, a run folded and opened, a click opening the conversation at that point, the next
// page, and no reading while nothing changes.

const NOW = Date.now();
const work = (id: string) => ({ id, title: id === "w1" ? "강의 준비" : "논문", archivedAt: null, folderId: null }) as unknown as Work;
const session = (id: string, extra: Partial<Session> = {}) => ({ id, workId: "w1", provider: "claude", purpose: id === "s1" ? "3주차 슬라이드" : "회의록", status: "idle", archivedAt: null, previewAt: null, queued: [], ...extra }) as unknown as Session;
const state: State = {
  ...initialState,
  works: { w1: work("w1"), w2: work("w2") },
  sessions: { s1: session("s1"), s2: session("s2", { provider: "codex" }) },
  artifacts: { d1: { id: "d1", workId: "w1", name: "보고서.md", revision: 2 } as unknown as Artifact },
};
const ev = (id: string, at: number, kind: HistoryEvent["kind"], extra: Partial<HistoryEvent> = {}): HistoryEvent => ({ id, at, kind, workId: "w1", sessionId: "s1", artifactId: null, itemId: id, provider: "claude", ...extra });

function Frame({ history, actions = {}, now = state }: { history: (query: unknown) => Promise<HistoryPage>; actions?: Record<string, unknown>; now?: State }) {
  const [today, setToday] = useState(false);
  const [api] = useState(() => ({ history }));
  const shared = { state: now, api, actions: { openSession: () => {}, openDoc: () => {}, openArchive: () => {}, ...actions } } as unknown as NavShared;
  return <div className="nav-level">{today ? <p>현황</p> : <ActivityHistory shared={shared} onToday={() => setToday(true)} />}</div>;
}

const lines = () => [...document.querySelectorAll<HTMLElement>("[data-history-line], [data-history-fold]")];

beforeEach(() => { Element.prototype.scrollIntoView = () => {}; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("활동 › 기록", () => {
  it("shows the page as day groups of lines: time, what happened, project · conversation · engine", async () => {
    const history = vi.fn(async () => ({ events: [ev("e1", NOW - 60_000, "failed"), ev("u1", NOW - 2 * 86_400_000, "request", { sessionId: "s2", via: "phone", text: "요약해 줘", provider: "codex" })], next: null }));
    render(<Frame history={history} />);
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(history).toHaveBeenCalledWith({ limit: 100, filter: "all", workId: null });
    expect([...document.querySelectorAll(".nav-group")].map((group) => group.textContent)).toEqual(["오늘", expect.stringMatching(/^\d+월 \d+일 \(.\)$/)]);
    const [failed, phone] = lines();
    expect(failed!.querySelector(".nav-hist-text")!.textContent).toBe("답하지 못함 (실패)");
    expect(failed!.querySelector(".nav-hist-text")!.className).toContain("tone-error");
    expect(failed!.querySelector(".nav-hist-place")!.textContent).toBe("강의 준비 · 3주차 슬라이드 · Claude");
    expect(phone!.querySelector(".nav-hist-text")!.textContent).toBe("휴대폰에서 요청 「요약해 줘」");
    expect(phone!.querySelector(".nav-hist-place")!.textContent).toBe("강의 준비 · 회의록 · Codex");
  });

  it("asks the gateway for a filter and a project; 내가 확인할 것 links to today's view", async () => {
    const history = vi.fn(async () => ({ events: [], next: null }));
    render(<Frame history={history} />);
    await waitFor(() => expect(screen.getByText("아직 기록이 없습니다.")).toBeTruthy());
    fireEvent.click(screen.getByRole("radio", { name: "문제" }));
    await waitFor(() => expect(history).toHaveBeenLastCalledWith({ limit: 100, filter: "problem", workId: null }));
    expect(screen.getByText("실패하거나 멈춘 일이 없습니다.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "내가 확인할 것" }));
    await waitFor(() => expect(history).toHaveBeenLastCalledWith({ limit: 100, filter: "attention", workId: null }));
    chooseOption("프로젝트로 거르기", "논문");
    await waitFor(() => expect(history).toHaveBeenLastCalledWith({ limit: 100, filter: "attention", workId: "w2" }));
    fireEvent.click(screen.getByRole("button", { name: "지금 확인할 대화는 현황에서" }));
    expect(screen.getByText("현황")).toBeTruthy();
  });

  it("folds one conversation's run into one line that opens; a line opens its conversation at that item", async () => {
    const openSessionAt = vi.fn();
    const history = vi.fn(async () => ({ events: [ev("e2", NOW - 1000, "answer", { durationMs: 9000 }), ev("u2", NOW - 60_000, "request", { via: "pc", text: "둘" }), ev("e1", NOW - 120_000, "answer"), ev("u1", NOW - 180_000, "request", { via: "pc", text: "하나" })], next: null }));
    render(<Frame history={history} actions={{ openSessionAt }} />);
    await waitFor(() => expect(lines()).toHaveLength(1));
    const fold = lines()[0]!;
    expect(fold.querySelector(".nav-hist-text")!.textContent).toBe("대화 「3주차 슬라이드」 · 요청 2건, 답 2건");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(fold, { key: "Enter" });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(lines()).toHaveLength(5);
    fireEvent.click(lines()[2]!);
    expect(openSessionAt).toHaveBeenCalledWith(state.sessions.s1, "u2");
  });

  it("a document's line opens the document; one taken out opens 보관함", async () => {
    const openDoc = vi.fn();
    const openArchive = vi.fn();
    const history = vi.fn(async () => ({ events: [ev("r", NOW - 1000, "doc-revised", { sessionId: null, artifactId: "d1", author: "user", revision: 2, name: "보고서.md" }), ev("x", NOW - 999_000, "doc-removed", { sessionId: null, artifactId: "gone", removal: "trash", name: "옛 문서.md" })], next: null }));
    render(<Frame history={history} actions={{ openDoc, openArchive }} />);
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(lines()[0]!.querySelector(".nav-hist-place")!.textContent).toBe("강의 준비 · 보고서.md");
    fireEvent.click(lines()[0]!);
    expect(openDoc).toHaveBeenCalledWith(state.artifacts.d1);
    fireEvent.click(lines()[1]!);
    expect(openArchive).toHaveBeenCalled();
  });

  it("reads the next page from the button under the list (and only then)", async () => {
    const history = vi.fn(async (query: unknown) => ((query as { before?: string }).before
      ? { events: [ev("old", NOW - 5 * 86_400_000, "answer", { sessionId: "s2" })], next: null }
      : { events: [ev("new", NOW - 1000, "answer")], next: "1:new" }));
    render(<Frame history={history} />);
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(history).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "기록 더 보기" }));
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(history).toHaveBeenLastCalledWith({ before: "1:new", limit: 100, filter: "all", workId: null });
    expect(screen.queryByRole("button", { name: "기록 더 보기" })).toBeNull();
  });

  it("says when the gateway could not answer, with a way to read again", async () => {
    const history = vi.fn().mockRejectedValueOnce(new Error("연결이 끊겼습니다.")).mockResolvedValue({ events: [], next: null });
    render(<Frame history={history} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("연결이 끊겼습니다."));
    fireEvent.click(screen.getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(screen.getByText("아직 기록이 없습니다.")).toBeTruthy());
  });

  it("reads the first page again once, a moment after a change that makes a line; a streamed token is not one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const history = vi.fn(async () => ({ events: [], next: null }));
    const { rerender } = render(<Frame history={history} />);
    await waitFor(() => expect(history).toHaveBeenCalledTimes(1));
    // A token: only the activity line changes (not a state, a revision or a 수정안).
    const streaming = { ...state, sessions: { ...state.sessions, s1: { ...state.sessions.s1!, activity: "답 쓰는 중" } } };
    expect(historyPulse(streaming)).toBe(historyPulse(state));
    rerender(<Frame history={history} now={streaming} />);
    await act(async () => { vi.advanceTimersByTime(HISTORY_SETTLE * 3); });
    expect(history).toHaveBeenCalledTimes(1);
    // Two turns end in a burst: one read, HISTORY_SETTLE after the last.
    const ended = { ...streaming, sessions: { ...streaming.sessions, s1: { ...streaming.sessions.s1!, status: "running" as const } } };
    rerender(<Frame history={history} now={ended} />);
    await act(async () => { vi.advanceTimersByTime(HISTORY_SETTLE / 2); });
    const again = { ...ended, sessions: { ...ended.sessions, s2: { ...(ended.sessions as Record<string, (typeof ended.sessions)["s1"]>).s2!, previewAt: NOW } } };
    rerender(<Frame history={history} now={again} />);
    await act(async () => { vi.advanceTimersByTime(HISTORY_SETTLE - 100); });
    expect(history).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(200); });
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
  });
});

