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

// The vault and the saved views are not part of this question.
vi.mock("./pkm/PkmContext.tsx", async (original) => ({ ...(await original<typeof import("./pkm/PkmContext.tsx")>()), usePkm: () => ({ pkmState: null, tree: null, target: null, open: null, unfolded: new Set(), setDialog: () => {} }), useOptionalPkm: () => null }));

// The sidebar as the two-pane navigator (Notebook Navigator's shape): the default again, its layout
// control in the head, and everything built since 0.3.3 inside it.

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

type Props = { prefs?: UiPrefs; now?: State; shown?: { work?: string; session?: string; doc?: string }; paneMinimum?: number; onPrefs?: (patch: UiPrefs) => void; actions?: Partial<SidebarActions>; open?: TreeOpenState };

function Frame({ prefs: initial = { navShortcuts: [] }, now = state, shown = {}, paneMinimum, onPrefs, actions = {}, open: initialOpen = OPEN }: Props) {
  const [prefs, setPrefs] = useState<UiPrefs>(initial);
  const [open, setOpen] = useState(initialOpen);
  const [api] = useState(() => new Proxy({}, { get: (_, key) => (key === "projects" ? async () => summaries : async () => []) }) as unknown as Api);
  const [all] = useState(() => new Proxy(actions, { get: (target, key) => (key in target ? target[key as keyof SidebarActions] : key === "menuFor" || key === "creationMenu" || key === "openRight" || key === "docRemoval" || key === "closeWebTab" || key === "openDocAgent" || key === "sessionPage" || key === "newSubpage" ? undefined : () => {}) }) as SidebarActions);
  return (
    <AppearanceContext.Provider value={{ appTheme: "light", lookOf: () => NEUTRAL_LOOK.light, themeOf: () => "light", openMenu: () => {} } as unknown as AppearanceApi}>
      <LinkContext.Provider value={{ state: now } as unknown as LinkApi}>
        <Sidebar
          state={now} currentWorkId={shown.work ?? null} visibleSessionId={shown.session ?? null} currentDocId={shown.doc ?? null}
          open={open} onOpenChange={setOpen} sortMode="manual" onSortMode={() => {}}
          width={typeof prefs.sidebarWidth === "number" ? prefs.sidebarWidth : 288} onWidth={(width) => { setPrefs((current) => ({ ...current, sidebarWidth: width })); onPrefs?.({ sidebarWidth: width }); }}
          paneMinimum={paneMinimum} actions={all} pending={null} onPendingDone={() => {}}
          prefs={prefs} onPrefs={(patch) => { setPrefs((current) => ({ ...current, ...patch })); onPrefs?.(patch); }}
          api={api} onToast={() => {}}
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
const layout = () => sidebar().dataset.layout;
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe("the navigator's layout", () => {
  it("is two panes on a wide window and stacked on a narrow one when nothing is stored", () => {
    render(<Frame />);
    expect(layout()).toBe("dual");
    expect(within(sidebar()).getByLabelText("탐색")).toBeTruthy();
    expect(within(sidebar()).getByLabelText("프로젝트 목록")).toBeTruthy();
    windowWidth(1000);
    expect(layout()).toBe("stacked");
    expect(within(sidebar()).getByLabelText("프로젝트 목록")).toBeTruthy();
    windowWidth(1920);
    expect(layout()).toBe("dual");
  });

  it("does not flip back and forth while the window's edge is dragged across the threshold, and stores nothing", () => {
    const onPrefs = vi.fn();
    render(<Frame onPrefs={onPrefs} />);
    expect(layout()).toBe("dual");
    // Just below 1253px: the two panes drawn stay…
    for (const width of [1252, 1240, 1253, 1230]) { windowWidth(width); expect(layout(), `${width}px on the way down`).toBe("dual"); }
    // …until the room is 24px short; then stacked stays until the threshold itself.
    windowWidth(1228);
    expect(layout()).toBe("stacked");
    for (const width of [1240, 1252]) { windowWidth(width); expect(layout(), `${width}px on the way up`).toBe("stacked"); }
    windowWidth(1253);
    expect(layout()).toBe("dual");
    // The window decided every time: no layout (nor anything else of the navigator) was written.
    expect(onPrefs).not.toHaveBeenCalled();
    // The edge's keys still never shrink the list while two panes hold on below the threshold.
    windowWidth(1240);
    fireEvent.keyDown(within(sidebar()).getByRole("separator", { name: "사이드바 너비" }), { key: "ArrowRight" });
    expect(layout()).toBe("dual");
    expect(saved(onPrefs).listWidth).toBeUndefined();
  });

  it("is still the automatic choice when only a width was ever stored (the owner's preferences)", () => {
    render(<Frame prefs={{ navShortcuts: [], navigator: { listWidth: 340 } }} />);
    expect(layout()).toBe("dual");
    expect(sidebar().style.width).toBe("557px");
  });

  it("keeps a stored choice", () => {
    render(<Frame prefs={{ navShortcuts: [], navigator: { layout: "tree" } }} />);
    expect(layout()).toBe("tree");
    expect(within(sidebar()).queryByLabelText("프로젝트 목록")).toBeNull();
    expect(within(sidebar()).getByRole("tree", { name: "프로젝트" })).toBeTruthy();
  });

  it("stacks rather than squeeze the work panes: their least width counts", () => {
    // Three work panes side by side (1096px) do not fit beside two navigator panes at 1440px.
    render(<Frame paneMinimum={1096} />);
    expect(layout()).toBe("stacked");
    expect(sidebar().style.width).toBe("288px");
  });
});

describe("the layout control in the sidebar head", () => {
  const control = () => within(sidebar()).getByRole("button", { name: "사이드바 배치" });
  const choices = () => within(screen.getByRole("menu", { name: "사이드바 배치" })).getAllByRole("menuitemradio");

  it("is one button that names the layout in use and opens the layouts by their plain names", () => {
    render(<Frame />);
    expect(control().closest(".side-head")).toBeTruthy();
    expect(control().title).toBe("사이드바 배치: 두 칸");
    expect(control().getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(control());
    expect(choices().map((item) => item.querySelector(".ui-menu-text")!.textContent)).toEqual(["두 칸", "위아래", "한 칸 (트리)", "창 너비에 맞추기"]);
    expect(choices().map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "false", "false", "true"]);
    expect(screen.getByRole("menu", { name: "사이드바 배치" }).textContent).not.toContain("고급");
  });

  it("stores the layout chosen, and 창 너비에 맞추기 lets the window decide again", () => {
    const onPrefs = vi.fn();
    render(<Frame onPrefs={onPrefs} />);
    fireEvent.click(control());
    fireEvent.click(screen.getByRole("menuitemradio", { name: /한 칸/ }));
    expect(layout()).toBe("tree");
    expect(saved(onPrefs).layout).toBe("tree");
    // The control stays where it was, now showing the tree.
    expect(control().title).toBe("사이드바 배치: 한 칸 (트리)");
    fireEvent.click(control());
    expect(choices().map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /창 너비에 맞추기/ }));
    expect(layout()).toBe("dual");
    expect(saved(onPrefs).layout).toBeUndefined();
  });

  it("opens from the keyboard, and the sidebar's ⋯ menu still offers the same layouts", () => {
    const openMenu = vi.fn();
    render(<Frame actions={{ openMenu }} />);
    fireEvent.keyDown(control(), { key: "ArrowDown" });
    expect(choices()).toHaveLength(4);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.click(within(sidebar()).getByRole("button", { name: "사이드바 메뉴" }));
    const labels = (openMenu.mock.calls[0]![0] as MenuRequest).items.flatMap((entry) => (entry.kind === "item" ? [entry.label] : []));
    expect(labels).toEqual(expect.arrayContaining(["두 칸", "위아래", "한 칸 (트리)", "창 너비에 맞추기", "모든 섹션 펼치기", "모든 섹션 접기", "다른 곳의 대화 가져오기…"]));
  });
});

