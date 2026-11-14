// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, Session, Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { initialState, type State } from "../../state.ts";
import { ShownPanels, ShownPanelsContext } from "../../completion-notifications.ts";
import { AppearanceContext, DEFAULT_APPEARANCE } from "../../appearance.ts";
import { DocContext } from "../DocCards.tsx";
import DocumentView from "./DocumentView.tsx";

// The embedded Office editor stands in here. `open` is what it says about its own AI sidebar when it
// starts (Word does; null = an editor that says nothing, like every other one); `report` says it later.
const sidebar = vi.hoisted(() => ({ open: true as boolean | null, report: null as ((open: boolean) => void) | null }));
vi.mock("./OfficeEditor.tsx", async () => {
  const React = await import("react");
  return {
    OfficeEditor: React.forwardRef((props: { onAiPanel: (open: boolean) => void }, _ref) => {
      React.useEffect(() => {
        sidebar.report = props.onAiPanel;
        if (sidebar.open !== null) props.onAiPanel(sidebar.open);
        return () => { sidebar.report = null; };
      }, []);
      return React.createElement("div", { "data-testid": "office-editor" });
    }),
  };
});

// A document with two AIs (A and B). The view draws the AI its pane's session names; switching A→B
// keeps the document's writer lease, reports B as drawn, and opens the AI's conversation — the
// app's own column beside the document, whatever the document is shown in.

beforeEach(() => { sidebar.open = true; vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); })

const work = { id: "w", title: "강의", cwd: "/w", folderId: null, archivedAt: null } as unknown as Work;
const artifact = { id: "doc", workId: "w", name: "메모.txt", path: "/w/메모.txt", format: "text", revision: 1, sha256: "", size: 4, diskState: "same", readBy: {}, createdAt: 1, updatedAt: 1 } as Artifact;
const ai = (id: string, provider: Session["provider"], extra: Partial<Session> = {}) => ({ id, workId: "w", provider, purpose: `메모.txt · 문서 AI`, status: "idle", queued: [], archivedAt: null, createdAt: 1, updatedAt: 1, documentAgent: { artifactId: "doc", parentSessionId: "main" }, ...extra }) as unknown as Session;
const A = ai("a", "codex"), B = ai("b", "claude");
/** A click on that AI's row: the app's request to show its conversation. */
const click = (session: Session) => ({ sessionId: session.id });
const word = { format: "docx" as const, name: "보고서.docx" };

function setup(options: { format?: Artifact["format"]; name?: string; b?: Session; reader?: boolean; writer?: boolean } = {}) {
  const doc = { ...artifact, format: options.format ?? artifact.format, name: options.name ?? artifact.name };
  const b = options.b ?? B;
  const closeDocument = vi.fn(async () => undefined);
  // `reader`: another tab or window holds the document's writer lease, so this view only reads.
  const registerDocument = vi.fn(async (artifactId: string, input: { viewId: string; windowId: string; sessionId?: string | null }) => {
    const view = { artifactId, viewId: input.viewId, windowId: input.windowId, sessionId: input.sessionId ?? null, revision: 1, dirty: false, label: "", mode: options.reader ? "read" : "write", expiresAt: Date.now() + 60_000 };
    return { view, writer: options.reader && options.writer !== false ? { ...view, viewId: "other-view", windowId: "other-window", mode: "write" } : null, writeToken: options.reader ? null : "lease" };
  });
  const documentSession = vi.fn(async (_artifactId: string, parentSessionId: string | null) => (parentSessionId === "b" ? b : A));
  const known: Record<string, unknown> = {
    documentSession, registerDocument, closeDocument,
    text: vi.fn(async () => ({ artifact: doc, revision: 1, text: "본문", editable: true, view: false })),
  };
  const api: Api = new Proxy(known, {
    get: (target, key: string) => (key === "forDocument" ? () => api : key in target ? target[key] : key === "then" ? undefined : vi.fn(async () => ({}))),
  }) as unknown as Api;
  const state: State = { ...initialState, ready: true, works: { w: work }, artifacts: { doc }, sessions: { a: A, b } };
  const onToast = vi.fn(), onRevealDone = vi.fn();
  const panels = new ShownPanels();
  /** Every AI the seen-registry was ever told is on screen. */
  const everShown = new Set<string>();
  panels.subscribe(() => panels.ids().forEach((id) => everShown.add(id)));
  const onAgentDrawn = vi.fn();
  const onSessionMenu = vi.fn();
  const view = (session: Session, reveal: { sessionId: string } | null = null) => (
    <AppearanceContext.Provider value={{ lookOf: (provider: "codex" | "claude") => DEFAULT_APPEARANCE[provider].light } as React.ContextType<typeof AppearanceContext>}>
    <ShownPanelsContext.Provider value={panels}>
    <DocContext.Provider value={{ state, actions: new Proxy({}, { get: () => vi.fn() }) } as never}>
      <DocumentView api={api} state={state} artifactId="doc" focusProposalId={null} work={work} session={session} onBack={() => undefined}
        onAgentDrawn={onAgentDrawn} onSend={vi.fn() as never} onPickTarget={async () => null} onAiSettings={() => undefined} onExternalSetup={() => undefined}
        onOpenArtifact={() => undefined} onToast={onToast} revealAgent={reveal} onRevealDone={onRevealDone} onSessionMenu={onSessionMenu} />
    </DocContext.Provider>
    </ShownPanelsContext.Provider>
    </AppearanceContext.Provider>
  );
  return { api, panels, everShown, onAgentDrawn, onSessionMenu, onToast, onRevealDone, b, documentSession, registerDocument, closeDocument, view };
}

