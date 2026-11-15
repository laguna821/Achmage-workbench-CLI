// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BrowserPage, Session, Work } from "@workbench/contracts";
import { initialState } from "../../state.ts";
import type { MenuRequest } from "../ContextMenu.tsx";
import { WebRows, type WebRowActions } from "./WebRows.tsx";
import type { NavShared } from "./shared.ts";

// Skin 2 · B, item 4: the 웹 section of level 2 lists the project's pages, open and closed; a row and
// its tab are one item; a closed row opens the same page again; 목록에서 지우기 is the only removal.

afterEach(cleanup);

const work = { id: "w", title: "AI 글쓰기 수업", folderId: null, cwd: "/w", archivedAt: null } as unknown as Work;
const page = (pageId: string, extra: Partial<BrowserPage> = {}): BrowserPage => ({
  pageId, profileId: "default", workId: "w", workspaceId: "space", driverId: "d", url: `https://${pageId}.example/`, title: `${pageId} 제목`, status: "ready",
  sessionId: null, control: { generation: 0, owner: "human" }, native: null, createdAt: 1, updatedAt: 1, error: null, ...extra });
const ai = { id: "page-ai", workId: "w", provider: "codex", purpose: "자료 찾기", status: "running", unread: false, previewAt: null, seenAt: null, createdAt: 2, updatedAt: 2, archivedAt: null, pageAgent: { pageId: "live", parentSessionId: null } } as unknown as Session;

function setup(over: Partial<WebRowActions> = {}, sections: Record<string, boolean> = {}) {
  const openMenu = vi.fn<(request: MenuRequest) => void>(), saveNav = vi.fn();
  const web: WebRowActions = {
    pages: [page("live", { sessionId: "page-ai" }), page("plain", { createdAt: 3 })], closedPages: [page("gone", { status: "closed", closedAt: 9 })], currentId: "browser:plain",
    open: vi.fn(), reopen: vi.fn(), close: vi.fn(), forget: vi.fn(), openAgent: vi.fn(), create: vi.fn(), ...over,
  };
  const shared = { state: { ...initialState, works: { w: work }, sessions: { "page-ai": ai } }, nav: { sections }, saveNav, visibleSessionId: null, actions: { openMenu } } as unknown as NavShared;
  const onKey = vi.fn();
  const view = render(<WebRows shared={shared} work={work} web={web} text="" tabId="browser:plain" onKey={onKey} />);
  return { ...view, web, openMenu, saveNav, onKey };
}
const row = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-row-id="${id}"]`)!;

describe("the 웹 rows of a project", () => {
  it("lists a page with no AI, a page with its AI's state, and a closed page that says 닫힘", () => {
    const { container } = setup();
    expect([...container.querySelectorAll("[data-row-id]")].map((element) => element.getAttribute("data-row-id"))).toEqual(["browser:live", "browser:plain", "browser:gone"]);
    expect(row(container, "browser:live").querySelector(".row-state")?.textContent).toBe("진행 중");
    expect(row(container, "browser:plain").querySelector(".row-state")).toBeNull();
    expect(row(container, "browser:gone").querySelector(".row-state")?.textContent).toBe("닫힘");
    // At most one trailing fact (the keys show on hover/focus; the word is the fact).
    expect(row(container, "browser:gone").querySelectorAll(".row-state")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "웹 3" })).toBeTruthy();
  });
  it("the row on screen is the selected one; it is the one Tab reaches", () => {
    const { container } = setup();
    expect(row(container, "browser:plain").getAttribute("aria-selected")).toBe("true");
    expect(row(container, "browser:plain").tabIndex).toBe(0);
    expect(row(container, "browser:live").tabIndex).toBe(-1);
  });
  it("an open row goes to its page (by the page's id); a closed row opens the same page again", () => {
    const { container, web } = setup();
    fireEvent.click(row(container, "browser:live"));
    expect(web.open).toHaveBeenCalledWith(expect.objectContaining({ id: "browser:live", pageId: "live" }));
    fireEvent.click(row(container, "browser:gone"));
    expect(web.reopen).toHaveBeenCalledWith(expect.objectContaining({ id: "browser:gone", pageId: "gone", open: false }));
    fireEvent.keyDown(row(container, "browser:plain"), { key: "Enter" });
    expect(web.open).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: "plain" }));
  });
  it("목록에서 지우기 is in the row's menu (also by keyboard), last and apart; 탭 닫기 keeps the row", () => {
    const { container, web, openMenu } = setup();
    fireEvent.keyDown(row(container, "browser:live"), { key: "F10", shiftKey: true });
    const request = openMenu.mock.calls[0]![0];
    const labels = request.items.map((entry) => (entry.kind === "item" ? entry.label : entry.kind));
    expect(labels).toEqual(["열기", "웹 AI 대화 열기", "탭 닫기", "separator", "목록에서 지우기"]);
    const forget = request.items.at(-1)!;
    if (forget.kind !== "item") throw new Error("menu");
    expect(forget.danger).toBe(true);
    forget.onSelect();
    expect(web.forget).toHaveBeenCalledWith(expect.objectContaining({ pageId: "live" }));
    fireEvent.contextMenu(row(container, "browser:gone"));
    expect(openMenu.mock.calls[1]![0].items.map((entry) => (entry.kind === "item" ? entry.label : entry.kind))).toEqual(["다시 열기", "separator", "목록에서 지우기"]);
  });
  it("+ opens a new web page in THIS project and says which", () => {
    const { web } = setup();
    fireEvent.click(screen.getByRole("button", { name: "「AI 글쓰기 수업」에 새 웹 페이지" }));
    expect(web.create).toHaveBeenCalledWith(work);
  });
  it("folded, the section keeps its count and says when the page on screen is inside", () => {
    const { container } = setup({}, { web: true });
    expect(container.querySelectorAll("[data-row-id]")).toHaveLength(0);
    const fold = container.querySelector<HTMLElement>(".nav-fold")!;
    expect(fold.getAttribute("aria-current")).toBe("location");
    expect(fold.textContent).toContain("3");
  });
  it("the list's keys (↑↓, Alt+←) reach the level", () => {
    const { container, onKey } = setup();
    fireEvent.keyDown(row(container, "browser:live"), { key: "ArrowDown" });
    expect(onKey).toHaveBeenCalled();
  });
});
