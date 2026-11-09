// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentProfile, AgentProfileInput, ModelOption } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { AgentProfilePicker } from "./AgentProfilePicker.tsx";

beforeEach(() => { HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const research: AgentProfile = { id: "research", name: "연구", revision: 3, updatedAt: 1, provider: null, model: "saved-research-id", effort: "high", access: "ask", instructions: "근거를 확인합니다.\n추측과 사실을 구분합니다." };
const writing: AgentProfile = { ...research, id: "writing", name: "글쓰기", provider: "claude" };
const session = { id: "conversation", provider: "codex" as const, profileId: null as string | null };
const models: ModelOption[] = [{ id: "discovered-id", label: "발견된 모델", description: null, efforts: ["low", "high"], defaultEffort: "low", isDefault: true }];
function profileApi(profiles = [research, writing]) {
  return {
    agentProfiles: vi.fn(async () => ({ profiles })),
    saveAgentProfile: vi.fn(async (input: AgentProfileInput, id?: string, revision?: number) => ({ ...input, id: id ?? "custom", revision: (revision ?? 0) + 1, updatedAt: 2 })),
    removeAgentProfile: vi.fn(async () => ({ ok: true as const })),
    updateSession: vi.fn(async () => ({})),
  };
}
const asApi = (api: ReturnType<typeof profileApi>) => api as unknown as Pick<Api, "agentProfiles" | "saveAgentProfile" | "removeAgentProfile" | "updateSession">;

it("loads host roles, filters incompatible engines and changes only the session profile", async () => {
  const api = profileApi(), onResolved = vi.fn();
  const view = render(<AgentProfilePicker api={asApi(api)} session={session} models={{ codex: models }} onResolved={onResolved} />);
  fireEvent.click(screen.getByRole("button", { name: "역할: 없음" }));
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /^연구/ }));
  expect(screen.queryByRole("menuitemcheckbox", { name: /^글쓰기/ })).toBeNull();
  await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith("conversation", { profileId: "research" }));
  view.rerender(<AgentProfilePicker api={asApi(api)} session={{ ...session, profileId: "research" }} models={{ codex: models }} onResolved={onResolved} />);
  expect(await screen.findByRole("button", { name: "역할: 연구" })).toBeTruthy();
  await waitFor(() => expect(onResolved).toHaveBeenLastCalledWith(research));
  fireEvent.click(screen.getByRole("button", { name: "역할: 연구" }));
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "역할 없음" }));
  await waitFor(() => expect(api.updateSession).toHaveBeenLastCalledWith("conversation", { profileId: null }));
});

it("creates a reusable role with discovered or direct IDs without changing the current engine", async () => {
  const api = profileApi(), onNotice = vi.fn();
  render(<AgentProfilePicker api={asApi(api)} session={session} models={{ codex: models }} onNotice={onNotice} />);
  fireEvent.click(screen.getByRole("button", { name: "역할: 없음" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "새 역할 만들기…" }));
  const dialog = screen.getByRole("dialog", { name: "새 역할 만들기" });
  fireEvent.change(screen.getByLabelText("역할 이름"), { target: { value: "검토 도우미" } });
  fireEvent.change(screen.getByLabelText("사용할 엔진"), { target: { value: "codex" } });
  fireEvent.change(screen.getByLabelText("기본 모델 ID"), { target: { value: " custom/preview-id " } });
  fireEvent.change(screen.getByLabelText("기본 추론 강도"), { target: { value: "high" } });
  fireEvent.change(screen.getByLabelText("기본 권한"), { target: { value: "ask" } });
  fireEvent.change(screen.getByLabelText("역할 지침"), { target: { value: "원문과 대조합니다.\n변경 이유를 씁니다." } });
  expect(dialog.querySelector('option[value="discovered-id"]')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "저장", exact: true })); });
  expect(api.saveAgentProfile).toHaveBeenCalledWith({ name: "검토 도우미", provider: "codex", model: "custom/preview-id", effort: "high", access: "ask", instructions: "원문과 대조합니다.\n변경 이유를 씁니다." }, undefined, undefined);
  expect(api.updateSession).not.toHaveBeenCalled();
  expect(onNotice).toHaveBeenCalledWith("‘검토 도우미’ 역할을 저장했습니다.");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("edits with the displayed revision, preserves custom IDs, then deletes without patching one session", async () => {
  const api = profileApi();
  render(<AgentProfilePicker api={asApi(api)} session={{ ...session, profileId: "research" }} models={{ codex: [] }} />);
  fireEvent.click(await screen.findByRole("button", { name: "역할: 연구" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "선택한 역할 편집…" }));
  expect((screen.getByLabelText("기본 모델 ID") as HTMLInputElement).value).toBe("saved-research-id");
  fireEvent.change(screen.getByLabelText("역할 지침"), { target: { value: "수정한 지침" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "저장", exact: true })); });
  expect(api.saveAgentProfile).toHaveBeenCalledWith(expect.objectContaining({ model: "saved-research-id", access: "ask", instructions: "수정한 지침" }), "research", 3);
  api.agentProfiles.mockResolvedValue({ profiles: [{ ...research, revision: 4, instructions: "수정한 지침" }] });
  fireEvent.click(screen.getByRole("button", { name: "역할: 연구" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "선택한 역할 편집…" }));
  fireEvent.click(screen.getByRole("button", { name: "역할 삭제…" }));
  expect(api.removeAgentProfile).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "삭제하기" })); });
  expect(api.removeAgentProfile).toHaveBeenCalledWith("research", 4);
  expect(api.updateSession).not.toHaveBeenCalled();
});

it("keeps unsaved edits on a revision error and does not submit composition input", async () => {
  const api = profileApi(); api.saveAgentProfile.mockRejectedValue(new Error("다른 창에서 역할이 변경되었습니다. 다시 열어 주세요."));
  render(<AgentProfilePicker api={asApi(api)} session={{ ...session, profileId: "research" }} models={{}} />);
  fireEvent.click(await screen.findByRole("button", { name: "역할: 연구" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "선택한 역할 편집…" }));
  const name = screen.getByLabelText("역할 이름");
  fireEvent.change(name, { target: { value: "수정 중인 이름" } });
  fireEvent.compositionStart(name); fireEvent.submit(name.closest("form")!);
  expect(api.saveAgentProfile).not.toHaveBeenCalled();
  fireEvent.compositionEnd(name);
  await act(async () => { fireEvent.submit(name.closest("form")!); });
  expect(screen.getByRole("alert").textContent).toContain("다른 창");
  expect((screen.getByLabelText("역할 이름") as HTMLInputElement).value).toBe("수정 중인 이름");
  expect(screen.getByRole("dialog", { name: "역할 편집" })).toBeTruthy();
});

it("exposes a loading error and keeps missing saved roles unresolved", async () => {
  const api = profileApi(); api.agentProfiles.mockRejectedValue(new Error("호스트 연결을 확인해 주세요."));
  const onResolved = vi.fn();
  render(<AgentProfilePicker api={asApi(api)} session={{ ...session, profileId: "missing" }} models={{}} onResolved={onResolved} />);
  fireEvent.click(screen.getByRole("button", { name: "역할: 불러오는 중" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "호스트 연결을 확인해 주세요.");
  expect(api.updateSession).not.toHaveBeenCalled();
  expect(onResolved).toHaveBeenLastCalledWith(null);
});
