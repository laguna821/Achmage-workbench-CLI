// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider, Session, SessionLink, Work } from "@workbench/contracts";
import { AppearanceContext, DEFAULT_APPEARANCE, type AppearanceApi } from "../appearance.ts";
import { LinkContext, type LinkApi } from "../links.ts";
import { initialState, type State } from "../state.ts";
import { LinkBar } from "./LinkBar.tsx";
import { LinkDialog } from "./LinkDialog.tsx";

afterEach(cleanup);

const session = (id: string, provider: Provider, extra: Partial<Session> = {}) =>
  ({ id, workId: "w", provider, purpose: id, status: "idle", archivedAt: null, updatedAt: 1, previewAt: null, ...extra }) as Session;
const work = { id: "w", title: "강의", folderId: null, archivedAt: null } as Work;
const link = (patch: Partial<SessionLink> = {}): SessionLink => ({
  id: "l1",
  participants: ["검토", "초안"],
  goal: "고칠 점 세 가지에 합의",
  maxRounds: 3,
  maxMinutes: 30,
  state: "active",
  reason: null,
  hops: 3,
  turn: 0,
  elapsedMs: 12 * 60_000,
  clockFrom: null,
  usageAllowed: false,
  startedAt: 1,
  endedAt: null,
  updatedAt: 1,
  ...patch,
});

function stateWith(sessions: Session[], links: SessionLink[] = []): State {
  return { ...initialState, ready: true, works: { w: work }, sessions: Object.fromEntries(sessions.map((entry) => [entry.id, entry])), links: Object.fromEntries(links.map((entry) => [entry.id, entry])) };
}

const appearance = {
  appearance: DEFAULT_APPEARANCE,
  appTheme: "light",
  lookOf: (provider: Provider) => DEFAULT_APPEARANCE[provider].light,
  themeOf: () => "light",
  updateLook: () => undefined,
  setMode: () => undefined,
  resetLook: () => undefined,
  openMenu: () => undefined,
  openSettings: () => undefined,
} as unknown as AppearanceApi;

const wrap = (node: ReactNode, links?: LinkApi) => (
  <AppearanceContext.Provider value={appearance}>{links ? <LinkContext.Provider value={links}>{node}</LinkContext.Provider> : node}</AppearanceContext.Provider>
);

const value = (label: string) => screen.getByRole("group", { name: label }).textContent;

describe("LinkDialog", () => {
  it("starts with the given sessions in order; presets and steppers set rounds and minutes", async () => {
    const state = stateWith([session("검토", "claude"), session("초안", "codex"), session("편집", "claude")]);
    const onStart = vi.fn(async () => true);
    render(wrap(<LinkDialog state={state} initial={["초안", "검토"]} onStart={onStart} onClose={() => undefined} />));
    expect(screen.getAllByText(/^(검토|초안)$/).length).toBeGreaterThan(0);
    const start = screen.getByRole("button", { name: "잇기 시작" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /가볍게/ }));
    expect([value("왕복"), value("시간")]).toEqual(["왕복−1왕복+", "시간−10분+"]);
    fireEvent.click(screen.getByRole("button", { name: "왕복 늘리기" }));
    fireEvent.click(screen.getByRole("button", { name: "시간 늘리기" }));
    fireEvent.click(screen.getByRole("button", { name: "시간 늘리기" }));
    expect([value("왕복"), value("시간")]).toEqual(["왕복−2왕복+", "시간−20분+"]);
    expect(screen.queryByRole("radio", { checked: true })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /편집/ }));
    fireEvent.click(screen.getByRole("button", { name: "순서 바꾸기" }));
    fireEvent.change(screen.getByPlaceholderText(/이 강의 계획의 약점/), { target: { value: "  순서를 정하기  " } });
    expect(screen.getByText(/모두 6번 주고받고, 길어도 20분이면 끝납니다/)).toBeTruthy();
    fireEvent.click(start);
    await vi.waitFor(() => expect(onStart).toHaveBeenCalledWith({ participants: ["검토", "편집", "초안"], goal: "순서를 정하기", maxRounds: 2, maxMinutes: 20 }));
  });

  it("keeps out sessions already in a live link, and waits for busy ones", () => {
    const state = stateWith([session("검토", "claude"), session("초안", "codex", { status: "running" }), session("편집", "claude"), session("다른", "codex")], [link({ participants: ["편집", "다른"] })]);
    render(wrap(<LinkDialog state={state} initial={["검토", "편집"]} onStart={async () => true} onClose={() => undefined} />));
    expect((screen.getByRole("option", { name: /편집/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("option", { name: /편집/ }).textContent).toContain("다른 잇기 중");
    fireEvent.click(screen.getByRole("option", { name: /초안/ }));
    expect(screen.getByText(/응답 중인 세션이 끝나야 시작할 수 있습니다: 초안/)).toBeTruthy();
  });
});

describe("LinkBar", () => {
  const api = (state: State) =>
    ({
      state,
      dialog: null,
      view: null,
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      extend: vi.fn(),
      openView: vi.fn(),
      openDialog: vi.fn(),
      closeDialog: vi.fn(),
      closeView: vi.fn(),
      start: vi.fn(async () => true),
      exportLink: vi.fn(),
      openSession: vi.fn(),
    }) satisfies LinkApi;

  it("shows hops, time, whose turn and the goal, with the actions of an active link", () => {
    const state = stateWith([session("검토", "claude"), session("초안", "codex", { status: "running" })], [link({ turn: 1 })]);
    const links = api(state);
    render(wrap(<LinkBar session={state.sessions["검토"]!} />, links));
    const bar = screen.getByRole("group", { name: "세션 잇기" });
    expect(bar.textContent?.replace(/\s+/g, " ")).toContain("⇄ 3/6");
    expect(bar.textContent).toContain("12분/30분");
    expect(bar.textContent).toContain("Codex · 초안 답하는 중");
    expect(bar.textContent).toContain("목표 고칠 점 세 가지에 합의");
    fireEvent.click(screen.getByRole("button", { name: "멈춤" }));
    fireEvent.click(screen.getByRole("button", { name: "+1왕복" }));
    expect(links.pause).toHaveBeenCalled();
    expect(links.extend).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "이어 가기" })).toBeNull();
  });

  it("paused: says why and offers to go on; nothing for a session outside a link", () => {
    const state = stateWith([session("검토", "claude"), session("초안", "codex"), session("혼자", "claude")], [link({ state: "paused", reason: "typed" })]);
    const links = api(state);
    const { unmount } = render(wrap(<LinkBar session={state.sessions["초안"]!} />, links));
    expect(screen.getByRole("group", { name: "세션 잇기" }).textContent).toContain("직접 입력해서 멈춤");
    fireEvent.click(screen.getByRole("button", { name: "이어 가기" }));
    expect(links.resume).toHaveBeenCalled();
    unmount();
    const { container } = render(wrap(<LinkBar session={state.sessions["혼자"]!} />, links));
    expect(container.textContent).toBe("");
  });
});
