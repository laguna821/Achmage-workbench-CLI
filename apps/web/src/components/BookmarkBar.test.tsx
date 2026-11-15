// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookmarkNode, Bookmarks } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { ApiRequestError } from "../api.ts";
import { AppearanceContext, DEFAULT_APPEARANCE } from "../appearance.ts";
import { bookmarkLetter, fitCount, shortTitle, typedAddress } from "../bookmarks.ts";
import { useBookmarkUi } from "./BookmarkBar.tsx";
import { BookmarkSettings } from "./BookmarkImport.tsx";

// The bookmark bar of a web tab, the star in the address field, and 설정's keys (bookmarks unit, 0.5.1).
// The gateway is a small stand-in that keeps the set in memory and answers as bookmarks.ts does.

beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const item = (id: string, title: string, url: string): BookmarkNode => ({ id, kind: "item", title, url });
const folder = (id: string, title: string, children: BookmarkNode[]): BookmarkNode => ({ id, kind: "folder", title, children });
const FIXTURE = (): BookmarkNode[] => [
  item("hallym", "한림대학교", "https://www.hallym.ac.kr/"),
  folder("class", "수업", [item("smart", "스마트캠퍼스", "https://smart.hallym.ac.kr/"), folder("papers", "자료", [item("riss", "RISS", "https://www.riss.kr/")]), folder("empty", "빈 폴더", [])]),
  item("long", "국립국어원 표준국어대사전 검색 결과 모음", "https://stdict.korean.go.kr/"),
  item("riss2", "riss 학술연구정보", "https://www.riss.kr/index.do"),
];

function gateway(start: BookmarkNode[] = FIXTURE(), showBar = true) {
  const state: Bookmarks = { showBar, items: start };
  let made = 0;
  const locate = (id: string, nodes = state.items): { list: BookmarkNode[]; index: number } | null => {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      if (node.id === id) return { list: nodes, index };
      if (node.kind === "folder") { const inner = locate(id, node.children); if (inner) return inner; }
    }
    return null;
  };
  const view = () => structuredClone(state);
  const request = vi.fn(async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const input = (body ?? {}) as Record<string, unknown>;
    if (path === "/api/bookmarks" && method === "GET") return view();
    if (path === "/api/bookmarks" && method === "DELETE") { state.items = []; return view(); }
    if (path === "/api/bookmarks" && method === "POST") {
      state.items.push(input.kind === "folder" ? { id: `new${++made}`, kind: "folder", title: String(input.title), children: [] } : { id: `new${++made}`, kind: "item", title: String(input.title), url: String(input.url) });
      return view();
    }
    if (path === "/api/bookmarks/bar") { state.showBar = input.show !== false; return view(); }
    if (path === "/api/bookmarks/sources") return [{ id: "chrome", label: "Chrome", profiles: [{ id: "Default", name: "기본 프로필" }] }, { id: "firefox", label: "Firefox", profiles: [{ id: "0:Profile0", name: "default-release" }] }];
    if (path === "/api/bookmarks/import") { state.items.push({ id: `new${++made}`, kind: "item", title: "가져온 것", url: "https://imported.example/" }); return { bookmarks: view(), items: 12, folders: 3, message: "즐겨찾기 12개, 폴더 3개를 가져왔습니다." }; }
    const target = /^\/api\/bookmarks\/items\/([^/]+)(\/move)?$/.exec(path);
    const at = target ? locate(decodeURIComponent(target[1]!)) : null;
    if (!target || !at) throw new Error(`no route ${method} ${path}`);
    const node = at.list[at.index]!;
    if (target[2]) { at.list.splice(at.index, 1); state.items.splice(Number(input.index), 0, node); }
    else if (method === "DELETE") at.list.splice(at.index, 1);
    else {
      if (typeof input.url === "string") { if (!/^https?:\/\/[^/]/.test(input.url)) throw new ApiRequestError(400, { code: "bookmark_url", message: "http 또는 https로 시작하는 웹 주소만 즐겨찾기에 넣을 수 있습니다." }); (node as { url: string }).url = input.url; }
      if (typeof input.title === "string") node.title = input.title;
    }
    return view();
  });
  return { api: { request } as unknown as Api, request, state, calls: () => request.mock.calls.filter(call => call[0] !== "GET").map(call => [call[0], call[1], call[2]]) };
}

