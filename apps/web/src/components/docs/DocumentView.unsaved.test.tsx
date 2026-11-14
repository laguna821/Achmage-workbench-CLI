// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, Session, Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { initialState, type State } from "../../state.ts";
import { ShownPanels, ShownPanelsContext } from "../../completion-notifications.ts";
import { AppearanceContext, DEFAULT_APPEARANCE } from "../../appearance.ts";
import { DocContext } from "../DocCards.tsx";
import type { EditorHandle } from "../../doc-editors.ts";
import DocumentView from "./DocumentView.tsx";
import type { OfficeStatus } from "./OfficeEditor.tsx";

// The embedded editor reports through this stand-in.
const editor = vi.hoisted(() => ({ report: null as ((status: OfficeStatus) => void) | null, leave: null as null | (() => Promise<number | null>) }));
vi.mock("./OfficeEditor.tsx", async () => {
  const React = await import("react");
  return {
    OfficeEditor: React.forwardRef((props: { onStatus: (status: OfficeStatus) => void }, ref) => {
      React.useImperativeHandle(ref, () => ({ leave: () => editor.leave ? editor.leave() : Promise.resolve(null) }) as never, []);
      React.useEffect(() => { editor.report = props.onStatus; return () => { editor.report = null; }; }, []);
      return React.createElement("div", { "data-testid": "office-editor" });
    }),
  };
});

beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

const work = { id: "w", title: "강의", cwd: "/w", folderId: null, archivedAt: null } as unknown as Work;
const artifact = { id: "doc", workId: "w", name: "강의안.md", path: "/w/강의안.md", format: "markdown", revision: 1, sha256: "", size: 4, diskState: "same", readBy: {}, createdAt: 1, updatedAt: 1 } as Artifact;
const A = { id: "a", workId: "w", provider: "codex", purpose: "강의안.md · 문서 AI", status: "idle", queued: [], archivedAt: null, createdAt: 1, updatedAt: 1, documentAgent: { artifactId: "doc", parentSessionId: "main" } } as unknown as Session;

async function open(hold?: (input: { dirty?: boolean }) => Promise<void> | undefined, gone = false) {
  const registerDocument = vi.fn(async (artifactId: string, input: { viewId: string; windowId: string; sessionId?: string | null; dirty?: boolean }) => {
    await hold?.(input);
    const view = { artifactId, viewId: input.viewId, windowId: input.windowId, sessionId: input.sessionId ?? null, revision: 1, dirty: false, label: "", mode: "write", expiresAt: Date.now() + 60_000 };
    return { view, writer: null, writeToken: "lease" };
  });
  const known: Record<string, unknown> = {
    registerDocument, documentSession: vi.fn(async () => A), closeDocument: vi.fn(async () => undefined),
    artifactText: vi.fn(async () => ({ artifact, revision: 1, text: "본문", editable: true, view: false })),
    documentViews: vi.fn(async () => ({ views: [] })),
  };
  const api: Api = new Proxy(known, {
    get: (target, key: string) => (key === "forDocument" ? () => api : key in target ? target[key] : key === "then" ? undefined : vi.fn(async () => ({}))),
  }) as unknown as Api;
  const state: State = { ...initialState, ready: true, works: { w: work }, artifacts: gone ? {} : { doc: artifact }, sessions: { a: A } };
  let handle: EditorHandle | null = null;
  let leaveGuard: ((reason?: "close" | "discard") => Promise<void>) | null = null;
  render(
    <AppearanceContext.Provider value={{ lookOf: (provider: "codex" | "claude") => DEFAULT_APPEARANCE[provider].light } as React.ContextType<typeof AppearanceContext>}>
    <ShownPanelsContext.Provider value={new ShownPanels()}>
    <DocContext.Provider value={{ state, actions: new Proxy({}, { get: () => vi.fn() }) } as never}>
      <DocumentView api={api} state={state} artifactId="doc" focusProposalId={null} work={work} session={A} onBack={() => undefined}
        onEditorHandle={(_artifactId, _viewId, next) => { if (next) handle = next; }} onLeaveGuard={(guard) => { leaveGuard = guard; }}
        onSend={vi.fn() as never} onPickTarget={async () => null} onAiSettings={() => undefined} onExternalSetup={() => undefined}
        onOpenArtifact={() => undefined} onToast={() => undefined} />
    </DocContext.Provider>
    </ShownPanelsContext.Provider>
    </AppearanceContext.Provider>,
  );
  if (gone) await screen.findByText("문서를 찾을 수 없습니다.");
  else {
    await screen.findByTestId("office-editor");
    await waitFor(() => expect(editor.report).toBeTruthy());
  }
  return { label: () => document.querySelector(".save-state")?.textContent, guard: () => handle?.dirty(), leave: () => leaveGuard!(), registerDocument };
}

