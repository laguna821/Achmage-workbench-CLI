// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserAction, BrowserDriverPoll, BrowserDriverReply, BrowserJob, BrowserJobResult, BrowserPage, BrowserPageCreate, NativeBrowserPage, Session, Work, Workspace } from "@workbench/contracts";
import type { Api } from "./api.ts";
import { SharedBrowser, type BrowserNative, type BrowserNativeCommand } from "./browser-state.ts";
import { BrowserView, NewBrowserDialog, BrowserSearch, openBrowserTab } from "./components/BrowserView.tsx";
import type { WorkActions } from "./components/WorkView.tsx";
import { initialState } from "./state.ts";
import { contentKey, moveTab, tabsOf, withTabs } from "./tabs.ts";
import { singleLayout, splitPane } from "./panes.ts";
import { createActions } from "./create-actions.ts";
import { BrowseStart } from "./components/BrowseStart.tsx";
import { AppearanceContext, DEFAULT_APPEARANCE } from "./appearance.ts";
import { sessionToOpen } from "./entry.ts";

vi.mock("./components/Transcript.tsx", () => ({ Transcript: (props: { sessionId: string; focusItem?: { itemId: string }; onAnswer: (id: string, decision: "accept") => void }) => <div data-testid="browser-transcript" data-session={props.sessionId} data-item={props.focusItem?.itemId}><button type="button" onClick={() => props.onAnswer("approval-exact", "accept")}>요청 확인</button></div> }));
vi.mock("./components/Composer.tsx", () => ({ Composer: (props: { disabled: boolean; onSend: (text: string) => Promise<boolean>; onStop: () => void }) => <form aria-label="웹 요청" onSubmit={event => { event.preventDefault(); void props.onSend("이 페이지를 읽어 주세요"); }}><button type="submit" disabled={props.disabled}>요청 보내기</button><button type="button" onClick={props.onStop}>AI 실행 멈추기</button></form> }));

