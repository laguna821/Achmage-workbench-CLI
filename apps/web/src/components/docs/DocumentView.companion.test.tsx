// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, Session, TranscriptItem, Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { initialState, type State } from "../../state.ts";
import { ShownPanels, ShownPanelsContext } from "../../completion-notifications.ts";
import { AppearanceContext, DEFAULT_APPEARANCE } from "../../appearance.ts";
import { persistDraft } from "../../draft.ts";
import { DocContext } from "../DocCards.tsx";
import DocumentView from "./DocumentView.tsx";

// 곁 화면, from a document tab: the document's own AI is a conversation column beside the document
// — the conversation's note head, Transcript and composer — in place of the drawer under it.

type Dock = { open: boolean; draft: string; sets: Array<boolean | [boolean, string]>; puts: string[]; pending: string | null; drawn: boolean; drawAfter: number | null; dead: boolean;
  /** As the real frame (hangul-studio.css, hwp-ai-dock.ts): at a narrow pane an open dock is hidden while a studio dialog is open, unless asked to open since (brought over). */
  narrow?: boolean; dialog?: boolean; over?: boolean };
const editor = vi.hoisted(() => ({ flushed: 0, mounts: 0, unmounts: 0, sidebar: null as boolean | null,
  // The Hangul editor's own AI dock: its state, what is typed in it, the tab's requests to it, and
  // whether it is drawn yet. As the real editor: nothing is said before the dock is drawn (shortly
  // after the frame mounts), a request then is answered "not ready", answers arrive later (a
  // message), and `dead` stands for a dock that never answers. As the real one it may be drawn OPEN
  // (Ieum remembers hwpapp.showAi=1 for every document once the dock was opened), and a draft put
  // in it REPLACES its input (open or closed: the panel stays mounted while collapsed), kept until drawn.
  dock: null as null | Dock, draw: null as null | (() => void),
  report: null as null | ((open: boolean, draft?: string, person?: boolean) => void), reload: null as null | (() => void),
  /** A studio dialog opened / closed (찾기 is modeless: the person may stay in that state), the pane made narrow / wide: the frame reports at once. */
  studio: null as null | ((dialog: boolean) => void), layout: null as null | ((narrow: boolean) => void) }));
vi.mock("./OfficeEditor.tsx", async () => {
  const React = await import("react");
  type Props = { onAiPanel?: (open: boolean, draft?: string, dock?: { ready: boolean; person: boolean; shown?: boolean }) => void; onReload?: () => void };
  return {
    OfficeEditor: React.forwardRef((props: Props, ref) => {
      const said = React.useRef(props);
      said.current = props;
      const tell = (person = false) => {
        const dock = editor.dock!;
        const open = dock.drawn && dock.open;
        if (!open) dock.over = false;
        said.current.onAiPanel?.(open, dock.draft, { ready: dock.drawn, person, shown: open && !(dock.narrow && dock.dialog && !dock.over) });
      };
      React.useImperativeHandle(ref, () => ({ flush: async () => { editor.flushed += 1; return 2; }, leave: async () => { editor.flushed += 1; },
        setAiPanel: (open: boolean, draft?: string) => setTimeout(() => {
          const dock = editor.dock;
          if (!dock || dock.dead) return;
          dock.sets.push(draft ? [open, draft] : open);
          if (draft !== undefined) dock.pending = draft;
          if (!dock.drawn) { tell(); return; }
          if (dock.pending !== null) { dock.draft = dock.pending; dock.pending = null; }
          // Asked to open while a dialog hides it: it comes over the dialog.
          if (open && dock.dialog) dock.over = true;
          dock.open = open;
          tell();
        }, 0),
        setAiDraft: (draft: string) => setTimeout(() => {
          const dock = editor.dock;
          if (!dock || dock.dead) return;
          dock.puts.push(draft);
          dock.pending = draft;
          if (dock.drawn) { dock.draft = draft; dock.pending = null; }
          tell();
        }, 0) }));
      // Word says whether its own AI sidebar is open at once; the Hangul dock only once it is drawn; the others say nothing.
      React.useEffect(() => {
        editor.mounts += 1;
        if (editor.sidebar !== null) props.onAiPanel?.(editor.sidebar);
        let timer: ReturnType<typeof setTimeout> | undefined;
        editor.draw = () => { const dock = editor.dock; if (dock && !dock.drawn) { dock.drawn = true; if (dock.pending !== null) { dock.draft = dock.pending; dock.pending = null; } if (!dock.dead) tell(); } };
        if (editor.dock?.drawAfter != null) timer = setTimeout(() => editor.draw?.(), editor.dock.drawAfter);
        editor.report = (open, draft, person = true) => { if (editor.dock) { editor.dock.open = open; editor.dock.draft = draft ?? editor.dock.draft; } tell(person); };
        // The editor reloads its frame in place (OfficeEditor's generation): a new page, a new dock drawn a moment later.
        editor.studio = (dialog) => { if (!editor.dock) return; editor.dock.dialog = dialog; editor.dock.over = false; if (editor.dock.drawn && !editor.dock.dead) tell(); };
        editor.layout = (narrow) => { if (!editor.dock) return; editor.dock.narrow = narrow; if (editor.dock.drawn && !editor.dock.dead) tell(); };
        editor.reload = () => { said.current.onReload?.(); editor.dock = { ...editor.dock!, draft: "", drawn: false, sets: [], puts: [], pending: null }; setTimeout(() => editor.draw?.(), 30); };
        return () => { clearTimeout(timer); editor.unmounts += 1; editor.report = null; editor.draw = null; editor.reload = null; editor.studio = null; editor.layout = null; };
      }, []);
      return React.createElement("div", { "data-testid": "office-editor" });
    }),
  };
});
vi.mock("./MarkdownEditor.tsx", async () => {
  const React = await import("react");
  return { MarkdownEditor: (props: { value: string; readOnly?: boolean; onChange: (text: string) => void }) => React.createElement("textarea", { "data-testid": "source", value: props.value, readOnly: Boolean(props.readOnly), onChange: (event: { target: { value: string } }) => props.onChange(event.target.value) }) };
});