describe("저장 안 됨 on a document in the embedded editor", () => {
  it("is not shown once the editor's text was found equal to the saved revision — nor is 저장됨 claimed, and leaving is still guarded by the editor's report", async () => {
    const view = await open();
    act(() => editor.report!({ dirty: true, changed: false, same: true, revision: 1, conflict: null }));
    // The revision alone: no unsaved mark, and no "저장됨" while the editor itself says otherwise.
    expect(view.label()).toBe("r1");
    expect(document.querySelector(".save-state")?.className).not.toContain("save-dirty");
    // Closing, removing and navigating ask the editor's own report, exactly as before.
    expect(view.guard()).toBe(true);
  });

  it("is shown once the document really changed", async () => {
    const view = await open();
    act(() => editor.report!({ dirty: true, changed: true, same: false, revision: 1, conflict: null }));
    expect(view.label()).toBe("저장 안 됨");
    // 저장됨 is the editor's own clean report.
    act(() => editor.report!({ dirty: false, changed: false, same: false, revision: 2, conflict: null }));
    expect(view.label()).toBe("r1 저장됨");
  });
});

// U38 finding 3: 저장하고 계속 saved, but the removal reached the gateway before this view's clean
// report did (409 document_unsaved). Leaving resolves only once the gateway has the clean report.
it("leaving through the editor finishes only after the gateway confirmed this view has nothing unsaved", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let holding = false;
  const view = await open((input) => (holding && input.dirty === false ? held : undefined));
  act(() => editor.report!({ dirty: true, changed: true, same: false, revision: 1, conflict: null }));
  await waitFor(() => expect(view.registerDocument.mock.calls.at(-1)?.[1]).toMatchObject({ dirty: true }));
  holding = true;
  editor.leave = async () => { editor.report!({ dirty: false, changed: false, same: false, revision: 1, conflict: null }); return 1; };
  let left = false;
  const leaving = view.leave().then(() => { left = true; });
  await waitFor(() => expect(view.registerDocument.mock.calls.at(-1)?.[1]).toMatchObject({ dirty: false }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(left).toBe(false);
  release();
  await leaving;
  expect(left).toBe(true);
  editor.leave = null;
});

it("an untouched document in the embedded editor shows its revision as saved, and leaving it is not refused", async () => {
  const view = await open();
  act(() => editor.report!({ dirty: false, changed: false, same: false, revision: 1, conflict: null }));
  expect(view.label()).toBe("r1 저장됨");
  await expect(view.leave()).resolves.toBeUndefined();
});

// U38 (found once 목록에서 빼기 worked): the removed document's tab leaves through its guard ("close")
// after the document is gone from the list. Nothing is left to save there — the gateway refuses a
// removal while a view has unsaved edits — so leaving must not fail ("문서를 저장하지 못해…"),
// or the tab stays on "문서를 찾을 수 없습니다" and the pane no longer moves (보관함 did not open).
it("leaving the tab of a document that is gone from the list does not fail", async () => {
  const view = await open(undefined, true);
  await expect(view.leave()).resolves.toBeUndefined();
});
