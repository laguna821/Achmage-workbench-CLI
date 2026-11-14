// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, Proposal, Session, TranscriptItem, Work } from "@workbench/contracts";
import { initialState, type State } from "../state.ts";
import type { Api } from "../api.ts";
import { DocContext, type DocActions } from "./DocCards.tsx";
import { LinkContext, type LinkApi } from "../links.ts";
import { AppearanceContext, NEUTRAL_LOOK, type AppearanceApi } from "../appearance.ts";
import { WorkView, type WorkActions } from "./WorkView.tsx";

vi.mock("./pkm/PkmContext.tsx", async (original) => ({ ...(await original<typeof import("./pkm/PkmContext.tsx")>()), usePkm: () => ({ state: { sessions: {}, transcripts: {} }, pkmState: null, tree: null, open: null, openMenu: () => {}, showSession: () => {}, showWork: () => {}, openArtifact: () => {} }) }));

// 곁 화면, from the main conversation: what it opened comes beside it, and it reads what its
// documents' AIs are doing without being held by them.

const work = { id: "w", title: "3주차 강의 슬라이드", folderId: null, cwd: "/works/lecture", defaultWorkspaceId: null, activeSessionId: "main", archivedAt: null } as unknown as Work;
const base = { workId: "w", provider: "codex", status: "idle", model: null, effort: null, context: null, worktree: null, lastError: null, engineModel: null, engineEffort: null, archivedAt: null, queued: [], unread: false, createdAt: 1, updatedAt: 1, sort: 0 };
const main = { ...base, id: "main", purpose: "슬라이드 정리" } as unknown as Session;
const docAi = (extra: Partial<Session> = {}) => ({ ...base, id: "ai", purpose: "강의안.md · 문서 AI", documentAgent: { artifactId: "lecture", parentSessionId: "main" }, ...extra }) as unknown as Session;
const lecture = { id: "lecture", workId: "w", name: "강의안.md", path: "/works/lecture/강의안.md", format: "markdown", revision: 1, diskState: "same", readBy: {}, createdAt: 1, updatedAt: 1 } as unknown as Artifact;
const items: TranscriptItem[] = [
  { kind: "user", id: "u1", text: "슬라이드 구성을 다시 짜 줘", at: 1 },
  { kind: "artifact", id: "f1", artifactId: "lecture", revision: 1, change: "created", at: 2 },
] as unknown as TranscriptItem[];
const proposal = { id: "p", artifactId: "lecture", sessionId: "ai", status: "pending", baseRevision: 1 } as unknown as Proposal;

const api = new Proxy({}, { get: (_, key) => vi.fn(async () => (key === "agentProfiles" ? { profiles: [] } : key === "documentViews" ? { views: [] } : {})) }) as unknown as Api;
const openBeside = vi.fn(), selectSession = vi.fn(), openTab = vi.fn();
const actions = new Proxy({}, { get: (_, key) => key === "queued" ? { send: vi.fn(), cancel: vi.fn(), edit: vi.fn() } : key === "openBeside" ? openBeside : key === "selectSession" ? selectSession : vi.fn() }) as unknown as WorkActions;

function view(child: Session | null, proposals: Proposal[] = [], docModes?: { artifactId: string; name: string; onRead: () => void; onReview: (() => void) | null }) {
  const state: State = {
    ...initialState,
    works: { w: work }, artifacts: { lecture },
    sessions: { main, ...(child ? { ai: child } : {}) },
    proposals: Object.fromEntries(proposals.map((entry) => [entry.id, entry])),
    transcripts: { main: { items } as unknown as State["transcripts"][string] },
  };
  const docs = { state, actions: { openArtifact: openTab, openSession: vi.fn() } as unknown as DocActions };
  return render(
    <AppearanceContext.Provider value={{ appTheme: "light", lookOf: () => NEUTRAL_LOOK.light, themeOf: () => "light", openMenu: () => {} } as unknown as AppearanceApi}>
    <LinkContext.Provider value={new Proxy({ state, dialog: null, view: null }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn() }) as unknown as LinkApi}>
    <DocContext.Provider value={docs}>
      <WorkView api={api} onToast={() => {}} state={state} work={work} actions={actions} engine="codex" setEngine={() => {}} pickFile={null} prefs={{}} docModes={docModes} />
    </DocContext.Provider>
    </LinkContext.Provider>
    </AppearanceContext.Provider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("CSS", { escape: (text: string) => text });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); openBeside.mockClear(); selectSession.mockClear(); openTab.mockClear(); });
