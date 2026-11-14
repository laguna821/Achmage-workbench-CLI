// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, TranscriptItem, Work } from "@workbench/contracts";
import { initialState, type State } from "../state.ts";
import type { Api } from "../api.ts";
import { DocContext, type DocActions } from "./DocCards.tsx";
import { LinkContext, type LinkApi } from "../links.ts";
import { AppearanceContext, NEUTRAL_LOOK, type AppearanceApi } from "../appearance.ts";
import { WorkView, type WorkActions } from "./WorkView.tsx";
import { writeDraft } from "../draft.ts";

// The vault's context is not part of this question.
vi.mock("./pkm/PkmContext.tsx", async (original) => ({ ...(await original<typeof import("./pkm/PkmContext.tsx")>()), usePkm: () => ({ state: { sessions: {}, transcripts: {} }, pkmState: null, tree: null, open: null, openMenu: () => {}, showSession: () => {}, showWork: () => {}, openArtifact: () => {} }) }));

// An archived conversation shown on purpose (from 보관함 or the right sidebar's 연결) is read-only.

const work = { id: "w", title: "학과 회의록 정리", folderId: null, cwd: "/works/meeting", defaultWorkspaceId: null, activeSessionId: "live", archivedAt: null } as unknown as Work;
const base = { workId: "w", provider: "codex", status: "idle", model: null, effort: null, context: null, worktree: null, lastError: null, engineModel: null, engineEffort: null, createdAt: 1, updatedAt: 1, sort: 0 };
const live = { ...base, id: "live", purpose: "회의록", archivedAt: null, queued: [], context: { used: 50_000, window: 200_000 }, nativeSessionId: "n2" } as unknown as Session;
const memo = { ...base, id: "memo", purpose: "지난 회의 메모", archivedAt: 9, context: { used: 50_000, window: 200_000 }, nativeSessionId: "n1", queued: [{ id: "q1", text: "다음 회의 안건도 정리해 줘", refs: [], create: null, at: 2, held: true }] } as unknown as Session;
const docAi = { ...base, id: "docAi", purpose: "강의안 다듬기", archivedAt: 9, queued: [], documentAgent: { artifactId: "lecture", parentSessionId: "live" } } as unknown as Session;
const asks: TranscriptItem[] = [
  { kind: "user", id: "u1", text: "폴더를 확인해 줘", at: 1 },
  { kind: "approval", id: "ap", title: "ls -la", detail: null, reason: null, decision: null, at: 2 },
];
const state: State = {
  ...initialState,
  works: { w: work },
  sessions: { live, memo, docAi },
  transcripts: { memo: { items: asks } as unknown as State["transcripts"][string], docAi: { items: asks } as unknown as State["transcripts"][string], live: { items: [] } as unknown as State["transcripts"][string] },
};
const api = new Proxy({}, { get: (_, key) => vi.fn(async () => (key === "agentProfiles" ? { profiles: [] } : {})) }) as unknown as Api;
const restore = vi.fn(), openArchive = vi.fn();
const actions = new Proxy({}, { get: (_, key) => key === "queued" ? { send: vi.fn(), cancel: vi.fn(), edit: vi.fn() } : key === "restore" ? restore : key === "openArchive" ? openArchive : vi.fn() }) as unknown as WorkActions;
const docs = { state, actions: { openArtifact: vi.fn(), openSession: vi.fn() } as unknown as DocActions };

const view = (shown: string, now: State = state) => render(
  <AppearanceContext.Provider value={{ appTheme: "light", lookOf: () => NEUTRAL_LOOK.light, themeOf: () => "light", openMenu: () => {} } as unknown as AppearanceApi}>
  <LinkContext.Provider value={new Proxy({ state, dialog: null, view: null }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn() }) as unknown as LinkApi}>
  <DocContext.Provider value={docs}>
    <WorkView api={api} onToast={() => {}} state={now} work={{ ...work, activeSessionId: shown }} actions={actions} engine="codex" setEngine={() => {}} pickFile={null} prefs={{}} />
  </DocContext.Provider>
  </LinkContext.Provider>
  </AppearanceContext.Provider>,
);

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("CSS", { escape: (text: string) => text });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); restore.mockClear(); openArchive.mockClear(); });
/** The one banner that stands where the input was. */
const banner = () => document.querySelector<HTMLElement>(".composer-area .note-banner");