const driverId = "driver-owned";
const nativePage = (pageId = "page-a"): NativeBrowserPage => ({ pageId, profileId: "default", url: "https://example.com/", title: "원본 웹 페이지", loading: false, control: { owner: "human", generation: 0 }, navigationRevision: 2, capabilities: ["observe", "navigate", "dom_actions", "persistent_profile"], popups: [], error: null });
const page = (pageId = "page-a"): BrowserPage => ({ ...nativePage(pageId), native: nativePage(pageId), driverId, workspaceId: "space", workId: "work", status: "ready", sessionId: null, createdAt: 1, updatedAt: 1 });
const main: Session = { id: "main", hostId: "host", workId: "work", workspaceId: "space", provider: "codex", purpose: "원래 대화", purposeSource: "user", status: "idle", queued: [], archivedAt: null, createdAt: 1, updatedAt: 1, nativeSessionId: null, model: null, effort: null, engineModel: null, engineEffort: null, preview: null, previewAt: null, activity: null, lastError: null, pinned: false, sort: 0, seenAt: null, unread: false, access: null, context: null };
const child = { ...main, id: "child", purpose: "웹 탭 AI", pageAgent: { pageId: "page-a", parentSessionId: "main" }, createdAt: 2, updatedAt: 2 } as Session;
const work = { id: "work", title: "연구", activeSessionId: "main", defaultWorkspaceId: "space", archivedAt: null } as Work;
const space = { id: "space", workId: "work", hostId: "host", cwd: "/fixture", label: "연구 폴더", archivedAt: null, removedAt: null } as Workspace;
beforeEach(() => {
  vi.useFakeTimers(); sessionStorage.clear(); localStorage.clear();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector<HTMLButtonElement>("button")?.focus(); };
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

function fixture(initial: BrowserPage[] = [page()]) {
  let rows = initial, natives = initial.flatMap(row => row.native ? [row.native] : []), jobs: BrowserJob[] = [];
  const profiles = [{ id: "default", name: "기본", createdAt: 1 }];
  const list = vi.fn(async () => ({ pages: rows, profiles }));
  const profile = vi.fn(async (name: string) => ({ id: "profile-new", name, createdAt: 2 }));
  const create = vi.fn(async (input: BrowserPageCreate): Promise<BrowserPage> => {
    const row = { ...page(input.requestId), workspaceId: input.workspaceId, url: input.url, profileId: input.profileId, native: null, status: "opening" as const };
    rows = [...rows, row]; return row;
  });
  const session = vi.fn(async (_pageId: string, _parent: string | null) => child);
  const control = vi.fn(async (pageId: string, owner: string, generation: number): Promise<BrowserPage> => {
    const before = rows.find(row => row.pageId === pageId)!;
    const next = { ...before, control: { owner, generation: generation + 1 }, native: { ...before.native!, control: { owner, generation: generation + 1 } } };
    rows = rows.map(row => row.pageId === pageId ? next : row); natives = natives.map(row => row.pageId === pageId ? next.native : row); return next;
  });
  const action = vi.fn(async (pageId: string, id: string, _action: BrowserAction): Promise<BrowserJobResult> => ({ id, pageId }));
  const receipt = vi.fn(async (_id: string): ReturnType<Api["sharedBrowser"]["receipt"]> => ({ status: "queued", result: null }));
  const poll = vi.fn(async (input: BrowserDriverPoll): Promise<BrowserDriverReply> => {
    rows = rows.map(row => {
      const live = input.pages.find(native => native.pageId === row.pageId);
      return row.status === "interrupted" ? row : live ? { ...row, native: live, url: live.url, status: "ready", control: live.control } : row.status === "ready" ? { ...row, native: null, status: "interrupted", error: "native gone" } : row;
    });
    const batch = jobs; jobs = []; return { pages: rows, profiles, jobs: batch };
  });
  const execute = vi.fn(async (job: BrowserJob): Promise<BrowserJobResult> => ({ id: job.id, pageId: job.pageId }));
  const native = vi.fn(async (command: BrowserNativeCommand): Promise<unknown> => {
    if (command.kind === "list") return natives;
    if (command.kind === "execute") return execute(command.job);
    if (command.kind === "create") { const next = { ...nativePage(command.pageId), url: command.url, profileId: command.profileId, control: command.control }; natives = [...natives, next]; return next; }
    return null;
  });
  const endpoint = { list, profile, create, session, control, action, receipt, poll };
  const browser = new SharedBrowser(endpoint, native as BrowserNative, driverId);
  const api = { sharedBrowser: endpoint, items: vi.fn(async () => ({ items: [], seq: 1 })) } as unknown as Api;
  const send = vi.fn(async (_session: Session, _text: string) => true), interrupt = vi.fn(), answer = vi.fn();
  const actions = { send, interrupt, answer, queued: { send: vi.fn(), cancel: vi.fn() } } as unknown as WorkActions;
  const state = { ...initialState, sessions: { main, child }, works: { work }, workspaces: { space } };
  return { browser, native, execute, endpoint, api, actions, send, interrupt, answer, state, setRows: (next: BrowserPage[]) => { rows = next; }, setNatives: (next: NativeBrowserPage[]) => { natives = next; }, setJobs: (next: BrowserJob[]) => { jobs = next; } };
}
const job = (id: string, pageId: string): BrowserJob => ({ id, pageId, driverId, action: { kind: "reload" }, expected: null, control: { owner: "human", generation: 0 }, deadline: Date.now() + 20000 });
const settle = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); };

