// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, Work } from "@workbench/contracts";
import { initialState, type State } from "../state.ts";
import type { Api } from "../api.ts";
import { DocContext, type DocActions } from "./DocCards.tsx";
import { LinkContext, type LinkApi } from "../links.ts";
import { AppearanceContext, NEUTRAL_LOOK, type AppearanceApi } from "../appearance.ts";
import { WorkView, type WorkActions } from "./WorkView.tsx";

vi.mock("./pkm/PkmContext.tsx", async (original) => ({ ...(await original<typeof import("./pkm/PkmContext.tsx")>()), usePkm: () => ({ state: { sessions: {}, transcripts: {} }, pkmState: null, tree: null, open: null, openMenu: () => {}, showSession: () => {}, showWork: () => {}, openArtifact: () => {} }) }));

// Skin 2 (C9): the project's conversations are in the list's level 2 and in the top tabs; the
// conversation's own third tab row is folded into its head as one quiet menu, "이 프로젝트의 대화 N".

const work = { id: "w", title: "AI 글쓰기 수업", folderId: null, cwd: "/works/w", defaultWorkspaceId: null, activeSessionId: "a", archivedAt: null } as unknown as Work;
const base = { workId: "w", status: "idle", model: null, effort: null, context: null, worktree: null, lastError: null, engineModel: null, engineEffort: null, createdAt: 1, updatedAt: 1, sort: 0, archivedAt: null, queued: [] };
const a = { ...base, id: "a", provider: "codex", purpose: "강의안 다듬기", previewAt: 5, seenAt: 6 } as unknown as Session;
const b = { ...base, id: "b", provider: "claude", purpose: "사례 발굴", status: "awaitingApproval" } as unknown as Session;
const c = { ...base, id: "c", provider: "claude", purpose: "평가 기준 검토", previewAt: 9, seenAt: 1 } as unknown as Session;
const state: State = { ...initialState, works: { w: work }, sessions: { a, b, c }, transcripts: { a: { items: [] } as unknown as State["transcripts"][string] } };
const api = new Proxy({}, { get: (_, key) => vi.fn(async () => (key === "agentProfiles" ? { profiles: [] } : {})) }) as unknown as Api;
const selectSession = vi.fn();
const actions = new Proxy({}, { get: (_, key) => key === "queued" ? { send: vi.fn(), cancel: vi.fn(), edit: vi.fn() } : key === "selectSession" ? selectSession : vi.fn() }) as unknown as WorkActions;
const docs = { state, actions: { openArtifact: vi.fn(), openSession: vi.fn() } as unknown as DocActions };
const openMenu = vi.fn();

const view = (modes?: { single?: boolean; groupedTabs?: boolean }) => render(
  <AppearanceContext.Provider value={{ appTheme: "light", lookOf: () => NEUTRAL_LOOK.light, themeOf: () => "light", openMenu } as unknown as AppearanceApi}>
  <LinkContext.Provider value={new Proxy({ state, dialog: null, view: null }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn() }) as unknown as LinkApi}>
  <DocContext.Provider value={docs}>
    <WorkView api={api} onToast={() => {}} state={state} work={work} actions={actions} engine="codex" setEngine={() => {}} pickFile={null} prefs={{}} modes={modes} />
  </DocContext.Provider>
  </LinkContext.Provider>
  </AppearanceContext.Provider>,
);

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("CSS", { escape: (text: string) => text });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); selectSession.mockClear(); openMenu.mockClear(); });

describe("the conversation's head carries the project's conversations", () => {
  it("draws no tab row of its own, in any layout", () => {
    for (const modes of [undefined, { single: true }, { groupedTabs: true }]) {
      view(modes);
      expect(document.querySelector(".session-tabs")).toBeNull();
      expect(document.querySelector(".session-tab")).toBeNull();
      cleanup();
    }
  });

  it("offers one quiet key naming how many there are; its menu lists them all with their state words", () => {
    view();
    const head = document.querySelector<HTMLElement>(".note-head")!;
    const key = within(head).getByRole("button", { name: /이 프로젝트의 대화 3/ });
    // The one waiting elsewhere is counted on the key.
    expect(key.querySelector(".conversations-waiting")?.textContent).toBe("1");
    fireEvent.click(key);
    const menu = screen.getByRole("menu", { name: "이 프로젝트의 대화 3" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((item) => item.querySelector(".menu-item-label, .ui-menu-label")?.textContent ?? item.textContent)).toHaveLength(3);
    expect(within(menu).getByText("확인 필요")).toBeTruthy();
    expect(within(menu).getByText("새 답")).toBeTruthy();
    // The one on screen is checked and says 완료, not 새 답 (it is being read).
    const current = items.find((item) => item.getAttribute("aria-checked") === "true")!;
    expect(current.textContent).toContain("강의안 다듬기");
    expect(current.textContent).toContain("완료");
    // Every row leads with its engine's mark; no row wears the engine's colour.
    expect(menu.querySelectorAll(".engine-mark")).toHaveLength(3);
    for (const item of items) expect((item as HTMLElement).style.getPropertyValue("--accent")).toBe("");
  });

  it("chooses a conversation from the menu (the old tab's click)", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: /이 프로젝트의 대화 3/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /사례 발굴/ }));
    expect(selectSession).toHaveBeenCalledWith(work, expect.objectContaining({ id: "b" }));
  });

  it("keeps the engine's look on a right click (the old tab's context menu)", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: /이 프로젝트의 대화 3/ }));
    fireEvent.contextMenu(screen.getByRole("menuitemradio", { name: /평가 기준 검토/ }));
    expect(openMenu).toHaveBeenCalledWith(expect.anything(), "claude");
  });

  it("shows the state word in the head: glyph and word, the live line as its tooltip", () => {
    view();
    const head = document.querySelector<HTMLElement>(".note-head")!;
    const status = head.querySelector<HTMLElement>(".note-prop-status")!;
    expect(status.querySelector(".state-word svg")).not.toBeNull();
    expect(status.textContent).toBe("완료");
  });

  it("has no menu with a single conversation", () => {
    const one: State = { ...state, sessions: { a } };
    render(
      <AppearanceContext.Provider value={{ appTheme: "light", lookOf: () => NEUTRAL_LOOK.light, themeOf: () => "light", openMenu } as unknown as AppearanceApi}>
      <LinkContext.Provider value={new Proxy({ state: one, dialog: null, view: null }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn() }) as unknown as LinkApi}>
      <DocContext.Provider value={{ ...docs, state: one }}>
        <WorkView api={api} onToast={() => {}} state={one} work={work} actions={actions} engine="codex" setEngine={() => {}} pickFile={null} prefs={{}} />
      </DocContext.Provider>
      </LinkContext.Provider>
      </AppearanceContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: /이 프로젝트의 대화/ })).toBeNull();
  });
});