describe("switching the drawn AI from a document row", () => {
  it("draws B, reports B, keeps the writer lease, and opens B's conversation", async () => {
    const { panels, onAgentDrawn, documentSession, registerDocument, closeDocument, view } = setup();
    const { rerender } = render(view(A));
    await waitFor(() => expect(onAgentDrawn).toHaveBeenLastCalledWith("doc", "a"));
    await waitFor(() => expect(registerDocument).toHaveBeenCalled());
    // The column is closed: nothing is on screen yet.
    expect(panels.ids()).toEqual([]);
    // A click on B's row: the pane names B and asks to show it.
    rerender(view(B, click(B)));
    await waitFor(() => expect(onAgentDrawn).toHaveBeenLastCalledWith("doc", "b"));
    expect(documentSession).toHaveBeenLastCalledWith("doc", "b");
    await waitFor(() => expect(panels.ids()).toEqual(["b"]));
    expect(closeDocument).not.toHaveBeenCalled();
    // One lease all along: every registration is the same view, never re-opened from nothing.
    expect(new Set(registerDocument.mock.calls.map(([, input]) => input.viewId)).size).toBe(1);
    // Never "no AI" between A and B.
    const reports = onAgentDrawn.mock.calls.map(([, id]) => id);
    expect(reports.slice(reports.indexOf("a"))).not.toContain(null);
  });

  it("opens the closed conversation again when the same AI's row is clicked", async () => {
    const { panels, onAgentDrawn, view } = setup();
    const { rerender } = render(view(A));
    await waitFor(() => expect(onAgentDrawn).toHaveBeenLastCalledWith("doc", "a"));
    expect(panels.ids()).toEqual([]);
    rerender(view(A, click(A)));
    await waitFor(() => expect(panels.ids()).toEqual(["a"]));
  });

  it("offers this AI's own menu in its conversation's head", async () => {
    const { view, onSessionMenu } = setup();
    render(view(A, click(A)));
    const button = await waitFor(() => within(document.querySelector<HTMLElement>(".agent-column .note-head")!).getByRole("button", { name: "이 문서 AI 메뉴" }));
    fireEvent.click(button);
    expect(onSessionMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), expect.any(Number), expect.any(Number));
  });

  it("hands the reveal back once acted on, so a later opening does not open the chat by itself", async () => {
    const { view, onRevealDone } = setup();
    const request = click(A);
    render(view(A, request));
    await waitFor(() => expect(onRevealDone).toHaveBeenCalledWith("doc", request));
  });
});

const column = () => document.querySelector<HTMLElement>(".agent-column");
const waiting = () => ai("b", "claude", { status: "awaitingApproval" });
const rich = { format: "markdown" as const, name: "메모.md" };
const slides = { format: "pptx" as const, name: "발표.pptx" };

