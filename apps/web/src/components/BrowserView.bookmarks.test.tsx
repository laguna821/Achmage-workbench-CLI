// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookmarkNode, Bookmarks, BrowserPage, NativeBrowserPage } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { SharedBrowser, type BrowserNativeCommand } from "../browser-state.ts";
import { initialState, type State } from "../state.ts";
import { ShownPanels, ShownPanelsContext } from "../completion-notifications.ts";
import { AppearanceContext, DEFAULT_APPEARANCE } from "../appearance.ts";
import { DocContext } from "./DocCards.tsx";
import { BrowserView } from "./BrowserView.tsx";
import type { WorkActions } from "./WorkView.tsx";

// The bookmark bar inside a web tab (bookmarks unit, 0.5.1): directly under the address row, the star at
// the end of the address field; a bookmark opens in THIS tab through the page's own navigation, or in a
// new web tab of the same project; and the native page's box is measured again when the bar shows or hides.

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  Element.prototype.scrollIntoView = vi.fn();
  sessionStorage.clear();
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const native: NativeBrowserPage = { pageId: "p", profileId: "default", url: "https://ctl.example.ac.kr/guide", title: "평가 루브릭 안내", loading: false, control: { owner: "human", generation: 1 }, navigationRevision: 1, capabilities: ["observe", "navigate"], popups: [], error: null } as unknown as NativeBrowserPage;
const pageOf = (url = native.url): BrowserPage => ({ ...native, url, native: { ...native, url }, driverId: "driver", workspaceId: "ws", workId: "w", status: "ready", sessionId: null, createdAt: 1, updatedAt: 1 }) as unknown as BrowserPage;
const MARKS = (): BookmarkNode[] => [{ id: "hallym", kind: "item", title: "한림대학교", url: "https://www.hallym.ac.kr/" }, { id: "class", kind: "folder", title: "수업", children: [{ id: "smart", kind: "item", title: "스마트캠퍼스", url: "https://smart.hallym.ac.kr/" }] }];

function apiWith(start: BookmarkNode[]) {
  const marks: Bookmarks = { showBar: true, items: start };
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    const input = (body ?? {}) as Record<string, unknown>;
    if (path === "/api/bookmarks" && method === "POST") marks.items.push({ id: `n${marks.items.length}`, kind: "item", title: String(input.title), url: String(input.url) });
    if (path === "/api/bookmarks/bar") marks.showBar = input.show !== false;
    return structuredClone(marks);
  });
  const api = new Proxy({ request } as Record<string, unknown>, { get: (target, key: string) => (key in target ? target[key] : key === "then" ? undefined : vi.fn(async () => ({}))) }) as unknown as Api;
  return { api, request };
}

function show(browser: SharedBrowser, api: Api, extra: Partial<Parameters<typeof BrowserView>[0]> = {}) {
  const state = { ...initialState, ready: true, sessions: {}, transcripts: {}, providers: {} } as unknown as State;
  const actions = new Proxy({}, { get: () => vi.fn() }) as unknown as WorkActions;
  return render(
    <AppearanceContext.Provider value={{ appTheme: "light", lookOf: (provider: "codex" | "claude") => DEFAULT_APPEARANCE[provider].light } as never}>
    <ShownPanelsContext.Provider value={new ShownPanels()}>
    <DocContext.Provider value={{ state, actions: new Proxy({}, { get: () => vi.fn() }) } as never}>
      <BrowserView browser={browser} api={api} state={state} pageId="p" visible parentSessionId={null} actions={actions} onNew={() => undefined} onClosed={() => undefined}
        onTranscript={() => undefined} onOpenSession={() => undefined} focusItem={null} onFocusDone={() => undefined} {...extra} />
    </DocContext.Provider>
    </ShownPanelsContext.Provider>
    </AppearanceContext.Provider>,
  );
}

