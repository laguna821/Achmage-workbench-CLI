// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { Artifact, Folder, ProjectSummary, Session, UiPrefs, Work } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { AppearanceContext, NEUTRAL_LOOK, type AppearanceApi } from "../appearance.ts";
import { LinkContext, type LinkApi } from "../links.ts";
import { initialState, type State } from "../state.ts";
import type { TreeOpenState } from "../tree.ts";
import type { MenuRequest } from "./ContextMenu.tsx";
import { Sidebar, type SidebarActions } from "./Sidebar.tsx";
import { forgetPlaces, placeStore } from "./nav/place.ts";
import { docRowRenders } from "./nav/Lists.tsx";

// The vault and the saved views are not part of this question.
vi.mock("./pkm/PkmContext.tsx", async (original) => ({ ...(await original<typeof import("./pkm/PkmContext.tsx")>()), usePkm: () => ({ pkmState: null, tree: null, target: null, open: null, unfolded: new Set(), setDialog: () => {} }), useOptionalPkm: () => null }));

// The list column (N1, the owner's navigation): level 1 (every project in its folders), level 2
// (inside one project: its note, 대화 · 문서 · 웹) with "← 프로젝트 목록", the rail's other lists, and
// everything the old three layouts kept (바로가기, tags, sorts, picks, menus, folds, the foot).

const folder = (id: string, parentId: string | null = null): Folder => ({ id, parentId, name: id, sort: 0, archivedAt: null });
const work = (id: string, folderId: string | null, updatedAt: number, extra: Partial<Work> = {}) =>
  ({ id, title: id, titleSource: "user", folderId, cwd: `/w/${id}`, cwdManaged: true, activeSessionId: null, pinned: false, sort: 0, archivedAt: null, createdAt: 1, updatedAt, ...extra }) as Work;
const session = (id: string, workId: string, extra: Partial<Session> = {}) =>
  ({ id, workId, provider: "codex", purpose: id, status: "idle", pinned: false, sort: 0, archivedAt: null, seenAt: null, unread: false, previewAt: null, preview: null, createdAt: 1, updatedAt: 1, queued: [], ...extra }) as unknown as Session;
const doc = (id: string, name: string, updatedAt: number) => ({ id, workId: "강의 준비", name, path: `/w/강의 준비/${name}`, format: name.endsWith(".md") ? "markdown" : "text", revision: 3, updatedAt }) as unknown as Artifact;

const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((entry) => [entry.id, entry]));
const NOW = Date.now();
const state: State = {
  ...initialState,
  folders: byId([folder("수업"), folder("2026-2", "수업"), folder("빈 폴더")]),
  works: byId([work("강의 준비", "수업", NOW - 1000), work("과제 채점", "2026-2", NOW - 2000), work("논문 메모", null, NOW - 3000)]),
  sessions: byId([
    session("도입부 다듬기", "강의 준비", { preview: "도입부를 질문 하나로 시작하도록 고쳤습니다.", previewAt: NOW - 1000, seenAt: NOW }),
    session("강의안 AI", "강의 준비", { provider: "claude", purpose: "강의안.md · 문서 AI", documentAgent: { artifactId: "강의안", parentSessionId: "도입부 다듬기" }, status: "awaitingApproval" } as Partial<Session>),
    session("참고 자료 찾기", "강의 준비", { pageAgent: { pageId: "p1" } } as unknown as Partial<Session>),
  ]),
  artifacts: byId([doc("강의안", "강의안.md", 20), doc("읽을거리", "읽을거리.txt", 10)]),
};
const summaries: ProjectSummary[] = [
  { workId: "강의 준비", stage: null, tags: ["강의"], related: [], decisions: 0, questions: 0, noteExists: true, properties: [], noteUpdatedAt: null, preview: "3주차 강의안을 질문 → 사례 → 실습 순서로 다시 짠다." } as unknown as ProjectSummary,
];
const OPEN: TreeOpenState = { closedFolders: [], openWorks: ["강의 준비"], closedWorks: [], openDocs: ["강의 준비"] };

type Props = { prefs?: UiPrefs; now?: State; shown?: { work?: string; session?: string; doc?: string }; paneMinimum?: number; onPrefs?: (patch: UiPrefs) => void; actions?: Partial<SidebarActions>; open?: TreeOpenState; onOpen?: (next: TreeOpenState) => void ; atNow?: boolean; onLeaveNow?: () => void };

function Frame({ prefs: initial = { navShortcuts: [] }, now = state, shown = {}, paneMinimum, onPrefs, actions = {}, open: initialOpen = OPEN, onOpen, atNow, onLeaveNow }: Props) {
  const [prefs, setPrefs] = useState<UiPrefs>(initial);
  const [open, setOpen] = useState(initialOpen);
  const [api] = useState(() => new Proxy({}, { get: (_, key) => (key === "projects" ? async () => summaries : key === "history" ? async () => ({ events: [], next: null }) : async () => []) }) as unknown as Api);
  const [all] = useState(() => new Proxy(actions, { get: (target, key) => (key in target ? target[key as keyof SidebarActions] : key === "menuFor" || key === "creationMenu" || key === "openRight" || key === "docRemoval" || key === "closeWebTab" || key === "openDocAgent" || key === "sessionPage" || key === "newSubpage" || key === "chooseProject" ? undefined : () => {}) }) as SidebarActions);
  return (
    <AppearanceContext.Provider value={{ appTheme: "light", lookOf: () => NEUTRAL_LOOK.light, themeOf: () => "light", openMenu: () => {} } as unknown as AppearanceApi}>
      <LinkContext.Provider value={{ state: now } as unknown as LinkApi}>
        <Sidebar
          state={now} currentWorkId={shown.work ?? null} visibleSessionId={shown.session ?? null} currentDocId={shown.doc ?? null}
          open={open} onOpenChange={(next) => { setOpen(next); onOpen?.(next); }} sortMode="manual" onSortMode={() => {}}
          width={typeof prefs.sidebarWidth === "number" ? prefs.sidebarWidth : 288} onWidth={(width) => { setPrefs((current) => ({ ...current, sidebarWidth: width })); onPrefs?.({ sidebarWidth: width }); }}
          paneMinimum={paneMinimum} actions={all} pending={null} onPendingDone={() => {}}
          prefs={prefs} onPrefs={(patch) => setPrefs((current) => { const change = typeof patch === "function" ? patch(current) : patch; onPrefs?.(change); return { ...current, ...change }; })}
          api={api} onToast={() => {}} atNow={atNow} onLeaveNow={onLeaveNow}
        />
      </LinkContext.Provider>
    </AppearanceContext.Provider>
  );
}