function Tab({ api, onOpen, url = "https://www.kci.go.kr/", title = "KCI 한국학술지인용색인", active = true }: { api: Api; onOpen: (url: string, newTab: boolean) => void; url?: string | null; title?: string; active?: boolean }) {
  const marks = useBookmarkUi({ api, page: url ? { url, title } : null, onOpen, active });
  return <section className="browser-view"><div className="browser-toolbar"><form><input aria-label="현재 웹 주소" />{marks.star}</form></div>{marks.bar}</section>;
}
async function mount(options: { start?: BookmarkNode[]; showBar?: boolean; url?: string | null } = {}) {
  const host = gateway(options.start, options.showBar), onOpen = vi.fn();
  await act(async () => {
    render(<AppearanceContext.Provider value={{ appTheme: "light", lookOf: (provider: "codex" | "claude") => DEFAULT_APPEARANCE[provider].light } as never}><Tab api={host.api} onOpen={onOpen} url={options.url} /></AppearanceContext.Provider>);
  });
  return { ...host, onOpen };
}
const bar = () => screen.queryByRole("toolbar", { name: "즐겨찾기 줄" });
const keys = () => within(bar()!).getAllByRole("button").map(key => key.textContent);
const key = (name: string) => within(bar()!).getByRole("button", { name });
const menu = () => screen.getByRole("menu");
const menuLabels = (surface: HTMLElement = menu()) => within(surface).getAllByRole("menuitem").map(entry => entry.textContent);
const star = () => document.querySelector<HTMLButtonElement>(".bookmark-star")!;

