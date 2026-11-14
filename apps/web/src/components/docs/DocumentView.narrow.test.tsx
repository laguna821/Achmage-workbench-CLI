// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, Session, Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { initialState, type State } from "../../state.ts";
import { ShownPanels, ShownPanelsContext } from "../../completion-notifications.ts";
import { AppearanceContext, DEFAULT_APPEARANCE } from "../../appearance.ts";
import { DocContext } from "../DocCards.tsx";
import DocumentView from "./DocumentView.tsx";

// The embedded editor stands in here: what it reports (its own "dirty"), and how often it was
// asked to flush — the only way its edits are written.
const editor = vi.hoisted(() => ({ report: null as ((status: { dirty: boolean; revision: number | null; conflict: null; changed: boolean }) => void) | null, flushed: 0, flushResult: 2 as number | null, mounts: 0, unmounts: 0 }));
vi.mock("./OfficeEditor.tsx", async () => {
  const React = await import("react");
  return {
    OfficeEditor: React.forwardRef((props: { onStatus: (status: unknown) => void }, ref) => {
      React.useImperativeHandle(ref, () => ({ flush: async () => { editor.flushed += 1; return editor.flushResult; }, leave: async () => { editor.flushed += 1; } }));
      React.useEffect(() => { editor.mounts += 1; editor.report = props.onStatus; return () => { editor.unmounts += 1; editor.report = null; }; }, []);
      return React.createElement("div", { "data-testid": "office-editor" });
    }),
  };
});
vi.mock("./MarkdownEditor.tsx", async () => {
  const React = await import("react");
  return { MarkdownEditor: (props: { value: string; onChange: (text: string) => void }) => React.createElement("textarea", { "data-testid": "source", value: props.value, onChange: (event: { target: { value: string } }) => props.onChange(event.target.value) }) };
});