const windowWidth = (width: number) => act(() => {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  window.dispatchEvent(new Event("resize"));
});
const sidebar = () => screen.getByRole("complementary", { name: "프로젝트 탐색" });
const level = () => sidebar().dataset.level;
/** Every row of the list in screen order, by id. */
const ids = () => [...sidebar().querySelectorAll<HTMLElement>("[data-list-row][data-row-id]")].map((element) => element.dataset.rowId!);
const row = (id: string) => sidebar().querySelector<HTMLElement>(`[data-row-id="${id}"]`);
/** The navigator preferences as last saved. */
const saved = (spy: ReturnType<typeof vi.fn>) => Object.assign({}, ...spy.mock.calls.map(([patch]) => (patch as UiPrefs).navigator ?? {})) as Record<string, unknown>;

beforeEach(() => {
  vi.stubGlobal("CSS", { escape: (text: string) => text });
  // jsdom has no layout: nothing to scroll.
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  windowWidth(1440);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); forgetPlaces(); });

describe("level 1: every project in its folders", () => {
  it("lists folders as folds with their projects under them, the projects outside folders last", () => {
    render(<Frame />);
    expect(level()).toBe("projects");
    expect(ids()).toEqual(["빈 폴더", "수업", "강의 준비", "2026-2", "과제 채점", "논문 메모"]);
    expect(within(sidebar()).getByText("폴더 밖")).toBeTruthy();
    // One row per project: its name and ONE trailing fact: how many things need the person (a pill).
    const lecture = row("강의 준비")!;
    expect(lecture.querySelector(".nav-pill")!.textContent).toBe("1");
    expect(lecture.querySelectorAll(".side-row-trail > :not(.row-add, .row-more)").length).toBe(1);
    expect(row("논문 메모")!.querySelector(".nav-pill, .nav-count")).toBeNull();
    expect(lecture.getAttribute("aria-label")).toBe("강의 준비, 확인 필요 1개");
    // No unfolded conversations at level 1 (they belong to level 2).
    expect(row("도입부 다듬기")).toBeNull();
  });

  it("folds a folder and keeps it folded (the tree's open state), from the pointer and the keyboard", () => {
    const onOpen = vi.fn();
    render(<Frame onOpen={onOpen} />);
    fireEvent.click(row("수업")!);
    expect(onOpen.mock.calls.at(-1)![0].closedFolders).toEqual(["수업"]);
    // Folded, a folder still shows the project that needs the person (rule 5).
    expect(ids()).toEqual(["빈 폴더", "수업", "강의 준비", "논문 메모"]);
    fireEvent.keyDown(row("수업")!, { key: "ArrowRight" });
    expect(ids()).toContain("강의 준비");
  });

  it("finds by project or folder name: a folder's name keeps its projects; nothing found says how to clear", () => {
    render(<Frame />);
    // The field is shown when asked for (찾기, Ctrl+F) or while it holds text.
    expect(within(sidebar()).queryByRole("textbox", { name: "프로젝트·폴더 찾기" })).toBeNull();
    fireEvent.click(within(sidebar()).getByRole("button", { name: "찾기" }));
    const field = within(sidebar()).getByRole("textbox", { name: "프로젝트·폴더 찾기" });
    fireEvent.change(field, { target: { value: "2026" } });
    expect(ids()).toEqual(["수업", "2026-2", "과제 채점"]);
    fireEvent.change(field, { target: { value: "없는 이름" } });
    fireEvent.click(within(sidebar()).getByRole("button", { name: "찾기 지우기" }));
    expect(ids()).toContain("논문 메모");
  });

  it("a tag filters this same list (a chip over it clears it); 바로가기 stays on top", async () => {
    render(<Frame prefs={{ navShortcuts: [{ kind: "work", id: "논문 메모" }] }} />);
    await waitFor(() => expect(within(sidebar()).getByRole("region", { name: "태그" })).toBeTruthy());
    fireEvent.click(within(within(sidebar()).getByRole("region", { name: "태그" })).getByText("강의"));
    await waitFor(() => expect(ids()).toEqual(["수업", "강의 준비"]));
    fireEvent.click(within(sidebar()).getByRole("button", { name: "태그 거르기 풀기" }));
    expect(ids()).toContain("논문 메모");
    expect(within(sidebar()).getByRole("region", { name: "바로가기" }).compareDocumentPosition(within(sidebar()).getByRole("tree", { name: "폴더별 프로젝트" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("picks several with Ctrl and Shift and opens their bulk menu (옮기기, 바로가기, 고정, 단계, 태그, 보관 N)", () => {
    const openMenu = vi.fn();
    render(<Frame actions={{ openMenu }} />);
    fireEvent.click(row("강의 준비")!, { ctrlKey: true });
    fireEvent.click(row("논문 메모")!, { ctrlKey: true });
    fireEvent.contextMenu(row("논문 메모")!);
    const request = openMenu.mock.calls.at(-1)![0] as MenuRequest;
    expect(request.title).toBe("프로젝트 2개");
    expect(request.items.map((entry) => ("label" in entry ? entry.label : "—"))).toEqual(["폴더로 옮기기", "바로가기에 더하기", "고정", "단계", "태그 더하기…", "—", "보관 (2개)"]);
  });

  it("보기 offers 묶기 (폴더별 / 목록), 정렬, 줄 모양 and the old head menu's items", async () => {
    render(<Frame />);
    fireEvent.click(within(sidebar()).getByRole("button", { name: "보기" }));
    const menu = await screen.findByRole("menu", { name: "보기" });
    for (const name of ["폴더별", "목록 (정렬대로 묶음)", "직접 정한 순서", "줄 모양", "새 폴더", "모든 섹션 접기", "다른 곳의 대화 가져오기…"]) expect(within(menu).getAllByText(name, { exact: false }).length, name).toBeGreaterThan(0);
  });

  it("보기 › 보드·표로 보기 opens home's projects board in the centre (home's switch is gone; the view stays reachable)", async () => {
    const openHomeView = vi.fn();
    render(<Frame actions={{ openHomeView }} />);
    fireEvent.click(within(sidebar()).getByRole("button", { name: "보기" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "보기" })).getByText("보드와 표로 보기"));
    expect(openHomeView).toHaveBeenCalledWith("projects");
  });
});

describe("level 2: inside one project, and back", () => {
  const enter = (actions: Partial<SidebarActions> = {}, onPrefs?: (patch: UiPrefs) => void) => {
    const view = render(<Frame actions={actions} onPrefs={onPrefs} />);
    fireEvent.click(row("강의 준비")!);
    return view;
  };

  it("a project chosen: the same column shows back, the path, the name, the pinned note, then 대화 · 문서 · 웹", () => {
    const chooseProject = vi.fn();
    enter({ chooseProject });
    expect(chooseProject).toHaveBeenCalledTimes(1);
    expect(level()).toBe("project");
    const column = sidebar();
    expect(within(column).getByRole("button", { name: "프로젝트 목록으로" })).toBeTruthy();
    expect(column.querySelector(".nav-path")!.textContent).toBe("수업");
    expect(within(column).getByRole("heading", { name: "강의 준비" })).toBeTruthy();
    expect(within(column).getByText("프로젝트 노트")).toBeTruthy();
    // The name first, its folder path quiet below it; no middle dots in the column.
    expect(column.querySelector(".nav-project-name")!.compareDocumentPosition(column.querySelector(".nav-path")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(column.textContent).not.toContain("·");
    // A conversation: a leading state glyph and one word at the end.
    expect(row("도입부 다듬기")!.querySelector(".row-glyph.tone-done")).toBeTruthy();
    expect([...column.querySelectorAll(".nav-inside-head .nav-fold")].map((head) => head.textContent)).toEqual(["대화1", "문서2", "웹1"]);
    // A conversation says its state in words; a document its kind; the document's AI on its row.
    expect(row("도입부 다듬기")!.querySelector(".row-state")!.textContent).toBe("완료");
    // One trailing fact: the kind, or — while its AI asks, fails, works or answered anew — that state in words.
    expect(row("읽을거리")!.querySelector(".row-kind")!.textContent).toBe("TXT");
    expect(row("강의안")!.querySelector(".row-kind")).toBeNull();
    expect(row("강의안")!.querySelector(".row-state.tone-attention")!.textContent).toBe("확인 필요");
    expect(row("강의안")!.querySelector('.state-mark[data-state="attention"]')).toBeTruthy();
  });

  it("← 프로젝트 목록 changes the list only: nothing is opened, closed or stopped", () => {
    const calls: string[] = [];
    // Every action the column could call is recorded (the frame asks `key in actions` first).
    const absent = new Set(["menuFor", "creationMenu", "openRight", "docRemoval", "openDocAgent"]);
    const spy = new Proxy({}, { has: (_, key) => typeof key === "string", get: (_, key) => (absent.has(String(key)) ? undefined : () => calls.push(String(key))) }) as Partial<SidebarActions>;
    const onPrefs = vi.fn();
    enter(spy, onPrefs);
    expect(calls).toEqual(["chooseProject"]);
    calls.length = 0;
    onPrefs.mockClear();
    fireEvent.click(within(sidebar()).getByRole("button", { name: "프로젝트 목록으로" }));
    expect(level()).toBe("projects");
    expect(calls).toEqual([]);
    // The level is this window's (nav/place.ts): nothing is written to the shared prefs.
    expect(onPrefs).not.toHaveBeenCalled();
    expect(placeStore().get().level).toBe("projects");
  });

  it("level 1 comes back as it was: folds, the search, the picks and the scroll", () => {
    render(<Frame open={{ ...OPEN, closedFolders: ["빈 폴더"] }} />);
    fireEvent.keyDown(sidebar(), { key: "f", ctrlKey: true });
    const field = within(sidebar()).getByRole("textbox", { name: "프로젝트·폴더 찾기" });
    fireEvent.change(field, { target: { value: "강의" } });
    fireEvent.click(row("강의 준비")!, { ctrlKey: true });
    const scroller = sidebar().querySelector<HTMLElement>(".nav-scroll")!;
    scroller.scrollTop = 120;
    fireEvent.scroll(scroller);
    fireEvent.click(row("강의 준비")!);
    expect(level()).toBe("project");
    fireEvent.click(within(sidebar()).getByRole("button", { name: "프로젝트 목록으로" }));
    expect(level()).toBe("projects");
    expect((within(sidebar()).getByRole("textbox", { name: "프로젝트·폴더 찾기" }) as HTMLInputElement).value).toBe("강의");
    expect(sidebar().querySelector<HTMLElement>(".nav-scroll")!.scrollTop).toBe(120);
    fireEvent.change(within(sidebar()).getByRole("textbox", { name: "프로젝트·폴더 찾기" }), { target: { value: "" } });
    expect(ids()).toEqual(["빈 폴더", "수업", "강의 준비", "2026-2", "과제 채점", "논문 메모"]);
  });

  it("keyboard: typing a name's first letters (or a Hangul first consonant) moves to that row", () => {
    render(<Frame />);
    row("빈 폴더")!.focus();
    fireEvent.keyDown(row("빈 폴더")!, { key: "ㄴ" });
    expect(document.activeElement).toBe(row("논문 메모"));
    fireEvent.keyDown(row("논문 메모")!, { key: "과" });
    expect(document.activeElement).toBe(row("과제 채점"));
  });

  it("keyboard: Enter goes inside, ↓ walks the rows, Alt+← goes back to the project it came from", async () => {
    render(<Frame />);
    row("강의 준비")!.focus();
    fireEvent.keyDown(row("강의 준비")!, { key: "Enter" });
    expect(level()).toBe("project");
    fireEvent.keyDown(row("도입부 다듬기")!, { key: "ArrowDown" });
    fireEvent.keyDown(row("도입부 다듬기")!, { key: "ArrowLeft", altKey: true });
    expect(level()).toBe("projects");
    await waitFor(() => expect(document.activeElement).toBe(row("강의 준비")));
  });

  it("each section's + adds into this project; the note row opens the project note", () => {
    const newSession = vi.fn();
    const openWork = vi.fn();
    const creationMenu = vi.fn();
    enter({ newSession, openWork, creationMenu });
    fireEvent.click(within(sidebar()).getByRole("button", { name: "이 프로젝트에 새 대화" }));
    expect(newSession.mock.calls[0]![0].work.id).toBe("강의 준비");
    fireEvent.click(within(sidebar()).getByRole("button", { name: "이 프로젝트에 새 문서" }));
    expect(creationMenu.mock.calls[0]![0].id).toBe("강의 준비");
    fireEvent.click(within(sidebar()).getByText("프로젝트 노트"));
    expect(openWork.mock.calls[0]![0].id).toBe("강의 준비");
  });

  it("follows the project on screen while inside (opened from elsewhere), and finds within it", () => {
    const view = render(<Frame prefs={{ navShortcuts: [], navigator: { level: "project", project: "강의 준비" } }} shown={{ work: "강의 준비" }} />);
    expect(level()).toBe("project");
    // Something of 논문 메모 opened from elsewhere: the app's follow rule moves the list (nav/place.ts).
    act(() => placeStore().follow("논문 메모"));
    view.rerender(<Frame prefs={{ navShortcuts: [], navigator: { level: "project", project: "강의 준비" } }} shown={{ work: "논문 메모" }} />);
    expect(within(sidebar()).getByRole("heading", { name: "논문 메모" })).toBeTruthy();
  });

  it("opens a document row's menu from its ⋯, with what the app offers for it", async () => {
    const remove = vi.fn();
    const menuFor = vi.fn((_row: unknown, x: number, y: number, _removal?: unknown): MenuRequest => ({ x, y, title: "강의안.md", items: [{ kind: "item", label: "열기", onSelect: () => {} }, { kind: "separator" }, { kind: "item", label: "목록에서 빼기", onSelect: remove }] }));
    enter({ menuFor, docRemoval: async () => ({ action: "unlist" }) as never });
    fireEvent.click(within(sidebar()).getByRole("button", { name: "강의안.md 더 보기" }));
    const menu = await screen.findByRole("menu", { name: "강의안.md" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "목록에서 빼기" }));
    expect(remove).toHaveBeenCalled();
    expect(menuFor.mock.calls[0]![3]).toEqual({ action: "unlist" });
  });
});

describe("the old layouts' preferences migrate without an error and without losing anything", () => {
  it.each(["dual", "stacked", "tree"] as const)("%s, with a tag selected, folded sections and widths: one navigation, the same classification", async (old) => {
    const onPrefs = vi.fn();
    const prefs: UiPrefs = { navShortcuts: [{ kind: "folder", id: "수업" }, { kind: "tag", id: "강의" }], navigator: { layout: old, navWidth: 230, listWidth: 340, navHeight: 0.5, selected: { kind: "tag", tag: "강의" }, sections: { tags: true, now: true }, sortByFolder: { root: { key: "name", desc: false } }, openTags: ["강의"] } };
    render(<Frame prefs={prefs} onPrefs={onPrefs} open={{ ...OPEN, closedFolders: ["2026-2"] }} />);
    expect(sidebar().dataset.layout).toBe("one");
    expect(level()).toBe("projects");
    // The selected tag is level 1's filter now; the folds, the shortcuts and the sorts are as stored.
    await waitFor(() => expect(ids()).toEqual(["수업", "강의 준비"]));
    expect(within(sidebar()).getByRole("region", { name: "바로가기" }).querySelectorAll("[data-shortcut-index]").length).toBe(2);
    expect(within(within(sidebar()).getByRole("region", { name: "태그" })).getByRole("button", { name: /태그/ }).getAttribute("aria-expanded")).toBe("false");
    // Nothing is rewritten by reading: the old keys stay in the stored object.
    expect(onPrefs.mock.calls.filter(([patch]) => (patch as UiPrefs).navigator)).toEqual([]);
  });

  it("a write keeps every key it does not know, and the old place keys stay as they were (read, never rewritten)", () => {
    const onPrefs = vi.fn();
    const prefs: UiPrefs = { navShortcuts: [], navigator: { layout: "dual", rail: "projects", level: "project", project: "강의 준비", fromANewerApp: { keep: true } } };
    render(<Frame prefs={prefs} onPrefs={onPrefs} />);
    expect(level()).toBe("project");
    fireEvent.click(sidebar().querySelector<HTMLElement>(".nav-inside-chats .nav-fold")!);
    const written = onPrefs.mock.calls.map(([patch]) => (patch as UiPrefs).navigator).filter(Boolean).at(-1) as Record<string, unknown>;
    expect(written).toMatchObject({ layout: "dual", rail: "projects", level: "project", project: "강의 준비", fromANewerApp: { keep: true }, sections: { chats: true } });
    // Going back is this window's: the shared object is not touched.
    onPrefs.mockClear();
    fireEvent.click(within(sidebar()).getByRole("button", { name: "프로젝트 목록으로" }));
    expect(onPrefs).not.toHaveBeenCalled();
  });
});

describe("the rail's other lists", () => {
  it("문서: every project's documents, newest first, each naming its project and kind; opens there", () => {
    const openDoc = vi.fn();
    render(<Frame prefs={{ navShortcuts: [], navigator: { rail: "docs" } }} actions={{ openDoc }} />);
    expect(sidebar().dataset.rail).toBe("docs");
    expect(ids()).toEqual(["강의안", "읽을거리"]);
    expect(row("강의안")!.textContent).toContain("강의 준비");
    fireEvent.click(row("강의안")!);
    expect(openDoc.mock.calls[0]![0].id).toBe("강의안");
  });

  it("문서's filter comes when asked (its key, Ctrl+F) and goes with Escape; nothing found offers to clear", async () => {
    render(<Frame prefs={{ navShortcuts: [], navigator: { rail: "docs" } }} />);
    expect(within(sidebar()).queryByRole("textbox", { name: "문서 찾기" })).toBeNull();
    fireEvent.keyDown(sidebar(), { key: "f", ctrlKey: true });
    const field = await within(sidebar()).findByRole("textbox", { name: "문서 찾기" });
    fireEvent.change(field, { target: { value: "없는 이름" } });
    expect(within(sidebar()).getByRole("status").textContent).toContain("찾는 이름의 문서가 없습니다.");
    fireEvent.click(within(sidebar()).getByRole("button", { name: "찾기 지우기" }));
    fireEvent.keyDown(within(sidebar()).getByRole("textbox", { name: "문서 찾기" }), { key: "Escape" });
    expect(within(sidebar()).queryByRole("textbox", { name: "문서 찾기" })).toBeNull();
  });

  it("an empty project says so in one line and offers 새 대화", () => {
    const newSession = vi.fn();
    render(<Frame prefs={{ navShortcuts: [], navigator: { level: "project", project: "논문 메모" } }} actions={{ newSession }} />);
    const empty = within(sidebar()).getByRole("status");
    expect(empty.textContent).toContain("아직 대화도 문서도 없습니다");
    fireEvent.click(within(empty).getByRole("button", { name: "새 대화" }));
    expect(newSession).toHaveBeenCalledWith({ work: expect.objectContaining({ id: "논문 메모" }) });
  });

  it("활동: 알림, 작업 현황, 보관함, then 지금 (확인 필요 · 진행 중 · 새 답) and the record by time", () => {
    const openNotifications = vi.fn();
    const openTasks = vi.fn();
    render(<Frame prefs={{ navShortcuts: [], navigator: { rail: "activity" } }} actions={{ openNotifications, openTasks }} />);
    fireEvent.click(within(sidebar()).getByRole("button", { name: /알림/ }));
    fireEvent.click(within(sidebar()).getByRole("button", { name: /작업 현황/ }));
    expect(openNotifications).toHaveBeenCalled();
    expect(openTasks).toHaveBeenCalled();
    expect(within(within(sidebar()).getByRole("region", { name: "지금" })).getByText(/강의안\.md · 문서 AI/)).toBeTruthy();
    expect(within(sidebar()).getByRole("region", { name: "최근에 다룬 것" })).toBeTruthy();
  });

  it("활동 opens on 현황 (as before); 기록 beside it is the history, and back", async () => {
    render(<Frame prefs={{ navShortcuts: [], navigator: { rail: "activity" } }} />);
    const today = within(sidebar()).getByRole("radio", { name: "현황" });
    expect(today.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(sidebar()).getByRole("radio", { name: "기록" }));
    expect(within(sidebar()).queryByRole("region", { name: "지금" })).toBeNull();
    expect(within(sidebar()).getByRole("list", { name: "활동 기록" })).toBeTruthy();
    await waitFor(() => expect(within(sidebar()).getByText("아직 기록이 없습니다.")).toBeTruthy());
    fireEvent.click(within(sidebar()).getByRole("radio", { name: "현황" }));
    expect(within(sidebar()).getByRole("region", { name: "지금" })).toBeTruthy();
  });

  it("활동's head opens the calendar (흐름) in the centre", () => {
    const openHomeView = vi.fn();
    render(<Frame prefs={{ navShortcuts: [], navigator: { rail: "activity" } }} actions={{ openHomeView }} />);
    fireEvent.click(within(sidebar()).getByRole("button", { name: "달력으로 보기" }));
    expect(openHomeView).toHaveBeenCalledWith("flow");
  });
});

describe("the column's edge and its foot", () => {
  it("resizes from the keyboard and never takes the work panes' room", () => {
    const onPrefs = vi.fn();
    render(<Frame onPrefs={onPrefs} prefs={{ navShortcuts: [], sidebarWidth: 264 }} />);
    const edge = within(sidebar()).getByRole("separator", { name: "사이드바 너비" });
    fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(onPrefs).toHaveBeenLastCalledWith({ sidebarWidth: 280 });
  });

  it("the plan limits fold to one line that still says each engine's highest use, and stay folded", () => {
    const onPrefs = vi.fn();
    const both = { claude: { installed: true, loggedIn: true, usage: [{ label: "5시간", usedPercent: 40, resetsAt: null }, { label: "주간", usedPercent: 82, resetsAt: null }] }, codex: { installed: true, loggedIn: true, usage: [{ label: "5시간", usedPercent: 12, resetsAt: null }] } } as unknown as State["providers"];
    render(<Frame now={{ ...state, providers: both }} onPrefs={onPrefs} />);
    const limits = () => within(sidebar()).getByRole("region", { name: "사용 한도" });
    expect(within(limits()).getAllByText(/%$/).map((element) => element.textContent)).toEqual(["40%", "82%", "12%"]);
    fireEvent.click(within(limits()).getByRole("button", { name: "사용 한도" }));
    expect(saved(onPrefs).sections).toEqual({ usage: true });
    expect(within(limits()).getAllByText(/%$/).map((element) => element.textContent)).toEqual(["82%", "12%"]);
  });

  it("an empty app says how to start", () => {
    render(<Frame now={{ ...state, works: {}, sessions: {}, artifacts: {}, folders: {} }} />);
    expect(within(sidebar()).getByText(/아직 프로젝트가 없습니다/)).toBeTruthy();
  });
});

describe("the column under the rail's 지금 (skin 2 merge)", () => {
  it("lists what 지금 means for navigation — needs the person, runs, a new answer — grouped by project, with the state word", () => {
    const busy: State = { ...state, sessions: { ...state.sessions,
      "회의 준비": session("회의 준비", "과제 채점", { status: "running" }),
      "끝난 일": session("끝난 일", "논문 메모", { previewAt: NOW - 10, seenAt: NOW }),
    } };
    render(<Frame now={busy} atNow />);
    expect(sidebar().dataset.rail).toBe("now");
    // Skin 2 fix 1 (ruling 3): the place's name 지금 is said by the rail, the page's head and the tab —
    // the column names what it lists instead (it said 지금 a fifth time).
    expect(screen.getByRole("heading", { level: 2, name: "챙길 대화" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "지금" })).toBeNull();
    const groups = [...sidebar().querySelectorAll<HTMLElement>(".nav-now-group")].map((group) => group.getAttribute("aria-label"));
    expect(groups).toEqual(["강의 준비 1", "과제 채점 1"]);
    expect(row("강의안 AI")?.textContent).toContain("확인 필요");
    expect(row("회의 준비")?.textContent).toContain("진행 중");
    expect(row("끝난 일")).toBeNull(); // 완료: not 지금
  });

  it("says so in one line with one way on when nothing is 지금", () => {
    const quiet: State = { ...state, sessions: {} };
    const leave = vi.fn();
    render(<Frame now={quiet} atNow onLeaveNow={leave} />);
    fireEvent.click(within(sidebar()).getByRole("button", { name: "프로젝트 보기" }));
    expect(leave).toHaveBeenCalledOnce();
  });
});

describe("the owner's corrections (2026-11-14 evening)", () => {
  it("draws a folder as a folder row — its folder icon, its name, the count of projects — named for what it is", () => {
    render(<Frame />);
    const folderRow = row("수업")!;
    // Its folder icon: the item folder (atlas-look), or the line icon the person chose.
    expect(folderRow.querySelector(".nav-folder-icon .item-icon, .nav-folder-icon svg")).not.toBeNull();
    expect(folderRow.querySelector(".nav-folder-name")?.textContent).toBe("수업");
    expect(folderRow.getAttribute("aria-label")).toBe("폴더 수업, 프로젝트 2개");
    // The concept named once: a quiet head 폴더 with + (새 폴더); sections keep their own quiet heads.
    const head = sidebar().querySelector(".nav-folders-head")!;
    expect(head.textContent).toContain("폴더");
    expect(within(head as HTMLElement).getByRole("button", { name: "새 폴더" })).toBeTruthy();
  });

  it("says once, under 폴더, that folders can hold projects when there is none yet", () => {
    render(<Frame now={{ ...state, folders: {}, works: { "논문 메모": state.works["논문 메모"]! } }} />);
    expect(within(sidebar()).getByText("폴더를 만들어 프로젝트를 묶을 수 있습니다.")).toBeTruthy();
  });

  it("gives every project and folder row (and a conversation row at level 2) a ⋯ key named for it, opening the row's menu", () => {
    const menuFor = vi.fn((row: { id: string }, x: number, y: number) => ({ x, y, title: row.id, items: [{ kind: "item" as const, label: "이름 바꾸기", onSelect: () => {} }] }));
    const openMenu = vi.fn();
    render(<Frame actions={{ menuFor, openMenu } as unknown as Partial<SidebarActions>} />);
    fireEvent.click(within(row("강의 준비")!).getByRole("button", { name: "강의 준비 더 보기" }));
    fireEvent.click(within(row("수업")!).getByRole("button", { name: "수업 더 보기" }));
    expect(menuFor.mock.calls.map(([entry]) => (entry as { id: string }).id)).toEqual(["강의 준비", "수업"]);
  });
});

// Skin 2 fix 1, design review finding 2: F2 on a project row put the field on the line UNDER the
// project's mark (the row is a block holding a line and a detail), and the field kept its own
// width (288 px in a 264 px column), so the whole column scrolled sideways. The field must sit in
// the row's one line, beside its mark, and shrink with it; the column never scrolls sideways.
describe("rename in place stays inside the row", () => {
  const field = () => sidebar().querySelector<HTMLInputElement>("input.side-rename")!;
  it.each([
    ["a project (level 1)", "강의 준비"],
    ["a folder (level 1)", "수업"],
  ])("%s: F2 puts the field on the row's one line, beside its mark", (_, id) => {
    render(<Frame />);
    row(id)!.focus();
    fireEvent.keyDown(row(id)!, { key: "F2" });
    const input = field();
    expect(input).toBeTruthy();
    const line = input.parentElement!;
    // The field's parent is the line that also holds the mark (a project's line, or the folder row itself).
    expect(line.querySelector(".side-row-icon")).not.toBeNull();
    expect(line.closest(".side-row.renaming")).not.toBeNull();
    if (id === "강의 준비") expect(line.classList.contains("nav-project-line")).toBe(true);
  });

  it("a conversation (level 2): F2 puts the field in its row, beside its mark", () => {
    render(<Frame />);
    row("강의 준비")!.focus();
    fireEvent.keyDown(row("강의 준비")!, { key: "Enter" });
    row("도입부 다듬기")!.focus();
    fireEvent.keyDown(row("도입부 다듬기")!, { key: "F2" });
    const input = field();
    expect(input.parentElement!.classList.contains("renaming")).toBe(true);
    // Its mark: the item icon (atlas-look) since the conversation is an item.
    expect(input.parentElement!.querySelector(".item-icon, svg")).not.toBeNull();
  });
});


// Technical review P1: the 문서 rail listed EVERY document of every project (2,000 rows: 5 s in jsdom)
// and re-rendered all of them on each state change. It shows the newest 100, then "N개 더 보기".
describe("the 문서 list keeps to a readable length", () => {
  it("shows the newest 100 documents and a key for the rest; finding still searches all", () => {
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, index) => {
      const entry = doc(`문서${index}`, `노트 ${index}.md`, 1000 + index);
      return [entry.id, entry];
    }));
    render(<Frame now={{ ...state, artifacts: many }} prefs={{ navShortcuts: [], navigator: { rail: "docs" } }} />);
    expect(ids()).toHaveLength(100);
    expect(ids()[0]).toBe("문서149");
    fireEvent.click(within(sidebar()).getByRole("button", { name: "문서 50개 더 보기" }));
    expect(ids()).toHaveLength(150);
  });

  // Re-review 1, next round 4: the key said only "N개 더 보기", ↓/End stopped at the last shown row, and
  // pressed from the keyboard it vanished with the focus (BODY).
  it("the key says what it shows, ↓ and End reach it, and pressed by keys the focus lands on the first new row", () => {
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, index) => {
      const entry = doc(`문서${index}`, `노트 ${index}.md`, 1000 + index);
      return [entry.id, entry];
    }));
    render(<Frame now={{ ...state, artifacts: many }} prefs={{ navShortcuts: [], navigator: { rail: "docs" } }} />);
    const more = within(sidebar()).getByRole("button", { name: "문서 50개 더 보기" });
    const last = row(ids().at(-1)!)!;
    last.focus();
    fireEvent.keyDown(last, { key: "ArrowDown" });
    expect(document.activeElement).toBe(more);
    row(ids()[0]!)!.focus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(more);
    fireEvent.keyDown(more, { key: "ArrowUp" });
    expect(document.activeElement).toBe(last);
    more.focus();
    fireEvent.click(more);
    expect(ids()).toHaveLength(150);
    expect((document.activeElement as HTMLElement).dataset.rowId).toBe(ids()[100]);
  });
});