// U23's kinds (대화 · 문서 · 웹, a document's AI on its document row) read the same in every layout.
describe("a project unfolded by kind", () => {
  /** The project's row and what is under it (not folders, other projects or the tree's "분류 없음" head). */
  const inside = () => [...sidebar().querySelectorAll<HTMLElement>("[data-row-id]")].map((element) => element.dataset.rowId!).filter((id) => id === "강의 준비" || id.endsWith(":강의 준비") || Boolean(state.sessions[id] ?? state.artifacts[id]));
  const GRAMMAR = ["강의 준비", "chats:강의 준비", "도입부 다듬기", "docs:강의 준비", "강의안", "읽을거리", "pages:강의 준비", "참고 자료 찾기"];

  it.each(["tree", "dual", "stacked"] as const)("%s: 대화 · 문서 · 웹 under the project, the document's AI on its row", (chosen) => {
    render(<Frame prefs={{ navShortcuts: [], navigator: { layout: chosen } }} />);
    expect(inside()).toEqual(GRAMMAR);
    expect(row("chats:강의 준비")!.textContent).toBe("대화1");
    expect(row("docs:강의 준비")!.textContent).toContain("문서2");
    expect(row("pages:강의 준비")!.textContent).toBe("웹1");
    // The document's AI: its engine's mark and its state at the end of the document's row.
    const lecture = row("강의안")!;
    expect(lecture.querySelector('.engine-mark[data-provider="claude"]')).toBeTruthy();
    expect(lecture.querySelector(".dot-attention")).toBeTruthy();
    expect(row("읽을거리")!.querySelector(".engine-mark")).toBeNull();
    // Kinds are told apart by place and shape, never by a colour of their own.
    for (const id of ["chats:강의 준비", "docs:강의 준비", "pages:강의 준비"]) expect(row(id)!.getAttribute("style") ?? "").not.toMatch(/color|accent/);
  });

  it.each(["tree", "dual"] as const)("%s: the project is marked the same way — on screen itself, or holding what is on screen", (chosen) => {
    const view = render(<Frame prefs={{ navShortcuts: [], navigator: { layout: chosen } }} shown={{ work: "강의 준비" }} />);
    expect(row("강의 준비")!.getAttribute("aria-selected")).toBe("true");
    expect(row("강의 준비")!.classList.contains("current")).toBe(true);
    view.rerender(<Frame prefs={{ navShortcuts: [], navigator: { layout: chosen } }} shown={{ work: "강의 준비", session: "도입부 다듬기" }} />);
    expect(row("강의 준비")!.getAttribute("aria-selected")).toBe("false");
    expect(row("강의 준비")!.getAttribute("aria-current")).toBe("location");
    expect(row("강의 준비")!.classList.contains("current")).toBe(false);
    expect(row("도입부 다듬기")!.classList.contains("current")).toBe(true);
  });

  // U24: the document row's ⋯ and its menu (the shared Menu), from the list pane.
  it("opens a document row's menu from its ⋯ in the list, with what the app offers for it", async () => {
    const remove = vi.fn();
    const menuFor = vi.fn((_row: unknown, x: number, y: number, _removal?: unknown): MenuRequest => ({ x, y, title: "강의안.md", items: [{ kind: "item", label: "열기", onSelect: () => {} }, { kind: "separator" }, { kind: "item", label: "목록에서 빼기", onSelect: remove }] }));
    render(<Frame actions={{ menuFor, docRemoval: async () => ({ action: "unlist" }) as never }} />);
    const list = within(sidebar()).getByLabelText("프로젝트 목록");
    fireEvent.click(within(list).getByRole("button", { name: "강의안.md 메뉴" }));
    const menu = await screen.findByRole("menu", { name: "강의안.md" });
    expect(menu.closest(".ui-menu")).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "목록에서 빼기" }));
    expect(remove).toHaveBeenCalled();
    expect(menuFor.mock.calls[0]![3]).toEqual({ action: "unlist" });
  });
});