// Widths as the browser would report them: the document column's, and the whole view's.
const pane = { doc: 1100, host: 1100, resize: [] as (() => void)[] };
beforeEach(() => {
  pane.doc = 1100; pane.host = 1100; pane.resize = [];
  editor.flushed = 0; editor.mounts = 0; editor.unmounts = 0; editor.sidebar = null; editor.dock = null; editor.report = null; editor.draw = null;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("ResizeObserver", class { constructor(changed: () => void) { pane.resize.push(changed); } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains("document-view") ? pane.doc : this.classList.contains("beside") ? pane.host : 0;
    return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const work = { id: "w", title: "강의", cwd: "/w", folderId: null, archivedAt: null } as unknown as Work;
const base = { id: "doc", workId: "w", name: "강의안.md", path: "/w/강의안.md", format: "markdown", revision: 1, sha256: "", size: 4, diskState: "same", readBy: {}, createdAt: 1, updatedAt: 1 } as Artifact;
const MAIN = { id: "main", workId: "w", provider: "claude", purpose: "슬라이드 정리", status: "idle", queued: [], archivedAt: null, createdAt: 1, updatedAt: 1 } as unknown as Session;
const ai = (extra: Partial<Session> = {}) => ({ id: "a", workId: "w", provider: "codex", purpose: "강의안.md · 문서 AI", status: "idle", queued: [], archivedAt: null, model: null, effort: null, createdAt: 1, updatedAt: 1, documentAgent: { artifactId: "doc", parentSessionId: "main" }, ...extra }) as unknown as Session;
const user = (id: string, text: string): TranscriptItem => ({ id, kind: "user", text, at: 1 }) as unknown as TranscriptItem;
const approval = (id: string): TranscriptItem => ({ id, kind: "approval", title: "이 명령을 실행할까요?", detail: "ls", decision: null, at: 2 }) as unknown as TranscriptItem;

function setup(options: { format?: Artifact["format"]; name?: string; agent?: Session; items?: TranscriptItem[]; hosted?: boolean | { over: boolean; back?: string | null }; extra?: Record<string, Session>; transcripts?: Record<string, TranscriptItem[]>; closeFails?: boolean; revisions?: unknown[] } = {}) {
  const artifact = { ...base, format: options.format ?? base.format, name: options.name ?? base.name } as Artifact;
  const agent = options.agent ?? ai();
  // As the gateway: the writer lease only for a view that claims it.
  const writers = new Set<string>();
  const registerDocument = vi.fn(async (artifactId: string, input: { viewId: string; windowId: string; sessionId?: string | null; claim?: boolean }) => {
    if (input.claim) writers.add(input.viewId);
    const writes = writers.has(input.viewId);
    const view = { artifactId, viewId: input.viewId, windowId: input.windowId, sessionId: input.sessionId ?? null, revision: 1, dirty: false, label: "", mode: writes ? "write" : "read", expiresAt: Date.now() + 60_000 };
    return { view, writer: null, writeToken: writes ? "lease" : null };
  });
  const closeDocument = vi.fn(async () => undefined);
  const saveArtifact = vi.fn(async () => ({ revision: 2 }));
  const known: Record<string, unknown> = {
    registerDocument, closeDocument, saveArtifact, documentSession: vi.fn(async () => agent),
    artifactText: vi.fn(async () => ({ artifact, revision: 1, text: "본문", editable: true, view: false })),
    resolveReferences: vi.fn(async (refs: unknown[]) => ({ refs })), documentViews: vi.fn(async () => ({ views: [] })),
  };
  if (options.revisions) known.revisions = vi.fn(async () => options.revisions);
  if (options.closeFails) known.closeOfficePreview = vi.fn(async () => { throw new Error("편집기를 닫지 못했습니다."); });
  const api: Api = new Proxy(known, {
    get: (target, key: string) => (key === "forDocument" ? () => api : key in target ? target[key] : key === "then" ? undefined : vi.fn(async () => ({}))),
  }) as unknown as Api;
  const models = [{ id: "fake", label: "Fake", description: null, efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true }];
  const transcripts = Object.fromEntries(Object.entries({ [agent.id]: options.items ?? [], ...options.transcripts }).map(([id, items]) => [id, { items, hasMore: false }]));
  const state = { ...initialState, ready: true, works: { w: work }, artifacts: { doc: artifact }, sessions: { main: MAIN, [agent.id]: agent, ...options.extra }, transcripts, providers: { codex: { models }, claude: { models } } } as unknown as State;
  const onSend = vi.fn(async () => true), onToast = vi.fn(), onBack = vi.fn(), onAnswer = vi.fn(), onSessionMenu = vi.fn(), onRevealDone = vi.fn();
  const hosted = options.hosted ? { onClose: vi.fn(), onWide: vi.fn(), onAgent: vi.fn(), over: typeof options.hosted === "object" ? options.hosted.over : false, back: typeof options.hosted === "object" ? options.hosted.back ?? null : null } : undefined;
  const guard: { current: ((reason?: "close" | "discard") => Promise<void>) | null } = { current: null };
  const handle: { current: import("../../doc-editors.ts").EditorHandle | null } = { current: null };
  const onBeside = vi.fn(), onRead = vi.fn();
  const panels = new ShownPanels();
  const view = (reveal: { sessionId: string } | null = null, focusItem: { sessionId: string; itemId: string; nonce: number } | null = null) => (
    <AppearanceContext.Provider value={{ lookOf: (provider: "codex" | "claude") => DEFAULT_APPEARANCE[provider].light } as React.ContextType<typeof AppearanceContext>}>
    <ShownPanelsContext.Provider value={panels}>
    <DocContext.Provider value={{ state, actions: new Proxy({}, { get: () => vi.fn() }) } as never}>
      <DocumentView api={api} state={state} artifactId="doc" focusProposalId={null} work={work} session={options.hosted ? MAIN : agent} onBack={onBack}
        onSend={onSend as never} onPickTarget={async () => null} onAiSettings={() => undefined} onExternalSetup={() => undefined} onAnswer={onAnswer}
        onOpenArtifact={() => undefined} onToast={onToast} revealAgent={reveal} onRevealDone={onRevealDone} onSessionMenu={onSessionMenu} hosted={hosted} focusItem={focusItem} onBeside={hosted ? undefined : onBeside} onRead={onRead}
        onLeaveGuard={(next) => { guard.current = next; }} onEditorHandle={(_id, _view, next) => { handle.current = next; }} />
    </DocContext.Provider>
    </ShownPanelsContext.Provider>
    </AppearanceContext.Provider>
  );
  const shown = render(view());
  return { shown, view, panels, onSend, onToast, onBack, onAnswer, onSessionMenu, onRevealDone, hosted, onBeside, onRead, registerDocument, closeDocument, saveArtifact, agent, guard, handle };
}
const column = () => document.querySelector<HTMLElement>(".agent-column");
/** The column's note head (the same buttons ride the pinned band once the head scrolls away). */
const head = () => within(column()!.querySelector<HTMLElement>(".note-head")!);
const toggle = () => screen.getByRole("button", { name: /^문서 AI/ });
const resize = async (doc: number, host = pane.host) => { pane.doc = doc; pane.host = host; await act(async () => { pane.resize.forEach((changed) => changed()); await new Promise((done) => setTimeout(done, 350)); }); };

describe("a document's own AI, beside the document", () => {
  it("is a conversation column: a head naming whose it is, its transcript, and its input directly under that transcript", async () => {
    const at = setup({ format: "text", name: "메모.txt", items: [user("u1", "서론을 줄여 줘")] });
    await waitFor(() => expect(at.registerDocument).toHaveBeenCalled());
    expect(column()).toBeNull();
    fireEvent.click(toggle());
    const chat = await waitFor(() => { const found = column(); expect(found).not.toBeNull(); return found!; });
    expect(within(chat).getByRole("heading", { level: 1 }).textContent).toBe("문서 AI · 메모.txt");
    // The conversation this AI was started from is one press away.
    fireEvent.click(within(chat).getByRole("button", { name: /슬라이드 정리/ }));
    await waitFor(() => expect(at.onBack).toHaveBeenCalled());
    // The same Transcript as a conversation, the request in it.
    const transcript = within(chat).getByRole("region", { name: "Codex 대화" });
    expect(transcript.textContent).toContain("서론을 줄여 줘");
    // One input, in this column, after its transcript — and none under the document.
    const inputs = [...document.querySelectorAll("textarea")].filter((element) => element.closest(".hig-composer, .composer"));
    expect(inputs).toHaveLength(1);
    expect(chat.contains(inputs[0]!)).toBe(true);
    expect(transcript.compareDocumentPosition(inputs[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector(".document-view")!.contains(inputs[0]!)).toBe(false);
    // The drawer and its sheet are gone.
    expect(document.querySelector(".drawer, .drawer-sheet")).toBeNull();
    expect(screen.queryByRole("region", { name: "대화 서랍" })).toBeNull();
  });

  it("sends what is typed there to the document's AI", async () => {
    const at = setup({ format: "text", name: "메모.txt" });
    fireEvent.click(toggle());
    await waitFor(() => expect(column()?.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false));
    fireEvent.change(column()!.querySelector("textarea")!, { target: { value: "요약해 줘" } });
    fireEvent.click(within(column()!).getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(at.onSend).toHaveBeenCalled());
    expect((at.onSend.mock.calls[0] as unknown as [Session, string])[0].id).toBe("a");
    expect((at.onSend.mock.calls[0] as unknown as [Session, string])[1]).toBe("요약해 줘");
  });

  it("text typed in the old drawer's input is in the column's input", async () => {
    persistDraft("doc:doc", "쓰다 만 요청");
    setup({ format: "text", name: "메모.txt" });
    fireEvent.click(toggle());
    await waitFor(() => expect(column()?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("쓰다 만 요청"));
  });

  it("carries the AI's own menu and the close button in its head", async () => {
    const at = setup({ format: "text", name: "메모.txt" });
    fireEvent.click(toggle());
    await waitFor(() => expect(column()).not.toBeNull());
    fireEvent.click(head().getByRole("button", { name: "이 문서 AI 메뉴" }));
    expect(at.onSessionMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), expect.any(Number), expect.any(Number));
    fireEvent.click(head().getByRole("button", { name: "문서 AI 대화 닫기" }));
    await waitFor(() => expect(column()).toBeNull());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("a waiting approval is answered in the column, for that AI", async () => {
    const at = setup({ format: "text", name: "메모.txt", agent: ai({ status: "awaitingApproval" }), items: [user("u1", "폴더를 봐 줘"), approval("ap1")] });
    fireEvent.click(toggle());
    await waitFor(() => expect(column()).not.toBeNull());
    fireEvent.click(within(column()!).getByRole("button", { name: /허용/ }));
    expect(at.onAnswer).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "ap1", "accept", undefined);
  });

  it("counts the AI as looked at only while the column shows it", async () => {
    const at = setup({ format: "text", name: "메모.txt" });
    await waitFor(() => expect(at.registerDocument).toHaveBeenCalled());
    expect(at.panels.ids()).toEqual([]);
    fireEvent.click(toggle());
    await waitFor(() => expect(at.panels.ids()).toEqual(["a"]));
    fireEvent.click(head().getByRole("button", { name: "문서 AI 대화 닫기" }));
    await waitFor(() => expect(at.panels.ids()).toEqual([]));
  });
});

describe("the document's AI was archived", () => {
  it("its conversation stays readable in the column — nothing in it can be answered, and one line stands where the input was", async () => {
    const at = setup({ format: "text", name: "메모.txt", agent: ai({ archivedAt: 9, status: "awaitingApproval" } as Partial<Session>), items: [user("u1", "폴더를 봐 줘"), approval("ap1")] });
    await waitFor(() => expect(at.registerDocument).toHaveBeenCalled());
    fireEvent.click(toggle());
    await waitFor(() => expect(column()?.textContent).toContain("폴더를 봐 줘"));
    expect(column()!.querySelector("textarea")).toBeNull();
    expect(within(column()!).queryByRole("button", { name: /허용/ })).toBeNull();
    expect(within(column()!).getByRole("status", { name: "문서 AI 안내" }).textContent).toMatch(/보관/);
    // Its head says what it is, not the status it stopped in.
    expect(column()!.querySelector(".note-head")!.textContent).toContain("보관됨");
    expect(column()!.querySelector(".note-head")!.textContent).not.toContain("승인 필요");
    // Looking at an archived conversation changes nothing: it is not counted as seen.
    expect(at.panels.ids()).toEqual([]);
  });
});

describe("the column and an embedded editor", () => {
  it.each(["markdown", "pptx"] as const)("%s (says nothing of its own AI panel): a row click opens the app's own column — no notice pointing at another panel", async (format) => {
    const at = setup({ format, name: format === "markdown" ? "강의안.md" : `문서.${format}` });
    await screen.findByTestId("office-editor");
    at.shown.rerender(at.view({ sessionId: "a" }));
    await waitFor(() => expect(column()).not.toBeNull());
    expect(at.onToast).not.toHaveBeenCalled();
    await waitFor(() => expect(at.panels.ids()).toEqual(["a"]));
    await waitFor(() => expect(at.onRevealDone).toHaveBeenCalledTimes(1));
  });

  it("Word with its own AI sidebar open: a row click does not put the app's column beside it too — the sidebar already shows the conversation", async () => {
    editor.sidebar = true;
    const at = setup({ format: "docx", name: "보고서.docx" });
    await screen.findByTestId("office-editor");
    at.shown.rerender(at.view({ sessionId: "a" }));
    await waitFor(() => expect(at.onRevealDone).toHaveBeenCalledTimes(1));
    await new Promise((done) => setTimeout(done, 30));
    expect(column()).toBeNull();
    expect(at.onToast).not.toHaveBeenCalled();
    expect(at.panels.ids()).toEqual(["a"]);
  });

  it("Word with its own AI sidebar closed: a row click opens the app's column", async () => {
    editor.sidebar = false;
    const at = setup({ format: "docx", name: "보고서.docx" });
    await screen.findByTestId("office-editor");
    at.shown.rerender(at.view({ sessionId: "a" }));
    await waitFor(() => expect(column()).not.toBeNull());
    await waitFor(() => expect(at.panels.ids()).toEqual(["a"]));
  });

  // The editor keeps a 360px AI panel of its own beside the page. Side by side with the app's
  // column it needs its 680 and that panel; with less the column lies over, never squeezing it.
  it("never squeezes the editor: at 1136 (a 1440 window) the column lies over as a sheet; with room for the editor and its own panel it is beside", async () => {
    setup();
    await screen.findByTestId("office-editor");
    await resize(1136, 1136);
    fireEvent.click(toggle());
    await waitFor(() => expect(column()).not.toBeNull());
    const host = () => document.querySelector<HTMLElement>(".beside")!;
    expect(host().dataset.fit).toBe("over");
    expect(host().querySelector(".beside-chat")!.hasAttribute("data-covers-web")).toBe(true);
    expect(host().querySelector(".beside-content")!.hasAttribute("inert")).toBe(true);
    // 360 + 7 + 680 + 360 = 1407 (and a little more to come back beside).
    await resize(1100, 1430);
    expect(host().dataset.fit).toBe("beside");
    expect(host().querySelector<HTMLElement>(".beside-chat")!.style.flex).toBe("0 0 383px");
    await resize(1000, 1380);
    expect(host().dataset.fit).toBe("over");
    expect(editor.mounts).toBe(1);
    expect(editor.unmounts).toBe(0);
    expect(editor.flushed).toBe(0);
  });

  it("Word that says its own AI sidebar is closed needs only its 680 beside the column", async () => {
    editor.sidebar = false;
    setup({ format: "docx", name: "보고서.docx" });
    await screen.findByTestId("office-editor");
    await resize(1136, 1136);
    fireEvent.click(toggle());
    await waitFor(() => expect(column()).not.toBeNull());
    expect(document.querySelector<HTMLElement>(".beside")!.dataset.fit).toBe("beside");
  });

  it("the app's own view of the document (원문) needs a pane's minimum only: the column is beside it", async () => {
    setup({ format: "text", name: "메모.txt" });
    await screen.findByTestId("source");
    await resize(760, 760);
    fireEvent.click(toggle());
    await waitFor(() => expect(column()).not.toBeNull());
    expect(document.querySelector<HTMLElement>(".beside")!.dataset.fit).toBe("beside");
  });

  it("opening and closing the column never removes, saves or flushes the editor, laid over or beside", async () => {
    const at = setup();
    await screen.findByTestId("office-editor");
    for (const width of [1136, 1500]) {
      await resize(width - 400, width);
      fireEvent.click(toggle());
      await waitFor(() => expect(column()).not.toBeNull());
      await resize(width - 420, width);
      fireEvent.click(head().getByRole("button", { name: "문서 AI 대화 닫기" }));
      await waitFor(() => expect(column()).toBeNull());
    }
    expect(screen.getByTestId("office-editor")).toBeTruthy();
    expect(editor.mounts).toBe(1);
    expect(editor.unmounts).toBe(0);
    expect(editor.flushed).toBe(0);
    expect(at.saveArtifact).not.toHaveBeenCalled();
    expect(at.closeDocument).not.toHaveBeenCalled();
    expect(new Set(at.registerDocument.mock.calls.map(([, input]) => input.viewId)).size).toBe(1);
  });
});

// The Hangul editor's own AI dock is the document's one AI entry while editing (H7 ruling): the
// tab's 문서 AI button opens and closes it; the app's column is not shown beside it; in 글 보기 the
// button opens the column. Never two AI inputs for one document. The tab keeps its wish until the
// dock agrees; the button shows what is on screen.
describe("a Hangul document's one AI entry", () => {
  const newDock = (extra: Partial<Dock> = {}): Dock => ({ open: false, draft: "", sets: [], puts: [], pending: null, drawn: false, drawAfter: 30, dead: false, ...extra });
  const hangul = (extra: Partial<Dock> = {}, options: Parameters<typeof setup>[0] = {}) => { persistDraft("doc:doc", ""); editor.dock = newDock(extra); return setup({ format: "hwpx", name: "공문.hwpx", ...options }); };
  const dockOpen = () => editor.dock!.drawn && editor.dock!.open;
  const mode = (label: string) => fireEvent.click(screen.getByRole("radio", { name: label }));
  const inputs = () => (dockOpen() && screen.queryByTestId("office-editor") ? 1 : 0) + (column()?.querySelector("textarea") ? 1 : 0);
  // The head's button (the open column has a 문서 AI button of its own in its head).
  const toggle = () => document.querySelector<HTMLButtonElement>(".doc-header-right .doc-agent-toggle")!;
  const pressed = () => toggle().getAttribute("aria-expanded");
  const drawn = () => waitFor(() => expect(editor.dock!.drawn).toBe(true));

  it("while editing, 문서 AI opens and closes the editor's own dock, never the column; the button follows the dock; nothing remounts", async () => {
    hangul();
    await screen.findByTestId("office-editor");
    await drawn();
    for (const [doc, host] of [[1440, 1440], [760, 760]]) {
      await resize(doc, host);
      expect(pressed()).toBe("false");
      fireEvent.click(toggle());
      await waitFor(() => expect(dockOpen()).toBe(true));
      await waitFor(() => expect(pressed()).toBe("true"));
      expect(column()).toBeNull();
      expect(inputs()).toBe(1);
      // The dock's own close button: the tab's button follows, and the dock is not opened again.
      act(() => editor.report!(false));
      await waitFor(() => expect(pressed()).toBe("false"));
      await new Promise((done) => setTimeout(done, 300));
      expect(dockOpen()).toBe(false);
      expect(column()).toBeNull();
      expect(inputs()).toBe(0);
    }
    expect(editor.dock!.sets).toEqual([true, true]);
    expect(editor.mounts).toBe(1);
    expect(editor.unmounts).toBe(0);
    expect(editor.flushed).toBe(0);
  });

  it("pressed before the editor has drawn its dock: the button is not shown pressed until the dock is open, and the dock opens once drawn", async () => {
    hangul({ drawAfter: null });
    await screen.findByTestId("office-editor");
    fireEvent.click(toggle());
    await new Promise((done) => setTimeout(done, 50));
    expect(pressed()).toBe("false");
    expect(toggle().getAttribute("aria-busy")).toBe("true");
    act(() => editor.draw!());
    await waitFor(() => expect(dockOpen()).toBe(true));
    await waitFor(() => expect(pressed()).toBe("true"));
    expect(toggle().getAttribute("aria-busy")).toBeNull();
  });

  it("글 보기 with the column open → 편집: the dock opens once the editor draws it (closed), showing what was typed in the column (the one draft); the button keeps working", async () => {
    hangul({ open: false });
    await screen.findByTestId("office-editor");
    await drawn();
    mode("글 보기");
    await waitFor(() => expect(screen.queryByTestId("office-editor")).toBeNull());
    fireEvent.click(toggle());
    await waitFor(() => expect(column()).not.toBeNull());
    fireEvent.change(column()!.querySelector("textarea")!, { target: { value: "표를 두 줄로 줄여 줘" } });
    // The new editor's dock: drawn closed a moment after the frame mounts.
    editor.dock = newDock();
    mode("편집");
    await screen.findByTestId("office-editor");
    await waitFor(() => expect(dockOpen()).toBe(true));
    await waitFor(() => expect(pressed()).toBe("true"));
    expect(column()).toBeNull();
    expect(inputs()).toBe(1);
    expect(editor.dock!.draft).toBe("표를 두 줄로 줄여 줘");
    // One draft: what the stored draft holds is what the dock shows (never a second copy added to it).
    expect(localStorage.getItem("workbench.draft.doc:doc")).toBe("표를 두 줄로 줄여 줘");
    // The button still works.
    fireEvent.click(toggle());
    await waitFor(() => expect(dockOpen()).toBe(false));
    await waitFor(() => expect(pressed()).toBe("false"));
    fireEvent.click(toggle());
    await waitFor(() => expect(dockOpen()).toBe(true));
    await waitFor(() => expect(pressed()).toBe("true"));
  });

  it("편집 → 글 보기 keeps what was typed in the dock, also right after the last key, and back to 편집 opens the dock", async () => {
    hangul();
    await screen.findByTestId("office-editor");
    await drawn();
    fireEvent.click(toggle());
    await waitFor(() => expect(dockOpen()).toBe(true));
    act(() => editor.report!(true, "표를 두 줄로 줄여 줘", false));
    mode("글 보기");
    await waitFor(() => expect(screen.queryByTestId("office-editor")).toBeNull());
    await waitFor(() => expect(column()).not.toBeNull());
    expect(inputs()).toBe(1);
    expect(pressed()).toBe("true");
    expect(column()!.querySelector("textarea")!.value).toBe("표를 두 줄로 줄여 줘");
    editor.dock = newDock();
    mode("편집");
    await screen.findByTestId("office-editor");
    await waitFor(() => expect(dockOpen()).toBe(true));
    await waitFor(() => expect(column()).toBeNull());
    expect(inputs()).toBe(1);
  });

  it("a dock the person left open opens open, with no column beside it", async () => {
    hangul({ open: true });
    await screen.findByTestId("office-editor");
    await waitFor(() => expect(pressed()).toBe("true"));
    expect(column()).toBeNull();
    expect(editor.dock!.sets).toEqual([]);
  });

  it("a click on the document AI's row opens the dock while editing, not the column — also before the dock is drawn", async () => {
    const at = hangul();
    await screen.findByTestId("office-editor");
    at.shown.rerender(at.view({ sessionId: "a" }));
    await waitFor(() => expect(dockOpen()).toBe(true));
    expect(column()).toBeNull();
    await waitFor(() => expect(at.panels.ids()).toEqual(["a"]));
  });

  it("a notice's link to the document's AI while editing: the column shows that conversation beside the editor, the dock closes; never two inputs", async () => {
    const older = ai({ id: "old", provider: "claude", purpose: "공문.hwpx · 문서 AI" });
    const at = hangul({}, { extra: { old: older }, transcripts: { old: [user("o1", "지난번 요청")] }, items: [user("u1", "지금 요청")] });
    await screen.findByTestId("office-editor");
    await drawn();
    fireEvent.click(toggle());
    await waitFor(() => expect(dockOpen()).toBe(true));
    at.shown.rerender(at.view(null, { sessionId: "old", itemId: "o1", nonce: 1 }));
    await waitFor(() => expect(column()?.textContent).toContain("지난번 요청"));
    await waitFor(() => expect(dockOpen()).toBe(false));
    expect(pressed()).toBe("true");
    expect(inputs()).toBe(0);
    // The current conversation's own item: shown with its input, the dock stays closed.
    at.shown.rerender(at.view(null, { sessionId: "a", itemId: "u1", nonce: 2 }));
    await waitFor(() => expect(column()?.textContent).toContain("지금 요청"));
    expect(inputs()).toBe(1);
    // Closing the column: the dock comes back as it was wished.
    fireEvent.click(column()!.querySelector<HTMLButtonElement>(".agent-close")!);
    await waitFor(() => expect(column()).toBeNull());
    await waitFor(() => expect(dockOpen()).toBe(true));
    expect(inputs()).toBe(1);
  });

  it("a notice opened from the attention list (it asks for the AI and points at an item at once) with the dock closed: the column shows it; closed, the dock stays closed", async () => {
    const at = hangul({}, { items: [user("u1", "지금 요청")] });
    await screen.findByTestId("office-editor");
    await drawn();
    at.shown.rerender(at.view({ sessionId: "a" }, { sessionId: "a", itemId: "u1", nonce: 5 }));
    await waitFor(() => expect(column()?.textContent).toContain("지금 요청"));
    expect(dockOpen()).toBe(false);
    fireEvent.click(column()!.querySelector<HTMLButtonElement>(".agent-close")!);
    await waitFor(() => expect(column()).toBeNull());
    await new Promise((done) => setTimeout(done, 300));
    expect(dockOpen()).toBe(false);
    expect(pressed()).toBe("false");
  });

  it("the document's AI waits for an approval while editing (dock open or closed): the line opens the column beside the editor and it is answered there", async () => {
    for (const dockWasOpen of [false, true]) {
      const at = hangul({}, { agent: ai({ status: "awaitingApproval" }), items: [user("u1", "폴더를 봐 줘"), approval("ap1")] });
      await screen.findByTestId("office-editor");
      await drawn();
      if (dockWasOpen) { fireEvent.click(toggle()); await waitFor(() => expect(dockOpen()).toBe(true)); }
      const line = await screen.findByRole("button", { name: /문서 AI · 승인 필요.*열기/ });
      fireEvent.click(line);
      await waitFor(() => expect(column()).not.toBeNull());
      fireEvent.click(within(column()!).getByRole("button", { name: /허용/ }));
      expect(at.onAnswer).toHaveBeenCalled();
      await waitFor(() => expect(dockOpen()).toBe(false));
      expect(inputs()).toBe(1);
      expect(pressed()).toBe("true");
      cleanup();
    }
  });

  it("an older revision shown over the editor: 문서 AI opens the column (the editor and its dock are not on screen)", async () => {
    const revision = (n: number) => ({ revision: n, author: "user", at: 1, sessionId: null, note: null });
    hangul({}, { revisions: [revision(0), revision(1)] });
    await screen.findByTestId("office-editor");
    await drawn();
    fireEvent.click(screen.getByRole("button", { name: /^r1/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^r0 ·/ }));
    await screen.findByText(/r0을 보는 중입니다/);
    fireEvent.click(toggle());
    await waitFor(() => expect(column()).not.toBeNull());
    expect(pressed()).toBe("true");
    expect(dockOpen()).toBe(false);
  });

  it("closing the AI while an older revision is shown keeps it closed back in the editor (the dock does not come back open)", async () => {
    const revision = (n: number) => ({ revision: n, author: "user", at: 1, sessionId: null, note: null });
    hangul({}, { revisions: [revision(0), revision(1)] });
    await screen.findByTestId("office-editor");
    await drawn();
    fireEvent.click(toggle());
    await waitFor(() => expect(dockOpen()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /^r1/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^r0 ·/ }));
    await screen.findByText(/r0을 보는 중입니다/);
    await waitFor(() => expect(column()).not.toBeNull());
    fireEvent.click(toggle());
    await waitFor(() => expect(column()).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "최신 판으로" }));
    await waitFor(() => expect(dockOpen()).toBe(false));
    await waitFor(() => expect(pressed()).toBe("false"));
  });

  it("the head's 문서 AI button has the app's pressed look while the AI is on screen (as the app's other pressed buttons)", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(`${process.cwd()}/apps/web/src/styles/companion.css`, "utf8").replace(/\s+/g, " ");
    const rule = /\.doc-agent-toggle\[aria-expanded="true"\][^{]*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("background: var(--accent-soft)");
    expect(rule).toContain("color: var(--accent)");
  });

  it("a dock that never answers: after a few tries the button is not pressed and one line says so", async () => {
    hangul({ dead: true });
    await screen.findByTestId("office-editor");
    // Drawn but silent: the tab cannot hear it, so here it reports once as drawn and then stops answering.
    editor.dock!.dead = false; act(() => editor.draw!()); editor.dock!.dead = true;
    await waitFor(() => expect(editor.dock!.drawn).toBe(true));
    fireEvent.click(toggle());
    await waitFor(() => expect(document.querySelector(".doc-dock-failed")).not.toBeNull(), { timeout: 5000 });
    expect(document.querySelector(".doc-dock-failed")!.textContent).toContain("열리지 않았습니다");
    expect(pressed()).toBe("false");
    expect(toggle().getAttribute("aria-busy")).toBeNull();
  }, 10_000);

  // Ruling D (round 4, H7-R3-1): the button shows what is on screen (the dock's `shown`, not `open`),
  // and a press always gets the AI: at a narrow pane a studio dialog (찾기 is modeless) hides the
  // open dock; a press brings it over the dialog.
  const shownNow = () => dockOpen() && !(editor.dock!.narrow && editor.dock!.dialog && !editor.dock!.over);
  it("H7-R3-1: narrow, dock open with text, 찾기 opened → not pressed; 문서 AI brings the dock over it; pressed again → closed; when the dialog closes the dock is as it would have been", async () => {
    hangul();
    await screen.findByTestId("office-editor");
    await drawn();
    act(() => editor.layout!(true));
    fireEvent.click(toggle());
    await waitFor(() => expect(pressed()).toBe("true"));
    act(() => editor.report!(true, "대화상자 뒤에 남는 글", false));
    act(() => editor.studio!(true));
    // Hidden for the dialog: the button does not say "open".
    await waitFor(() => expect(pressed()).toBe("false"));
    expect(dockOpen()).toBe(true);
    // Left alone, the tab does not force it back over the dialog.
    await new Promise((done) => setTimeout(done, 300));
    expect(shownNow()).toBe(false);
    expect(toggle().getAttribute("aria-busy")).toBeNull();
    // The person asks for the AI: it is on screen, over the dialog, with its text.
    fireEvent.click(toggle());
    await waitFor(() => expect(shownNow()).toBe(true));
    await waitFor(() => expect(pressed()).toBe("true"));
    expect(editor.dock!.draft).toBe("대화상자 뒤에 남는 글");
    // The next press closes it as usual.
    fireEvent.click(toggle());
    await waitFor(() => expect(dockOpen()).toBe(false));
    await waitFor(() => expect(pressed()).toBe("false"));
    // Closed with the dialog still open: a press opens it visible over the dialog the same way.
    fireEvent.click(toggle());
    await waitFor(() => expect(shownNow()).toBe(true));
    await waitFor(() => expect(pressed()).toBe("true"));
    // Another dialog: hidden again, not pressed; the dialogs close: shown again, pressed, its text kept.
    act(() => editor.studio!(true));
    await waitFor(() => expect(pressed()).toBe("false"));
    act(() => editor.studio!(false));
    await waitFor(() => expect(pressed()).toBe("true"));
    expect(shownNow()).toBe(true);
    expect(editor.dock!.draft).toBe("대화상자 뒤에 남는 글");
    expect(document.querySelector(".doc-dock-failed")).toBeNull();
  }, 10_000);

  it("the pressed look in every case {dock open / closed} × {dialog open / closed} × {narrow / wide}, and a press in each gives a visible result", async () => {
    hangul();
    await screen.findByTestId("office-editor");
    await drawn();
    const seen: string[] = [];
    for (const narrow of [false, true]) for (const open of [false, true]) for (const dialog of [false, true]) {
      // The state: the dock as the person left it, then the dialog, at this width.
      act(() => { editor.studio!(false); editor.layout!(narrow); });
      if (open !== dockOpen()) { fireEvent.click(toggle()); await waitFor(() => expect(dockOpen()).toBe(open)); }
      act(() => editor.studio!(dialog));
      const hidden = open && narrow && dialog;
      await waitFor(() => expect(pressed()).toBe(String(open && !hidden)));
      // A press: what was on screen goes away, what was not comes (over the dialog if one is open).
      fireEvent.click(toggle());
      if (open && !hidden) {
        await waitFor(() => expect(dockOpen()).toBe(false));
        await waitFor(() => expect(pressed()).toBe("false"));
      } else {
        await waitFor(() => expect(shownNow()).toBe(true));
        await waitFor(() => expect(pressed()).toBe("true"));
      }
      seen.push(`${narrow ? "narrow" : "wide"} ${open ? "open" : "closed"} ${dialog ? "dialog" : "-"}: ${open && !hidden ? "pressed→closed" : "not pressed→shown"}`);
    }
    expect(seen).toEqual([
      "wide closed -: not pressed→shown", "wide closed dialog: not pressed→shown", "wide open -: pressed→closed", "wide open dialog: pressed→closed",
      "narrow closed -: not pressed→shown", "narrow closed dialog: not pressed→shown", "narrow open -: pressed→closed", "narrow open dialog: not pressed→shown",
    ]);
  }, 20_000);

  // Ruling B (round 3): the failure line's advice works — pressing 문서 AI tries again (afresh, with
  // the same bounded retries); 글 보기 opens the conversation; the pressed look follows the screen.
  it("after the failure line, pressing 문서 AI tries again and opens the dock once it answers; 글 보기 opens the conversation", async () => {
    hangul({ dead: true });
    await screen.findByTestId("office-editor");
    editor.dock!.dead = false; act(() => editor.draw!()); editor.dock!.dead = true;
    await waitFor(() => expect(editor.dock!.drawn).toBe(true));
    fireEvent.click(toggle());
    await waitFor(() => expect(document.querySelector(".doc-dock-failed")).not.toBeNull(), { timeout: 5000 });
    const before = editor.dock!.sets.length;
    // The dock would answer now.
    editor.dock!.dead = false;
    fireEvent.click(toggle());
    expect(document.querySelector(".doc-dock-failed")).toBeNull();
    expect(toggle().getAttribute("aria-busy")).toBe("true");
    expect(pressed()).toBe("false");
    await waitFor(() => expect(dockOpen()).toBe(true));
    await waitFor(() => expect(pressed()).toBe("true"));
    expect(editor.dock!.sets.length).toBeGreaterThan(before);
    // The button keeps working.
    fireEvent.click(toggle());
    await waitFor(() => expect(dockOpen()).toBe(false));
    await waitFor(() => expect(pressed()).toBe("false"));
    // Failing again, pressed again while it still does not answer: the line comes back after the same few tries, never an endless loop.
    editor.dock!.dead = true;
    fireEvent.click(toggle());
    await waitFor(() => expect(document.querySelector(".doc-dock-failed")).not.toBeNull(), { timeout: 5000 });
    fireEvent.click(toggle());
    expect(document.querySelector(".doc-dock-failed")).toBeNull();
    await waitFor(() => expect(document.querySelector(".doc-dock-failed")).not.toBeNull(), { timeout: 5000 });
    // The line's other way out: 글 보기 shows the conversation.
    mode("글 보기");
    await waitFor(() => expect(column()).not.toBeNull());
    expect(pressed()).toBe("true");
    expect(inputs()).toBe(1);
  }, 20_000);

  it("a dock that does not close: the line says so, and pressing 문서 AI tries closing again", async () => {
    hangul();
    await screen.findByTestId("office-editor");
    await drawn();
    fireEvent.click(toggle());
    await waitFor(() => expect(dockOpen()).toBe(true));
    editor.dock!.dead = true;
    fireEvent.click(toggle());
    await waitFor(() => expect(document.querySelector(".doc-dock-failed")?.textContent).toContain("닫히지 않았습니다"), { timeout: 5000 });
    expect(pressed()).toBe("true");
    editor.dock!.dead = false;
    fireEvent.click(toggle());
    await waitFor(() => expect(dockOpen()).toBe(false));
    await waitFor(() => expect(pressed()).toBe("false"));
    expect(document.querySelector(".doc-dock-failed")).toBeNull();
  }, 10_000);

  // Ruling A (round 3): what the person typed is ONE draft per document's AI conversation, shown in
  // the input on screen now; a move replaces, never appends, never brings back a replaced or sent text.
  const revision = (n: number) => ({ revision: n, author: "user", at: 1, sessionId: null, note: null });
  const olderRevision = async () => {
    fireEvent.click(screen.getByRole("button", { name: /^r1/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^r0 ·/ }));
    await screen.findByText(/r0을 보는 중입니다/);
  };
  const columnInput = () => column()!.querySelector("textarea")!;

  it("글 보기 column with text → 편집 with the dock drawn OPEN by itself (remembered): the dock shows the text, once", async () => {
    hangul();
    await screen.findByTestId("office-editor");
    await drawn();
    mode("글 보기");
    await waitFor(() => expect(screen.queryByTestId("office-editor")).toBeNull());
    fireEvent.click(toggle());
    await waitFor(() => expect(column()).not.toBeNull());
    fireEvent.change(columnInput(), { target: { value: "다른 요청 하나" } });
    // Ieum remembers the dock open for every document: the new editor draws it open.
    editor.dock = newDock({ open: true });
    mode("편집");
    await screen.findByTestId("office-editor");
    await waitFor(() => expect(editor.dock!.draft).toBe("다른 요청 하나"));
    expect(dockOpen()).toBe(true);
    await waitFor(() => expect(pressed()).toBe("true"));
    expect(column()).toBeNull();
    expect(inputs()).toBe(1);
    await new Promise((done) => setTimeout(done, 300));
    expect(editor.dock!.draft).toBe("다른 요청 하나");
  });

  it("the same with the column closed again before 편집: the dock (drawn open, then closed to the wish) still holds the one draft for when it is opened", async () => {
    hangul();
    await screen.findByTestId("office-editor");
    await drawn();
    mode("글 보기");
    await waitFor(() => expect(screen.queryByTestId("office-editor")).toBeNull());
    fireEvent.click(toggle());
    await waitFor(() => expect(column()).not.toBeNull());
    fireEvent.change(columnInput(), { target: { value: "닫아 둔 요청" } });
    fireEvent.click(toggle());
    await waitFor(() => expect(column()).toBeNull());
    editor.dock = newDock({ open: true });
    mode("편집");
    await screen.findByTestId("office-editor");
    await waitFor(() => expect(dockOpen()).toBe(false));
    fireEvent.click(toggle());
    await waitFor(() => expect(dockOpen()).toBe(true));
    expect(editor.dock!.draft).toBe("닫아 둔 요청");
  });

  for (const leftOpen of [true, false]) {
    it(`back to the latest version after an older revision (dock ${leftOpen ? "open" : "closed"} when leaving): the dock shows exactly the newest text, once`, async () => {
      hangul({}, { revisions: [revision(0), revision(1)] });
      await screen.findByTestId("office-editor");
      await drawn();
      fireEvent.click(toggle());
      await waitFor(() => expect(dockOpen()).toBe(true));
      act(() => editor.report!(true, "표를 두 줄로 줄여 줘", false));
      if (!leftOpen) { act(() => editor.report!(false)); await waitFor(() => expect(pressed()).toBe("false")); }
      await olderRevision();
      if (!leftOpen) fireEvent.click(toggle());
      await waitFor(() => expect(column()).not.toBeNull());
      expect(columnInput().value).toBe("표를 두 줄로 줄여 줘");
      fireEvent.change(columnInput(), { target: { value: "표를 세 줄로 바꿔 줘" } });
      fireEvent.click(screen.getByRole("button", { name: "최신 판으로" }));
      await waitFor(() => expect(dockOpen()).toBe(true));
      await waitFor(() => expect(editor.dock!.draft).toBe("표를 세 줄로 바꿔 줘"));
      expect(column()).toBeNull();
      expect(inputs()).toBe(1);
      expect(editor.mounts).toBe(1);
      // Back in 글 보기: the same one text, not two.
      mode("글 보기");
      await waitFor(() => expect(column()).not.toBeNull());
      expect(columnInput().value).toBe("표를 세 줄로 바꿔 줘");
    });
  }

  it("a sent request never reappears in an input: sent from the column over a revision, or from the dock", async () => {
    const at = hangul({}, { revisions: [revision(0), revision(1)] });
    await screen.findByTestId("office-editor");
    await drawn();
    fireEvent.click(toggle());
    await waitFor(() => expect(dockOpen()).toBe(true));
    act(() => editor.report!(true, "보낼 요청", false));
    await olderRevision();
    await waitFor(() => expect(column()).not.toBeNull());
    expect(columnInput().value).toBe("보낼 요청");
    fireEvent.click(within(column()!).getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(at.onSend).toHaveBeenCalled());
    await waitFor(() => expect(columnInput().value).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "최신 판으로" }));
    await waitFor(() => expect(dockOpen()).toBe(true));
    await waitFor(() => expect(editor.dock!.draft).toBe(""));
    // Typed in the dock and sent from it (Ieum empties its input): 글 보기 shows no old text.
    act(() => editor.report!(true, "두 번째 요청", false));
    act(() => editor.report!(true, "", false));
    mode("글 보기");
    await waitFor(() => expect(column()).not.toBeNull());
    expect(columnInput().value).toBe("");
    editor.dock = newDock({ open: true });
    mode("편집");
    await screen.findByTestId("office-editor");
    await waitFor(() => expect(dockOpen()).toBe(true));
    await new Promise((done) => setTimeout(done, 300));
    expect(editor.dock!.draft).toBe("");
  });

  it("the editor reloading its frame in place: the new, empty dock is given the draft, not taken for the person emptying it", async () => {
    hangul({ open: true });
    await screen.findByTestId("office-editor");
    await waitFor(() => expect(dockOpen()).toBe(true));
    act(() => editor.report!(true, "남아야 하는 요청", false));
    await waitFor(() => expect(localStorage.getItem("workbench.draft.doc:doc")).toBe("남아야 하는 요청"));
    act(() => editor.reload!());
    await waitFor(() => expect(editor.dock!.drawn).toBe(true));
    await waitFor(() => expect(editor.dock!.draft).toBe("남아야 하는 요청"));
    expect(localStorage.getItem("workbench.draft.doc:doc")).toBe("남아야 하는 요청");
  });

  it("typed in both places: the newer text is the draft, the older one is dropped (never stacked)", async () => {
    const at = hangul({}, { items: [user("u1", "지금 요청")] });
    await screen.findByTestId("office-editor");
    await drawn();
    fireEvent.click(toggle());
    await waitFor(() => expect(dockOpen()).toBe(true));
    act(() => editor.report!(true, "먼저 쓴 요청", false));
    // A notice's link to this conversation: the column beside the editor, the dock closed (it keeps its text).
    at.shown.rerender(at.view(null, { sessionId: "a", itemId: "u1", nonce: 1 }));
    await waitFor(() => expect(column()?.textContent).toContain("지금 요청"));
    await waitFor(() => expect(dockOpen()).toBe(false));
    fireEvent.change(columnInput(), { target: { value: "나중에 쓴 요청" } });
    fireEvent.click(column()!.querySelector<HTMLButtonElement>(".agent-close")!);
    await waitFor(() => expect(dockOpen()).toBe(true));
    await waitFor(() => expect(editor.dock!.draft).toBe("나중에 쓴 요청"));
    // Now the dock is typed in last: that is the draft.
    act(() => editor.report!(true, "마지막에 쓴 요청", false));
    mode("글 보기");
    await waitFor(() => expect(column()).not.toBeNull());
    expect(columnInput().value).toBe("마지막에 쓴 요청");
  });
});

describe("what was under the document is still said and reachable there", () => {
  it("the closed AI's state is a word beside its dot on the button, not a tooltip only", async () => {
    setup({ format: "text", name: "메모.txt", agent: ai({ status: "awaitingApproval" }) });
    const button = await screen.findByRole("button", { name: "문서 AI · 승인 필요" });
    expect(button.textContent).toContain("승인 필요");
    expect(button.querySelector(".dot-attention")).toBeTruthy();
  });

  it("the document's AI waiting for an approval while its column is closed: one line at the document's foot that opens it", async () => {
    setup({ format: "text", name: "메모.txt", agent: ai({ status: "awaitingApproval" }), items: [user("u1", "폴더를 봐 줘"), approval("ap1")] });
    const line = await screen.findByRole("button", { name: /문서 AI · 승인 필요.*열기/ });
    expect(line.closest(".document-view")).toBeTruthy();
    expect(line.closest(".doc-header")).toBeNull();
    fireEvent.click(line);
    await waitFor(() => expect(column()).not.toBeNull());
    // Open, the column shows the approval itself: the line is gone.
    expect(screen.queryByRole("button", { name: /문서 AI · 승인 필요.*열기/ })).toBeNull();
    expect(within(column()!).getByRole("button", { name: /허용/ })).toBeTruthy();
  });

  it("no line at the foot while the AI only works or rests", async () => {
    setup({ format: "text", name: "메모.txt", agent: ai({ status: "running" }) });
    await screen.findByRole("button", { name: "문서 AI · 응답 중" });
    expect(document.querySelector(".doc-agent-wait")).toBeNull();
  });

  it("나란히 and 읽기 are buttons in the document's head", async () => {
    const at = setup({ format: "text", name: "메모.txt" });
    await waitFor(() => expect(at.registerDocument).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "대화 옆에" }));
    expect(at.onBeside).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "읽기" }));
    await waitFor(() => expect(at.onRead).toHaveBeenCalledTimes(1));
  });
});

