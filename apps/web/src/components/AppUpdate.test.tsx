// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AppUpdateStatus } from "@workbench/contracts";
import { AppUpdateRows, updateMarked } from "./AppUpdate.tsx";
import { SettingsSheet } from "./SettingsSheet.tsx";

// 설정 › 정보 › 업데이트: what a person sees in each state, and the key that names an action only.
afterEach(cleanup);

const base: AppUpdateStatus = { state: "idle", installed: "0.5.2", kind: "user-folder", installable: true, available: null, progress: null, blockers: [], saved: null, message: null, autoCheck: true, lastCheckedAt: null, lastResult: null };
const next = { version: "0.5.3", published: "2026-11-20", notes: "", releaseUrl: "https://github.com/laguna821/Achmage-workbench-CLI/releases/tag/v0.5.3" };
const view = (patch: Partial<AppUpdateStatus>, extra: { onQuit?(): void; onOpenUrl?(url: string): void } = {}) => {
  const act = vi.fn();
  render(<div className="settings-rows"><AppUpdateRows status={{ ...base, ...patch }} act={act} onOpenUrl={extra.onOpenUrl ?? (() => undefined)} onQuit={extra.onQuit} /></div>);
  return act;
};

it("shows the version and checks on one key", () => {
  const act = view({});
  expect(screen.getByText("버전 0.5.2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "업데이트 확인" }));
  expect(act).toHaveBeenCalledWith("check");
});
it("최신 / a newer version with its release page / one key to install", () => {
  view({ state: "latest" });
  expect(screen.getByText("최신 버전입니다")).toBeTruthy();
  cleanup();
  const opened: string[] = [];
  const act = view({ state: "available", available: next }, { onOpenUrl: (url) => opened.push(url) });
  expect(screen.getByText("0.5.3이 나왔습니다")).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "바뀐 점 보기" }));
  expect(opened).toEqual([next.releaseUrl]);
  fireEvent.click(screen.getByRole("button", { name: "업데이트" }));
  expect(act).toHaveBeenCalledWith("install");
});
it("progress in plain words, then the closing window", () => {
  view({ state: "downloading", available: next, progress: 62 });
  expect(screen.getByText("내려받는 중 62%")).toBeTruthy();
  cleanup();
  const quit = vi.fn();
  view({ state: "installing", available: next }, { onQuit: quit });
  expect(screen.getByText("앱이 잠시 닫혔다 다시 열립니다. 대화와 문서는 그대로 남습니다.")).toBeTruthy();
  expect(quit).toHaveBeenCalledTimes(1);
});
it("running or unsaved work: its own labels, 작업이 끝나면 업데이트 and 취소", () => {
  const act = view({ state: "blocked", available: next, blockers: [{ kind: "task", id: "r", label: "보고서 초안 대화" }, { kind: "office", id: "v", label: "저장하지 않은 문서 회의록" }] });
  expect(screen.getByText("보고서 초안 대화")).toBeTruthy();
  expect(screen.getByText("저장하지 않은 문서 회의록")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "작업이 끝나면 업데이트" }));
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(act.mock.calls).toEqual([["wait"], ["cancel"]]);
});
it("a failure is one sentence with what to do; the line after the restart is shown once", () => {
  view({ state: "failed", available: next, message: "내려받은 파일이 게시된 것과 다릅니다. 설치하지 않았습니다." });
  expect(screen.getByText("내려받은 파일이 게시된 것과 다릅니다. 설치하지 않았습니다.")).toBeTruthy();
  cleanup();
  view({ state: "idle", installed: "0.5.3", lastResult: { ok: true, message: "0.5.3으로 업데이트했습니다.", at: 1 } });
  expect(screen.getByText("0.5.3으로 업데이트했습니다.").closest(".settings-row-hint")).toBeTruthy();
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["업데이트 확인"]);
});
it("the automatic check is a switch; 설정's mark only when a newer version is published", () => {
  const act = view({});
  fireEvent.click(screen.getByRole("switch", { name: "새 버전 자동으로 확인" }));
  expect(act).toHaveBeenCalledWith("auto-off");
  expect(updateMarked({ ...base, state: "available", available: next })).toBe(true);
  expect(updateMarked({ ...base, state: "latest" })).toBe(false);
  expect(updateMarked(null)).toBe(false);
  cleanup();
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  render(<SettingsSheet section="general" onSection={() => undefined} onClose={() => undefined} marks={{ about: "새 버전이 나왔습니다" }}><p>x</p></SettingsSheet>);
  expect(screen.getByRole("img", { name: "새 버전이 나왔습니다" }).closest("button")?.dataset.section).toBe("about");
});