it("uses an explicit acknowledged handoff, sends only to the page child, and keeps the main session", async () => {
  const f = fixture(); await f.browser.poll();
  const onNew = vi.fn(), onOpenSession = vi.fn();
  await act(async () => render(<BrowserView browser={f.browser} api={f.api} state={f.state} pageId="page-a" visible parentSessionId="main" actions={f.actions} onNew={onNew} onClosed={() => {}} onTranscript={() => {}} onOpenSession={onOpenSession} focusItem={null} onFocusDone={() => {}} />));
  expect(screen.queryByRole("complementary", { name: "웹 탭 AI 대화" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "AI에게 요청" })));
  expect(f.endpoint.session).toHaveBeenCalledWith("page-a", "main"); expect(f.endpoint.control).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "요청 보내기" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole("button", { name: "AI에게 맡기기" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "요청 보내기" })));
  expect(f.endpoint.control).toHaveBeenCalledWith("page-a", "child", 0);
  expect(f.endpoint.control.mock.invocationCallOrder[0]!).toBeLessThan(f.send.mock.invocationCallOrder[0]!);
  expect(f.send).toHaveBeenCalledWith(child, "이 페이지를 읽어 주세요", undefined, undefined, undefined);
  expect(screen.getByTestId("browser-transcript").dataset.session).toBe("child");
  fireEvent.click(screen.getByRole("button", { name: "요청 확인" })); expect(f.answer).toHaveBeenCalledWith(child, "approval-exact", "accept");
  expect((screen.getByRole("button", { name: "이전 페이지" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole("button", { name: "내가 조작하기" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "이전 페이지" })));
  expect(f.endpoint.control).toHaveBeenLastCalledWith("page-a", "human", 1);
  expect((screen.getByRole("button", { name: "이전 페이지" }) as HTMLButtonElement).disabled).toBe(false);
  expect(f.state.works.work.activeSessionId).toBe("main"); expect(sessionToOpen(f.state, work)?.id).toBe("main");
  fireEvent.click(screen.getByRole("button", { name: "원래 대화 열기" })); expect(onOpenSession).toHaveBeenCalledWith(main);
  fireEvent.click(screen.getByRole("button", { name: "기본" })); expect(onNew).toHaveBeenCalledWith({ workspaceId: "space", profileId: "default", url: "https://example.com/" });
});

it("reconciles an unknown human action by its receipt without repeating the mutation", async () => {
  const f = fixture(); await f.browser.poll();
  f.endpoint.action.mockRejectedValueOnce(new TypeError("응답 유실"));
  await act(async () => render(<BrowserView browser={f.browser} api={f.api} state={f.state} pageId="page-a" visible parentSessionId="main" actions={f.actions} onNew={() => {}} onClosed={() => {}} onTranscript={() => {}} onOpenSession={() => {}} focusItem={null} onFocusDone={() => {}} />));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "새로고침" })));
  const id = f.endpoint.action.mock.calls[0]![1];
  expect(f.endpoint.receipt).toHaveBeenCalledWith(id); expect(f.endpoint.action).toHaveBeenCalledOnce();
  expect(screen.getByRole("alert").textContent).toContain("자동 재실행하지 않았습니다");
  expect((screen.getByRole("button", { name: "새로고침" }) as HTMLButtonElement).disabled).toBe(true);
  f.endpoint.receipt.mockResolvedValueOnce({ status: "completed", result: { id, pageId: "page-a" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "결과 다시 확인" })));
  expect(f.endpoint.action).toHaveBeenCalledOnce(); expect(f.browser.getState().pending["page-a"]).toBeUndefined();
});

it("runs inactive pages concurrently, preserves each page order, and retains unknown results until acknowledged", async () => {
  const f = fixture([page("page-a"), page("page-b")]);
  let finishA!: (result: BrowserJobResult) => void;
  f.execute.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; }));
  f.execute.mockRejectedValueOnce(new Error("IPC 응답 유실"));
  const jobs = [job("a1", "page-a"), job("a2", "page-a"), job("b1", "page-b")];
  f.setJobs(jobs); await f.browser.poll(); await settle();
  expect(f.execute.mock.calls.map(call => call[0].id)).toEqual(["a1", "b1"]);
  finishA({ id: "a1", pageId: "page-a" }); await settle();
  expect(f.execute.mock.calls.map(call => call[0].id)).toEqual(["a1", "b1", "a2"]);
  f.endpoint.poll.mockRejectedValueOnce(new TypeError("host lost")); await f.browser.poll();
  const failedBatch = f.endpoint.poll.mock.calls.at(-1)![0].results;
  expect(failedBatch.find(result => result.id === "b1")).toMatchObject({ outcome: "unknown" });
  f.setJobs(jobs); await f.browser.poll();
  expect(f.endpoint.poll.mock.calls.at(-1)![0].results).toEqual(failedBatch); expect(f.execute).toHaveBeenCalledTimes(3);
  await f.browser.poll(); expect(f.endpoint.poll.mock.calls.at(-1)![0].results).toEqual([]);
});

