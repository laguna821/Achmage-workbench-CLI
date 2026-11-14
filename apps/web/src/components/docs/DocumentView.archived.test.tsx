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

vi.mock("./OfficeEditor.tsx", async () => {
  const React = await import("react");
  return { OfficeEditor: React.forwardRef(() => React.createElement("div", { "data-testid": "office-editor" })) };
});

// The gateway sends nothing to an archived conversation. The document view therefore never offers
// one as the place to type: when the AI it shows is archived (from its own ⋯, or from elsewhere) it
// goes on with another live AI of the document, or with none until the person starts one.

beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

const work = { id: "w", title: "강의", cwd: "/w", folderId: null, archivedAt: null } as unknown as Work;
const artifact = { id: "doc", workId: "w", name: "메모.txt", path: "/w/메모.txt", format: "text", revision: 1, sha256: "", size: 4, diskState: "same", readBy: {}, createdAt: 1, updatedAt: 1 } as Artifact;
const ai = (id: string, provider: Session["provider"], extra: Partial<Session> = {}) => ({ id, workId: "w", provider, purpose: "메모.txt · 문서 AI", status: "idle", queued: [], archivedAt: null, createdAt: 1, updatedAt: 1, documentAgent: { artifactId: "doc", parentSessionId: "main" }, ...extra }) as unknown as Session;
const A = ai("a", "codex"), B = ai("b", "claude"), C = ai("c", "codex", { createdAt: 9, updatedAt: 9 });
const archived = (session: Session) => ({ ...session, archivedAt: 20, updatedAt: 20 }) as Session;

function setup(sessions: Record<string, Session>) {
  const closeDocument = vi.fn(async () => undefined);
  const registerDocument = vi.fn(async (artifactId: string, input: { viewId: string; windowId: string; sessionId?: string | null }) => {
    const view = { artifactId, viewId: input.viewId, windowId: input.windowId, sessionId: input.sessionId ?? null, revision: 1, dirty: false, label: "", mode: "write", expiresAt: Date.now() + 60_000 };
    return { view, writer: null, writeToken: "lease" };
  });
  // The gateway: an AI of this document asked for by its id is returned as it is; otherwise the
  // one this test stands in for a newly started conversation.
  const documentSession = vi.fn(async (_artifactId: string, parentSessionId: string | null) => (parentSessionId === "b" ? B : parentSessionId === "a" && !gone.a ? A : C));
  const gone: Record<string, boolean> = {};
  const known: Record<string, unknown> = {
    documentSession, registerDocument, closeDocument,
    artifactText: vi.fn(async () => ({ artifact, revision: 1, text: "본문", editable: true, view: false })),
    resolveReferences: vi.fn(async (refs: unknown[]) => ({ refs })), documentViews: vi.fn(async () => ({ views: [] })),
  };
  const api: Api = new Proxy(known, {
    get: (target, key: string) => (key === "forDocument" ? () => api : key in target ? target[key] : key === "then" ? undefined : vi.fn(async () => ({}))),
  }) as unknown as Api;
  const onSend = vi.fn(async () => true), onAgentDrawn = vi.fn(), onToast = vi.fn();
  const panels = new ShownPanels();
  const view = (now: Record<string, Session>, reveal: { sessionId: string } | null = { sessionId: "a" }) => {
    const state: State = { ...initialState, ready: true, works: { w: work }, artifacts: { doc: artifact }, sessions: now };
    return (
      <AppearanceContext.Provider value={{ lookOf: (provider: "codex" | "claude") => DEFAULT_APPEARANCE[provider].light } as React.ContextType<typeof AppearanceContext>}>
      <ShownPanelsContext.Provider value={panels}>
      <DocContext.Provider value={{ state, actions: new Proxy({}, { get: () => vi.fn() }) } as never}>
        <DocumentView api={api} state={state} artifactId="doc" focusProposalId={null} work={work} session={now.a ?? A} onBack={() => undefined}
          onAgentDrawn={onAgentDrawn} onSend={onSend as never} onPickTarget={async () => null} onAiSettings={() => undefined} onExternalSetup={() => undefined}
          onOpenArtifact={() => undefined} onToast={onToast} revealAgent={reveal} onRevealDone={() => undefined} onSessionMenu={() => undefined} />
      </DocContext.Provider>
      </ShownPanelsContext.Provider>
      </AppearanceContext.Provider>
    );
  };
  const shown = render(view(sessions));
  return { shown, view, gone, documentSession, registerDocument, closeDocument, onSend, onAgentDrawn, onToast, sessions };
}
const input = () => document.querySelector<HTMLTextAreaElement>(".doc-composer textarea");
const type = (text: string) => fireEvent.change(input()!, { target: { value: text } });