// Found by fix 1's focus walk: Enter on a project row's + (새로 만들기) also reached the row and went inside the
// project, so the menu it opened lost its opener. The + keeps its keys.
it("Enter on a row's + does not also open the row", () => {
  render(<Frame />);
  const add = within(row("강의 준비")!).getByRole("button", { name: "새로 만들기" });
  add.focus();
  fireEvent.keyDown(add, { key: "Enter" });
  expect(level()).toBe("projects");
});

// Technical review P1, measured as the reviewer did: 2,000 documents (400 conversations) made 36,023 nodes in
// the 문서 list, and every streamed reply re-rendered all of its rows.
describe("the 문서 list and level 2 scale", () => {
  const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const entry = doc(`문서${index}`, `노트 ${index}.md`, 1000 + index);
    return [entry.id, entry];
  }));
  const chats = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`대화${index}`, session(`대화${index}`, "강의 준비", { preview: "답", previewAt: NOW - index })]));
  it("2,000 documents: about 100 rows in a few thousand nodes; a session update re-renders no unchanged row", () => {
    const big = { ...state, artifacts: many(2000), sessions: { ...state.sessions, ...chats(400) } };
    const view = render(<Frame now={big} prefs={{ navShortcuts: [], navigator: { rail: "docs" } }} />);
    expect(ids().length).toBeLessThanOrEqual(101);
    expect(sidebar().querySelectorAll("*").length).toBeLessThan(3000);
    const before = docRowRenders.count;
    const streamed = { ...big, sessions: { ...big.sessions, 대화0: { ...big.sessions["대화0"]!, preview: "답이 이어집니다", previewAt: NOW } } };
    view.rerender(<Frame now={streamed} prefs={{ navShortcuts: [], navigator: { rail: "docs" } }} />);
    expect(docRowRenders.count - before).toBe(0);
  });
  it("level 2: each section shows about 100 rows and a key for the rest; the conversation on screen always shows", () => {
    const big = { ...state, sessions: { ...state.sessions, ...chats(250) } };
    render(<Frame now={big} shown={{ work: "강의 준비", session: "대화249" }} prefs={{ navShortcuts: [], navigator: { level: "project", project: "강의 준비" } }} />);
    const chatsShown = ids().filter((id) => id.startsWith("대화"));
    expect(chatsShown.length).toBeLessThanOrEqual(101);
    expect(chatsShown).toContain("대화249");
    const more = within(sidebar()).getByRole("button", { name: /^대화 \d+개 더 보기$/ });
    more.focus();
    fireEvent.click(more);
    expect(ids().filter((id) => id.startsWith("대화")).length).toBe(250);
    // The focus stays in the list: on the first conversation that was not shown before.
    const now = document.activeElement as HTMLElement;
    expect(now.dataset.rowId).toMatch(/^대화/);
    expect(chatsShown).not.toContain(now.dataset.rowId);
  });
});