describe("another conversation of the document, opened from a notice or a search hit", () => {
  it("is shown in the column with no input under it — the input stays with the conversation it sends to", async () => {
    const older = ai({ id: "old", provider: "claude", purpose: "강의안.md · 문서 AI" });
    const at = setup({ format: "text", name: "메모.txt", extra: { old: older }, transcripts: { old: [user("o1", "지난번 요청")] } });
    await waitFor(() => expect(at.registerDocument).toHaveBeenCalled());
    at.shown.rerender(at.view(null, { sessionId: "old", itemId: "o1", nonce: 1 }));
    await waitFor(() => expect(column()?.textContent).toContain("지난번 요청"));
    expect(column()!.querySelector("textarea")).toBeNull();
    fireEvent.click(within(column()!).getByRole("button", { name: "지금 대화로" }));
    await waitFor(() => expect(column()!.querySelector("textarea")).not.toBeNull());
    expect(column()!.textContent).not.toContain("지난번 요청");
  });
});

describe("a document beside a conversation (that conversation's companion)", () => {
  it("has no conversation of its own on screen: no AI column, no input — asking goes to the conversation it is beside", async () => {
    const at = setup({ format: "text", name: "메모.txt", hosted: true });
    await waitFor(() => expect(at.registerDocument).toHaveBeenCalled());
    at.shown.rerender(at.view({ sessionId: "main" }));
    await new Promise((done) => setTimeout(done, 20));
    expect(column()).toBeNull();
    expect(document.querySelector(".hig-composer, .composer")).toBeNull();
  });

  // Beside a conversation a document is read, whatever its format: no embedded editor (and so no
  // AI panel or input of the editor's own next to the conversation's input), nothing to save.
  it.each([
    ["markdown", "강의안.md", "미리보기"], ["docx", "보고서.docx", "쪽 보기"], ["pptx", "발표.pptx", "쪽 보기"], ["xlsx", "표.xlsx", "쪽 보기"],
    ["hwpx", "공문.hwpx", null], ["html", "안내.html", null], ["text", "메모.txt", null],
  ] as const)("%s opens in the app's own read view: no editor is mounted, nothing can be typed into it, and it never asks for the writer lease", async (format, name, view) => {
    const at = setup({ format, name, hosted: true });
    await waitFor(() => expect(at.registerDocument).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 30));
    expect(screen.queryByTestId("office-editor")).toBeNull();
    expect(editor.mounts).toBe(0);
    const source = screen.queryByTestId("source") as HTMLTextAreaElement | null;
    if (source) expect(source.readOnly || source.disabled).toBe(true);
    if (view) expect([...document.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="보기"] [role="radio"]')].find((button) => button.getAttribute("aria-checked") === "true")?.textContent).toBe(view);
    // Its editor is not a view to switch to here.
    expect(screen.queryByRole("radio", { name: "편집" })).toBeNull();
    expect(at.registerDocument.mock.calls.every(([, input]) => (input as { claim?: boolean }).claim !== true)).toBe(true);
    expect(screen.queryByText(/편집 권한 받기/)).toBeNull();
  });

  it("editing is one labelled step away, and its own AI another: both go to the document's own tab", async () => {
    const at = setup({ hosted: true });
    await waitFor(() => expect(at.registerDocument).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "탭으로 열어 고치기" }));
    await waitFor(() => expect(at.hosted!.onWide).toHaveBeenCalledTimes(1));
    const own = await screen.findByRole("button", { name: /^문서 AI/ });
    await waitFor(() => expect((own as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(own);
    expect(at.hosted!.onAgent).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    // Nothing was written by any of it.
    expect(at.saveArtifact).not.toHaveBeenCalled();
    expect(editor.flushed).toBe(0);
  });

  it("side by side it closes with ×; laid over the conversation it carries a labelled ← 대화 instead", async () => {
    const beside = setup({ format: "text", name: "메모.txt", hosted: { over: false } });
    await waitFor(() => expect(beside.registerDocument).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "대화" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "곁 화면 닫기" }));
    await waitFor(() => expect(beside.hosted!.onClose).toHaveBeenCalledTimes(1));
    cleanup();
    const over = setup({ format: "text", name: "메모.txt", hosted: { over: true } });
    await waitFor(() => expect(over.registerDocument).toHaveBeenCalled());
    const back = screen.getByRole("button", { name: "대화" });
    expect(back.textContent).toContain("대화");
    fireEvent.click(back);
    await waitFor(() => expect(over.hosted!.onClose).toHaveBeenCalledTimes(1));
  });
});