it("uses measured native bounds, hides pages for DOM overlays and tab removal, and never recreates a lost page", async () => {
  const f = fixture(); await f.browser.poll();
  const surface = document.createElement("div"); document.body.append(surface);
  vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(new DOMRect(15, 40, 600, 350));
  const remove = f.browser.surface("slot-a", "page-a", surface, true); await f.browser.present();
  const presentations = () => f.native.mock.calls.map(call => call[0]).filter((command): command is Extract<BrowserNativeCommand, { kind: "present" }> => command.kind === "present");
  expect(presentations().at(-1)?.pages).toEqual([{ pageId: "page-a", x: 15, y: 40, width: 600, height: 350, visible: true }]);
  const overlay = document.createElement("div"); overlay.setAttribute("role", "dialog"); document.body.append(overlay);
  vi.spyOn(overlay, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList);
  await f.browser.present(); expect(presentations().at(-1)?.pages[0]?.visible).toBe(false);
  overlay.remove(); remove(); await f.browser.present(); expect(presentations().at(-1)?.pages[0]?.visible).toBe(false);
  f.setNatives([]); await f.browser.poll(); expect(f.browser.getState().pages[0]?.status).toBe("interrupted");
  await f.browser.poll(); expect(f.native.mock.calls.some(call => call[0].kind === "create")).toBe(false); surface.remove();
});

it("creates one native page after a lost host response, offers profiles, and preserves tab identity when moved", async () => {
  const f = fixture([]); await f.browser.poll();
  f.endpoint.create.mockImplementationOnce(async input => {
    f.setRows([{ ...page(input.requestId), native: null, status: "opening", url: input.url }]); throw new TypeError("lost response");
  });
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  const onOpen = vi.fn(), onClose = vi.fn();
  let mounted!: ReturnType<typeof render>;
  await act(async () => { mounted = render(<NewBrowserDialog browser={f.browser} workspaces={[space]} target={{ workspaceId: "space", url: "example.com" }} onOpen={onOpen} onClose={onClose} />); });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "웹 탭 열기" })));
  const request = f.endpoint.create.mock.calls[0]![0];
  expect(request.url).toBe("https://example.com/"); expect(f.endpoint.create).toHaveBeenCalledOnce();
  expect(f.native.mock.calls.filter(call => call[0].kind === "create")).toEqual([[{ kind: "create", pageId: request.requestId, profileId: "default", url: request.url, control: { owner: "human", generation: 0 } }]]);
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ pageId: request.requestId, status: "ready" }));
  mounted.unmount(); expect(document.activeElement).toBe(opener); opener.remove();
  const view = { kind: "browser", pageId: request.requestId };
  const layout = withTabs(singleLayout(view, "work"));
  const two = splitPane(layout, layout.focus, "right", { view: { kind: "browser", pageId: "another-page" }, workId: "work", sessionId: null }, null);
  const tab = tabsOf(two.panes[0]!)[0]!;
  const moved = moveTab(two, tab.id, { paneId: two.panes[1]!.id, side: "center" });
  expect(moved.panes.flatMap(tabsOf).filter(entry => contentKey(entry) === `browser:${request.requestId}`)).toHaveLength(1);
  expect(moved.panes.flatMap(tabsOf).find(entry => entry.id === tab.id)?.view.pageId).toBe(request.requestId);
  expect(createActions({ workId: "work", workspaceId: "space", folderId: null }).find(action => action.kind === "browser")?.label).toBe("새 웹 탭");
});

