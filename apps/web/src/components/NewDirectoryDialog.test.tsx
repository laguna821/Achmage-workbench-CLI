// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Workspace } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { createActions } from "../create-actions.ts";
import { NewDirectoryDialog } from "./NewDirectoryDialog.tsx";

const workspace = { id: "branch", workId: "project", hostId: "host", label: "원고", cwd: "/project-branch" } as Workspace;
beforeEach(() => { HTMLDialogElement.prototype.showModal = function () { this.open = true; }; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  const createWorkspaceDirectory = vi.fn(async (_workspace: string, path: string) => ({ workspaceId: "branch", path: "/project-branch/" + path, relativePath: path }));
  const onCreated = vi.fn(), onClose = vi.fn();
  render(<NewDirectoryDialog api={{ createWorkspaceDirectory } as unknown as Api} workspace={workspace} onCreated={onCreated} onClose={onClose} />);
  return { createWorkspaceDirectory, onCreated, onClose, path: screen.getByRole("textbox", { name: /폴더 상대 경로/ }), submit: screen.getByRole("button", { name: "폴더 만들기" }) };
}
it("offers actual workspace directories separately and creates in the selected branch", async () => {
  const actions = createActions({ workId: "project", workspaceId: "branch", folderId: null });
  expect(actions.find(action => action.kind === "folder")?.label).toBe("새 정리 폴더…");
  expect(actions.find(action => action.kind === "directory")?.target.workspaceId).toBe("branch");
  expect(createActions({ workId: null, folderId: null }).some(action => action.kind === "directory")).toBe(false);
  const f = setup();
  fireEvent.change(f.path, { target: { value: "강의/자료" } });
  await act(async () => fireEvent.click(f.submit));
  expect(f.createWorkspaceDirectory).toHaveBeenCalledWith("branch", "강의/자료");
  expect(f.onCreated).toHaveBeenCalledWith({ workspaceId: "branch", path: "/project-branch/강의/자료", relativePath: "강의/자료" });
  expect(f.onClose).toHaveBeenCalledOnce();
});
it("keeps the requested path and server conflict visible, without closing or creating elsewhere", async () => {
  const f = setup(); f.createWorkspaceDirectory.mockRejectedValue(new Error("같은 폴더가 이미 있습니다."));
  fireEvent.change(f.path, { target: { value: "자료" } });
  await act(async () => fireEvent.click(f.submit));
  expect(screen.getByRole("alert").textContent).toBe("같은 폴더가 이미 있습니다."); expect((f.path as HTMLInputElement).value).toBe("자료");
  expect(f.onCreated).not.toHaveBeenCalled(); expect(f.onClose).not.toHaveBeenCalled();
});
it("rejects traversal and absolute paths before contacting the host and prevents duplicate submit", async () => {
  const f = setup();
  for (const path of ["../다른곳", "/tmp/자료", "C:\\자료"]) {
    fireEvent.change(f.path, { target: { value: path } }); await act(async () => fireEvent.click(f.submit));
  }
  expect(f.createWorkspaceDirectory).not.toHaveBeenCalled();
  let finish!: (value: { workspaceId: string; path: string; relativePath: string }) => void;
  f.createWorkspaceDirectory.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.change(f.path, { target: { value: "자료" } });
  fireEvent.click(f.submit); fireEvent.submit(f.submit.closest("form")!);
  expect(f.createWorkspaceDirectory).toHaveBeenCalledOnce();
  await act(async () => finish({ workspaceId: "branch", path: "/project-branch/자료", relativePath: "자료" }));
});
