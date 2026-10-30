// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkbenchSkill, WorkbenchSkillDetail } from "@workbench/contracts";
import type { Api } from "./api.ts";
import { SkillLibraryDialog } from "./components/SkillLibraryDialog.tsx";

afterEach(cleanup);
it("lets a person return to their installed skill without toggling an already enabled checkbox off first", async () => {
  const scope = { workId: "work", sessionId: "session" };
  const installed: WorkbenchSkill = { id: "native", name: "report", title: "Installed report", description: "Reports", source: "claude", dir: "/fixture/native/report", plugin: null, template: null, state: { enabled: true, invoke: "manual" }, shadowedBy: "copy", editable: false, hasScripts: false, github: false, files: 1, bytes: 100, problem: null };
  const copy = { ...installed, id: "copy", title: "My report", source: "imported" as const, dir: "/fixture/app/report", shadowedBy: null, editable: true };
  const detail: WorkbenchSkillDetail = { skill: installed, markdown: "REPORT", body: "REPORT", sha256: "digest" };
  let selected = installed;
  const api = { userSkills: vi.fn(async () => [selected, copy]), userSkill: vi.fn(async () => ({ ...detail, skill: selected })), skillState: vi.fn(async () => { selected = { ...installed, shadowedBy: null }; return selected; }) };
  render(<SkillLibraryDialog api={api as unknown as Api} scope={scope} onClose={() => {}} />);
  fireEvent.click(await screen.findByText("Installed report"));
  fireEvent.click(await screen.findByRole("button", { name: "설치 판 선택으로 돌아가기" }));
  await waitFor(() => expect(api.skillState).toHaveBeenCalledWith("native", { enabled: true, invoke: "manual" }, scope));
  await waitFor(() => expect(screen.queryByRole("button", { name: "설치 판 선택으로 돌아가기" })).toBeNull());
  expect(screen.queryByText("현재 선택된 다른 판이 우선합니다.")).toBeNull();
});
