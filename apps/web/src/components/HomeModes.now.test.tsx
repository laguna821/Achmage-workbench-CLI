// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, Session, Work } from "@workbench/contracts";
import { initialState, type State } from "../state.ts";
import type { Api } from "../api.ts";
import { AppearanceContext, NEUTRAL_LOOK, type AppearanceApi } from "../appearance.ts";
import { HomeModes } from "./HomeModes.tsx";
import { forgetUnread, keepUnread } from "../kept-unread.ts";

// Skin 2 (S7, as merged): home "지금" in the owner's draft's shape — the head, a filter row (묶어서 보기 at
// its end), ONE band "확인이 필요한 작업 N개" + 검토하기, ONE table whose first rows are the decisions
// (the row's name opens it; its chevron unfolds the full entry in place), 최근 문서 as a row of three. The other views are
// reached from the list (unit A's 보기 › 보드·표로 보기, 활동 › 달력으로 보기) and keys 1–4.

const now = Date.now();
const work = (id: string, title: string) => ({ id, title, folderId: null, cwd: `/w/${id}`, cwdManaged: false, activeSessionId: null, pinned: false, sort: 0, archivedAt: null, createdAt: 1, updatedAt: now - 1000 }) as unknown as Work;
const base = { status: "idle", model: null, effort: null, context: null, worktree: null, lastError: null, archivedAt: null, queued: [], sort: 0, createdAt: 1, seenAt: null, unread: false, previewAt: null };
let order = 0;
const session = (id: string, workId: string, purpose: string, patch: Record<string, unknown> = {}) =>
  ({ ...base, id, workId, purpose, provider: order++ % 2 ? "claude" : "codex", updatedAt: now - order * 60_000, ...patch }) as unknown as Session;
const doc = (id: string, workId: string, name: string, at: number) => ({ id, workId, name, path: `/w/${workId}/${name}`, format: "markdown", revision: 1, updatedAt: at, role: "file" }) as unknown as Artifact;

const works = { w1: work("w1", "AI 글쓰기 수업"), w2: work("w2", "학과 회의"), w3: work("w3", "연구") };
const sessions = {
  ask1: session("ask1", "w1", "강의안 다듬기", { status: "awaitingApproval" }),
  ask2: session("ask2", "w2", "회의록 정리", { status: "awaitingApproval" }),
  ask3: session("ask3", "w3", "논문 검토 메모", { status: "awaitingApproval" }),
  fail: session("fail", "w3", "관련 논문 검색", { lastError: "엔진이 응답하지 않았습니다" }),
  run: session("run", "w1", "참고 자료 조사", { status: "running" }),
  fresh: session("fresh", "w1", "3주차 강의안 작성", { previewAt: now - 120_000, seenAt: now - 600_000 }),
  done1: session("done1", "w2", "회의 안건", { previewAt: now - 900_000, seenAt: now }),
  done2: session("done2", "w1", "수업자료 정리", { previewAt: now - 3_600_000, seenAt: now }),
};
const artifacts = {
  a1: doc("a1", "w1", "강의안.md", now - 60_000),
  a2: doc("a2", "w2", "회의록.md", now - 120_000),
  a3: doc("a3", "w1", "수업자료.md", now - 180_000),
  a4: doc("a4", "w3", "오래된.md", now - 9_000_000),
};
const full: State = { ...initialState, works, sessions, artifacts } as State;
const api = { items: vi.fn(async () => ({ items: [] })), updateSession: vi.fn(async () => ({})) } as unknown as Api;
const appearance = { appTheme: "light", lookOf: () => NEUTRAL_LOOK.light, themeOf: () => "light", openMenu: () => {} } as unknown as AppearanceApi;

const open = { session: vi.fn(), work: vi.fn(), doc: vi.fn(), mode: vi.fn() };
const view = (state: State = full, mode: "now" | "projects" | "flow" | "docs" = "now") => render(
  <AppearanceContext.Provider value={appearance}>
    <HomeModes api={api} state={state} mode={mode} onMode={open.mode} onOpenSession={open.session} onOpenWork={open.work} onOpenProject={open.work} onOpenDoc={open.doc} />
  </AppearanceContext.Provider>,
);

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); forgetUnread("fresh"); });

