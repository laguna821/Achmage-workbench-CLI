// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, Session, Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { initialState, type State } from "../../state.ts";
import { ShownPanels, ShownPanelsContext } from "../../completion-notifications.ts";
import { AppearanceContext, DEFAULT_APPEARANCE } from "../../appearance.ts";
import { DocContext } from "../DocCards.tsx";
import { writeDocOpen } from "../../doc-open.ts";
import { markNewDocument } from "../../doc-new.ts";
import DocumentView from "./DocumentView.tsx";

// doc-pages-first: the placeholder over a booting editor (point 1) and 쪽 보기로 먼저 열기 (point 3).

const editor = vi.hoisted(() => ({ report: null as ((status: { dirty: boolean; revision: number | null; conflict: null; changed: boolean; same: boolean }) => void) | null, mounts: 0, drawn: null as (() => void) | null, pageDrawn: null as (() => void) | null }));
vi.mock("./OfficeEditor.tsx", async () => {
  const React = await import("react");
  return {
    OfficeEditor: React.forwardRef((props: { onStatus: (status: unknown) => void; onAiPanel?: (open: boolean, draft?: string, dock?: object) => void; onPageDrawn?: () => void }, ref) => {
      React.useImperativeHandle(ref, () => ({ flush: async () => 1, leave: async () => 1 }));
      React.useEffect(() => {
        editor.mounts += 1; editor.report = props.onStatus;
        editor.drawn = () => props.onAiPanel?.(false, "", { ready: true, person: false, shown: false });
        editor.pageDrawn = () => props.onPageDrawn?.();
        return () => { editor.report = null; editor.drawn = null; editor.pageDrawn = null; };
      }, []);
      return React.createElement("div", { "data-testid": "office-editor" });
    }),
  };
});
vi.mock("./OfficeView.tsx", async () => {
  const React = await import("react");
  return { OfficeView: (props: { mode: string; revision: number }) => React.createElement("div", { "data-testid": `office-${props.mode}` }, `r${props.revision}`) };
});
vi.mock("./HwpxView.tsx", async () => {
  const React = await import("react");
  return { HwpxView: () => React.createElement("div", { "data-testid": "hwpx-pages" }) };
});

const asked: string[] = [];
/** The revisions the gateway has no pictures of (still being made, refused, over the bound). */
const unpictured = new Set<number>();
beforeEach(() => {
  editor.mounts = 0; asked.length = 0; unpictured.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { width: this.classList.contains("document-view") ? 1200 : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
  URL.createObjectURL = vi.fn(() => "blob:page");
  // The gateway's pictures: every revision of these documents has its first page.
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    asked.push(path);
    const revision = Number(/revision=(\d+)/.exec(path)?.[1]);
    if (path.includes("/cover-image")) return { ok: true, blob: async () => new Blob(["png"]) };
    return { ok: true, json: async () => ({ revision, cover: unpictured.has(revision) ? null : { page: 1, width: 1190, height: 1684 } }) };
  }));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const work = { id: "w", title: "강의", cwd: "/w", folderId: null, archivedAt: null } as unknown as Work;
const A = { id: "a", workId: "w", provider: "codex", purpose: "문서 AI", status: "idle", queued: [], archivedAt: null, createdAt: 1, updatedAt: 1, documentAgent: { artifactId: "doc", parentSessionId: "main" } } as unknown as Session;