// Technical review (MINOR, N1's MAP row 27): Escape in level 1 clears a tag filter.
it("Escape in level 1 clears a tag filter", async () => {
  render(<Frame prefs={{ navShortcuts: [] }} />);
  await waitFor(() => expect(within(sidebar()).getByRole("region", { name: "태그" })).toBeTruthy());
  fireEvent.click(within(within(sidebar()).getByRole("region", { name: "태그" })).getByText("강의"));
  await waitFor(() => expect(ids()).toEqual(["수업", "강의 준비"]));
  row("강의 준비")!.focus();
  fireEvent.keyDown(row("강의 준비")!, { key: "Escape" });
  expect(ids()).toContain("논문 메모");
});

// Re-review 1, next round 6: no row of the list column (level 1 or 2) is named with a middle dot.
it("no row in the list column is named with a middle dot", () => {
  render(<Frame />);
  const names = () => [...sidebar().querySelectorAll<HTMLElement>("[data-row-id][aria-label]")].map((element) => element.getAttribute("aria-label")!);
  expect(names().length).toBeGreaterThan(0);
  expect(names().filter((name) => name.includes("·"))).toEqual([]);
  row("강의 준비")!.focus();
  fireEvent.keyDown(row("강의 준비")!, { key: "Enter" });
  expect(names().filter((name) => name.includes("·"))).toEqual([]);
});