// The pane's width, as the browser would report it for the document view.
const pane = { width: 1000, resize: [] as (() => void)[] };
beforeEach(() => {
  pane.width = 1000; pane.resize = [];
  editor.flushed = 0; editor.flushResult = 2; editor.mounts = 0; editor.unmounts = 0;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { constructor(changed: () => void) { pane.resize.push(changed); } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { width: this.classList.contains("document-view") ? pane.width : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const work = { id: "w", title: "강의", cwd: "/w", folderId: null, archivedAt: null } as unknown as Work;
const markdown = { id: "doc", workId: "w", name: "강의안.md", path: "/w/강의안.md", format: "markdown", revision: 1, sha256: "", size: 4, diskState: "same", readBy: {}, createdAt: 1, updatedAt: 1 } as Artifact;
const A = { id: "a", workId: "w", provider: "codex", purpose: "강의안.md · 문서 AI", status: "idle", queued: [], archivedAt: null, createdAt: 1, updatedAt: 1, documentAgent: { artifactId: "doc", parentSessionId: "main" } } as unknown as Session;

const FORMATS = { markdown: "강의안.md", docx: "보고서.docx", pptx: "발표.pptx" } as const;
async function open(width: number, format: keyof typeof FORMATS = "markdown") {
  pane.width = width;
  const artifact = { ...markdown, format, name: FORMATS[format], path: `/w/${FORMATS[format]}` } as Artifact;
  const registerDocument = vi.fn(async (artifactId: string, input: { viewId: string; windowId: string; sessionId?: string | null }) => {
    const view = { artifactId, viewId: input.viewId, windowId: input.windowId, sessionId: input.sessionId ?? null, revision: 1, dirty: false, label: "", mode: "write", expiresAt: Date.now() + 60_000 };
    return { view, writer: null, writeToken: "lease" };
  });
  const closeDocument = vi.fn(async () => undefined);
  const known: Record<string, unknown> = {
    registerDocument, closeDocument, documentSession: vi.fn(async () => A),
    artifactText: vi.fn(async () => ({ artifact, revision: 1, text: "본문", editable: true, view: false })), documentViews: vi.fn(async () => ({ views: [] })),
    // Saving never ends here, so an edit stays unsaved for as long as the test looks.
    saveArtifact: vi.fn(() => new Promise(() => {})),
  };
  const api: Api = new Proxy(known, {
    get: (target, key: string) => (key === "forDocument" ? () => api : key in target ? target[key] : key === "then" ? undefined : vi.fn(async () => ({}))),
  }) as unknown as Api;
  const state: State = { ...initialState, ready: true, works: { w: work }, artifacts: { doc: artifact }, sessions: { a: A } };
  const onUiState = vi.fn(), onToast = vi.fn();
  render(
    <AppearanceContext.Provider value={{ lookOf: (provider: "codex" | "claude") => DEFAULT_APPEARANCE[provider].light } as React.ContextType<typeof AppearanceContext>}>
    <ShownPanelsContext.Provider value={new ShownPanels()}>
    <DocContext.Provider value={{ state, actions: new Proxy({}, { get: () => vi.fn() }) } as never}>
      <DocumentView api={api} state={state} artifactId="doc" focusProposalId={null} work={work} session={A} onBack={() => undefined} onUiState={onUiState}
        onSend={vi.fn() as never} onPickTarget={async () => null} onAiSettings={() => undefined} onExternalSetup={() => undefined}
        onOpenArtifact={() => undefined} onToast={onToast} />
    </DocContext.Provider>
    </ShownPanelsContext.Provider>
    </AppearanceContext.Provider>,
  );
  await waitFor(() => expect(registerDocument).toHaveBeenCalled());
  return { registerDocument, closeDocument, onUiState, onToast, saveArtifact: known.saveArtifact as ReturnType<typeof vi.fn> };
}
/** The editor's own word on unsaved edits (the Markdown editor says so from the moment it opens). */
const reports = (dirty: boolean) => act(() => editor.report!({ dirty, revision: 1, conflict: null, changed: dirty }));
const resizeTo = async (width: number) => { pane.width = width; await act(async () => { pane.resize.forEach((changed) => changed()); await new Promise((done) => setTimeout(done, 350)); }); };
const line = () => screen.queryByRole("status", { name: "좁은 칸 안내" });
/** The document's view (its 보기 group; the AI's input beside it has radios of its own). */
const mode = () => [...document.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="보기"] [role="radio"]')].find((button) => button.getAttribute("aria-checked") === "true")?.textContent;

// A size change never removes an editor that is already open, whatever it reports: the Word and
// PowerPoint editors say "unsaved" only every 2 seconds, so "it reports clean" does not mean it is.
// The app's own view is chosen by itself only when a document is opened into an already narrow
// pane, before any editor exists.
describe("a document opened in a pane too narrow for the embedded editor", () => {
  it("opens in the app's own view with one line saying why, and a button to open the editor anyway", async () => {
    await open(420);
    await screen.findByTestId("source");
    expect(screen.queryByTestId("office-editor")).toBeNull();
    // The editor was never mounted, and nothing was written.
    expect(editor.mounts).toBe(0);
    expect(editor.flushed).toBe(0);
    expect(mode()).toBe("원문");
    expect(line()?.textContent).toMatch(/칸이 좁아 원문으로 열었습니다/);
    fireEvent.click(screen.getByRole("button", { name: "편집기로 열기" }));
    await screen.findByTestId("office-editor");
    expect(line()).toBeNull();
    // Asked for: it stays, however the pane is resized, with nothing offered.
    await resizeTo(400);
    expect(screen.getByTestId("office-editor")).toBeTruthy();
    expect(line()).toBeNull();
    expect(editor.unmounts).toBe(0);
  });

  it("a Word document opened into a narrow pane opens as 글 보기, the editor never mounted", async () => {
    await open(420, "docx");
    await waitFor(() => expect(mode()).toBe("글 보기"));
    expect(editor.mounts).toBe(0);
    expect(line()?.textContent).toMatch(/칸이 좁아 글 보기로 열었습니다/);
  });

  it("a wide pane opens the editor, with no line", async () => {
    await open(1000);
    await screen.findByTestId("office-editor");
    expect(line()).toBeNull();
  });

  it("widening brings the editor in from the view the app chose — it mounts one, it removes none", async () => {
    await open(420);
    await screen.findByTestId("source");
    await resizeTo(1000);
    await screen.findByTestId("office-editor");
    expect(line()).toBeNull();
    expect(editor.unmounts).toBe(0);
  });

  it("widening does not switch views by itself while there are unsaved edits", async () => {
    await open(420);
    fireEvent.change(await screen.findByTestId("source"), { target: { value: "본문에 한 줄 더" } });
    await resizeTo(1000);
    expect(screen.getByTestId("source")).toBeTruthy();
    expect(screen.queryByTestId("office-editor")).toBeNull();
    expect(screen.getByRole("button", { name: "편집기로 열기" })).toBeTruthy();
  });
});

describe("an editor that is already open, when its pane becomes narrow", () => {
  // What the editor has said about unsaved edits by the time the pane narrows.
  const SAID = [
    ["has reported nothing yet", () => undefined],
    ["reported clean (its next report may be up to 2 s away)", () => reports(false)],
    ["reports unsaved edits", () => reports(true)],
  ] as const;

  it.each((["docx", "pptx", "markdown"] as const).flatMap((format) => SAID.map(([said, say]) => [format, said, say] as const)))(
    "%s, which %s: it stays — not removed, not saved, not flushed — and the other view is offered",
    async (format, _said, say) => {
      const view = await open(1000, format);
      await screen.findByTestId("office-editor");
      say();
      await resizeTo(430);
      expect(screen.getByTestId("office-editor")).toBeTruthy();
      expect(mode()).toBe("편집");
      expect(editor.mounts).toBe(1);
      expect(editor.unmounts).toBe(0);
      expect(editor.flushed).toBe(0);
      expect(view.saveArtifact).not.toHaveBeenCalled();
      expect(line()?.textContent).toMatch(/칸이 좁아/);
      expect(screen.getByRole("button", { name: format === "markdown" ? "원문으로 보기" : "글 보기로 바꾸기" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "편집기로 열기" })).toBeNull();
      // Narrower still, then wide again: the offer goes; the same editor was there throughout.
      await resizeTo(380);
      await resizeTo(1000);
      expect(line()).toBeNull();
      expect(editor.mounts).toBe(1);
      expect(editor.unmounts).toBe(0);
      expect(editor.flushed).toBe(0);
    },
  );

  // 곁 화면: the document's AI opens as a column beside it, which takes width from the document.
  it.each(["docx", "pptx", "markdown"] as const)("%s: its AI's conversation opening and closing beside it changes the editor's width only — not removed, not saved, not flushed", async (format) => {
    const view = await open(1000, format);
    await screen.findByTestId("office-editor");
    fireEvent.click(screen.getByRole("button", { name: "문서 AI" }));
    await waitFor(() => expect(document.querySelector(".agent-column")).toBeTruthy());
    // Whatever width the column leaves it (here less than the editor asks for), the editor stays.
    await resizeTo(600);
    expect(screen.getByTestId("office-editor")).toBeTruthy();
    expect(mode()).toBe("편집");
    expect(line()?.textContent).toMatch(/칸이 좁아/);
    fireEvent.click(document.querySelector<HTMLElement>(".agent-column .note-head .agent-close")!);
    await waitFor(() => expect(document.querySelector(".agent-column")).toBeNull());
    await resizeTo(1000);
    expect(line()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "문서 AI" }));
    await waitFor(() => expect(document.querySelector(".agent-column")).toBeTruthy());
    expect(editor.mounts).toBe(1);
    expect(editor.unmounts).toBe(0);
    expect(editor.flushed).toBe(0);
    expect(view.saveArtifact).not.toHaveBeenCalled();
    expect(view.closeDocument).not.toHaveBeenCalled();
    expect(new Set(view.registerDocument.mock.calls.map(([, input]) => input.viewId)).size).toBe(1);
  });

  it("원문으로 보기 is the person's own change of view: it saves first, as picking a view does, then switches — and that view stays theirs", async () => {
    await open(1000);
    await screen.findByTestId("office-editor");
    await resizeTo(430);
    fireEvent.click(screen.getByRole("button", { name: "원문으로 보기" }));
    await screen.findByTestId("source");
    // The ordinary switch: the editor is asked to flush, exactly once, before it goes.
    expect(editor.flushed).toBe(1);
    expect(mode()).toBe("원문");
    // Picked by the person: widening does not bring the editor back by itself.
    await resizeTo(1000);
    expect(screen.getByTestId("source")).toBeTruthy();
    expect(screen.queryByTestId("office-editor")).toBeNull();
  });

  it("the offer's button does what the view segment does", async () => {
    await open(1000);
    await screen.findByTestId("office-editor");
    await resizeTo(430);
    fireEvent.click(screen.getByRole("radio", { name: "원문" }));
    await screen.findByTestId("source");
    expect(editor.flushed).toBe(1);
    expect(line()).toBeNull();
  });

  it("원문으로 보기 keeps the editor when its edits cannot be saved, and says so", async () => {
    const view = await open(1000);
    await screen.findByTestId("office-editor");
    reports(true);
    await resizeTo(430);
    editor.flushResult = null;
    fireEvent.click(screen.getByRole("button", { name: "원문으로 보기" }));
    await waitFor(() => expect(view.onToast).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", text: expect.stringContaining("보기를 바꾸지 않았습니다") })));
    expect(screen.getByTestId("office-editor")).toBeTruthy();
    expect(editor.flushed).toBe(1);
    expect(editor.unmounts).toBe(0);
  });

  it("편집기로 열기 holds for that editor only: once the person picks another view, a later narrow pane offers again", async () => {
    await open(420);
    await screen.findByTestId("source");
    fireEvent.click(screen.getByRole("button", { name: "편집기로 열기" }));
    await screen.findByTestId("office-editor");
    // The person goes back to 원문, widens the pane and picks the editor there.
    fireEvent.click(screen.getByRole("radio", { name: "원문" }));
    await screen.findByTestId("source");
    await resizeTo(1000);
    fireEvent.click(screen.getByRole("radio", { name: "편집" }));
    await screen.findByTestId("office-editor");
    await resizeTo(430);
    expect(screen.getByTestId("office-editor")).toBeTruthy();
    expect(screen.getByRole("button", { name: "원문으로 보기" })).toBeTruthy();
  });

  it("keeps one writer lease throughout, and the tab remembers the editor as its view until the person picks another", async () => {
    const view = await open(420);
    await screen.findByTestId("source");
    await resizeTo(1000);
    await screen.findByTestId("office-editor");
    await resizeTo(420);
    expect(screen.getByTestId("office-editor")).toBeTruthy();
    expect(view.closeDocument).not.toHaveBeenCalled();
    expect(new Set(view.registerDocument.mock.calls.map(([, input]) => input.viewId)).size).toBe(1);
    // The stand-in view was never what the tab keeps: reopened in a wide pane, it is the editor again.
    expect(view.onUiState.mock.calls.filter(([state]) => "mode" in state).every(([state]) => state.mode === "rich")).toBe(true);
  });
});
