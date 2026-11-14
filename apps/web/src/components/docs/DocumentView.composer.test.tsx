// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, DocRef, Session, Work } from "@workbench/contracts";
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

// One composer: the document AI's input is laid out as the conversation's. Engine, model and effort
// sit at the bar's right; 수정 / 검토 is the one extra, a small segment in the bar. What is sent,
// to whom, and in which mode is as it always was.

beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

const work = { id: "w", title: "강의", cwd: "/w", folderId: null, archivedAt: null } as unknown as Work;
const artifact = { id: "doc", workId: "w", name: "메모.txt", path: "/w/메모.txt", format: "text", revision: 1, sha256: "", size: 4, diskState: "same", readBy: {}, createdAt: 1, updatedAt: 1 } as Artifact;
const A = { id: "a", workId: "w", provider: "codex", purpose: "메모.txt · 문서 AI", status: "idle", queued: [], archivedAt: null, model: null, effort: null, createdAt: 1, updatedAt: 1, documentAgent: { artifactId: "doc", parentSessionId: "main" } } as unknown as Session;
const onClaude = { ...A, id: "a2", provider: "claude" } as Session;

function setup() {
  const documentSession = vi.fn(async (_artifactId: string, _parent: string | null, _fresh?: boolean, provider?: string) => (provider === "claude" ? onClaude : A));
  const registerDocument = vi.fn(async (artifactId: string, input: { viewId: string; windowId: string; sessionId?: string | null }) => {
    const view = { artifactId, viewId: input.viewId, windowId: input.windowId, sessionId: input.sessionId ?? null, revision: 1, dirty: false, label: "", mode: "write", expiresAt: Date.now() + 60_000 };
    return { view, writer: null, writeToken: "lease" };
  });
  const known: Record<string, unknown> = {
    documentSession, registerDocument, closeDocument: vi.fn(async () => undefined),
    artifactText: vi.fn(async () => ({ artifact, revision: 1, text: "본문", editable: true, view: false })),
    resolveReferences: vi.fn(async (refs: unknown[]) => ({ refs })), documentViews: vi.fn(async () => ({ views: [] })),
  };
  const api: Api = new Proxy(known, {
    get: (target, key: string) => (key === "forDocument" ? () => api : key in target ? target[key] : key === "then" ? undefined : vi.fn(async () => ({}))),
  }) as unknown as Api;
  const models = [{ id: "fake", label: "Fake", description: null, efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true }];
  const state = { ...initialState, ready: true, works: { w: work }, artifacts: { doc: artifact }, sessions: { a: A, a2: onClaude }, providers: { codex: { models }, claude: { models } } } as unknown as State;
  const onSend = vi.fn(async () => true);
  render(
    <AppearanceContext.Provider value={{ lookOf: (provider: "codex" | "claude") => DEFAULT_APPEARANCE[provider].light } as React.ContextType<typeof AppearanceContext>}>
    <ShownPanelsContext.Provider value={new ShownPanels()}>
    <DocContext.Provider value={{ state, actions: new Proxy({}, { get: () => vi.fn() }) } as never}>
      <DocumentView api={api} state={state} artifactId="doc" focusProposalId={null} work={work} session={A} onBack={() => undefined}
        onSend={onSend as never} onPickTarget={async () => null} onAiSettings={() => undefined} onExternalSetup={() => undefined}
        onOpenArtifact={() => undefined} onToast={() => undefined} revealAgent={{ sessionId: "a" }} onRevealDone={() => undefined} />
    </DocContext.Provider>
    </ShownPanelsContext.Provider>
    </AppearanceContext.Provider>,
  );
  return { onSend, documentSession };
}
const bar = () => document.querySelector<HTMLElement>(".doc-composer .composer-bar")!;
const send = async (text: string, onSend: ReturnType<typeof vi.fn>, nth: number) => {
  fireEvent.change(document.querySelector(".doc-composer textarea")!, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "보내기" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(nth));
  return onSend.mock.calls[nth - 1] as unknown as [Session, string, DocRef[]];
};

describe("the document AI's input is the conversation's composer", () => {
  it("has no row of its own above the input: engine, model and effort are at the bar's right, as in a conversation", async () => {
    setup();
    await waitFor(() => expect(document.querySelector<HTMLTextAreaElement>(".doc-composer textarea")?.disabled).toBe(false));
    expect(document.querySelector(".doc-composer .side-chat-controls")).toBeNull();
    const right = bar().querySelector<HTMLElement>(".composer-right")!;
    expect(within(right).getByRole("button", { name: "Fake" })).toBeTruthy();
    expect(within(right).getByTitle(/추론 강도/)).toBeTruthy();
    // The engine and the document, not the AI's long name.
    const target = within(right).getByRole("button", { name: /Codex/ });
    expect(target.textContent).toBe("Codex · 메모.txt");
    expect(bar().textContent).not.toContain("문서 AI");
  });

  it("수정 / 검토 is one small segment inside the bar, and decides the mode of what is sent — to this document's AI", async () => {
    const { onSend } = setup();
    await waitFor(() => expect(document.querySelector<HTMLTextAreaElement>(".doc-composer textarea")?.disabled).toBe(false));
    const kinds = within(bar()).getByRole("radiogroup", { name: "요청 종류" });
    expect(within(kinds).getAllByRole("radio").map((button) => button.textContent)).toEqual(["수정", "검토"]);
    expect(document.querySelector(".doc-composer .composer-header [role=radiogroup]")).toBeNull();
    const first = await send("서론을 줄여 줘", onSend, 1);
    expect(first[0].id).toBe("a");
    expect(first[1]).toBe("서론을 줄여 줘");
    expect(first[2]).toEqual([expect.objectContaining({ artifactId: "doc", mode: "edit" })]);
    fireEvent.click(within(kinds).getByRole("radio", { name: "검토" }));
    expect(within(kinds).getByRole("radio", { name: "검토" }).getAttribute("aria-checked")).toBe("true");
    const second = await send("읽고 의견만 줘", onSend, 2);
    expect(second[0].id).toBe("a");
    expect(second[2]).toEqual([expect.objectContaining({ artifactId: "doc", mode: "review" })]);
  });

  it("another engine is picked from the same target menu, and asks the gateway for that engine's conversation of this document", async () => {
    const { documentSession } = setup();
    await waitFor(() => expect(document.querySelector<HTMLTextAreaElement>(".doc-composer textarea")?.disabled).toBe(false));
    fireEvent.click(within(bar()).getByRole("button", { name: /Codex/ }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Claude/ }));
    await waitFor(() => expect(documentSession).toHaveBeenLastCalledWith("doc", "a", false, "claude"));
    await waitFor(() => expect(within(bar()).getByRole("button", { name: /Claude/ }).textContent).toBe("Claude · 메모.txt"));
  });
});