describe("the bookmark bar under a web tab's address", () => {
  it("no bookmarks yet → no bar (not an empty strip); with bookmarks, one row of items and folders in order", async () => {
    await mount({ start: [] });
    expect(bar()).toBeNull();
    cleanup();
    await mount();
    expect(document.querySelector(".browser-toolbar + .bookmark-bar")).toBeTruthy();
    // A name is cut at 18 characters with an ellipsis; the whole name and the address are in the tip.
    expect(keys()).toEqual(["한한림대학교", "수업", "국국립국어원 표준국어대사전 검색…", "Rriss 학술연구정보"]);
    expect(key("국립국어원 표준국어대사전 검색 결과 모음").getAttribute("title")).toBe("국립국어원 표준국어대사전 검색 결과 모음\nhttps://stdict.korean.go.kr/");
    expect(key("수업").getAttribute("aria-haspopup")).toBe("menu");
    expect(key("수업").querySelector(".item-icon.item-folder")).toBeTruthy();
    expect(key("한림대학교").querySelector(".bookmark-mark")!.textContent).toBe("한");
  });

  it("a change made in another window arrives when this window gets the focus again", async () => {
    const at = await mount();
    at.state.items.push(item("other", "다른 창에서 넣은 것", "https://other.example/"));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(keys().at(-1)).toBe("다다른 창에서 넣은 것");
  });

  it("is hidden when 즐겨찾기 줄 보이기 is off, and Ctrl+Shift+B shows and hides it", async () => {
    const at = await mount({ showBar: false });
    expect(bar()).toBeNull();
    await act(async () => { fireEvent.keyDown(document.body, { key: "B", code: "KeyB", ctrlKey: true, shiftKey: true }); });
    expect(at.calls()).toEqual([["PUT", "/api/bookmarks/bar", { show: true }]]);
    expect(bar()).toBeTruthy();
    await act(async () => { fireEvent.keyDown(document.body, { key: "ㅠ", code: "KeyB", metaKey: true, shiftKey: true }); });
    expect(bar()).toBeNull();
  });

  it("a click opens the page in THIS web tab; a middle click or Ctrl/⌘-click opens a new web tab", async () => {
    const at = await mount();
    fireEvent.click(key("한림대학교"));
    expect(at.onOpen).toHaveBeenLastCalledWith("https://www.hallym.ac.kr/", false);
    fireEvent.click(key("한림대학교"), { ctrlKey: true });
    expect(at.onOpen).toHaveBeenLastCalledWith("https://www.hallym.ac.kr/", true);
    fireEvent.click(key("한림대학교"), { metaKey: true });
    expect(at.onOpen).toHaveBeenLastCalledWith("https://www.hallym.ac.kr/", true);
    fireEvent(key("riss 학술연구정보"), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(at.onOpen).toHaveBeenLastCalledWith("https://www.riss.kr/index.do", true);
    expect(at.onOpen).toHaveBeenCalledTimes(4);
  });

  it("a folder is a key that opens a menu of its items; a folder inside it is a sub-menu; an empty one says so", async () => {
    const at = await mount();
    fireEvent.click(key("수업"));
    expect(key("수업").getAttribute("aria-expanded")).toBe("true");
    expect(menuLabels()).toEqual(["스마트캠퍼스", "자료", "빈 폴더"]);
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "자료" }));
    const inner = screen.getAllByRole("menu")[1]!;
    expect(menuLabels(inner)).toEqual(["RISS"]);
    fireEvent.click(within(inner).getByRole("menuitem", { name: "RISS" }));
    expect(at.onOpen).toHaveBeenLastCalledWith("https://www.riss.kr/", false);
    expect(screen.queryByRole("menu")).toBeNull();
    // Ctrl-click in the menu: a new web tab.
    fireEvent.click(key("수업"));
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "스마트캠퍼스" }), { ctrlKey: true });
    expect(at.onOpen).toHaveBeenLastCalledWith("https://smart.hallym.ac.kr/", true);
    fireEvent.click(key("수업"));
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "빈 폴더" }));
    expect(screen.getAllByRole("menu")[1]!.textContent).toBe("비어 있음");
  });

  it("what does not fit goes behind »: a menu of the rest", async () => {
    // jsdom lays nothing out: every key is 100 wide, the row 250 (two fit).
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) { return [...(this.parentElement?.children ?? [])].indexOf(this) * 100; });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(250);
    const at = await mount();
    expect(within(bar()!).getAllByRole("button").map(entry => entry.getAttribute("aria-label"))).toEqual(["한림대학교", "수업", "나머지 즐겨찾기"]);
    expect(key("나머지 즐겨찾기").textContent).toBe("»");
    // The ones that do not fit stay laid out (to be measured) but are out of sight and out of reach.
    expect([...bar()!.querySelectorAll("[data-overflow]")].map(entry => [entry.getAttribute("aria-label"), entry.getAttribute("tabindex"), entry.getAttribute("aria-hidden")])).toEqual([["국립국어원 표준국어대사전 검색 결과 모음", "-1", "true"], ["riss 학술연구정보", "-1", "true"]]);
    fireEvent.click(key("나머지 즐겨찾기"));
    expect(menuLabels()).toEqual(["국립국어원 표준국어대사전 검색 결과 모음", "riss 학술연구정보"]);
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "riss 학술연구정보" }));
    expect(at.onOpen).toHaveBeenLastCalledWith("https://www.riss.kr/index.do", false);
    expect(fitCount([100, 200, 300], 250)).toBe(2);
    expect(fitCount([100, 200], 250)).toBe(2);
    expect(fitCount([], 0)).toBe(0);
  });
});