it("closes the native page only for an explicit close guard, with takeover before close and no duplicate footer close", async () => {
  const controlled = { owner: "child", generation: 4 };
  const f = fixture([{ ...page(), sessionId: "child", control: controlled, native: { ...nativePage(), control: controlled } }]);
  await f.browser.poll();
  const holder: { guard: ((reason?: "close") => Promise<void>) | null } = { guard: null };
  const capture = (guard: typeof holder.guard) => { holder.guard = guard; };
  let mounted!: ReturnType<typeof render>;
  await act(async () => { mounted = render(<BrowserView browser={f.browser} api={f.api} state={f.state} pageId="page-a" visible parentSessionId="main" actions={f.actions} onNew={() => {}} onClosed={() => {}} onLeaveGuard={capture} onTranscript={() => {}} onOpenSession={() => {}} focusItem={null} onFocusDone={() => {}} />); });
  await holder.guard!(); expect(f.endpoint.control).not.toHaveBeenCalled(); expect(f.endpoint.action).not.toHaveBeenCalled();
  mounted.unmount(); expect(f.endpoint.action).not.toHaveBeenCalled(); expect(holder.guard).toBeNull();
  await act(async () => { mounted = render(<BrowserView browser={f.browser} api={f.api} state={f.state} pageId="page-a" visible parentSessionId="main" actions={f.actions} onNew={() => {}} onClosed={() => {}} onLeaveGuard={capture} onTranscript={() => {}} onOpenSession={() => {}} focusItem={null} onFocusDone={() => {}} />); });
  await act(async () => { await Promise.all([holder.guard!("close"), f.browser.close("page-a")]); });
  expect(f.endpoint.control).toHaveBeenCalledWith("page-a", "human", 4);
  expect(f.endpoint.control.mock.invocationCallOrder[0]!).toBeLessThan(f.endpoint.action.mock.invocationCallOrder[0]!);
  expect(f.endpoint.action).toHaveBeenCalledWith("page-a", expect.any(String), { kind: "close" });
  await holder.guard!("close"); expect(f.endpoint.action).toHaveBeenCalledOnce(); expect(f.browser.getState().pages[0]?.status).toBe("closed");
});


it("opens a direct blank tab with the inherited workspace/profile and searches without a dialog", async () => {
  const f = fixture([]); await f.browser.poll();
  const opened = await openBrowserTab(f.browser, f.api, f.state, { workspaceId: "space", profileId: "default" });
  expect(f.endpoint.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "space", profileId: "default", url: "about:blank" }));
  expect(opened.url).toBe("about:blank"); expect(sessionStorage.getItem("workbench.browser.creation")).toBeNull();
  const onOpen = vi.fn(async () => true);
  render(<BrowserSearch onOpen={onOpen} />);
  fireEvent.change(screen.getByRole("textbox", { name: "웹 검색 또는 주소" }), { target: { value: "한림대학교" } });
  await act(async () => fireEvent.submit(screen.getByRole("search", { name: "웹 검색" })));
  expect(onOpen).toHaveBeenCalledWith("한림대학교"); expect(screen.queryByRole("dialog")).toBeNull();
});

it("creates a default project only when a workspace is missing", async () => {
  const f = fixture([]); await f.browser.poll();
  const createWork = vi.fn(async () => ({ ...work, defaultWorkspaceId: "managed-space" }));
  await openBrowserTab(f.browser, { ...f.api, createWork } as unknown as Api, { ...f.state, works: {}, workspaces: {} }, {});
  expect(createWork).toHaveBeenCalledOnce();
  expect(f.endpoint.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "managed-space", url: "about:blank" }));
});

it("keeps the composer available after human takeover and does not send when control fails", async () => {
  const f = fixture([{ ...page(), sessionId: "child" }]); await f.browser.poll();
  await act(async () => render(<BrowserView browser={f.browser} api={f.api} state={f.state} pageId="page-a" visible parentSessionId="main" actions={f.actions} onNew={() => {}} onClosed={() => {}} onTranscript={() => {}} onOpenSession={() => {}} focusItem={{ sessionId: "child", itemId: "a", nonce: 1 }} onFocusDone={() => {}} />));
  f.endpoint.control.mockRejectedValueOnce(new Error("제어권 인계 실패"));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "요청 보내기" })));
  expect(f.send).not.toHaveBeenCalled(); expect(screen.getByRole("alert").textContent).toContain("제어권 인계 실패");
  expect((screen.getByRole("button", { name: "요청 보내기" }) as HTMLButtonElement).disabled).toBe(false);
});