async function open(format: "docx" | "pptx" | "hwpx" | "pdf" | "xlsx", options: { revision?: number; uiMode?: string; edited?: boolean; createdAt?: number; reveal?: boolean; onUiState?: (ui: unknown) => void } = {}) {
  const name = `보고서.${format}`;
  const artifact = { id: "doc", workId: "w", name, path: `/w/${name}`, format, revision: options.revision ?? 3, sha256: "", size: 4, diskState: "same", readBy: {}, createdAt: options.createdAt ?? 1, updatedAt: 1 } as Artifact;
  const registerDocument = vi.fn(async (artifactId: string, input: { viewId: string; windowId: string; sessionId?: string | null }) => {
    const view = { artifactId, viewId: input.viewId, windowId: input.windowId, sessionId: input.sessionId ?? null, revision: artifact.revision, dirty: false, label: "", mode: "write", expiresAt: Date.now() + 60_000 };
    return { view, writer: null, writeToken: "lease" };
  });
  const known: Record<string, unknown> = {
    registerDocument, closeDocument: vi.fn(async () => undefined), documentSession: vi.fn(async () => A),
    artifactText: vi.fn(async () => ({ artifact, revision: artifact.revision, text: "본문", editable: false, view: true })), documentViews: vi.fn(async () => ({ views: [] })),
  };
  const api: Api = new Proxy(known, {
    get: (target, key: string) => (key === "forDocument" ? () => api : key in target ? target[key] : key === "then" ? undefined : vi.fn(async () => ({}))),
  }) as unknown as Api;
  const state: State = { ...initialState, ready: true, works: { w: work }, artifacts: { doc: artifact }, sessions: { a: A } };
  render(
    <AppearanceContext.Provider value={{ lookOf: (provider: "codex" | "claude") => DEFAULT_APPEARANCE[provider].light } as React.ContextType<typeof AppearanceContext>}>
    <ShownPanelsContext.Provider value={new ShownPanels()}>
    <DocContext.Provider value={{ state, actions: new Proxy({}, { get: () => vi.fn() }) } as never}>
      <DocumentView api={api} state={state} artifactId="doc" focusProposalId={null} work={work} session={A} onBack={() => undefined} onUiState={options.onUiState ?? vi.fn()}
        uiState={options.uiMode ? { mode: options.uiMode, edited: options.edited } as never : undefined}
        revealAgent={options.reveal ? { sessionId: "a" } : null} onRevealDone={vi.fn()}
        onSend={vi.fn() as never} onPickTarget={async () => null} onAiSettings={() => undefined} onExternalSetup={() => undefined}
        onOpenArtifact={() => undefined} onToast={vi.fn()} />
    </DocContext.Provider>
    </ShownPanelsContext.Provider>
    </AppearanceContext.Provider>,
  );
  await waitFor(() => expect(registerDocument).toHaveBeenCalled());
}
const mode = () => [...document.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="보기"] [role="radio"]')].find((button) => button.getAttribute("aria-checked") === "true")?.textContent;
const cover = () => document.querySelector<HTMLElement>(".doc-cover");

describe("the placeholder: the document's first page while its editor boots", () => {
  // These open the editor: the person's choice "편집기로 바로 열기" (the default is 쪽 보기 first since doc-default).
  beforeEach(() => writeDocOpen("editor"));
  it("covers the booting editor with the picture of the revision it opens, and goes once the editor has opened and drawn", async () => {
    await open("docx", { revision: 3 });
    await screen.findByTestId("office-editor");
    await waitFor(() => expect(cover()?.querySelector("img")?.getAttribute("src")).toBe("blob:page"));
    expect(cover()!.getAttribute("data-cover-revision")).toBe("3");
    expect(asked).toContain("/api/artifacts/doc/cover?revision=3");
    // Opened, not drawn yet (PowerPoint says opened a second before it draws): the picture stays.
    act(() => editor.report!({ dirty: false, revision: 3, conflict: null, changed: false, same: false }));
    await act(async () => { await new Promise((done) => setTimeout(done, 300)); });
    expect(cover()).not.toBeNull();
    act(() => editor.drawn!());
    await waitFor(() => expect(cover()).toBeNull());
  });

  it("PowerPoint: the AI panel's ready is not the slide drawn — the picture stays until the slides page says the slide is drawn at its fitted place", async () => {
    await open("pptx", { revision: 3 });
    await waitFor(() => expect(cover()?.querySelector("img")).not.toBeNull());
    act(() => editor.report!({ dirty: false, revision: 3, conflict: null, changed: false, same: false }));
    act(() => editor.drawn!());
    // The panel and ribbon come before the slide (its own "여는 중…" between): the picture stays past the old 1.5 s.
    await act(async () => { await new Promise((done) => setTimeout(done, 1800)); });
    expect(cover()).not.toBeNull();
    act(() => editor.pageDrawn!());
    await waitFor(() => expect(cover()).toBeNull());
  });

  it("without the editor's drawn report it goes 1.5 s after opened", async () => {
    await open("docx");
    await waitFor(() => expect(cover()).not.toBeNull());
    act(() => editor.report!({ dirty: false, revision: 3, conflict: null, changed: false, same: false }));
    await waitFor(() => expect(cover()).toBeNull(), { timeout: 2500 });
  });

  it("is not shown for Excel (its printed page is not its grid) or PDF", async () => {
    await open("pdf");
    await screen.findByTestId("office-editor");
    await act(async () => { await new Promise((done) => setTimeout(done, 50)); });
    expect(cover()).toBeNull();
    expect(asked.filter((path) => path.includes("/cover"))).toEqual([]);
  });
});