describe("an archived conversation, shown", () => {
  it("offers no 압축, nor any other setting of a request it cannot send", () => {
    view("memo");
    expect(document.querySelector(".context-gauge")).toBeNull();
    expect(screen.queryByRole("button", { name: "지금 압축" })).toBeNull();
    for (const name of [/첨부/, /음성/, /도구/, /모델/]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("has no input, so no draft of another conversation shows", () => {
    writeDraft("work:w:live", "다른 대화의 초안");
    view("memo");
    expect(document.querySelector(".composer")).toBeNull();
    expect(document.body.textContent).not.toContain("다른 대화의 초안");
    writeDraft("work:w:live", "");
  });

  it("turns read-only at once when it is archived while shown", () => {
    const shown = view("live");
    const archived: State = { ...state, sessions: { ...state.sessions, live: { ...live, archivedAt: 20 } } };
    shown.rerender(
      <AppearanceContext.Provider value={{ appTheme: "light", lookOf: () => NEUTRAL_LOOK.light, themeOf: () => "light", openMenu: () => {} } as unknown as AppearanceApi}>
      <LinkContext.Provider value={new Proxy({ state, dialog: null, view: null }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn() }) as unknown as LinkApi}>
      <DocContext.Provider value={docs}>
        <WorkView api={api} onToast={() => {}} state={archived} work={{ ...work, activeSessionId: "live" }} actions={actions} engine="codex" setEngine={() => {}} pickFile={null} prefs={{}} />
      </DocContext.Provider>
      </LinkContext.Provider>
      </AppearanceContext.Provider>,
    );
    expect(banner()?.textContent).toContain("보관한 대화입니다");
    expect(document.querySelector(".composer")).toBeNull();
  });

  it("is read-only: one banner in the input's place says why and offers 되돌리기; nothing waiting can be sent, no approval answered", () => {
    view("memo");
    // No composer at all — not a disabled one that still looks like a place to type.
    expect(document.querySelector(".composer")).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.querySelectorAll(".note-banner")).toHaveLength(1);
    expect(banner()?.getAttribute("role")).toBe("status");
    expect(banner()?.textContent).toContain("보관한 대화입니다");
    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    expect(restore).toHaveBeenCalledWith({ kind: "session", id: "memo" });
    expect(screen.getByText("다음 회의 안건도 정리해 줘")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /지금 보내기/ })).toBeNull();
    expect(screen.getByText("ls -la")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /허용/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /거절/ })).toBeNull();
  });

  it("shows an archived document AI as the conversation it names", () => {
    view("docAi");
    expect(document.querySelector(".note-title")?.textContent).toBe("강의안 다듬기");
  });

  it("keeps a live conversation sendable, with no banner", () => {
    view("live");
    const inputs = [...document.querySelectorAll<HTMLTextAreaElement>(".composer textarea")];
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect(input.disabled).toBe(false);
    expect(document.querySelector(".note-banner")).toBeNull();
  });

  it("an AI whose document was removed: the same banner, its way out is 보관함에서 보기", () => {
    const removed = { ...state, removedArtifacts: { lecture: { id: "lecture", name: "강의안.md", removed: { kind: "unlisted" } } } } as unknown as State;
    view("docAi", removed);
    expect(document.querySelector(".composer")).toBeNull();
    expect(document.querySelectorAll(".note-banner")).toHaveLength(1);
    expect(banner()?.textContent).toMatch(/목록에서 뺀 문서 「강의안\.md」/);
    expect(screen.queryByRole("button", { name: "되돌리기" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "보관함에서 보기" }));
    expect(openArchive).toHaveBeenCalledTimes(1);
  });

  it("says the text typed so far is kept and comes back with 되돌리기 — only when there is such text", () => {
    writeDraft("work:w:live", "다음 주 안건도 같이 정리해 줘");
    const shown = view("live");
    expect(document.querySelector<HTMLTextAreaElement>(".composer textarea")?.value).toBe("다음 주 안건도 같이 정리해 줘");
    const archived: State = { ...state, sessions: { ...state.sessions, live: { ...live, archivedAt: 20 } } };
    shown.rerender(
      <AppearanceContext.Provider value={{ appTheme: "light", lookOf: () => NEUTRAL_LOOK.light, themeOf: () => "light", openMenu: () => {} } as unknown as AppearanceApi}>
      <LinkContext.Provider value={new Proxy({ state, dialog: null, view: null }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn() }) as unknown as LinkApi}>
      <DocContext.Provider value={docs}>
        <WorkView api={api} onToast={() => {}} state={archived} work={{ ...work, activeSessionId: "live" }} actions={actions} engine="codex" setEngine={() => {}} pickFile={null} prefs={{}} />
      </DocContext.Provider>
      </LinkContext.Provider>
      </AppearanceContext.Provider>,
    );
    expect(document.querySelector(".composer")).toBeNull();
    expect(banner()?.textContent).toMatch(/쓰던 요청은 그대로 두었습니다.*되돌리면 입력창에 다시 나옵니다/);
    // The text itself is still kept for that conversation.
    expect(localStorage.getItem("workbench.draft.work:w:live")).toBe("다음 주 안건도 같이 정리해 줘");
  });

  it("says nothing about typed text when there is none", () => {
    view("memo");
    expect(banner()?.textContent).toContain("보관한 대화입니다");
    expect(banner()?.textContent).not.toContain("쓰던 요청");
  });

  it("an imported conversation: the same banner, no button — and its input stays, since a request continues it", () => {
    const imported = { ...state, sessions: { ...state.sessions, live: { ...live, importedHistory: { kind: "archive", provider: "codex", nativeSessionId: "n9", sourceUpdatedAt: 1, importedAt: 2, continuedAt: null } } } } as unknown as State;
    view("live", imported);
    const line = document.querySelector<HTMLElement>(".note-banner");
    expect(line?.textContent).toContain("가져온 과거 기록");
    expect(line?.querySelector("button")).toBeNull();
    for (const input of document.querySelectorAll<HTMLTextAreaElement>(".composer textarea")) expect(input.disabled).toBe(false);
  });
});