describe("what the two-pane navigator kept", () => {
  const list = () => within(sidebar()).getByLabelText("프로젝트 목록");
  const nav = () => within(sidebar()).getByLabelText("탐색");
  const projects = () => [...list().querySelectorAll<HTMLElement>(".nav-project")].map((element) => element.dataset.rowId);

  it("lists the selection's projects as notes: title, preview, last activity and a state dot", async () => {
    render(<Frame />);
    const note = row("강의 준비")!;
    expect(note.querySelector(".nav-project-title")!.textContent).toBe("강의 준비");
    // The project note's first words, once read (the latest reply until then).
    await waitFor(() => expect(note.querySelector(".nav-project-preview")!.textContent).toContain("질문 → 사례 → 실습"));
    expect(note.querySelector(".nav-project-date")!.textContent).not.toBe("");
    // A document AI waits for the person: the project's row says so.
    expect(note.querySelector(".dot-attention")).toBeTruthy();
    // Every row here is a project: the word is not repeated on each.
    expect(note.textContent).not.toContain("프로젝트");
    // What it holds, by kind: a document's AI is not counted as a conversation.
    expect(note.querySelector(".nav-project-kinds")!.getAttribute("title")).toBe("대화 1 · 문서 2 · 웹 1");
  });

  it("selects a folder, a tag and a folder shortcut; the folder selected is not drawn as the project on screen", async () => {
    const onPrefs = vi.fn();
    render(<Frame prefs={{ navShortcuts: [{ kind: "folder", id: "2026-2" }] }} onPrefs={onPrefs} shown={{ work: "강의 준비" }} />);
    expect(projects()).toEqual(["강의 준비", "과제 채점", "논문 메모"]);
    fireEvent.click(within(nav()).getByRole("treeitem", { name: /^수업/ }));
    expect(saved(onPrefs).selected).toEqual({ kind: "folder", id: "수업" });
    expect(projects()).toEqual(["강의 준비", "과제 채점"]);
    expect(list().querySelector(".list-name")!.textContent).toBe("수업");
    // Two different marks: the folder is the scope of the list, the project is where the person is.
    const chosen = nav().querySelector<HTMLElement>('[data-row-id="수업"]')!;
    expect(chosen.getAttribute("aria-selected")).toBe("true");
    expect(chosen.dataset.scope).toBe("");
    expect(row("강의 준비")!.dataset.scope).toBeUndefined();
    // A tag of the projects' notes.
    fireEvent.click(await within(nav()).findByRole("treeitem", { name: /강의/ }));
    expect(list().querySelector(".list-name")!.textContent).toBe("#강의");
    expect(projects()).toEqual(["강의 준비"]);
    // A shortcut to a folder.
    fireEvent.click(within(within(nav()).getByRole("list", { name: "바로가기" })).getByText("2026-2"));
    expect(projects()).toEqual(["과제 채점"]);
  });

  it("folds a section and keeps it folded", () => {
    const onPrefs = vi.fn();
    render(<Frame onPrefs={onPrefs} />);
    expect(within(nav()).getByRole("tree", { name: "프로젝트 폴더" })).toBeTruthy();
    fireEvent.click(within(nav()).getByRole("button", { name: "프로젝트 탐색" }));
    expect(within(nav()).queryByRole("tree", { name: "프로젝트 폴더" })).toBeNull();
    expect(saved(onPrefs).sections).toEqual({ projects: true });
  });

  it("sorts one folder's list its own way, and takes 하위 포함 off", () => {
    const onPrefs = vi.fn();
    render(<Frame onPrefs={onPrefs} />);
    // The list's own menu is the shared Menu (drawn above the list and its scrollbar).
    fireEvent.click(within(list()).getByRole("button", { name: "정렬과 줄 모양" }));
    const menu = screen.getByRole("menu", { name: "프로젝트 정렬" });
    expect(menu.closest(".ui-menu")).toBeTruthy();
    expect(within(menu).getByRole("menuitemcheckbox", { name: "최근 활동" }).getAttribute("aria-checked")).toBe("true");
    for (const name of ["만든 날", "마감일", "단계", "줄 모양", "묶기"]) expect(within(menu).getByText(name)).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "이름" }));
    expect(saved(onPrefs).sortByFolder).toEqual({ root: { key: "name", desc: false } });
    expect(projects()).toEqual(["강의 준비", "과제 채점", "논문 메모"]);
    const sub = within(list()).getByRole("button", { name: "하위 포함" });
    expect(sub.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(sub);
    expect(saved(onPrefs).includeSub).toBe(false);
    expect(projects()).toEqual(["논문 메모"]);
  });

  it("draws rows compact, or with as many preview lines as chosen", async () => {
    const view = render(<Frame prefs={{ navShortcuts: [], navigator: { previewLines: 2 } }} />);
    await waitFor(() => expect(row("강의 준비")!.querySelector<HTMLElement>(".nav-project-preview")!.style.webkitLineClamp).toBe("2"));
    view.unmount();
    render(<Frame prefs={{ navShortcuts: [], navigator: { density: "compact" } }} />);
    expect(row("강의 준비")!.classList.contains("compact")).toBe(true);
    expect(row("강의 준비")!.querySelector(".nav-project-preview")).toBeNull();
  });

  it("resizes from the keyboard: the split between the panes, and the sidebar's edge", () => {
    const onPrefs = vi.fn();
    render(<Frame onPrefs={onPrefs} />);
    const split = within(sidebar()).getByRole("separator", { name: "탐색 칸과 목록 칸 사이" });
    fireEvent.keyDown(split, { key: "ArrowRight" });
    expect(saved(onPrefs)).toMatchObject({ navWidth: 232, listWidth: 284 });
    const edge = within(sidebar()).getByRole("separator", { name: "사이드바 너비" });
    expect(edge.tabIndex).toBe(0);
    fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(saved(onPrefs).listWidth).toBe(300);
    expect(sidebar().style.width).toBe("533px");
  });

  it("never grows past the room the work panes need", () => {
    const onPrefs = vi.fn();
    // Two work panes (728px) on a 1440px window leave the navigator 704px.
    render(<Frame onPrefs={onPrefs} paneMinimum={728} prefs={{ navShortcuts: [], navigator: { layout: "dual", navWidth: 216, listWidth: 480 } }} />);
    const edge = within(sidebar()).getByRole("separator", { name: "사이드바 너비" });
    for (let press = 0; press < 4; press += 1) fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(saved(onPrefs).listWidth).toBe(487);
    expect(layout()).toBe("dual");
  });

  it("the one-column sidebar's edge moves from the keyboard too", () => {
    const onPrefs = vi.fn();
    render(<Frame onPrefs={onPrefs} prefs={{ navShortcuts: [], navigator: { layout: "tree" } }} />);
    fireEvent.keyDown(within(sidebar()).getByRole("separator", { name: "사이드바 너비" }), { key: "ArrowLeft" });
    expect(onPrefs).toHaveBeenCalledWith({ sidebarWidth: 272 });
  });
});

