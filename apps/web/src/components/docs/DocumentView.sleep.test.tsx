// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Artifact, Session, Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { initialState, type State } from "../../state.ts";
import { ShownPanels, ShownPanelsContext } from "../../completion-notifications.ts";
import { AppearanceContext, DEFAULT_APPEARANCE } from "../../appearance.ts";
import { DocContext } from "../DocCards.tsx";
import { EditorRegistry, leaveEditors } from "../../doc-editors.ts";
import { viewDocument } from "../../companion.ts";
import type { Layout, PaneTab } from "../../panes.ts";
import { drawnLayout } from "../../tabs.ts";
import { tabAtWork } from "../../tab-sleep.ts";
import { PaneLayout, type TabSleep } from "../Panes.tsx";
import DocumentView from "./DocumentView.tsx";
import type { OfficeStatus } from "./OfficeEditor.tsx";

// Tab sleep with the real document view and the app's own wiring (App.tsx `tabSleep`: the editors registry as the
// keeper, the tab's leave guard as the save). The embedded editor is a stand-in that answers as the real one does:
// `leave()` resolves with the saved revision, or rejects (a conflict the person must settle, a save that failed).

const editor = vi.hoisted(() => ({ report: null as ((status: OfficeStatus) => void) | null, leave: null as null | (() => Promise<number | null>), left: 0 }));
vi.mock("./OfficeEditor.tsx", async () => {
  const React = await import("react");
  return {
    OfficeEditor: React.forwardRef((props: { onStatus: (status: OfficeStatus) => void }, ref) => {
      React.useImperativeHandle(ref, () => ({ leave: () => { editor.left += 1; return editor.leave ? editor.leave() : Promise.resolve(1); } }) as never, []);
      React.useEffect(() => { editor.report = props.onStatus; return () => { editor.report = null; }; }, []);
      return React.createElement("div", { "data-testid": "office-editor" });
    }),
  };
});

const SLEEP = 300;
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("CSS", { escape: (text: string) => text });
  // The rig's shorter time (tab-sleep.ts `tabSleepAfter`); the shipped default is ten minutes.
  vi.stubGlobal("__workbenchTabSleepMs", SLEEP);
  editor.leave = null; editor.left = 0;
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

type View = { kind: "work" } | { kind: "document"; artifactId: string; proposalId: null };
const work = { id: "w", title: "강의", cwd: "/w", folderId: null, archivedAt: null } as unknown as Work;
const artifact = { id: "doc", workId: "w", name: "강의안.docx", path: "/w/강의안.docx", format: "docx", revision: 1, sha256: "", size: 4, diskState: "same", readBy: {}, createdAt: 1, updatedAt: 1 } as Artifact;
const A = { id: "a", workId: "w", provider: "codex", purpose: "강의안.docx · 문서 AI", status: "idle", queued: [], archivedAt: null, createdAt: 1, updatedAt: 1, documentAgent: { artifactId: "doc", parentSessionId: "main" } } as unknown as Session;
const docTab: PaneTab<View> = { id: "t-doc", view: { kind: "document", artifactId: "doc", proposalId: null }, workId: "w", sessionId: null };
const otherTab: PaneTab<View> = { id: "t-other", view: { kind: "work" }, workId: "w2", sessionId: null };
const layoutOf = (front: PaneTab<View>): Layout<View> => ({ focus: "a", panes: [{ id: "a", view: front.view, workId: front.workId, sessionId: front.sessionId, tabs: [docTab, otherTab], activeTabId: front.id, recentTabIds: [front.id] }] });

