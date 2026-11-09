// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TerminalSession, Workspace, WorkspaceService, WorkspaceServiceOwner, WorkspaceServiceStart } from "@workbench/contracts";
import { ApiRequestError, type Api } from "../api.ts";
import { WorkspaceServices } from "./WorkspaceServices.tsx";

const workspace: Workspace = { id: "branch", workId: "work", hostId: "host-a", label: "원고", cwd: "/fixture/branch", kind: "folder", managed: false, worktree: null, archivedAt: null, removedAt: null, createdAt: 1, updatedAt: 1 };
const command = "printf '안녕'\nnpm run dev -- --port 4321";
const row = (request: WorkspaceServiceStart): WorkspaceService => ({ id: request.requestId, workspaceId: workspace.id, workId: workspace.workId, hostId: workspace.hostId, cwd: workspace.cwd, label: request.label, command: request.command, port: request.port ?? null, url: "https://ignored.example", terminalId: "pty-owned", ownerId: "owner-exact", startedAt: 1000, status: "running", pid: 412, exitCode: null, error: null });
beforeEach(() => { vi.useFakeTimers(); sessionStorage.clear(); HTMLDialogElement.prototype.showModal = function () { this.open = true; }; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); sessionStorage.clear(); });
function fixture(initial: WorkspaceService[] = []) {
  let rows = initial;
  const workspaceServices = vi.fn(async () => ({ available: true, services: [...rows] }));
  const startWorkspaceService = vi.fn(async (_workspace: string, request: WorkspaceServiceStart): Promise<WorkspaceService> => { const entry = row(request); rows = [entry, ...rows]; return entry; });
  const stopWorkspaceService = vi.fn(async (id: string, _owner: WorkspaceServiceOwner): Promise<WorkspaceService> => { const entry = { ...rows.find(value => value.id === id)!, status: "exited" as const, exitCode: 0, pid: null }; rows = rows.map(value => value.id === id ? entry : value); return entry; });
  const deleteWorkspaceService = vi.fn(async (id: string) => { rows = rows.filter(entry => entry.id !== id); return { ok: true as const }; });
  const terminal = { id: "pty-owned", workspaceId: workspace.id, workId: workspace.workId, createdAt: 1000, label: "출력" } as TerminalSession;
  const terminalOutput = vi.fn(async () => ({ terminal })), onOpen = vi.fn(), onClose = vi.fn(), openExternal = vi.fn(async (_url: string) => {});
  const api = { workspaceServices, startWorkspaceService, stopWorkspaceService, deleteWorkspaceService, terminalOutput } as unknown as Api;
  return { workspaceServices, startWorkspaceService, stopWorkspaceService, deleteWorkspaceService, terminalOutput, onOpen, onClose, openExternal, terminal, setRows: (next: WorkspaceService[]) => { rows = next; }, mount: () => render(<WorkspaceServices api={api} workspace={workspace} onOpen={onOpen} onClose={onClose} openExternal={openExternal} />) };
}
function fill() {
  fireEvent.change(screen.getByRole("textbox", { name: "실행 이름" }), { target: { value: "미리보기" } });
  fireEvent.change(screen.getByRole("textbox", { name: "실행 명령" }), { target: { value: command } });
  fireEvent.change(screen.getByRole("textbox", { name: "포트 · 선택" }), { target: { value: "4321" } });
}

it("starts the exact command once, keeps the draft through polling, and uses the owned stop/output identity", async () => {
  const f = fixture(); await act(async () => { f.mount(); }); fill();
  let finish!: (entry: WorkspaceService) => void;
  f.startWorkspaceService.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "명령 실행" }));
  fireEvent.submit(screen.getByRole("textbox", { name: "실행 명령" }).closest("form")!);
  expect(f.startWorkspaceService).toHaveBeenCalledOnce();
  const request = f.startWorkspaceService.mock.calls[0]![1], entry = row(request);
  expect(f.startWorkspaceService).toHaveBeenCalledWith("branch", { requestId: expect.any(String), label: "미리보기", command, port: 4321 });
  f.setRows([entry]); await act(async () => finish(entry));
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(f.workspaceServices).toHaveBeenCalledTimes(2);
  expect((screen.getByRole("textbox", { name: "실행 명령" }) as HTMLTextAreaElement).value).toBe(command);
  expect(screen.getAllByText("/fixture/branch").length).toBeGreaterThan(0);
  await act(async () => fireEvent.click(screen.getByRole("link", { name: "http://127.0.0.1:4321 열기" })));
  expect(f.openExternal).toHaveBeenCalledWith("http://127.0.0.1:4321");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "실행 종료" })));
  expect(f.stopWorkspaceService).toHaveBeenCalledWith(request.requestId, { ownerId: "owner-exact", terminalId: "pty-owned", startedAt: 1000 });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "출력·터미널 열기" })));
  expect(f.terminalOutput).toHaveBeenCalledWith("pty-owned"); expect(f.onOpen).toHaveBeenCalledWith(f.terminal); expect(f.onClose).toHaveBeenCalledOnce();
});