const table = () => screen.getByRole("table");
const rowNames = () => within(table()).getAllByRole("row").slice(1).map((row) => row.querySelector(".now-cell-work")?.textContent);

describe("home 지금", () => {
  it("heads the page with 지금, today's date and the four views of home in sight", () => {
    view();
    expect(screen.getByRole("heading", { level: 1, name: "지금" })).toBeTruthy();
    expect(document.querySelector(".home-date")?.textContent).toMatch(/\d+월 \d+일/);
    const views = screen.getByRole("radiogroup", { name: "홈 보기" });
    expect(Array.from(views.querySelectorAll("button")).map((entry) => entry.textContent)).toEqual(["지금", "보드와 표", "달력", "문서"]);
  });

  it("switches to the board, the calendar and the documents from the head, and back to 지금 from any of them", () => {
    view();
    fireEvent.click(screen.getByRole("radio", { name: "보드와 표" }));
    expect(open.mode).toHaveBeenCalledWith("projects");
    fireEvent.click(screen.getByRole("radio", { name: "달력" }));
    expect(open.mode).toHaveBeenCalledWith("flow");
    cleanup();
    view(full, "docs");
    expect(screen.getByRole("heading", { level: 1, name: "문서" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "지금" }));
    expect(open.mode).toHaveBeenCalledWith("now");
  });

  it("brings back the former 지금 views (group, board, filter) from 묶어서 보기 at the end of the filter row, and back again", () => {
    view();
    const key = screen.getByRole("button", { name: /묶어서 보기/ });
    expect(key.closest(".now-filters")).not.toBeNull();
    expect(key.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(key);
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector(".now-mode")).not.toBeNull();
    const again = screen.getByRole("button", { name: /묶어서 보기/ });
    expect(again.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(again);
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("switches views with the keys 1–4 as before", () => {
    view();
    fireEvent.keyDown(window, { key: "3" });
    expect(open.mode).toHaveBeenCalledWith("flow");
  });

  it("counts what needs the person and what runs in the filter row, in tabular figures", () => {
    view();
    const tabs = screen.getByRole("tablist", { name: "지금 거르기" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["전체", "확인 필요4", "진행 중1", "완료"]);
    expect(within(tabs).getByRole("tab", { name: "전체" }).getAttribute("aria-selected")).toBe("true");
  });

  it("says what waits for a decision in ONE band over the table, and the decisions are the table's first rows (oldest ask first)", () => {
    view();
    const band = screen.getByRole("group", { name: "확인이 필요한 작업" });
    expect(band.textContent).toContain("확인이 필요한 작업 3개");
    expect(band.compareDocumentPosition(table()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryAllByRole("article")).toHaveLength(0); // no framed entries until asked
    expect(rowNames().slice(0, 3)).toEqual(["논문 검토 메모", "회의록 정리", "강의안 다듬기"]);
    const first = within(table()).getAllByRole("row")[1]!;
    expect(first.querySelector(".state-word")?.textContent).toBe("확인 필요");
    // Fix 1 (the review's change 2): no second key per row ("열어서 확인" is gone); the row's name opens it.
    expect(within(first).queryByRole("button", { name: "열어서 확인" })).toBeNull();
    fireEvent.click(within(first).getByRole("button", { name: "논문 검토 메모" }));
    expect(open.session).toHaveBeenCalledWith(expect.objectContaining({ id: "ask3" }));
    // The band's key is a quiet text key (the owner's draft: "검토하기 ›"), not a filled one.
    const review = within(band).getByRole("button", { name: "검토하기" });
    expect(review.classList.contains("primary")).toBe(false);
    expect(review.classList.contains("text-button")).toBe(true);
    // Listed once each.
    expect(rowNames().filter((name) => name === "논문 검토 메모")).toHaveLength(1);
  });

  it("검토하기 unfolds the first decision's full entry in place; a row's chevron unfolds or folds its own", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "검토하기" }));
    const entries = screen.getAllByRole("article");
    expect(entries.map((entry) => entry.getAttribute("aria-label"))).toEqual(["연구, 논문 검토 메모"]);
    expect(entries[0]!.closest(".now-reply-row")).not.toBeNull();
    const second = within(table()).getAllByRole("row").find((row) => row.textContent?.includes("회의록 정리") && row.classList.contains("now-row"))!;
    fireEvent.click(within(second).getByRole("button", { name: "확인할 내용 펼치기" }));
    expect(screen.getAllByRole("article")).toHaveLength(2);
    fireEvent.click(within(second).getByRole("button", { name: "확인할 내용 접기" }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("draws one table: 작업 | 프로젝트 | 상태 | AI | 최근 활동, the state as glyph and word, the engine as its mark and name", () => {
    view();
    expect(within(table()).getAllByRole("columnheader").map((cell) => cell.textContent).slice(0, 5)).toEqual(["작업", "프로젝트", "상태", "AI", "최근 활동"]);
    const running = within(table()).getAllByRole("row").find((row) => row.textContent?.includes("참고 자료 조사"))!;
    expect(running.querySelector(".state-word .state-mark[data-state=running]")).not.toBeNull();
    expect(running.querySelector(".state-word")?.textContent).toBe("진행 중");
    expect(running.querySelector(".now-cell-ai .engine-mark")).not.toBeNull();
    expect(running.querySelector(".now-cell-project")?.textContent).toBe("AI 글쓰기 수업");
    expect(within(table()).getAllByText("완료")).toHaveLength(2);
    expect(within(table()).getByText("새 답")).toBeTruthy();
    expect(within(table()).getByText("실패")).toBeTruthy();
  });

  it("opens a conversation from its name and the project's note from its project", () => {
    view();
    fireEvent.click(within(table()).getByRole("button", { name: "참고 자료 조사" }));
    expect(open.session).toHaveBeenCalledWith(expect.objectContaining({ id: "run" }));
    fireEvent.click(within(table()).getAllByRole("button", { name: "학과 회의" })[0]!);
    expect(open.work).toHaveBeenCalledWith(expect.objectContaining({ id: "w2" }));
  });

  it("filters the table to one state; 확인 필요 holds the failed one too", () => {
    view();
    fireEvent.click(screen.getByRole("tab", { name: /진행 중/ }));
    expect(screen.queryByRole("group", { name: "확인이 필요한 작업" })).toBeNull();
    expect(rowNames()).toEqual(["참고 자료 조사"]);
    fireEvent.click(screen.getByRole("tab", { name: /확인 필요/ }));
    expect(rowNames()).toEqual(["논문 검토 메모", "회의록 정리", "강의안 다듬기", "관련 논문 검색"]);
    fireEvent.click(screen.getByRole("tab", { name: /완료/ }));
    expect(rowNames()).toEqual(["회의 안건", "수업자료 정리"]);
  });

  it("moves between filters with the arrow keys (one tab stop)", () => {
    view();
    const first = screen.getByRole("tab", { name: "전체" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const attention = screen.getByRole("tab", { name: /확인 필요/ });
    expect(attention.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(attention);
    expect(first.tabIndex).toBe(-1);
  });

  it("opens a row's last reply in place (the former ledger's chevron)", () => {
    view();
    const row = within(table()).getAllByRole("row").find((entry) => entry.textContent?.includes("회의 안건"))!;
    fireEvent.click(within(row).getByRole("button", { name: "마지막 답 보기" }));
    expect(document.querySelector(".now-reply-row")).not.toBeNull();
  });

  // Re-review 1, next round 8 (W1): a web page whose tab was closed is held until its AI's new answer is
  // seen. An answer read here, unfolded in 지금, is seen: it is marked so (and the held page can go).
  it("an unseen answer read in place here is marked seen; an answer already seen is not marked again", async () => {
    vi.mocked(api.items).mockResolvedValue({ items: [{ id: "q", kind: "user", text: "요약해 줘" }, { id: "a", kind: "assistant", text: "세 가지로 요약했습니다." }] } as never);
    view();
    const fresh = within(table()).getAllByRole("row").find((entry) => entry.textContent?.includes("3주차 강의안 작성"))!;
    fireEvent.click(within(fresh).getByRole("button", { name: "마지막 답 보기" }));
    await screen.findByText(/세 가지로 요약했습니다/);
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith("fresh", { seen: true }));
    vi.mocked(api.updateSession).mockClear();
    const done = within(table()).getAllByRole("row").find((entry) => entry.textContent?.includes("회의 안건"))!;
    fireEvent.click(within(done).getByRole("button", { name: "마지막 답 보기" }));
    await waitFor(() => expect(screen.getAllByText(/세 가지로 요약했습니다/)).toHaveLength(2));
    expect(api.updateSession).not.toHaveBeenCalled();
  });

  // Tech review 4 (MINOR): seen = it was on screen, and a person's 읽지 않음으로 stands.
  it("does not re-mark as seen an answer the person kept unread, until a newer one comes", async () => {
    vi.mocked(api.items).mockResolvedValue({ items: [{ id: "q", kind: "user", text: "요약해 줘" }, { id: "a", kind: "assistant", text: "세 가지로 요약했습니다." }] } as never);
    keepUnread("fresh", sessions.fresh.previewAt);
    view();
    const fresh = within(table()).getAllByRole("row").find((entry) => entry.textContent?.includes("3주차 강의안 작성"))!;
    fireEvent.click(within(fresh).getByRole("button", { name: "마지막 답 보기" }));
    await screen.findByText(/세 가지로 요약했습니다/);
    await new Promise((done) => setTimeout(done, 20));
    expect(api.updateSession).not.toHaveBeenCalled();
  });

  it("does not mark a new answer seen before it has been fetched and shown", async () => {
    vi.mocked(api.items).mockResolvedValueOnce({ items: [{ id: "q", kind: "user", text: "요약해 줘" }, { id: "a", kind: "assistant", text: "세 가지로 요약했습니다." }] } as never);
    const shown = view();
    const fresh = within(table()).getAllByRole("row").find((entry) => entry.textContent?.includes("3주차 강의안 작성"))!;
    fireEvent.click(within(fresh).getByRole("button", { name: "마지막 답 보기" }));
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith("fresh", { seen: true }));
    vi.mocked(api.updateSession).mockClear();
    // A newer answer arrives while the row is open; its transcript is still on its way.
    vi.mocked(api.items).mockReturnValueOnce(new Promise(() => {}) as never);
    const newer = { ...full, sessions: { ...sessions, fresh: { ...sessions.fresh, previewAt: now + 5_000, seenAt: now - 600_000 } } } as State;
    shown.rerender(<AppearanceContext.Provider value={appearance}><HomeModes api={api} state={newer} mode="now" onMode={open.mode} onOpenSession={open.session} onOpenWork={open.work} onOpenProject={open.work} onOpenDoc={open.doc} /></AppearanceContext.Provider>);
    await new Promise((done) => setTimeout(done, 20));
    expect(api.updateSession).not.toHaveBeenCalled();
  });

  it("marks every new answer read from the filter row (the former 모두 읽음)", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: /새 답 1개 읽음으로/ }));
    expect(api.updateSession).toHaveBeenCalledWith("fresh", { seen: true });
  });

  it("ends with 최근 문서 as one row of three, and 전체 보기 opens 문서", () => {
    view();
    const docs = screen.getByRole("region", { name: "최근 문서" });
    expect(within(docs).getAllByRole("listitem").map((item) => item.querySelector(".now-doc-name")?.textContent)).toEqual(["강의안.md", "회의록.md", "수업자료.md"]);
    fireEvent.click(within(docs).getByRole("button", { name: /강의안.md/ }));
    expect(open.doc).toHaveBeenCalledWith("a1");
    fireEvent.click(within(docs).getByRole("button", { name: /전체 보기/ }));
    expect(open.mode).toHaveBeenCalledWith("docs");
  });

  it("says what gathers here when nothing was asked yet", () => {
    view({ ...initialState, works } as State);
    expect(screen.getByRole("status").textContent).toContain("아직 맡긴 일이 없습니다");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says so when a filter holds nothing", () => {
    const quiet: State = { ...full, sessions: { done1: sessions.done1 } };
    view(quiet);
    fireEvent.click(screen.getByRole("tab", { name: /진행 중/ }));
    expect(screen.getByText("지금 진행 중인 작업이 없습니다.")).toBeTruthy();
  });
});

// Technical review (MINOR): 묶어서 보기 is this window's choice — it is still on when 지금 opens again.
it("remembers 묶어서 보기 when 지금 opens again", () => {
  sessionStorage.clear();
  const first = view();
  fireEvent.click(screen.getByRole("button", { name: /묶어서 보기/ }));
  first.unmount();
  view();
  expect(screen.getByRole("button", { name: /묶어서 보기/ }).getAttribute("aria-pressed")).toBe("true");
  sessionStorage.clear();
});