describe("the AI a document view shows is archived", () => {
  it("another live AI of the document: the view goes on with that one, says so once, and a request goes to it", async () => {
    const at = setup({ a: A, b: B });
    await waitFor(() => expect(input()?.disabled).toBe(false));
    at.gone.a = true;
    at.shown.rerender(at.view({ a: archived(A), b: B }));
    await waitFor(() => expect(at.onAgentDrawn).toHaveBeenLastCalledWith("doc", "b"));
    expect(at.documentSession).toHaveBeenLastCalledWith("doc", "b");
    expect(screen.getByRole("status", { name: "문서 AI 안내" }).textContent).toMatch(/보관.*다른 문서 AI/);
    expect(input()?.disabled).toBe(false);
    type("서론을 줄여 줘");
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(at.onSend).toHaveBeenCalled());
    expect((at.onSend.mock.calls[0] as unknown as [Session])[0].id).toBe("b");
    // The document's writer lease was never given up.
    expect(at.closeDocument).not.toHaveBeenCalled();
    expect(new Set(at.registerDocument.mock.calls.map(([, registration]) => registration.viewId)).size).toBe(1);
    // Said once: the line goes with the request that follows it.
    await waitFor(() => expect(screen.queryByRole("status", { name: "문서 AI 안내" })).toBeNull());
  });

  it("no other AI: no input at all, one line saying why, and nothing is started behind the person's back", async () => {
    const at = setup({ a: A });
    await waitFor(() => expect(input()?.disabled).toBe(false));
    const asked = at.documentSession.mock.calls.length;
    at.gone.a = true;
    at.shown.rerender(at.view({ a: archived(A) }));
    await waitFor(() => expect(input()).toBeNull());
    expect(screen.queryByRole("button", { name: "보내기" })).toBeNull();
    expect(screen.getByRole("status", { name: "문서 AI 안내" }).textContent).toMatch(/보관/);
    expect(at.onAgentDrawn).toHaveBeenLastCalledWith("doc", null);
    await new Promise((done) => setTimeout(done, 20));
    expect(at.documentSession.mock.calls.length).toBe(asked);
    expect(at.closeDocument).not.toHaveBeenCalled();
  });

  it("no other AI: 문서 AI 시작 asks the gateway for a conversation, and the input is back for that one", async () => {
    const at = setup({ a: A });
    await waitFor(() => expect(input()?.disabled).toBe(false));
    at.gone.a = true;
    at.shown.rerender(at.view({ a: archived(A) }));
    fireEvent.click(await screen.findByRole("button", { name: "문서 AI 시작" }));
    await waitFor(() => expect(at.onAgentDrawn).toHaveBeenLastCalledWith("doc", "c"));
    await waitFor(() => expect(input()?.disabled).toBe(false));
    type("요약해 줘");
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(at.onSend).toHaveBeenCalled());
    expect((at.onSend.mock.calls[0] as unknown as [Session])[0].id).toBe("c");
  });

  it("archived before the view opened its conversation: the same — never a live input for it", async () => {
    setup({ a: archived(A) });
    // The gateway (stood in for) still names A here; the app's own state says it is archived.
    await waitFor(() => expect(screen.getByRole("status", { name: "문서 AI 안내" })).toBeTruthy());
    expect(input()).toBeNull();
  });

  it("restored while the view waits: its conversation and its input are back", async () => {
    const at = setup({ a: A });
    await waitFor(() => expect(input()?.disabled).toBe(false));
    at.shown.rerender(at.view({ a: archived(A) }));
    await waitFor(() => expect(input()).toBeNull());
    at.shown.rerender(at.view({ a: { ...A, updatedAt: 30 } as Session }));
    await waitFor(() => expect(input()?.disabled).toBe(false));
    expect(at.onAgentDrawn).toHaveBeenLastCalledWith("doc", "a");
    type("이어서");
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(at.onSend).toHaveBeenCalled());
    expect((at.onSend.mock.calls[0] as unknown as [Session])[0].id).toBe("a");
  });
});