const lines = () => screen.queryByRole("group", { name: "이 대화의 문서·웹 AI" });

describe("a file card in the conversation", () => {
  it("opens its document beside this conversation, not in a tab of its own", () => {
    view(null);
    fireEvent.click(screen.getByRole("button", { name: /강의안\.md/ }));
    expect(openBeside).toHaveBeenCalledWith("lecture");
    expect(openTab).not.toHaveBeenCalled();
  });
});

describe("the main conversation and its document's AI", () => {
  it("says what that AI is doing in one line above its input: who, which document, its state", () => {
    view(docAi({ status: "running" }), [{ ...proposal, status: "running" } as Proposal]);
    const line = within(lines()!).getByRole("button");
    expect(line.textContent).toContain("문서 AI · 강의안.md");
    expect(line.textContent).toContain("수정안 1건 · 응답 중");
    // The line is in the conversation's input zone, directly above its composer.
    expect(line.closest(".composer-area")).toBeTruthy();
  });

  it("is not held by it: its own input stays open while that AI works or waits for an approval", () => {
    view(docAi({ status: "awaitingApproval" }));
    const input = document.querySelector<HTMLTextAreaElement>(".composer-area textarea")!;
    expect(input.disabled).toBe(false);
    expect(screen.getByRole("button", { name: "보내기" })).toBeTruthy();
    expect(lines()!.textContent).toContain("승인 필요");
  });

  it("the line opens that AI's conversation through the one opener", () => {
    const child = docAi({ status: "idle" });
    view(child, [proposal]);
    fireEvent.click(within(lines()!).getByRole("button"));
    expect(selectSession).toHaveBeenCalledWith(work, child);
  });

  it("says nothing while that AI is idle with nothing waiting", () => {
    view(docAi());
    expect(lines()).toBeNull();
  });
});

// The bar under the input (대화 · 문서 · 검토 · 나란히 · 읽기) is gone; what it did from a conversation is
// still reachable there with a pointer: 읽기 and 검토 are in the note's ⋯, named after the document.
describe("읽기 and 검토 from a conversation", () => {
  const menu = () => { fireEvent.click(screen.getAllByRole("button", { name: "노트 메뉴" })[0]!); return screen.getByRole("menu", { name: "노트 메뉴" }); };

  it("are in the note's ⋯ while a document of the project is open, and do what the bar did", () => {
    const onRead = vi.fn(), onReview = vi.fn();
    view(null, [], { artifactId: "lecture", name: "강의안.md", onRead, onReview });
    fireEvent.click(within(menu()).getByRole("menuitem", { name: /읽기.*강의안\.md/ }));
    expect(onRead).toHaveBeenCalledTimes(1);
    fireEvent.click(within(menu()).getByRole("menuitem", { name: /검토.*강의안\.md/ }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("검토 says there is nothing to review instead of disappearing", () => {
    view(null, [], { artifactId: "lecture", name: "강의안.md", onRead: vi.fn(), onReview: null });
    const item = within(menu()).getByRole("menuitem", { name: /검토.*강의안\.md/ });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("수정안 없음");
  });

  it("are not there when no document of the project is open", () => {
    view(null);
    expect(within(menu()).queryByRole("menuitem", { name: /^읽기/ })).toBeNull();
  });
});