it("hands a queued request to the same page session only after control is granted", async () => {
  const f = fixture([{ ...page(), sessionId: "child" }]); await f.browser.poll();
  const queued = { ...child, queued: [{ id: "q1", text: "검색해 주세요", held: true }] } as Session;
  await act(async () => render(<BrowserView browser={f.browser} api={f.api} state={{ ...f.state, sessions: { ...f.state.sessions, child: queued } }} pageId="page-a" visible parentSessionId="main" actions={f.actions} onNew={() => {}} onClosed={() => {}} onTranscript={() => {}} onOpenSession={() => {}} focusItem={{ sessionId: "child", itemId: "a", nonce: 1 }} onFocusDone={() => {}} />));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "보내기" })));
  expect(f.endpoint.control).toHaveBeenCalledWith("page-a", "child", 0);
  expect(f.actions.queued.send).toHaveBeenCalledWith(queued, "q1");
  expect(f.endpoint.control.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(f.actions.queued.send).mock.invocationCallOrder[0]!);
});


it("refreshes the page transcript when a turn ends so the assistant body arrives with its receipt", async () => {
  const f = fixture([{ ...page(), sessionId: "child" }]); await f.browser.poll();
  const text = "브라우저 제어권이 사용자에게 있어 검색을 진행하지 못했습니다.";
  const completed = { items: [{ id: "answer", kind: "assistant", text, streaming: false, at: 3 }, { id: "end", kind: "turnEnd", status: "completed", at: 4 }], seq: 9 } as Awaited<ReturnType<Api["items"]>>;
  f.api.items = vi.fn(async () => completed);
  const onTranscript = vi.fn();
  const state = { ...f.state, transcripts: { child: { items: [], seq: 2 } } };
  const props = { browser: f.browser, api: f.api, pageId: "page-a", visible: true, parentSessionId: "main", actions: f.actions, onNew: () => {}, onClosed: () => {}, onTranscript, onOpenSession: () => {}, focusItem: null, onFocusDone: () => {} };
  let mounted!: ReturnType<typeof render>;
  await act(async () => { mounted = render(<BrowserView {...props} state={{ ...state, sessions: { ...state.sessions, child: { ...child, status: "running" } } }} />); });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "AI에게 요청" })));
  expect(f.api.items).not.toHaveBeenCalled();
  await act(async () => mounted.rerender(<BrowserView {...props} state={state} />));
  expect(onTranscript).toHaveBeenCalledWith("child", completed);
});


it("shows one Search or Ask input in the common home entry", async () => {
  const onSearch = vi.fn(async () => true);
  render(<BrowseStart onSearch={onSearch}><textarea aria-label="메인 작업 요청" /></BrowseStart>);
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  expect(screen.queryByRole("textbox", { name: "메인 작업 요청" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Ask" }));
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: "메인 작업 요청" })).toBeTruthy();
  expect(screen.queryByRole("search")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Search" }));
  fireEvent.change(screen.getByRole("textbox", { name: "웹 검색 또는 주소" }), { target: { value: "example.com" } });
  await act(async () => fireEvent.submit(screen.getByRole("search")));
  expect(onSearch).toHaveBeenCalledWith("example.com");
});

it("routes blank-tab Ask to the main task callback without creating a page child", async () => {
  const native = { ...nativePage(), url: "about:blank" };
  const f = fixture([{ ...page(), url: "about:blank", native }]); await f.browser.poll();
  const onStart = vi.fn(async () => true);
  const appearance = { lookOf: (provider: "codex" | "claude") => DEFAULT_APPEARANCE[provider].light } as React.ContextType<typeof AppearanceContext>;
  await act(async () => render(<AppearanceContext.Provider value={appearance}><BrowserView browser={f.browser} api={f.api} state={f.state} pageId="page-a" visible parentSessionId="main" actions={f.actions} onNew={() => {}} onClosed={() => {}} onStart={onStart} engine="codex" onTranscript={() => {}} onOpenSession={() => {}} focusItem={null} onFocusDone={() => {}} /></AppearanceContext.Provider>));
  expect(screen.queryByRole("complementary", { name: "웹 탭 AI 대화" })).toBeNull();
  expect(screen.queryByRole("button", { name: "AI에게 요청" })).toBeNull();
  expect(screen.getByRole("search")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Ask" }));
  fireEvent.click(screen.getByRole("radio", { name: "Claude" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "요청 보내기" })));
  expect(onStart).toHaveBeenCalledWith("이 페이지를 읽어 주세요", "claude", { model: null, effort: null });
  expect(f.endpoint.session).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
});