// The app owns the conversation's place: a row click opens its column beside the document. One
// editor says whether its own AI sidebar is open (Word); while it is, the conversation is already
// on screen there and the column is not put beside it too.
describe("a row click while the document is in an embedded editor", () => {
  it.each([
    ["the app's rich editor (says nothing of its own sidebar)", null, rich],
    ["PowerPoint (says nothing of its own sidebar)", null, slides],
    ["Word, its own sidebar closed", false, word],
  ] as const)("%s: the AI's conversation opens in the app's column, and only then counts as looked at", async (_name, open, doc) => {
    sidebar.open = open;
    const { panels, view, onToast, onRevealDone, b } = setup({ ...doc, b: waiting() });
    const { rerender } = render(view(A));
    await screen.findByTestId("office-editor");
    const request = click(b);
    rerender(view(b, request));
    await waitFor(() => expect(column()?.querySelector("h1")?.textContent).toBe(`문서 AI · ${doc.name}`));
    await waitFor(() => expect(panels.ids()).toEqual(["b"]));
    expect(onToast).not.toHaveBeenCalled();
    expect(onRevealDone.mock.calls).toEqual([["doc", request]]);
    // The editor is the same one.
    expect(screen.getByTestId("office-editor")).toBeTruthy();
  });

  it("Word, its own sidebar open: the sidebar already shows the conversation — no column beside it, no notice, and it counts as looked at", async () => {
    sidebar.open = true;
    const { panels, view, onToast, onRevealDone, b } = setup({ ...word, b: waiting() });
    const { rerender } = render(view(A));
    await screen.findByTestId("office-editor");
    const request = click(b);
    rerender(view(b, request));
    await waitFor(() => expect(onRevealDone.mock.calls).toEqual([["doc", request]]));
    await waitFor(() => expect(panels.ids()).toEqual(["b"]));
    await new Promise((done) => setTimeout(done, 30));
    expect(column()).toBeNull();
    expect(onToast).not.toHaveBeenCalled();
  });

  it("an editor that says nothing about its own sidebar is not taken to show the conversation", async () => {
    sidebar.open = null;
    const { view, onAgentDrawn, everShown } = setup({ ...slides });
    render(view(A));
    await screen.findByTestId("office-editor");
    await waitFor(() => expect(onAgentDrawn).toHaveBeenLastCalledWith("doc", "a"));
    await new Promise((done) => setTimeout(done, 30));
    expect([...everShown]).toEqual([]);
  });

  it("Word that says its own sidebar is open counts as showing it, without the column", async () => {
    const { view, panels } = setup({ ...word });
    render(view(A));
    await waitFor(() => expect(panels.ids()).toEqual(["a"]));
    expect(column()).toBeNull();
  });
});