describe("leaving a document tab without saving, and what the app compares", () => {
  it("저장하지 않고 옮기기 (the discard path): nothing is saved, and this view's kept copy of the unsaved text goes", async () => {
    const at = setup({ format: "text", name: "메모.txt" });
    await waitFor(() => expect(at.guard.current).not.toBeNull());
    const source = await screen.findByTestId("source");
    // The app's comparison while the text is the saved one.
    await waitFor(() => expect(at.handle.current?.same?.()).toBe(true));
    fireEvent.change(source, { target: { value: "고친 본문" } });
    await waitFor(() => expect(at.handle.current?.same?.()).toBe(false));
    await waitFor(() => expect(Object.keys(localStorage).some((key) => key.startsWith("workbench.docDraft.doc."))).toBe(true));
    await act(async () => { await at.guard.current!("discard"); });
    expect(at.saveArtifact).not.toHaveBeenCalled();
    expect(Object.keys(localStorage).some((key) => key.startsWith("workbench.docDraft.doc."))).toBe(false);
  });
});

describe("the way back to a conversation that waits", () => {
  it("laid over a conversation waiting for an approval, ← 대화 says so", async () => {
    const at = setup({ format: "text", name: "메모.txt", hosted: { over: true, back: "승인 필요" } });
    await waitFor(() => expect(at.registerDocument).toHaveBeenCalled());
    const back = screen.getByRole("button", { name: /대화 · 승인 필요/ });
    fireEvent.click(back);
    await waitFor(() => expect(at.hosted!.onClose).toHaveBeenCalledTimes(1));
  });
});

