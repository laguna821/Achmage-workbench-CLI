// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, Session, Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { initialState, type State } from "../../state.ts";
import { ShownPanels, ShownPanelsContext } from "../../completion-notifications.ts";
import { AppearanceContext, DEFAULT_APPEARANCE } from "../../appearance.ts";
import { DocContext } from "../DocCards.tsx";
import DocumentView from "./DocumentView.tsx";

// 0.5.6 round 2 (the owner): on a phone joined to the PC a document is read; its AI and the PC's own apps are not offered.
vi.mock("./OfficeEditor.tsx", async () => {
  const React = await import("react");
  // The editor's own panel turned off by the person (one-doc-ai): 문서 AI is then the app's column beside the editor.
  return { OfficeEditor: React.forwardRef((props: { onAiPanel?: (open: boolean, draft?: string, dock?: object) => void }) => { React.useEffect(() => { props.onAiPanel?.(false, "", { ready: true, person: false, shown: false, off: true }); }, []); return React.createElement("div", { "data-testid": "office-editor" }); }) };
});

beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

const work = { id: "w", title: "강의", cwd: "/w", folderId: null, archivedAt: null } as unknown as Work;
const reader = { id: "chat", workId: "w", provider: "codex", purpose: "슬라이드 정리", status: "idle", queued: [], archivedAt: null, createdAt: 1, updatedAt: 1 } as unknown as Session;
const A = { id: "a", workId: "w", provider: "codex", purpose: "메모 · 문서 AI", status: "awaitingApproval", queued: [], archivedAt: null, createdAt: 1, updatedAt: 1, documentAgent: { artifactId: "doc", parentSessionId: "chat" } } as unknown as Session;

function open(format: Artifact["format"], name: string, reveal: { sessionId: string } | null = null, remote = false, late = false) {
  const artifact = { id: "doc", workId: "w", name, path: `/w/${name}`, format, revision: 1, sha256: "", size: 4, diskState: "same", readBy: { chat: 1 }, createdAt: 1, updatedAt: 1 } as Artifact;
  const registerDocument = vi.fn(async (artifactId: string, input: { viewId: string; windowId: string; sessionId?: string | null }) => {
    const view = { artifactId, viewId: input.viewId, windowId: input.windowId, sessionId: input.sessionId ?? null, revision: 1, dirty: false, label: "", mode: "write", expiresAt: Date.now() + 60_000 };
    return { view, writer: null, writeToken: "lease" };
  });
  const known: Record<string, unknown> = {
    registerDocument, documentSession: vi.fn(async () => A), closeDocument: vi.fn(async () => undefined),
    artifactText: vi.fn(async () => ({ artifact, revision: 1, text: "본문", editable: true, view: false })), documentViews: vi.fn(async () => ({ views: [] })),
    isRemote: remote,
  };
  const api: Api = new Proxy(known, {
    get: (target, key: string) => (key === "forDocument" ? () => api : key in target ? target[key] : key === "then" ? undefined : vi.fn(async () => ({}))),
  }) as unknown as Api;
  const state: State = { ...initialState, ready: true, works: { w: work }, artifacts: late ? {} : { doc: artifact }, sessions: { chat: reader, a: A } };
  const onToast = vi.fn();
  const tree = (shown: State) => (
    <AppearanceContext.Provider value={{ lookOf: (provider: "codex" | "claude") => DEFAULT_APPEARANCE[provider].light } as React.ContextType<typeof AppearanceContext>}>
    <ShownPanelsContext.Provider value={new ShownPanels()}>
    <DocContext.Provider value={{ state: shown, actions: new Proxy({}, { get: () => vi.fn() }) } as never}>
      <DocumentView api={api} state={shown} artifactId="doc" focusProposalId={null} work={work} session={A} onBack={() => undefined}
        onSend={vi.fn() as never} onPickTarget={async () => null} onAiSettings={() => undefined} onExternalSetup={() => undefined}
        onOpenArtifact={() => undefined} onToast={onToast} revealAgent={reveal} onRevealDone={() => undefined} />
    </DocContext.Provider>
    </ShownPanelsContext.Provider>
    </AppearanceContext.Provider>
  );
  const view = render(tree(state));
  // The document arrives in the phone's state after its tab opened (made a moment ago, over the device channel).
  const arrive = () => view.rerender(tree({ ...state, artifacts: { doc: artifact } }));
  return { onToast, arrive };
}

describe("a document on a phone joined to the PC", () => {
  it("has no 문서 AI key and no 앱으로 열기; it says it is read here", async () => {
    open("markdown", "메모.md", null, true);
    await screen.findByText(/휴대폰에서는 문서를 읽기만 합니다/);
    expect(screen.queryByRole("button", { name: /^문서 AI/ })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "문서 메뉴" }));
    expect(screen.queryByText("앱으로 열기")).toBeNull();
  });

  it("a Hangul document made a moment ago (its tab opens before it reaches the phone) opens in its page pictures, as from the 문서 list", async () => {
    const { arrive } = open("hwpx", "새 한글.hwpx", null, true, true);
    arrive();
    await waitFor(() => expect(document.querySelector(".hwpx-view")).toBeTruthy());
  });

  it("on the PC the 문서 AI key stays", async () => {
    open("markdown", "메모.md");
    expect(await screen.findByRole("button", { name: /^문서 AI/ })).toBeTruthy();
  });
});