// The click that opens the document: the view mounts with the request already there. It is never
// dropped. Only Word is waited for (it says shortly whether its sidebar is open), and not for ever.
describe("a row click on a document that is not open yet", () => {
  it.each([["the app's rich editor", rich], ["PowerPoint", slides]] as const)("%s: the column is there from the start", async (_name, doc) => {
    sidebar.open = null;
    const { view, onToast, onRevealDone, panels, b } = setup({ ...doc, b: waiting() });
    const request = click(b);
    render(view(b, request));
    await waitFor(() => expect(column()).not.toBeNull());
    await waitFor(() => expect(panels.ids()).toEqual(["b"]));
    expect(onToast).not.toHaveBeenCalled();
    expect(onRevealDone.mock.calls).toEqual([["doc", request]]);
  });

  it("Word with its sidebar open: the editor shows the conversation, so no column", async () => {
    const { view, onToast, onRevealDone, panels, b } = setup({ ...word });
    const request = click(b);
    render(view(b, request));
    await waitFor(() => expect(panels.ids()).toEqual(["b"]));
    await waitFor(() => expect(onRevealDone.mock.calls).toEqual([["doc", request]]));
    expect(column()).toBeNull();
    expect(onToast).not.toHaveBeenCalled();
  });

  it("Word with its sidebar closed: the column comes once the editor says so", async () => {
    sidebar.open = false;
    const { view, onRevealDone, panels, b } = setup({ ...word, b: waiting() });
    const request = click(b);
    render(view(b, request));
    await waitFor(() => expect(column()).not.toBeNull());
    await waitFor(() => expect(panels.ids()).toEqual(["b"]));
    expect(onRevealDone.mock.calls).toEqual([["doc", request]]);
  });

  it("Word that says nothing about its sidebar: the column comes after a short wait, not silence", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sidebar.open = null;
    const { view, onRevealDone, b } = setup({ ...word, b: waiting() });
    const request = click(b);
    render(view(b, request));
    await screen.findByTestId("office-editor");
    expect(column()).toBeNull();
    expect(onRevealDone).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(column()).not.toBeNull();
    expect(onRevealDone.mock.calls).toEqual([["doc", request]]);
    // A late answer from the editor changes nothing: the request was acted on once.
    act(() => sidebar.report?.(true));
    expect(column()).not.toBeNull();
    expect(onRevealDone).toHaveBeenCalledTimes(1);
  });

  it("the view closing while the request waits: nothing happens afterwards, and the request is still there for the next opening", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sidebar.open = null;
    const { view, onRevealDone, b } = setup({ ...word, b: waiting() });
    const request = click(b);
    const first = render(view(b, request));
    await screen.findByTestId("office-editor");
    first.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(onRevealDone).not.toHaveBeenCalled();
    sidebar.open = false;
    render(view(b, request));
    await waitFor(() => expect(column()).not.toBeNull());
    expect(onRevealDone.mock.calls).toEqual([["doc", request]]);
  });

  it("text mode: the app's own conversation opens", async () => {
    const { view, onToast, onRevealDone, panels } = setup();
    const request = click(B);
    render(view(B, request));
    await waitFor(() => expect(panels.ids()).toEqual(["b"]));
    expect(onRevealDone.mock.calls).toEqual([["doc", request]]);
    expect(onToast).not.toHaveBeenCalled();
  });

  it("two clicks in a row: each is acted on once, and the newer AI is the one shown", async () => {
    sidebar.open = null;
    const { view, onRevealDone, onAgentDrawn, panels, b } = setup({ ...slides, b: waiting() });
    const first = click(A), second = click(b);
    const { rerender } = render(view(A, first));
    await screen.findByTestId("office-editor");
    rerender(view(b, second));
    await waitFor(() => expect(onAgentDrawn).toHaveBeenLastCalledWith("doc", "b"));
    await waitFor(() => expect(panels.ids()).toEqual(["b"]));
    expect(onRevealDone.mock.calls).toEqual([["doc", first], ["doc", second]]);
  });

  it("the person closes the column: the same request does not open it again", async () => {
    const { view, panels } = setup();
    const request = click(A);
    const { rerender } = render(view(A, request));
    await waitFor(() => expect(column()).not.toBeNull());
    fireEvent.click(within(column()!.querySelector<HTMLElement>(".note-head")!).getByRole("button", { name: "문서 AI 대화 닫기" }));
    await waitFor(() => expect(column()).toBeNull());
    rerender(view(A, request));
    await new Promise((done) => setTimeout(done, 20));
    expect(column()).toBeNull();
    expect(panels.ids()).toEqual([]);
  });

  it("a view whose pane names another conversation leaves the request to the one it was meant for", async () => {
    const { view, onRevealDone, onAgentDrawn, panels } = setup();
    render(view(A, click(B)));
    await waitFor(() => expect(onAgentDrawn).toHaveBeenLastCalledWith("doc", "a"));
    await new Promise((done) => setTimeout(done, 20));
    expect(panels.ids()).toEqual([]);
    expect(onRevealDone).not.toHaveBeenCalled();
  });
});

// Another tab or window edits the document: this screen shows its pages only, with no editor.
// The AI's conversation is the app's own, so it is shown here all the same.
describe("a document edited in another tab or window (pages only on this screen)", () => {
  it("a row click opens the AI's conversation beside the pages — no notice pointing elsewhere", async () => {
    const { view, onToast, onRevealDone, panels, registerDocument, b } = setup({ ...word, reader: true, b: waiting() });
    const request = click(b);
    render(view(b, request));
    await waitFor(() => expect(column()).not.toBeNull());
    await waitFor(() => expect(panels.ids()).toEqual(["b"]));
    expect(onToast).not.toHaveBeenCalled();
    expect(registerDocument).toHaveBeenCalled();
    expect(screen.queryByTestId("office-editor")).toBeNull();
    expect(onRevealDone.mock.calls).toEqual([["doc", request]]);
  });

  it("does not count the AI as seen on this screen while its column is closed, also for an editor that never reports its sidebar", async () => {
    const { view, onAgentDrawn, registerDocument, everShown, b } = setup({ format: "pptx", name: "발표.pptx", reader: true });
    render(view(b));
    await waitFor(() => expect(onAgentDrawn).toHaveBeenLastCalledWith("doc", "b"));
    await waitFor(() => expect(registerDocument).toHaveBeenCalled());
    await screen.findByText(/다른 탭이나 창에서 편집 중입니다/);
    expect(screen.queryByTestId("office-editor")).toBeNull();
    expect([...everShown]).toEqual([]);
  });
});