describe("adding and editing, as a browser does", () => {
  it("right-click on the bar's empty space: 이 페이지를 즐겨찾기에 추가, 폴더 추가", async () => {
    const at = await mount();
    fireEvent.contextMenu(bar()!, { clientX: 400, clientY: 70 });
    expect(menuLabels()).toEqual(["이 페이지를 즐겨찾기에 추가", "폴더 추가"]);
    await act(async () => { fireEvent.click(within(menu()).getByRole("menuitem", { name: "이 페이지를 즐겨찾기에 추가" })); });
    expect(at.calls()).toEqual([["POST", "/api/bookmarks", { kind: "item", title: "KCI 한국학술지인용색인", url: "https://www.kci.go.kr/" }]]);
    expect(keys().at(-1)).toBe("KKCI 한국학술지인용색인");
    fireEvent.contextMenu(bar()!, { clientX: 400, clientY: 70 });
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "폴더 추가" }));
    const dialog = screen.getByRole("dialog", { name: "폴더 추가" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "폴더 이름" }), { target: { value: "학회" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "추가" })); });
    expect(at.calls().at(-1)).toEqual(["POST", "/api/bookmarks", { kind: "folder", title: "학회" }]);
    expect(key("학회").getAttribute("aria-haspopup")).toBe("menu");
    // The page is already kept: adding it again is off, and says why.
    fireEvent.contextMenu(bar()!, { clientX: 400, clientY: 70 });
    expect(within(menu()).getByRole("menuitem", { name: /이 페이지를 즐겨찾기에 추가/ }).getAttribute("aria-disabled")).toBe("true");
  });

  it("right-click on an item: 새 탭에서 열기, 이름 바꾸기, 주소 고치기, 삭제", async () => {
    const at = await mount();
    const openMenu = () => fireEvent.contextMenu(key("한림대학교"), { clientX: 30, clientY: 70 });
    openMenu();
    expect(menuLabels()).toEqual(["새 탭에서 열기", "이름 바꾸기", "주소 고치기", "삭제"]);
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "새 탭에서 열기" }));
    expect(at.onOpen).toHaveBeenLastCalledWith("https://www.hallym.ac.kr/", true);
    openMenu();
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "이름 바꾸기" }));
    let dialog = screen.getByRole("dialog", { name: "즐겨찾기 이름 바꾸기" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "이름" }), { target: { value: "한림대" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "바꾸기" })); });
    expect(at.calls().at(-1)).toEqual(["PATCH", "/api/bookmarks/items/hallym", { title: "한림대" }]);
    fireEvent.contextMenu(key("한림대"), { clientX: 30, clientY: 70 });
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "주소 고치기" }));
    dialog = screen.getByRole("dialog", { name: "즐겨찾기 주소 고치기" });
    const field = within(dialog).getByRole("textbox", { name: "주소" }) as HTMLInputElement;
    expect(field.value).toBe("https://www.hallym.ac.kr/");
    // A refusal stays in the dialog, in the gateway's words; an address typed without https:// gets it.
    fireEvent.change(field, { target: { value: "ftp://files.example/" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "고치기" })); });
    expect(within(dialog).getByRole("alert").textContent).toBe("http 또는 https로 시작하는 웹 주소만 즐겨찾기에 넣을 수 있습니다.");
    fireEvent.change(field, { target: { value: "www.hallym.ac.kr/kr" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "고치기" })); });
    expect(at.calls().at(-1)).toEqual(["PATCH", "/api/bookmarks/items/hallym", { url: "https://www.hallym.ac.kr/kr" }]);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.contextMenu(key("한림대"), { clientX: 30, clientY: 70 });
    await act(async () => { fireEvent.click(within(menu()).getByRole("menuitem", { name: "삭제" })); });
    expect(at.calls().at(-1)).toEqual(["DELETE", "/api/bookmarks/items/hallym", undefined]);
    expect(keys()[0]).toBe("수업");
    expect(typedAddress(" example.com ")).toBe("https://example.com");
  });

  it("right-click on a folder: 이름 바꾸기, 삭제 (a folder with bookmarks in it asks first)", async () => {
    const at = await mount();
    fireEvent.contextMenu(key("수업"), { clientX: 120, clientY: 70 });
    expect(menuLabels()).toEqual(["이름 바꾸기", "삭제"]);
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "이름 바꾸기" }));
    const dialog = screen.getByRole("dialog", { name: "폴더 이름 바꾸기" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "이름" }), { target: { value: "강의" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "바꾸기" })); });
    expect(at.calls().at(-1)).toEqual(["PATCH", "/api/bookmarks/items/class", { title: "강의" }]);
    fireEvent.contextMenu(key("강의"), { clientX: 120, clientY: 70 });
    fireEvent.click(within(menu()).getByRole("menuitem", { name: "삭제" }));
    const ask = screen.getByRole("dialog", { name: "폴더 삭제" });
    expect(ask.textContent).toContain("「강의」 폴더와 그 안의 즐겨찾기 2개를 지웁니다. 되돌릴 수 없습니다.");
    expect(at.calls().some(call => call[0] === "DELETE")).toBe(false);
    await act(async () => { fireEvent.click(within(ask).getByRole("button", { name: "삭제" })); });
    expect(at.calls().at(-1)).toEqual(["DELETE", "/api/bookmarks/items/class", undefined]);
    expect(screen.queryByRole("button", { name: "강의" })).toBeNull();
  });

  it("the star at the end of the address field adds the page; filled when it is a bookmark, and then offers 이름 바꾸기 / 삭제; Ctrl/⌘+D does the same", async () => {
    const at = await mount();
    expect([star().getAttribute("aria-pressed"), star().getAttribute("aria-label")]).toEqual(["false", "이 페이지를 즐겨찾기에 추가"]);
    expect(star().previousElementSibling?.getAttribute("aria-label")).toBe("현재 웹 주소");
    await act(async () => { fireEvent.click(star()); });
    expect(at.calls()).toEqual([["POST", "/api/bookmarks", { kind: "item", title: "KCI 한국학술지인용색인", url: "https://www.kci.go.kr/" }]]);
    expect([star().getAttribute("aria-pressed"), star().getAttribute("aria-label")]).toEqual(["true", "즐겨찾기에 있음, 이름 바꾸기 또는 삭제"]);
    fireEvent.click(star());
    expect(menuLabels()).toEqual(["이름 바꾸기", "삭제"]);
    await act(async () => { fireEvent.click(within(menu()).getByRole("menuitem", { name: "삭제" })); });
    expect(at.calls().at(-1)![0]).toBe("DELETE");
    expect(star().getAttribute("aria-pressed")).toBe("false");
    // Ctrl+D (⌘+D), read by the physical key so a Korean input mode does not break it.
    await act(async () => { fireEvent.keyDown(document.body, { key: "ㅇ", code: "KeyD", ctrlKey: true }); });
    expect(at.calls().at(-1)).toEqual(["POST", "/api/bookmarks", { kind: "item", title: "KCI 한국학술지인용색인", url: "https://www.kci.go.kr/" }]);
    await act(async () => { fireEvent.keyDown(document.body, { key: "d", code: "KeyD", metaKey: true }); });
    expect(menuLabels()).toEqual(["이름 바꾸기", "삭제"]);
  });

  it("the star is off on the blank new-tab page, and the keys answer in one web tab only", async () => {
    await mount({ url: null });
    expect(star().disabled).toBe(true);
    cleanup();
    const host = gateway(), onOpen = vi.fn();
    await act(async () => {
      render(<AppearanceContext.Provider value={{ appTheme: "light" } as never}><Tab api={host.api} onOpen={onOpen} url="https://a.example/" title="가" /><Tab api={host.api} onOpen={onOpen} url="https://b.example/" title="나" /><Tab api={host.api} onOpen={onOpen} url="https://c.example/" title="다" active={false} /></AppearanceContext.Provider>);
    });
    await act(async () => { fireEvent.keyDown(document.body, { key: "d", code: "KeyD", ctrlKey: true }); });
    expect(host.calls()).toEqual([["POST", "/api/bookmarks", { kind: "item", title: "가", url: "https://a.example/" }]]);
    // Pressed inside the second tab, the second tab answers.
    await act(async () => { fireEvent.keyDown(document.querySelectorAll(".browser-view")[1]!.querySelector("input")!, { key: "d", code: "KeyD", ctrlKey: true }); });
    expect(host.calls().at(-1)).toEqual(["POST", "/api/bookmarks", { kind: "item", title: "나", url: "https://b.example/" }]);
    expect(host.calls()).toHaveLength(2);
    // Typed in a field outside every web tab (a note beside it): not the bookmarks' key.
    const note = document.createElement("textarea"); document.body.append(note);
    await act(async () => { fireEvent.keyDown(note, { key: "d", code: "KeyD", ctrlKey: true }); });
    note.remove();
    expect(host.calls()).toHaveLength(2);
  });

  it("the bar is a toolbar: one Tab stop, arrows move, Enter opens, the menu key opens the menu, Ctrl+Shift+←/→ moves the focused item", async () => {
    const at = await mount();
    const stops = () => within(bar()!).getAllByRole("button").map(entry => entry.tabIndex);
    expect(stops()).toEqual([0, -1, -1, -1]);
    key("한림대학교").focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(key("수업"));
    expect(stops()).toEqual([-1, 0, -1, -1]);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(key("riss 학술연구정보"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(key("riss 학술연구정보"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(key("한림대학교"));
    // Enter is the key's own click.
    fireEvent.click(document.activeElement!);
    expect(at.onOpen).toHaveBeenLastCalledWith("https://www.hallym.ac.kr/", false);
    fireEvent.keyDown(document.activeElement!, { key: "ContextMenu" });
    expect(menuLabels()).toEqual(["새 탭에서 열기", "이름 바꾸기", "주소 고치기", "삭제"]);
    fireEvent.keyDown(menu(), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    key("한림대학교").focus();
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "ArrowRight", ctrlKey: true, shiftKey: true }); });
    expect(at.calls().at(-1)).toEqual(["POST", "/api/bookmarks/items/hallym/move", { parentId: null, index: 1 }]);
    expect(within(bar()!).getAllByRole("button").map(entry => entry.getAttribute("aria-label"))).toEqual(["수업", "한림대학교", "국립국어원 표준국어대사전 검색 결과 모음", "riss 학술연구정보"]);
    expect(document.activeElement).toBe(key("한림대학교"));
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft", ctrlKey: true, shiftKey: true }); });
    expect(at.calls().at(-1)).toEqual(["POST", "/api/bookmarks/items/hallym/move", { parentId: null, index: 0 }]);
    // At the bar's start there is nowhere further to go.
    const before = at.calls().length;
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft", ctrlKey: true, shiftKey: true }); });
    expect(at.calls()).toHaveLength(before);
    // A folder opens with ↓ too.
    key("수업").focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(menuLabels()).toEqual(["스마트캠퍼스", "자료", "빈 폴더"]);
  });

  it("dragging an item along the bar puts it where it is let go, and the click that ends a drag opens nothing", async () => {
    const at = await mount();
    const all = [...bar()!.querySelectorAll<HTMLElement>("[data-bookmark]")];
    all.forEach((entry, index) => vi.spyOn(entry, "getBoundingClientRect").mockReturnValue(new DOMRect(index * 100, 0, 100, 28)));
    const dragged = key("한림대학교");
    fireEvent.pointerDown(dragged, { button: 0, clientX: 50, pointerId: 1 });
    fireEvent.pointerMove(dragged, { clientX: 52, pointerId: 1 });
    expect(bar()!.querySelector("[data-dragging]")).toBeNull();
    fireEvent.pointerMove(dragged, { clientX: 260, pointerId: 1 });
    expect(bar()!.querySelector("[data-dragging]")).toBe(dragged);
    expect(key("riss 학술연구정보").getAttribute("data-drop")).toBe("before");
    await act(async () => { fireEvent.pointerUp(dragged, { clientX: 260, pointerId: 1 }); });
    fireEvent.click(dragged);
    expect(at.calls()).toEqual([["POST", "/api/bookmarks/items/hallym/move", { parentId: null, index: 2 }]]);
    expect(at.onOpen).not.toHaveBeenCalled();
    expect(within(bar()!).getAllByRole("button").map(entry => entry.getAttribute("aria-label"))).toEqual(["수업", "국립국어원 표준국어대사전 검색 결과 모음", "한림대학교", "riss 학술연구정보"]);
    // A press without travel is an ordinary click.
    fireEvent.pointerDown(key("한림대학교"), { button: 0, clientX: 250, pointerId: 2 });
    fireEvent.pointerUp(key("한림대학교"), { clientX: 251, pointerId: 2 });
    fireEvent.click(key("한림대학교"));
    expect(at.onOpen).toHaveBeenLastCalledWith("https://www.hallym.ac.kr/", false);
  });

  it("names and marks: cut at 18 characters, a letter mark from the name", () => {
    expect(shortTitle("짧은 이름")).toBe("짧은 이름");
    expect(Array.from(shortTitle("가나다라마바사아자차카타파하가나다라마")).length).toBe(18);
    expect(shortTitle("가나다라마바사아자차카타파하가나다라마").endsWith("…")).toBe(true);
    expect([bookmarkLetter("  한림대"), bookmarkLetter("riss"), bookmarkLetter("「국어」"), bookmarkLetter("…")]).toEqual(["한", "R", "국", "•"]);
  });
});