describe("empty lists say what to do", () => {
  const list = () => within(sidebar()).getByLabelText("프로젝트 목록");

  it("with no project at all: start one from the head", () => {
    render(<Frame now={{ ...initialState }} />);
    expect(list().querySelector(".list-empty")!.textContent).toBe("아직 프로젝트가 없습니다. 위의 “새로 만들기”로 시작하세요.");
  });

  it("an empty folder: make one here or drag one in", () => {
    render(<Frame prefs={{ navShortcuts: [], navigator: { selected: { kind: "folder", id: "빈 폴더" } } }} />);
    // The sentence names a control by the words drawn on it, and says where it is.
    const sentence = list().querySelector(".list-empty")!.textContent!;
    expect(sentence).toBe("이 폴더에는 프로젝트가 없습니다. 목록 위의 “+ 만들기”로 시작하거나 프로젝트를 이 폴더로 끌어 놓으세요.");
    const named = /“\+ ([^”]+)”/.exec(sentence)![1]!;
    const control = within(list()).getByRole("button", { name: "프로젝트에서 만들기" });
    expect(control.textContent!.trim()).toBe(named);
    expect(control.querySelector("svg")).toBeTruthy();
  });

  it("every hint that names a control uses the words on that control, in every layout", () => {
    // No project at all: the head's button, in the list (two panes, stacked) and in the tree.
    for (const chosen of ["dual", "stacked", "tree"] as const) {
      const view = render(<Frame now={{ ...initialState }} prefs={{ navShortcuts: [], navigator: { layout: chosen } }} />);
      const hint = sidebar().querySelector(".list-empty, .side-empty")!.textContent!;
      expect(hint, chosen).toBe("아직 프로젝트가 없습니다. 위의 “새로 만들기”로 시작하세요.");
      expect(within(sidebar()).getByRole("button", { name: /새로 만들기/ }).textContent!.trim(), chosen).toBe(/“([^”]+)”/.exec(hint)![1]);
      view.unmount();
    }
    // 바로가기 with nothing in it: tags can be dragged there only where the tag tree is drawn.
    const view = render(<Frame />);
    expect(within(sidebar()).getByRole("region", { name: "바로가기" }).textContent).toContain("프로젝트·폴더·태그를 여기로 끌어 놓으면 바로가기가 됩니다.");
    view.unmount();
    render(<Frame prefs={{ navShortcuts: [], navigator: { layout: "tree" } }} />);
    expect(within(sidebar()).getByRole("region", { name: "바로가기" }).textContent).toContain("프로젝트·폴더를 여기로 끌어 놓으면 바로가기가 됩니다.");
    expect(sidebar().textContent).not.toContain("“만들기”");
  });

  it("nothing outside folders: 하위 포함 shows the ones inside, from the hint itself", () => {
    const onPrefs = vi.fn();
    const filed = { ...state, works: byId(Object.values(state.works).filter((entry) => entry.folderId)) };
    render(<Frame now={filed} prefs={{ navShortcuts: [], navigator: { includeSub: false } }} onPrefs={onPrefs} />);
    expect(list().querySelector(".list-empty")!.textContent).toContain("폴더 밖에는 프로젝트가 없습니다.");
    fireEvent.click(within(list()).getByRole("button", { name: "폴더 안의 프로젝트도 보기" }));
    expect(saved(onPrefs).includeSub).toBe(true);
    expect(list().querySelector(".list-empty")).toBeNull();
  });

  it("a filter that matches nothing: clear it from the hint", () => {
    render(<Frame />);
    fireEvent.click(within(list()).getByRole("button", { name: "거르기" }));
    fireEvent.change(within(list()).getByRole("textbox", { name: "프로젝트 거르기" }), { target: { value: "없는이름" } });
    expect(list().querySelector(".list-empty")!.textContent).toContain("거르기에 맞는 프로젝트가 없습니다.");
    fireEvent.click(within(list()).getByRole("button", { name: "거르기 지우기" }));
    expect(list().querySelectorAll(".nav-project")).toHaveLength(3);
  });
});

// 0.4 put these behind closed disclosures in the one-column layout (and the plan limits in every layout).
describe("nothing behind a closed disclosure", () => {
  const usage = { claude: { installed: true, loggedIn: true, usage: [{ label: "5시간", usedPercent: 40, resetsAt: null }] } } as unknown as State["providers"];

  it.each(["tree", "dual"] as const)("%s: 지금, 바로가기 and the plan limits are in the open", (chosen) => {
    render(<Frame now={{ ...state, providers: usage }} prefs={{ navShortcuts: [{ kind: "work", id: "논문 메모" }], navigator: { layout: chosen } }} />);
    for (const name of ["지금", "바로가기", "사용 한도"]) {
      const section = within(sidebar()).getByRole("region", { name });
      expect(section.closest("details"), name).toBeNull();
    }
    expect(sidebar().querySelector("details")).toBeNull();
    expect(within(within(sidebar()).getByRole("region", { name: "지금" })).getByText(/강의안\.md · 문서 AI/)).toBeTruthy();
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
    expect(within(limits()).getByRole("button", { name: "사용 한도 다시 읽기" })).toBeTruthy();
  });
});
