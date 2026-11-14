// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Artifact, Session, Work } from "@workbench/contracts";
import { initialState } from "../../state.ts";
import type { Row } from "../../tree.ts";
import { TreeRow, type RowContext } from "./rows.tsx";

afterEach(cleanup);

const work = { id: "w", title: "문서 정리", folderId: null, cwd: "/w", archivedAt: null } as unknown as Work;
const artifact = { id: "doc", workId: "w", name: "word-source.md", path: "/w/word-source.md", format: "markdown", revision: 10, updatedAt: 1 } as Artifact;
const agent = (id: string, extra: Partial<Session> = {}) =>
  ({ id, workId: "w", provider: "codex", purpose: "word-source.md · 문서 AI", status: "idle", unread: false, previewAt: null, seenAt: null, createdAt: 1, archivedAt: null, documentAgent: { artifactId: "doc", parentSessionId: null }, ...extra }) as Session;

function ctx(over: Partial<RowContext> = {}): RowContext {
  return {
    state: initialState, lookOf: () => ({}) as never, visibleSessionId: null, currentWorkId: null, currentDocId: null, focusId: null, tabId: null, renaming: null,
    startRename: vi.fn(), toggle: vi.fn(), activate: vi.fn(), onKey: vi.fn(), onPress: vi.fn(), onFocusRow: vi.fn(), onRename: vi.fn(), onRenameDone: vi.fn(),
    onMenu: vi.fn(), justDragged: () => false, newSession: vi.fn(), newPage: vi.fn(), ...over,
  };
}

describe("a document row with its AI", () => {
  it("shows the AI's engine mark and its state at the row's end; the row still opens the document", () => {
    const row: Row = { type: "doc", id: "doc", depth: 2, artifact, work, agents: [agent("ai", { previewAt: 9, seenAt: 1 })] };
    const activate = vi.fn();
    const { container } = render(<TreeRow row={row} ctx={ctx({ activate })} />);
    const element = container.querySelector<HTMLElement>('[data-row-id="doc"]')!;
    const trail = element.querySelector(".side-row-trail")!;
    expect(trail.querySelector('.engine-mark[data-provider="codex"]')).toBeTruthy();
    // The dot is the last thing on the row, as on a conversation row.
    expect(trail.lastElementChild?.className).toContain("dot-new");
    expect(element.getAttribute("aria-label")).toContain("문서 AI");
    fireEvent.click(element);
    expect(activate).toHaveBeenCalledWith(row);
  });

  it("a document without an AI shows no engine mark", () => {
    const row: Row = { type: "doc", id: "doc", depth: 2, artifact, work, agents: [] };
    const { container } = render(<TreeRow row={row} ctx={ctx()} />);
    expect(container.querySelector(".engine-mark")).toBeNull();
    expect(container.querySelector(".dot")).toBeNull();
  });

  it("a folded 문서 group carries the most pressing state of its documents' AIs", () => {
    const row: Row = { type: "docs", id: "docs:w", depth: 1, work, count: 6, open: false, agents: [agent("a"), agent("b", { status: "awaitingApproval" })] };
    const { container } = render(<TreeRow row={row} ctx={ctx()} />);
    expect(container.querySelector(".dot-attention")).toBeTruthy();
  });
});

describe("group labels", () => {
  it("draw a kind icon, the name and the count", () => {
    const row: Row = { type: "section", id: "chats:w", depth: 1, label: "대화", workId: "w", kind: "chat", count: 2 };
    const { container } = render(<TreeRow row={row} ctx={ctx()} />);
    const label = container.querySelector(".side-kind")!;
    expect(label.querySelector("svg")).toBeTruthy();
    expect(label.textContent).toBe("대화2");
    expect(label.querySelector(".side-kind-count")?.textContent).toBe("2");
  });
});

describe("a document row's menu", () => {
  it("has a ⋯ button that opens the row's menu beside it", () => {
    const row: Row = { type: "doc", id: "doc", depth: 2, artifact, work, agents: [] };
    const onMoreMenu = vi.fn(), activate = vi.fn();
    const { getByRole } = render(<TreeRow row={row} ctx={ctx({ onMoreMenu, activate })} />);
    const more = getByRole("button", { name: "word-source.md 메뉴" });
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(more);
    expect(onMoreMenu).toHaveBeenCalledWith(row, more);
    expect(activate).not.toHaveBeenCalled();
  });
});

describe("where the user is, and what a screen reader hears", () => {
  it("a folded 문서 group is the 'you are here' row for a document open on screen, with the AI's mark and a named state", () => {
    const row: Row = { type: "docs", id: "docs:w", depth: 1, work, count: 6, open: false, agents: [agent("a", { status: "awaitingApproval" })] };
    const state = { ...initialState, artifacts: { doc: artifact } };
    const { container } = render(<TreeRow row={row} ctx={ctx({ state, currentDocId: "doc" })} />);
    const element = container.querySelector<HTMLElement>('[data-row-id="docs:w"]')!;
    expect(element.classList.contains("current")).toBe(true);
    expect(element.getAttribute("aria-current")).toBe("location");
    expect(element.querySelector('.engine-mark[data-provider="codex"]')).toBeTruthy();
    expect(element.getAttribute("aria-label")).toBe("문서 6 · 확인 필요");
  });

  it("names a new answer on the document row", () => {
    const row: Row = { type: "doc", id: "doc", depth: 2, artifact, work, agents: [agent("ai", { previewAt: 9, seenAt: 1 })] };
    const { container } = render(<TreeRow row={row} ctx={ctx()} />);
    expect(container.querySelector('[data-row-id="doc"]')!.getAttribute("aria-label")).toContain("새 답");
  });
});