describe("저장하지 않고 옮기기 from an embedded editor marks the document; closing with a save does not", () => {
  it.each([["discard", true], ["close", false], [undefined, false]] as const)("leave guard %s → marked %s", async (reason, marked) => {
    const { takeDiscarded } = await import("../../discarded-edits.ts");
    localStorage.clear();
    const at = setup({ format: "docx", name: "계획.docx" });
    await waitFor(() => expect(at.guard.current).not.toBeNull());
    await screen.findByTestId("office-editor");
    await act(async () => { await at.guard.current!(reason); });
    expect(takeDiscarded("doc")).toBe(marked);
  });
  it("a discard that is refused (the editor could not be closed) leaves no mark and keeps the kept copy: the edits are still on screen", async () => {
    const { takeDiscarded } = await import("../../discarded-edits.ts");
    localStorage.clear();
    const at = setup({ format: "docx", name: "계획.docx", closeFails: true });
    await waitFor(() => expect(at.guard.current).not.toBeNull());
    await screen.findByTestId("office-editor");
    let refused = false;
    await act(async () => { await at.guard.current!("discard").catch(() => { refused = true; }); });
    expect(refused).toBe(true);
    expect(takeDiscarded("doc")).toBe(false);
  });
  it("a refused discard of a text view keeps its copy of the unsaved text", async () => {
    localStorage.clear();
    const at = setup({ format: "text", name: "메모.txt", closeFails: true });
    await waitFor(() => expect(at.guard.current).not.toBeNull());
    const source = await screen.findByTestId("source");
    fireEvent.change(source, { target: { value: "고친 본문" } });
    await waitFor(() => expect(Object.keys(localStorage).some((key) => key.startsWith("workbench.docDraft.doc."))).toBe(true));
    let refused = false;
    await act(async () => { await at.guard.current!("discard").catch(() => { refused = true; }); });
    expect(refused).toBe(true);
    expect(Object.keys(localStorage).some((key) => key.startsWith("workbench.docDraft.doc."))).toBe(true);
  });
  it("a text view dropping its edits also drops the older recovery copy it was opened from", async () => {
    localStorage.clear();
    // A copy kept by an earlier view of this document (the window closed before saving).
    localStorage.setItem("workbench.docDraft.doc.view-old", JSON.stringify({ baseRevision: 1, text: "옛 편집", at: 5 }));
    const at = setup({ format: "text", name: "메모.txt" });
    await waitFor(() => expect(at.guard.current).not.toBeNull());
    const source = await screen.findByTestId("source");
    await waitFor(() => expect((source as HTMLTextAreaElement).value).toBe("옛 편집"));
    await act(async () => { await at.guard.current!("discard"); });
    expect(at.saveArtifact).not.toHaveBeenCalled();
    expect(Object.keys(localStorage).filter((key) => key.startsWith("workbench.docDraft.doc."))).toEqual([]);
  });
});