it("reconciles a lost response from the service list without issuing another command or hiding the error on poll", async () => {
  const f = fixture(); await act(async () => { f.mount(); }); fill();
  f.startWorkspaceService.mockImplementationOnce(async (_id, request) => { f.setRows([row(request)]); throw new TypeError("응답 연결이 끊겼습니다."); });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "명령 실행" })));
  expect(f.workspaceServices).toHaveBeenCalledTimes(2); expect(f.startWorkspaceService).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "같은 요청 다시 보내기" })).toBeNull();
  expect(screen.getByText("미리보기 실행 요청을 확인했습니다.")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByRole("alert").textContent).toBe("응답 연결이 끊겼습니다."); expect(f.startWorkspaceService).toHaveBeenCalledOnce();
});

it("persists an unknown request across reopening and observes before resending its original request id", async () => {
  const f = fixture(); let first!: ReturnType<typeof render>;
  await act(async () => { first = f.mount(); }); fill();
  f.startWorkspaceService.mockRejectedValueOnce(new TypeError("응답 유실"));
  f.workspaceServices.mockRejectedValueOnce(new TypeError("호스트 연결 없음"));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "명령 실행" })));
  const original = f.startWorkspaceService.mock.calls[0]![1];
  expect((screen.getByRole("textbox", { name: "실행 명령" }) as HTMLTextAreaElement).disabled).toBe(true);
  first.unmount(); await act(async () => { f.mount(); });
  expect((screen.getByRole("textbox", { name: "실행 명령" }) as HTMLTextAreaElement).value).toBe(command);
  expect(f.startWorkspaceService).toHaveBeenCalledOnce();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "같은 요청 다시 보내기" })));
  expect(f.startWorkspaceService).toHaveBeenCalledTimes(2); expect(f.startWorkspaceService.mock.calls[1]).toEqual(["branch", original]);
  expect(f.workspaceServices.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.startWorkspaceService.mock.invocationCallOrder.at(-1)!);
  expect(screen.queryByRole("button", { name: "같은 요청 다시 보내기" })).toBeNull();
});

it("keeps a rejected port editable and removes only an inactive service record after confirmation", async () => {
  const previous = { ...row({ requestId: "previous-request", label: "이전 실행", command: "printf old" }), status: "exited" as const, exitCode: 0 };
  const f = fixture([previous]); await act(async () => { f.mount(); }); fill();
  f.startWorkspaceService.mockRejectedValueOnce(new ApiRequestError(409, { code: "service_port_busy", message: "포트 4321을 사용할 수 없습니다." }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "명령 실행" })));
  expect(screen.getByRole("alert").textContent).toBe("포트 4321을 사용할 수 없습니다.");
  expect((screen.getByRole("textbox", { name: "포트 · 선택" }) as HTMLInputElement).disabled).toBe(false);
  const history = within(screen.getByRole("article", { name: "이전 실행 실행 기록" }));
  fireEvent.click(history.getByRole("button", { name: "기록 지우기…" })); expect(f.deleteWorkspaceService).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(history.getByRole("button", { name: "기록만 지우기" })));
  expect(f.deleteWorkspaceService).toHaveBeenCalledWith("previous-request"); expect(f.stopWorkspaceService).not.toHaveBeenCalled(); expect(f.terminalOutput).not.toHaveBeenCalled();
  expect(screen.queryByRole("article", { name: "이전 실행 실행 기록" })).toBeNull();
});
