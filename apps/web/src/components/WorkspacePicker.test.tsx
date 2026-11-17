import { describe, expect, it } from "vitest";
import type { Work, Workspace } from "@workbench/contracts";
import { workspaceName } from "./WorkspacePicker.tsx";

// Re-review 1, next round 6: the conversation head showed a "기본 작업공간" chip — a developer's word that
// says nothing. The project's own folder is named for what it is; other folders keep their own names.
describe("the folder chip in a conversation's head", () => {
  const work = { id: "w", cwd: "/home/t/수업" } as Work;
  const ws = (extra: Partial<Workspace>) => ({ id: "x", workId: "w", label: "기본 작업공간", kind: "folder", cwd: "/home/t/수업", worktree: null, archivedAt: null, ...extra }) as unknown as Workspace;
  it("names the project's own folder 프로젝트 폴더", () => {
    expect(workspaceName(ws({}), work)).toBe("프로젝트 폴더");
  });
  it("keeps a linked folder's or a branch's own name", () => {
    expect(workspaceName(ws({ label: "자료", cwd: "/home/t/자료" }), work)).toBe("자료");
    expect(workspaceName(ws({ label: "feat/x", kind: "worktree", cwd: "/home/t/수업-x" }), work)).toBe("feat/x");
  });
  it("never says 작업 폴더", () => {
    expect(workspaceName(ws({ label: "기본 작업공간", cwd: "/elsewhere" }), work)).not.toContain("작업 폴더");
  });
});
