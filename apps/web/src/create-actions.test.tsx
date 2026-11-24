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
  expect(commands.find(action => action.kind === "folder")?.label).toBe("목록에 새 폴더…");
  const created = { id: "file", workId: "project", workspaceId: "branch" } as Artifact;
  const createOfficeDocument = vi.fn(async () => created), createDesign = vi.fn(async () => created), onOpen = vi.fn();
  const api = { createOfficeDocument, createDesign } as unknown as Api;
  for (const command of commands) {
    if (command.kind !== "document") continue;
    const view = render(<NewDocumentDialog api={api} state={{ ...initialState, works: { project: work }, workspaces }} request={{ ...command.target, format: command.format }} onOpen={onOpen} onClose={() => {}} />);
    expect(screen.getByText("저장할 폴더: 원고")).toBeTruthy();
    expect(screen.getByText("/research-branch")).toBeTruthy();
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

it("speaks the owner's words when a person starts something (I5): 대화, 문서, 폴더, never 세션 or 작업공간", () => {
  const labels = createActions({ workId: "project", workspaceId: "main", folderId: null }).map(action => action.label);
  expect(labels).toEqual(expect.arrayContaining(["Claude와 새 대화", "Codex와 새 대화", "목록에 새 폴더…", "프로젝트 폴더 안에 새 폴더…", "새 디자인"]));
  expect(createActions({ folderId: null }).map(action => action.label)).toContain("새 대화");
  expect(labels.join("\n")).not.toMatch(/세션|작업공간|doory|정리 폴더/);
});

it("on a phone joined to the PC: no 새 웹 탭 (the PC's browser, not the phone's) — every other way to make something stays", () => {
  const target = { workId: "project", workspaceId: "main", folderId: null };
  const pc = createActions(target).map((action) => action.kind);
  const phone = createActions(target, { remote: true }).map((action) => action.kind);
  expect(pc).toContain("browser");
  expect(phone).not.toContain("browser");
  expect(phone).toEqual(pc.filter((kind) => kind !== "browser"));
});