describe("설정 › 일반 › 웹 즐겨찾기", () => {
  const settings = async (host = gateway()) => { await act(async () => { render(<BookmarkSettings api={host.api} />); }); return host; };

  it("즐겨찾기 줄 보이기 on/off, the same import keys (one line says what came in), and 모두 지우기 behind a confirmation", async () => {
    const at = await settings();
    const group = screen.getByRole("region", { name: "웹 즐겨찾기" });
    const toggle = within(group).getByRole("switch", { name: "즐겨찾기 줄 보이기" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await act(async () => { fireEvent.click(toggle); });
    expect(at.calls()).toEqual([["PUT", "/api/bookmarks/bar", { show: false }]]);
    expect(toggle.checked).toBe(false);
    expect(within(group).getAllByRole("button").map(entry => entry.textContent)).toEqual(["Chrome에서 가져오기", "Firefox에서 가져오기", "모두 지우기"]);
    expect(group.textContent).toContain("즐겨찾기만 읽습니다. 암호, 방문 기록, 로그인 정보는 읽지 않습니다.");
    await act(async () => { fireEvent.click(within(group).getByRole("button", { name: "Firefox에서 가져오기" })); });
    expect(at.calls().at(-1)).toEqual(["POST", "/api/bookmarks/import", { source: "firefox", profile: "0:Profile0" }]);
    expect(within(group).getByRole("status").textContent).toBe("즐겨찾기 12개, 폴더 3개를 가져왔습니다.");
    expect(group.textContent).toContain("지금 즐겨찾기 6개, 폴더 3개가 있습니다.");
    // 모두 지우기 asks first; 취소 leaves everything.
    fireEvent.click(within(group).getByRole("button", { name: "모두 지우기" }));
    const ask = within(group).getByRole("group", { name: "즐겨찾기 모두 지우기 확인" });
    expect(ask.textContent).toContain("즐겨찾기 6개와 폴더 3개를 모두 지웁니다. 되돌릴 수 없습니다.");
    expect(at.calls().some(call => call[0] === "DELETE")).toBe(false);
    fireEvent.click(within(ask).getByRole("button", { name: "취소" }));
    expect(at.state.items).toHaveLength(5);
    fireEvent.click(within(group).getByRole("button", { name: "모두 지우기" }));
    await act(async () => { fireEvent.click(within(within(group).getByRole("group", { name: "즐겨찾기 모두 지우기 확인" })).getByRole("button", { name: "모두 지우기" })); });
    expect(at.calls().at(-1)).toEqual(["DELETE", "/api/bookmarks", undefined]);
    expect(group.textContent).toContain("지금은 즐겨찾기가 없습니다.");
    expect((within(group).getByRole("button", { name: "모두 지우기" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("no browser on this PC: said in one line, no key", async () => {
    const host = gateway();
    host.request.mockImplementation(async (_method: string, path: string) => path === "/api/bookmarks/sources" ? [] : { showBar: true, items: [] });
    await settings(host);
    const group = screen.getByRole("region", { name: "웹 즐겨찾기" });
    await waitFor(() => expect(group.textContent).toContain("이 PC에서 즐겨찾기를 가져올 브라우저를 찾지 못했습니다."));
    expect(within(group).getAllByRole("button").map(entry => entry.textContent)).toEqual(["모두 지우기"]);
  });
});