function open() {
  const closeDocument = vi.fn(async () => undefined);
  const known: Record<string, unknown> = {
    registerDocument: vi.fn(async (artifactId: string, input: { viewId: string; windowId: string; sessionId?: string | null }) => ({
      view: { artifactId, viewId: input.viewId, windowId: input.windowId, sessionId: input.sessionId ?? null, revision: 1, dirty: false, label: "", mode: "write", expiresAt: Date.now() + 60_000 }, writer: null, writeToken: "lease" })),
    documentSession: vi.fn(async () => A), closeDocument,
    artifactText: vi.fn(async () => ({ artifact, revision: 1, text: "본문", editable: true, view: false })),
    documentViews: vi.fn(async () => ({ views: [] })),
  };
  const api: Api = new Proxy(known, { get: (target, key: string) => (key === "forDocument" ? () => api : key in target ? target[key] : key === "then" ? undefined : vi.fn(async () => ({}))) }) as unknown as Api;
  const state: State = { ...initialState, ready: true, works: { w: work }, artifacts: { doc: artifact }, sessions: { a: A } };
  // As App.tsx wires it.
  const editors = new EditorRegistry();
  const guards: Record<string, (reason?: "close" | "discard") => Promise<void>> = {};
  const sleep: TabSleep<View> = {
    unsaved: (tab) => { const artifactId = viewDocument(tab.view); return Boolean(artifactId && editors.states(artifactId).some((dirty) => dirty !== false)); },
    atWork: (tab) => tab.id === "t-other" ? false : tabAtWork(tab, state),
    before: (tab) => { const guard = guards[tab.id]; return guard ? () => leaveEditors([() => guard()], 2000) : null; },
  };
  const screenOf = (layout: Layout<View>) => (
    <AppearanceContext.Provider value={{ lookOf: (provider: "codex" | "claude") => DEFAULT_APPEARANCE[provider].light } as React.ContextType<typeof AppearanceContext>}>
    <ShownPanelsContext.Provider value={new ShownPanels()}>
    <DocContext.Provider value={{ state, actions: new Proxy({}, { get: () => vi.fn() }) } as never}>
      <PaneLayout layout={layout} drawn={drawnLayout(layout)} enabled={false} sleep={sleep} onResize={() => {}} onFocus={() => {}} onClose={() => {}} onMove={() => {}} onSplit={() => {}} onDrop={() => {}}
        head={() => ({ title: "", icon: null, item: null })} scope={() => ({ theme: "light", bubble: "none", frame: false, glow: "none", style: {} })} effectOf={() => "split" as const}
        render={(pane, info) => pane.view.kind === "document"
          ? <DocumentView api={api} state={state} artifactId="doc" focusProposalId={null} work={work} session={A} visible={info.active} onBack={() => undefined}
              onEditorHandle={(artifactId, viewId, handle) => editors.set(artifactId, viewId, handle)} onLeaveGuard={(guard) => { if (guard) guards[info.tabId] = guard; else delete guards[info.tabId]; }}
              onSend={vi.fn() as never} onPickTarget={async () => null} onAiSettings={() => undefined} onExternalSetup={() => undefined} onOpenArtifact={() => undefined} onToast={() => undefined} />
          : <p>다른 프로젝트</p>} />
    </DocContext.Provider>
    </ShownPanelsContext.Provider>
    </AppearanceContext.Provider>
  );
  return { screenOf, closeDocument, editors };
}
const rest = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const shownThenLeft = async () => {
  const app = open();
  const view = render(app.screenOf(layoutOf(docTab)));
  await screen.findByTestId("office-editor");
  await waitFor(() => expect(editor.report).toBeTruthy());
  act(() => editor.report!({ dirty: false, changed: false, same: false, revision: 1, conflict: null }));
  return { ...app, view, leave: () => view.rerender(app.screenOf(layoutOf(otherTab))) };
};

it("a Word document nobody changed: its editor cannot tell at once, so it is asked through the leave path — it answers saved, the view is unmounted and its edit lease given back", async () => {
  const app = await shownThenLeft();
  // The embedded editor always says "cannot tell" to the keeper: without the question it would stay awake for ever.
  expect(app.editors.states("doc")).toEqual(["unknown"]);
  app.leave();
  expect(screen.queryByTestId("office-editor")).not.toBeNull();
  await rest(3 * SLEEP);
  expect(editor.left).toBe(1);
  expect(screen.queryByTestId("office-editor")).toBeNull();
  await waitFor(() => expect(app.closeDocument).toHaveBeenCalledTimes(1));
  // Shown again: mounted again, opened from the gateway.
  app.view.rerender(app.screenOf(layoutOf(docTab)));
  await screen.findByTestId("office-editor");
});

it("unsaved edits in it: the editor saves through its leave path (one saved version, as when its tab is left), then the view is unmounted", async () => {
  const app = await shownThenLeft();
  act(() => editor.report!({ dirty: true, changed: true, same: false, revision: 1, conflict: null }));
  editor.leave = async () => { editor.report!({ dirty: false, changed: false, same: false, revision: 2, conflict: null }); return 2; };
  app.leave();
  await rest(3 * SLEEP);
  expect(editor.left).toBe(1);
  expect(screen.queryByTestId("office-editor")).toBeNull();
});

it("a save that needs the person (a conflict to settle): the leave path refuses — the editor stays mounted with its edits, nothing is asked on the other project's screen, and it is not asked again before the next interval", async () => {
  const app = await shownThenLeft();
  act(() => editor.report!({ dirty: true, changed: true, same: false, revision: 1, conflict: { code: "revision_conflict", message: "다른 곳에서 r2가 생겼습니다." } }));
  editor.leave = async () => { throw new Error("문서의 저장 충돌을 해결한 뒤 이동해 주세요. 편집 내용은 현재 탭에 있습니다."); };
  app.leave();
  await rest(SLEEP + 400);
  expect(editor.left).toBe(1);
  expect(screen.queryByTestId("office-editor")).not.toBeNull();
  expect(document.querySelector('[role="dialog"], [role="alertdialog"], dialog')).toBeNull();
  expect(app.closeDocument).not.toHaveBeenCalled();
  // Asked again one interval later, not on every tick.
  await waitFor(() => expect(editor.left).toBe(2), { timeout: 3000 });
  expect(screen.queryByTestId("office-editor")).not.toBeNull();
});
