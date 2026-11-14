// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Artifact, Work } from "@workbench/contracts";
import { initialState } from "../state.ts";
import { ArchiveView } from "./ArchiveView.tsx";

afterEach(cleanup);

const work = { id: "w", title: "강의", archivedAt: null } as Work;
const removed = (id: string, kind: "trash" | "unlisted") => ({ id, workId: "w", name: `${id}.md`, path: `/w/${id}.md`, format: "markdown", revision: 3, removed: { at: Date.now(), kind } }) as Artifact;

function show(extra: { onRestoreDoc?: () => void; onPurgeDoc?: () => Promise<void> } = {}) {
  const state = { ...initialState, works: { w: work }, removedArtifacts: { a: removed("a", "trash"), b: removed("b", "unlisted") } };
  return render(<ArchiveView state={state} onRestore={vi.fn()} onOpenSession={vi.fn()} onOpenWork={vi.fn()} onClose={vi.fn()}
    onRestoreDoc={extra.onRestoreDoc ?? vi.fn()} onPurgeDoc={extra.onPurgeDoc ?? vi.fn(async () => undefined)} />);
}

describe("보관함 documents", () => {
  it("lists removed documents with their project, and restores one", () => {
    const onRestoreDoc = vi.fn();
    show({ onRestoreDoc });
    expect(screen.getByText("a.md")).toBeTruthy();
    expect(screen.getAllByText(/문서 · 강의/)).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: /되돌리기/ })[0]!);
    expect(onRestoreDoc).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("offers 영구 삭제 only for a trashed document, asks once, and says exactly what goes", async () => {
    const onPurgeDoc = vi.fn(async () => undefined);
    const state = { ...initialState, works: { w: work }, removedArtifacts: { a: { ...removed("a", "trash"), removed: { at: Date.now(), kind: "trash", trashPath: "/data/trash/a-1/a.md", sessionIds: ["ai"] } } as Artifact, b: removed("b", "unlisted") } };
    render(<ArchiveView state={state} onRestore={vi.fn()} onOpenSession={vi.fn()} onOpenWork={vi.fn()} onClose={vi.fn()} onRestoreDoc={vi.fn()} onPurgeDoc={onPurgeDoc} onSaveDocElsewhere={vi.fn()} />);
    // The unlisted one: its file was never the app's; only 되돌리기. No 다른 곳에 저장 for a live project.
    const unlisted = screen.getByText("b.md").closest("li")!;
    expect(unlisted.textContent).toContain("목록에서 뺌 · 파일은 그대로");
    expect([...unlisted.querySelectorAll("button")].map((button) => button.textContent?.trim())).toEqual(["되돌리기"]);
    expect(screen.queryByRole("button", { name: "다른 곳에 저장…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "영구 삭제…" }));
    expect(onPurgeDoc).not.toHaveBeenCalled();
    const text = screen.getByRole("dialog").textContent!;
    expect(text).toContain("/data/trash/a-1/a.md");
    expect(text).toContain("판 기록");
    expect(text).toContain("문서 AI 대화 1개는 읽기 전용 기록으로 남습니다");
    expect(text).toContain("되돌릴 수 없습니다");
    fireEvent.click(screen.getByRole("button", { name: "영구 삭제" }));
    expect(onPurgeDoc).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    await screen.findByText("a.md");
  });
});

describe("보관함 after a project was deleted", () => {
  it("keeps its trashed document under the project's old name; it can be saved elsewhere, not restored", () => {
    const onSaveDocElsewhere = vi.fn();
    const orphan = { ...removed("o", "trash"), workId: "gone", removed: { at: Date.now(), kind: "trash", orphaned: true, workTitle: "지난 학기" } } as Artifact;
    const state = { ...initialState, removedArtifacts: { o: orphan } };
    render(<ArchiveView state={state} onRestore={vi.fn()} onOpenSession={vi.fn()} onOpenWork={vi.fn()} onClose={vi.fn()}
      onRestoreDoc={vi.fn()} onPurgeDoc={vi.fn(async () => undefined)} onSaveDocElsewhere={onSaveDocElsewhere} />);
    expect(screen.getByText(/지난 학기 \(지운 프로젝트\)/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /되돌리기/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "다른 곳에 저장…" }));
    expect(onSaveDocElsewhere).toHaveBeenCalledWith(expect.objectContaining({ id: "o" }));
  });

  it("shows a deleted document's AI as its history, with no 되돌리기 of its own", () => {
    const agent = { id: "ai", workId: "w", provider: "codex", purpose: "a.md · 문서 AI", archivedAt: Date.now(), documentAgent: { artifactId: "a", parentSessionId: null } } as unknown as import("@workbench/contracts").Session;
    const state = { ...initialState, works: { w: work }, sessions: { ai: agent }, removedArtifacts: { a: removed("a", "trash") } };
    render(<ArchiveView state={state} onRestore={vi.fn()} onOpenSession={vi.fn()} onOpenWork={vi.fn()} onClose={vi.fn()} />);
    const row = screen.getByText("a.md · 문서 AI").closest("li")!;
    expect(row.textContent).toContain("지운 문서의 문서 AI");
    expect(row.querySelector("button.button")).toBeNull();
  });
});
