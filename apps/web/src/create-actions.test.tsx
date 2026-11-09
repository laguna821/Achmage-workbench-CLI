// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Artifact, Work, Workspace } from "@workbench/contracts";
import type { Api } from "./api.ts";
import { createActions, creationWorkspace } from "./create-actions.ts";
import { NewDocumentDialog } from "./components/NewDocumentButton.tsx";
import { initialState } from "./state.ts";

beforeEach(() => { HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const work = { id: "project", title: "연구", defaultWorkspaceId: "main", cwd: "/research" } as Work;
const workspace = (id: string, workId: string, cwd: string, label: string): Workspace => ({
  id, workId, cwd, label, hostId: "host", kind: "folder", managed: false, worktree: null,
  archivedAt: null, removedAt: null, createdAt: 1, updatedAt: 1,
});
const workspaces = {
  main: workspace("main", "project", "/research", "기본"),
  branch: workspace("branch", "project", "/research-branch", "원고"),
  foreign: workspace("foreign", "other", "/other", "다른 프로젝트"),
};

it("shares all manual formats and preserves the chosen project/workspace in the actual creation dialog", async () => {
  const target = { workId: "project", workspaceId: "branch", folderId: "lectures" };
  const commands = createActions(target);
  expect(commands.filter(action => action.kind === "document").map(action => action.format)).toEqual([
    "docx", "pptx", "xlsx", "hwpx", "pdf", "markdown", "html", "xmind", "design",
  ]);
  expect(commands.filter(action => action.kind === "session").map(action => action.target)).toEqual([target, target]);
  expect(commands.find(action => action.kind === "folder")?.label).toBe("새 정리 폴더…");
  const created = { id: "file", workId: "project", workspaceId: "branch" } as Artifact;
  const createOfficeDocument = vi.fn(async () => created), createDesign = vi.fn(async () => created), onOpen = vi.fn();
  const api = { createOfficeDocument, createDesign } as unknown as Api;
  for (const command of commands) {
    if (command.kind !== "document") continue;
    const view = render(<NewDocumentDialog api={api} state={{ ...initialState, works: { project: work }, workspaces }} request={{ ...command.target, format: command.format }} onOpen={onOpen} onClose={() => {}} />);
    expect(screen.getByText("원고 · /research-branch")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "만들고 열기" })); });
    if (command.format === "design") expect(createDesign).toHaveBeenLastCalledWith("project", expect.any(String), "square", "branch");
    else expect(createOfficeDocument).toHaveBeenLastCalledWith("project", expect.objectContaining({ format: command.format, workspaceId: "branch" }));
    view.unmount();
  }
  expect(onOpen).toHaveBeenCalledTimes(9);
});

it("resolves a workspace only within the selected project and falls back to its default", () => {
  expect(creationWorkspace(work, ["branch", "foreign"], workspaces)).toBe("branch");
  expect(creationWorkspace(work, ["foreign"], workspaces)).toBe("main");
  expect(creationWorkspace(work, ["branch"], { ...workspaces, branch: { ...workspaces.branch!, archivedAt: 1 } })).toBe("main");
});