describe("문서를 열 때: 쪽 보기로 먼저 열기", () => {
  it("chosen 편집기로 바로 열기: a Word document opens in its editor", async () => {
    writeDocOpen("editor");
    await open("docx");
    await screen.findByTestId("office-editor");
    expect(mode()).toBe("편집");
    expect(editor.mounts).toBe(1);
  });

  it("the default (nothing chosen): a Word document opens in 쪽 보기, the editor not started, the line says what the pictures are", async () => {
    await open("docx", { revision: 5 });
    await screen.findByTestId("office-pages");
    expect(mode()).toBe("쪽 보기");
    expect(editor.mounts).toBe(0);
    expect(screen.getByText(/쪽 그림입니다. 글자를 고를 수는 없습니다/)).toBeTruthy();
    expect(asked).toContain("/api/artifacts/doc/cover?revision=5");
  });

  it("(a) a new document (made by this window's create flow a moment ago, first revision) opens in its editor", async () => {
    markNewDocument("doc");
    await open("docx", { revision: 1 });
    await screen.findByTestId("office-editor");
    expect(mode()).toBe("편집");
    expect(screen.queryByTestId("office-pages")).toBeNull();
  });

  it("(b) the row's 문서 AI on a document in 쪽 보기 starts its editor at once", async () => {
    await open("docx", { reveal: true });
    await screen.findByTestId("office-editor");
    expect(mode()).toBe("편집");
  });

  it("(c) Excel opens in its editor", async () => {
    await open("xlsx");
    await screen.findByTestId("office-editor");
    expect(mode()).toBe("편집");
  });

  it.each(["docx", "pptx"] as const)("(d) %s without its page pictures yet opens in its editor, never an empty 쪽 보기 or a wait", async (format) => {
    // (A revision no earlier test asked about: the pictures found are kept for the window.)
    const revision = format === "docx" ? 11 : 12;
    unpictured.add(revision);
    await open(format, { revision });
    await screen.findByTestId("office-editor");
    expect(mode()).toBe("편집");
    expect(screen.queryByTestId("office-pages")).toBeNull();
    expect(screen.queryByText(/쪽 그림을 만드는 중/)).toBeNull();
  });

  it("(e) a tab the person edited in before it slept wakes in its editor; the editor's unsaved edits mark the tab edited", async () => {
    const onUiState = vi.fn();
    await open("docx", { uiMode: "edit", edited: true, onUiState });
    await screen.findByTestId("office-editor");
    expect(mode()).toBe("편집");
    act(() => editor.report!({ dirty: true, revision: 3, conflict: null, changed: true, same: false }));
    expect(onUiState).toHaveBeenCalledWith({ edited: true });
  });

  it.each([
    ["a double click in a page", () => fireEvent.doubleClick(screen.getByTestId("office-pages"))],
    ["typing with the page focused", () => fireEvent.keyDown(screen.getByLabelText("보고서.docx · 쪽 보기"), { key: "가" })],
    ["the 편집 key", () => fireEvent.click(screen.getByRole("radio", { name: "편집" }))],
    ["문서 AI", () => fireEvent.click(screen.getByRole("button", { name: "문서 AI" }))],
  ])("%s starts the editor", async (_intent, act) => {
    writeDocOpen("pages");
    await open("docx");
    await screen.findByTestId("office-pages");
    act();
    await screen.findByTestId("office-editor");
    expect(mode()).toBe("편집");
  });

  it("a shortcut or an arrow key in 쪽 보기 is not an edit (only typing is)", async () => {
    writeDocOpen("pages");
    await open("docx");
    const reading = await screen.findByLabelText("보고서.docx · 쪽 보기");
    fireEvent.keyDown(reading, { key: "ArrowDown" });
    fireEvent.keyDown(reading, { key: "c", ctrlKey: true });
    await act(async () => { await new Promise((done) => setTimeout(done, 30)); });
    expect(editor.mounts).toBe(0);
  });

  it("a tab woken from sleep that was in its editor follows the choice (Hangul too)", async () => {
    writeDocOpen("pages");
    await open("hwpx", { uiMode: "edit" });
    await screen.findByTestId("hwpx-pages");
    expect(editor.mounts).toBe(0);
  });

  it("a PDF opens in its own page view (미리보기)", async () => {
    writeDocOpen("pages");
    await open("pdf");
    await waitFor(() => expect(mode()).toBe("미리보기"));
    expect(editor.mounts).toBe(0);
  });
});
