// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, Session, Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { initialState, type State } from "../../state.ts";
import { ShownPanels, ShownPanelsContext } from "../../completion-notifications.ts";
import { AppearanceContext, DEFAULT_APPEARANCE } from "../../appearance.ts";
import { DocContext } from "../DocCards.tsx";
import DocumentView from "./DocumentView.tsx";

vi.mock("./OfficeEditor.tsx", async () => {
  const React = await import("react");
  return { OfficeEditor: React.forwardRef(() => React.createElement("div", { "data-testid": "office-editor" })) };
});

beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

const work = { id: "w", title: "강의", cwd: "/w", folderId: null, archivedAt: null } as unknown as Work;
const reader = { id: "chat", workId: "w", provider: "codex", purpose: "슬라이드 정리", status: "idle", queued: [], archivedAt: null, createdAt: 1, updatedAt: 1 } as unknown as Session;
const A = { id: "a", workId: "w", provider: "codex", purpose: "메모 · 문서 AI", status: "awaitingApproval", queued: [], archivedAt: null, createdAt: 1, updatedAt: 1, documentAgent: { artifactId: "doc", parentSessionId: "chat" } } as unknown as Session;

function open(format: Artifact["format"], name: string, reveal: { sessionId: string } | null = null) {
  const artifact = { id: "doc", workId: "w", name, path: `/w/${name}`, format, revision: 1, sha256: "", size: 4, diskState: "same", readBy: { chat: 1 }, createdAt: 1, updatedAt: 1 } as Artifact;
  const registerDocument = vi.fn(async (artifactId: string, input: { viewId: string; windowId: string; sessionId?: string | null }) => {
    const view = { artifactId, viewId: input.viewId, windowId: input.windowId, sessionId: input.sessionId ?? null, revision: 1, dirty: false, label: "", mode: "write", expiresAt: Date.now() + 60_000 };
    return { view, writer: null, writeToken: "lease" };
  });
  const known: Record<string, unknown> = {
    registerDocument, documentSession: vi.fn(async () => A), closeDocument: vi.fn(async () => undefined),
    artifactText: vi.fn(async () => ({ artifact, revision: 1, text: "본문", editable: true, view: false })), documentViews: vi.fn(async () => ({ views: [] })),
  };
  const api: Api = new Proxy(known, {
    get: (target, key: string) => (key === "forDocument" ? () => api : key in target ? target[key] : key === "then" ? undefined : vi.fn(async () => ({}))),
  }) as unknown as Api;
  const state: State = { ...initialState, ready: true, works: { w: work }, artifacts: { doc: artifact }, sessions: { chat: reader, a: A } };
  const onToast = vi.fn();
  render(
    <AppearanceContext.Provider value={{ lookOf: (provider: "codex" | "claude") => DEFAULT_APPEARANCE[provider].light } as React.ContextType<typeof AppearanceContext>}>
    <ShownPanelsContext.Provider value={new ShownPanels()}>
    <DocContext.Provider value={{ state, actions: new Proxy({}, { get: () => vi.fn() }) } as never}>
      <DocumentView api={api} state={state} artifactId="doc" focusProposalId={null} work={work} session={A} onBack={() => undefined}
        onSend={vi.fn() as never} onPickTarget={async () => null} onAiSettings={() => undefined} onExternalSetup={() => undefined}
        onOpenArtifact={() => undefined} onToast={onToast} revealAgent={reveal} onRevealDone={() => undefined} />
    </DocContext.Provider>
    </ShownPanelsContext.Provider>
    </AppearanceContext.Provider>,
  );
  return { onToast };
}

describe("the document head's words", () => {
  it("names the revision a conversation read without a particle that depends on the name", async () => {
    open("text", "메모.txt");
    const chip = await waitFor(() => { const found = document.querySelector(".reader-chip"); expect(found).toBeTruthy(); return found!; });
    expect(chip.textContent?.trim()).toBe("읽은 판 r1 · 슬라이드 정리");
    expect(document.body.textContent).not.toContain("이(가)");
  });

  it("has one name for the document's AI: 문서 AI — with what it has to show said beside it in words", async () => {
    open("text", "메모.txt");
    const button = await screen.findByRole("button", { name: "문서 AI · 승인 필요" });
    expect(button.closest(".doc-header")).toBeTruthy();
    expect(document.querySelector(".doc-header")?.textContent).not.toContain("문서별 AI");
    expect(screen.getAllByRole("button", { name: /^문서 AI/ }).filter((entry) => entry.closest(".doc-header"))).toHaveLength(1);
    expect(button.querySelector(".dot-attention")).toBeTruthy();
  });

  it("a row click opens the AI's conversation beside the document: no notice sending the person to another panel", async () => {
    const { onToast } = open("markdown", "메모.md", { sessionId: "a" });
    await waitFor(() => expect(document.querySelector(".agent-column")).toBeTruthy());
    expect(document.querySelector(".agent-column h1")?.textContent).toBe("문서 AI · 메모.md");
    expect(onToast).not.toHaveBeenCalled();
  });
});