// 0.5.1, messenger homes: a messenger's own place for its conversations ("텔레그램 대화", "Slack 대화",
// `Work.messengerHome`) is not a row among the person's projects and folders. It stands in its own short
// section "메신저" above 폴더; opening it goes inside it as a project does. While its messenger is
// registered it keeps its name and place: the row's menu says why.
describe("level 1: 메신저, each messenger's own place", () => {
  const telegram = work("텔레그램 대화", null, NOW - 500, { messengerHome: { kind: "telegram", registered: true } });
  const slack = work("Slack 대화", null, NOW - 400, { messengerHome: { kind: "slack", registered: false } });
  const withHomes: State = {
    ...state,
    works: { ...state.works, [slack.id]: slack, [telegram.id]: telegram },
    sessions: { ...state.sessions, ...byId([session("휴대폰 11/16", telegram.id, { status: "awaitingApproval" } as Partial<Session>), session("휴대폰 11/15", telegram.id)]) },
  };
  const section = () => within(sidebar()).queryByRole("tree", { name: "메신저" });
  const tree = () => within(sidebar()).getByRole("tree", { name: "폴더별 프로젝트" });
  const MENU: MenuRequest["items"] = [
    { kind: "item", label: "열기", onSelect: () => {} },
    { kind: "item", label: "이름 바꾸기", onSelect: () => {} },
    { kind: "item", label: "고정", onSelect: () => {} },
    { kind: "submenu", label: "옮기기", items: [] },
    { kind: "item", label: "보관", onSelect: () => {} },
    { kind: "item", label: "프로젝트 삭제…", onSelect: () => {} },
  ];
  const menuOf = (id: string) => {
    const menuFor = vi.fn((_row: unknown, x: number, y: number): MenuRequest => ({ x, y, title: id, items: MENU }));
    const openMenu = vi.fn();
    render(<Frame now={withHomes} actions={{ menuFor, openMenu } as unknown as Partial<SidebarActions>} />);
    fireEvent.contextMenu(row(id)!);
    return (openMenu.mock.calls.at(-1)![0] as MenuRequest).items.flatMap((entry) => (entry.kind === "item" || entry.kind === "submenu" ? [{ label: entry.label, disabled: Boolean(entry.disabled), why: entry.disabledReason }] : []));
  };

  it("no home: no 메신저 section at all", () => {
    render(<Frame />);
    expect(section()).toBeNull();
    expect(within(sidebar()).queryByText("메신저")).toBeNull();
  });

  it("the homes stand under 메신저 above 폴더, Telegram's first, with a project row's marks; they are not among the projects", () => {
    render(<Frame now={withHomes} />);
    const homes = section()!;
    expect([...homes.querySelectorAll<HTMLElement>("[data-row-id]")].map((element) => element.dataset.rowId)).toEqual(["텔레그램 대화", "Slack 대화"]);
    expect(within(sidebar()).getByText("메신저").compareDocumentPosition(within(sidebar()).getByText("폴더")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The person's projects and folders are as they were: no home among them, "폴더 밖" counts one.
    expect([...tree().querySelectorAll<HTMLElement>("[data-list-row][data-row-id]")].map((element) => element.dataset.rowId)).toEqual(["빈 폴더", "수업", "강의 준비", "2026-2", "과제 채점", "논문 메모"]);
    expect(within(tree()).getByText("폴더 밖").parentElement!.querySelector(".nav-count")!.textContent).toBe("1");
    // The marks a project row has: what needs the person.
    expect(row("텔레그램 대화")!.querySelector(".nav-pill")!.textContent).toBe("1");
    expect(row("텔레그램 대화")!.getAttribute("aria-label")).toBe("텔레그램 대화, 확인 필요 1개");
    expect(row("Slack 대화")!.querySelector(".nav-pill")).toBeNull();
  });

  it("opening a home goes inside it as a project does (the same level 2, with the way back)", () => {
    const chooseProject = vi.fn();
    render(<Frame now={withHomes} actions={{ chooseProject }} />);
    fireEvent.click(row("텔레그램 대화")!);
    expect(chooseProject).toHaveBeenCalledTimes(1);
    expect(level()).toBe("project");
    expect(within(sidebar()).getByRole("button", { name: "프로젝트 목록으로" })).toBeTruthy();
    expect(ids()).toEqual(expect.arrayContaining(["휴대폰 11/16", "휴대폰 11/15"]));
    // Back: the section is where it was. The keyboard opens one too.
    fireEvent.click(within(sidebar()).getByRole("button", { name: "프로젝트 목록으로" }));
    expect(level()).toBe("projects");
    fireEvent.keyDown(row("Slack 대화")!, { key: "Enter" });
    expect(level()).toBe("project");
  });

  it("while its messenger is registered the row's menu keeps the name, the place, 보관 and 삭제 off and says why; the rest works", () => {
    const why = "텔레그램을 연결해 둔 동안에는 할 수 없습니다.";
    const items = menuOf("텔레그램 대화");
    expect(items.filter((entry) => entry.disabled)).toEqual([
      { label: "이름 바꾸기", disabled: true, why },
      { label: "폴더로 옮기기", disabled: true, why },
      { label: "보관", disabled: true, why },
      { label: "프로젝트 삭제…", disabled: true, why },
    ]);
    expect(items.filter((entry) => !entry.disabled).map((entry) => entry.label)).toEqual(expect.arrayContaining(["열기", "고정"]));
  });

  it("its messenger removed: the row stays under 메신저 and its menu allows all of it", () => {
    expect(menuOf("Slack 대화").filter((entry) => entry.disabled)).toEqual([]);
  });

  it("a registered home is not renamed by F2 or a double click, nor archived by Delete; a free one is", () => {
    const archive = vi.fn();
    render(<Frame now={withHomes} actions={{ archive }} />);
    fireEvent.keyDown(row("텔레그램 대화")!, { key: "F2" });
    fireEvent.doubleClick(row("텔레그램 대화")!);
    fireEvent.keyDown(row("텔레그램 대화")!, { key: "Delete" });
    expect(sidebar().querySelector("input.side-rename")).toBeNull();
    expect(archive).not.toHaveBeenCalled();
    fireEvent.keyDown(row("Slack 대화")!, { key: "Delete" });
    expect(archive).toHaveBeenCalledWith({ kind: "work", id: "Slack 대화" });
    fireEvent.keyDown(row("Slack 대화")!, { key: "F2" });
    expect(sidebar().querySelector("input.side-rename")).toBeTruthy();
  });

  it("a home is never part of a pick of projects (Ctrl, Shift, Ctrl+A)", () => {
    const openMenu = vi.fn();
    render(<Frame now={withHomes} actions={{ openMenu }} />);
    fireEvent.click(row("강의 준비")!, { ctrlKey: true });
    fireEvent.keyDown(row("강의 준비")!, { key: "a", ctrlKey: true });
    fireEvent.contextMenu(row("논문 메모")!);
    expect((openMenu.mock.calls.at(-1)![0] as MenuRequest).title).toBe("프로젝트 3개");
    expect(row("텔레그램 대화")!.classList.contains("selected")).toBe(false);
  });

  it("찾기 narrows the section by name with the projects; a tag filter shows projects only", async () => {
    render(<Frame now={withHomes} />);
    fireEvent.click(within(sidebar()).getByRole("button", { name: "찾기" }));
    fireEvent.change(within(sidebar()).getByRole("textbox", { name: "프로젝트·폴더 찾기" }), { target: { value: "텔레" } });
    expect(ids()).toEqual(["텔레그램 대화"]);
    fireEvent.change(within(sidebar()).getByRole("textbox", { name: "프로젝트·폴더 찾기" }), { target: { value: "논문" } });
    expect(section()).toBeNull();
    expect(ids()).toEqual(["논문 메모"]);
    fireEvent.change(within(sidebar()).getByRole("textbox", { name: "프로젝트·폴더 찾기" }), { target: { value: "" } });
    await waitFor(() => expect(within(sidebar()).getByRole("region", { name: "태그" })).toBeTruthy());
    fireEvent.click(within(within(sidebar()).getByRole("region", { name: "태그" })).getByText("강의"));
    await waitFor(() => expect(ids()).toEqual(["수업", "강의 준비"]));
    expect(section()).toBeNull();
  });
});