/** A web tab over a stand-in browser (no native view): what the bar asks of the page. */
function standIn(page = pageOf()) {
  const data = { pages: [page], profiles: [{ id: "default", name: "기본" }], pending: {}, connected: true, error: null, closedPageIds: [] };
  const control = vi.fn(async () => undefined), action = vi.fn(async () => undefined);
  const browser = { available: true, driverId: "driver", subscribe: () => () => undefined, getState: () => data, surface: vi.fn(() => () => undefined), restore: vi.fn(async () => undefined), control, action, close: vi.fn(async () => undefined) } as unknown as SharedBrowser;
  return { browser, control, action };
}

describe("a web tab's bookmark bar", () => {
  it("sits directly under the address row, with the star at the end of the address field", async () => {
    const { browser } = standIn(), { api } = apiWith(MARKS());
    await act(async () => { show(browser, api); });
    const view = document.querySelector(".browser-view")!;
    expect([...view.children].slice(0, 3).map(child => child.className)).toEqual(["browser-toolbar", "bookmark-bar", "browser-content"]);
    const field = screen.getByRole("textbox", { name: "현재 웹 주소" });
    expect([...field.parentElement!.children].map(child => child.getAttribute("aria-label"))).toEqual(["현재 웹 주소", "이 페이지를 즐겨찾기에 추가", "이동"]);
    expect(within(screen.getByRole("toolbar", { name: "즐겨찾기 줄" })).getAllByRole("button").map(key => key.getAttribute("aria-label"))).toEqual(["한림대학교", "수업"]);
  });

  it("a click goes to the page in THIS tab (the person takes the page, then navigates); Ctrl-click and 새 탭에서 열기 ask for a new web tab", async () => {
    const { browser, control, action } = standIn(), { api } = apiWith(MARKS()), onOpenUrl = vi.fn();
    await act(async () => { show(browser, api, { onOpenUrl }); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "한림대학교" })); });
    expect(control).toHaveBeenCalledWith("p", "human");
    expect(action).toHaveBeenCalledWith("p", { kind: "navigate", url: "https://www.hallym.ac.kr/" });
    expect(onOpenUrl).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "한림대학교" }), { ctrlKey: true }); });
    expect(onOpenUrl).toHaveBeenLastCalledWith("https://www.hallym.ac.kr/");
    fireEvent.contextMenu(screen.getByRole("button", { name: "한림대학교" }), { clientX: 30, clientY: 70 });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "새 탭에서 열기" }));
    expect(onOpenUrl).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("the blank new-tab page has the bar too (its star is off: there is no page to keep)", async () => {
    const { browser, action } = standIn(pageOf("about:blank")), { api } = apiWith(MARKS());
    await act(async () => { show(browser, api); });
    expect((document.querySelector(".bookmark-star") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "한림대학교" })); });
    expect(action).toHaveBeenCalledWith("p", { kind: "navigate", url: "https://www.hallym.ac.kr/" });
  });

  it("the native page's box is measured again when the bar shows and when it hides", async () => {
    // The real driver over a stand-in native side: the page area starts 32 px lower while the bar is there.
    const commands: BrowserNativeCommand[] = [];
    const nativeSide = vi.fn(async (command: BrowserNativeCommand) => { commands.push(command); return command.kind === "list" ? [native] : undefined; });
    const endpoint = { poll: vi.fn(async () => ({ pages: [pageOf()], profiles: [{ id: "default", name: "기본", createdAt: 1 }], jobs: [], closedPageIds: [], closedPages: [] })) };
    const browser = new SharedBrowser(endpoint as never, nativeSide as never, "driver");
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.classList.contains("browser-viewport") ? new DOMRect(0, document.querySelector(".bookmark-bar") ? 84 : 52, 1000, document.querySelector(".bookmark-bar") ? 668 : 700) : new DOMRect(0, 0, 0, 0);
    });
    const placed = () => commands.filter((command): command is Extract<BrowserNativeCommand, { kind: "present" }> => command.kind === "present").at(-1)?.pages[0];
    const { api } = apiWith([]);
    const stop = browser.start();
    try {
      await act(async () => { show(browser, api); });
      await waitFor(() => expect(placed()).toEqual({ pageId: "p", x: 0, y: 52, width: 1000, height: 700, visible: true }));
      expect(screen.queryByRole("toolbar", { name: "즐겨찾기 줄" })).toBeNull();
      // The first bookmark: the bar appears, and the page moves down under it.
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "이 페이지를 즐겨찾기에 추가" })); });
      expect(screen.getByRole("toolbar", { name: "즐겨찾기 줄" })).toBeTruthy();
      await waitFor(() => expect(placed()).toEqual({ pageId: "p", x: 0, y: 84, width: 1000, height: 668, visible: true }));
      // Ctrl+Shift+B hides the bar: the page takes the row back.
      await act(async () => { fireEvent.keyDown(document.body, { key: "B", code: "KeyB", ctrlKey: true, shiftKey: true }); });
      expect(screen.queryByRole("toolbar", { name: "즐겨찾기 줄" })).toBeNull();
      await waitFor(() => expect(placed()).toEqual({ pageId: "p", x: 0, y: 52, width: 1000, height: 700, visible: true }));
    } finally { stop(); }
  });

  it("Ctrl/⌘+D and Ctrl/⌘+Shift+B pressed inside the page reach the tab: the native listing hands them over once, and they never go to the gateway", async () => {
    // The page script took the keys (shared_browser.js); the next native listing carries them as `keys`.
    let pressed: string[] = [];
    const nativeSide = vi.fn(async (command: BrowserNativeCommand) => { if (command.kind !== "list") return undefined; const keys = pressed; pressed = []; return [{ ...native, keys }]; });
    const polled: unknown[] = [];
    const endpoint = { poll: vi.fn(async (input: { pages: unknown[] }) => { polled.push(...input.pages); return { pages: [pageOf()], profiles: [{ id: "default", name: "기본", createdAt: 1 }], jobs: [], closedPageIds: [], closedPages: [] }; }) };
    const browser = new SharedBrowser(endpoint as never, nativeSide as never, "driver");
    const { api, request } = apiWith([]);
    await act(async () => { show(browser, api); });
    await act(async () => { await browser.poll(); });
    pressed = ["bookmark"];
    await act(async () => { await browser.poll(); });
    expect(request.mock.calls.filter(call => call[0] !== "GET")).toEqual([["POST", "/api/bookmarks", { kind: "item", title: "평가 루브릭 안내", url: "https://ctl.example.ac.kr/guide" }]]);
    // Handed over once: the next listing does not repeat it.
    await act(async () => { await browser.poll(); });
    expect(request.mock.calls.filter(call => call[0] !== "GET")).toHaveLength(1);
    pressed = ["bookmark-bar", "reload"];
    await act(async () => { await browser.poll(); });
    expect(request.mock.calls.filter(call => call[0] !== "GET").at(-1)).toEqual(["PUT", "/api/bookmarks/bar", { show: false }]);
    expect(request.mock.calls.filter(call => call[0] !== "GET")).toHaveLength(2);
    expect(polled.length).toBeGreaterThan(0);
    for (const page of polled) expect(page).not.toHaveProperty("keys");
  });

  it("a page not on screen does not answer the keys pressed in it", async () => {
    const nativeSide = vi.fn(async (command: BrowserNativeCommand) => command.kind === "list" ? [{ ...native, keys: ["bookmark"] }] : undefined);
    const endpoint = { poll: vi.fn(async () => ({ pages: [pageOf()], profiles: [], jobs: [], closedPageIds: [], closedPages: [] })) };
    const browser = new SharedBrowser(endpoint as never, nativeSide as never, "driver");
    const { api, request } = apiWith([]);
    await act(async () => { show(browser, api, { visible: false }); });
    await act(async () => { await browser.poll(); });
    await act(async () => { await browser.poll(); });
    expect(request.mock.calls.filter(call => call[0] !== "GET")).toEqual([]);
  });
});
