// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { defaultViews, DEFAULT_STAGES, type HomeView, type ModeViews, type Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { AppearanceContext, NEUTRAL_LOOK, type AppearanceApi } from "../../appearance.ts";
import { initialState } from "../../state.ts";
import { ProjectsMode } from "./ProjectsMode.tsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const works = Object.fromEntries(["가", "나", "다"].map((title, index) => [title, { id: title, title, titleSource: "user", cwd: "/projects/" + title, cwdManaged: false, activeSessionId: null, pinned: false, tags: [], folderId: null, archivedAt: null, sort: index, createdAt: 1, updatedAt: 1 } satisfies Work]));
async function setup(layout: HomeView["layout"] = "table") {
  const updateWork = vi.fn(async (id: string, _patch: unknown) => works[id]!);
  const api = { updateWork, projects: async () => [], projectStages: async () => DEFAULT_STAGES, propertyTemplate: async () => [] } as unknown as Api;
  const openProject = vi.fn();
  function Harness() {
    const [views, onViews] = useState<ModeViews>({ current: "test", views: [{ ...defaultViews("projects")[1]!, id: "test", layout, fields: [], group: layout === "board" ? { key: "stage" } : null, sort: { key: "title", dir: "asc" } }] });
    return <AppearanceContext.Provider value={{ appTheme: "light", lookOf: () => NEUTRAL_LOOK.light } as unknown as AppearanceApi}>
      <ProjectsMode api={api} state={{ ...initialState, works }} views={views} onViews={onViews} openProject={openProject} open={{ session: vi.fn(), doc: vi.fn() }} />
    </AppearanceContext.Provider>;
  }
  render(<Harness />); await act(async () => {});
  return { updateWork, openProject };
}
it("keeps selection through filtering, explicitly archives the chosen set and retains failures", async () => {
  const f = await setup();
  fireEvent.click(screen.getByRole("checkbox", { name: "가 선택" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "다 선택" }), { shiftKey: true });
  expect((screen.getByRole("checkbox", { name: "나 선택" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "거르기" }));
  fireEvent.change(screen.getByRole("textbox", { name: "거르기" }), { target: { value: "가" } });
  expect(screen.getByText(/3개 선택 · 이 보기 밖 2개 포함/)).toBeTruthy();
  expect(f.updateWork).not.toHaveBeenCalled(); expect(f.openProject).not.toHaveBeenCalled();
  f.updateWork.mockImplementation(async id => { if (id === "나") throw new Error("다른 창에서 변경했습니다."); return works[id]!; });
  fireEvent.click(screen.getByRole("button", { name: "선택 항목 보관…" }));
  expect(f.updateWork).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "3개 보관" })));
  expect(f.updateWork.mock.calls).toEqual([["가", { archived: true }], ["나", { archived: true }], ["다", { archived: true }]]);
  expect(screen.getByRole("status").textContent).toContain("2개 프로젝트를 보관했습니다. 1개 실패");
  expect(screen.getByText(/1개 선택 · 이 보기 밖 1개 포함/)).toBeTruthy();
});
it.each(["cards", "list", "board"] as const)("%s exposes real selection without opening or moving the project", async layout => {
  const f = await setup(layout);
  fireEvent.click(screen.getByRole("checkbox", { name: "가 선택" }));
  expect((screen.getByRole("checkbox", { name: "가 선택" }) as HTMLInputElement).checked).toBe(true);
  expect(f.openProject).not.toHaveBeenCalled(); expect(f.updateWork).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "현재 결과 모두 선택" }));
  expect(screen.getByText("3개 선택")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "선택 해제" }));
  expect(screen.getByText("0개 선택")).toBeTruthy();
});
