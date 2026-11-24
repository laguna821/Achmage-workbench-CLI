// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, Work, Workspace } from "@workbench/contracts";
import { initialState, type State } from "../state.ts";
import type { Api } from "../api.ts";
import { DocContext, type DocActions } from "./DocCards.tsx";
import { LinkContext, type LinkApi } from "../links.ts";
import { AppearanceContext, NEUTRAL_LOOK, type AppearanceApi } from "../appearance.ts";
import { WorkView, type WorkActions } from "./WorkView.tsx";
import { droppedPaths } from "../file-drop.ts";

vi.mock("./pkm/PkmContext.tsx", async (original) => ({ ...(await original<typeof import("./pkm/PkmContext.tsx")>()), usePkm: () => ({ state: { sessions: {}, transcripts: {} }, pkmState: null, tree: null, open: null, openMenu: () => {}, showSession: () => {}, showWork: () => {}, openArtifact: () => {} }) }));

// composer-056 (the owner, 2026-11-23): "'프로젝트 폴더 지정 (코덱스/클로드 코드식)'을 기본적으로 '첨부'에서 쉽게
// 지정해놓고 파일들은 별도로 첨부 추가로 할 수 있게" and "세션 채팅창에 드래그 앤 드롭방식으로 파일 추가가 안되니까 불편해".

const work = { id: "w", title: "AI 글쓰기 수업", folderId: null, cwd: "/works/w", defaultWorkspaceId: "home", activeSessionId: "a", archivedAt: null } as unknown as Work;
const space = (id: string, cwd: string, label: string) => ({ id, workId: "w", hostId: "h", label, kind: "folder", cwd, managed: false, worktree: null, archivedAt: null, removedAt: null, createdAt: 1, updatedAt: 1 }) as Workspace;
const base = { workId: "w", status: "idle", model: null, effort: null, context: null, worktree: null, lastError: null, engineModel: null, engineEffort: null, createdAt: 1, updatedAt: 1, sort: 0, archivedAt: null, queued: [], nativeSessionId: null };
const fresh = { ...base, id: "a", provider: "codex", purpose: "새 대화", workspaceId: "class" } as unknown as Session;
const stateWith = (session: Session, items: unknown[] = []): State => ({
  ...initialState,
  works: { w: work },
  sessions: { a: session },
  workspaces: { home: space("home", "/works/w", "기본 작업공간"), class: space("class", "/home/u/수업 자료", "수업 자료") },
  transcripts: { a: { items } as unknown as State["transcripts"][string] },
});

let api: Api;
let actions: WorkActions;
let calls: Record<string, ReturnType<typeof vi.fn>>;
const view = (state: State, extra: Partial<WorkActions> = {}) => {
  calls = { upload: vi.fn(async (file: File) => ({ id: `${"a".repeat(64)}.txt`, name: file.name, mime: "text/plain", size: file.size })), attachLocalFile: vi.fn(async (path: string) => ({ id: `${"b".repeat(64)}.txt`, name: path.split("/").at(-1), mime: "text/plain", size: 7 })) };
  api = new Proxy({}, { get: (_, key) => key === "attachLocalFile" ? calls.attachLocalFile : key === "isRemote" ? false : vi.fn(async () => (key === "agentProfiles" ? { profiles: [] } : {})) }) as unknown as Api;
  actions = new Proxy(extra, { get: (target, key) => key in target ? target[key as keyof WorkActions] : key === "queued" ? { send: vi.fn(), cancel: vi.fn(), edit: vi.fn() } : key === "upload" ? calls.upload : key === "changeSessionFolder" ? undefined : vi.fn() }) as unknown as WorkActions;
  return render(
    <AppearanceContext.Provider value={{ appTheme: "light", lookOf: () => NEUTRAL_LOOK.light, themeOf: () => "light", openMenu: vi.fn() } as unknown as AppearanceApi}>
      <LinkContext.Provider value={new Proxy({ state, dialog: null, view: null }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn() }) as unknown as LinkApi}>
        <DocContext.Provider value={{ state, actions: { openArtifact: vi.fn(), openSession: vi.fn() } as unknown as DocActions }}>
          <WorkView api={api} onToast={() => {}} state={state} work={work} actions={actions} engine="codex" setEngine={() => {}} pickFile={null} prefs={{}} />
        </DocContext.Provider>
      </LinkContext.Provider>
    </AppearanceContext.Provider>,
  );
};
const openAttach = () => fireEvent.click(screen.getByRole("button", { name: "사진 또는 파일 첨부" }));
/** A DataTransfer as a drag from outside the page carries it (jsdom has none). */
const transfer = (files: File[], uriList = "") => ({ types: [...(files.length ? ["Files"] : []), ...(uriList ? ["text/uri-list"] : [])], files, dropEffect: "none", getData: (type: string) => (type === "text/uri-list" ? uriList : "") });

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("CSS", { escape: (text: string) => text });
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("첨부: the conversation's working folder first, then the files", () => {
  it("names the folder the engine runs in (its path on hover) and offers 작업 폴더 바꾸기… before 파일 첨부…", () => {
    const changeSessionFolder = vi.fn(async () => {});
    view(stateWith(fresh), { changeSessionFolder });
    openAttach();
    const menu = screen.getByRole("menu", { name: "사진 또는 파일 첨부" });
    const folder = within(menu).getByText("수업 자료").closest<HTMLElement>("[title]")!;
    expect(folder.title).toBe("/home/u/수업 자료");
    const items = within(menu).getAllByRole("menuitem").map((item) => item.textContent ?? "");
    expect(items[0]).toContain("작업 폴더 바꾸기…");
    expect(items[1]).toContain("파일 첨부…");
    expect(within(menu).getByText("이 대화가 고른 폴더에서 시작합니다.")).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /작업 폴더 바꾸기/ }));
    expect(changeSessionFolder).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("a conversation that has started says what a change does: it stays, a new conversation opens in the folder", () => {
    view(stateWith(fresh, [{ kind: "user", id: "u1", text: "먼저", at: 1 }]), { changeSessionFolder: vi.fn(async () => {}) });
    openAttach();
    expect(screen.getByText("시작한 대화는 그대로 두고, 고른 폴더에서 새 대화를 엽니다.")).toBeTruthy();
  });

  it("where no PC folder can be chosen (the phone page) the folder is shown and the menu says where it is changed", () => {
    view(stateWith(fresh));
    openAttach();
    const menu = screen.getByRole("menu", { name: "사진 또는 파일 첨부" });
    expect(within(menu).getByText("수업 자료")).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: /작업 폴더 바꾸기/ })).toBeNull();
    expect(within(menu).getByText("작업 폴더는 PC에서 바꿉니다.")).toBeTruthy();
  });
});

describe("files dropped anywhere on the conversation", () => {
  it("over the transcript (not the input) says where they go; a drop with files attaches them all", async () => {
    view(stateWith(fresh));
    const pane = document.querySelector<HTMLElement>(".work-view")!;
    const target = pane.querySelector<HTMLElement>(".transcript, .work-scroll, .column") ?? pane;
    const files = [new File(["가"], "자료1.txt", { type: "text/plain" }), new File(["나"], "자료2.txt", { type: "text/plain" })];
    fireEvent.dragEnter(target, { dataTransfer: transfer(files) });
    fireEvent.dragOver(target, { dataTransfer: transfer(files) });
    expect(screen.getByText("여기에 놓으면 첨부합니다")).toBeTruthy();
    fireEvent.drop(target, { dataTransfer: transfer(files) });
    expect(screen.queryByText("여기에 놓으면 첨부합니다")).toBeNull();
    await waitFor(() => expect(calls.upload).toHaveBeenCalledTimes(2));
    expect(screen.getByText("자료1.txt")).toBeTruthy();
    expect(screen.getByText("자료2.txt")).toBeTruthy();
  });

  it("a file manager's drop that carries only a file:// list (WebKitGTK) attaches the files by their paths", async () => {
    view(stateWith(fresh));
    const pane = document.querySelector<HTMLElement>(".work-view")!;
    const list = "file:///home/u/%EA%B0%95%EC%9D%98%EA%B3%84%ED%9A%8D%EC%84%9C.hwpx\r\n# a comment\r\nfile:///home/u/b%20c.pdf\r\n";
    fireEvent.dragOver(pane, { dataTransfer: transfer([], list) });
    expect(screen.getByText("여기에 놓으면 첨부합니다")).toBeTruthy();
    fireEvent.drop(pane, { dataTransfer: transfer([], list) });
    await waitFor(() => expect(calls.attachLocalFile).toHaveBeenCalledTimes(2));
    expect(calls.attachLocalFile.mock.calls.map(([path]) => path)).toEqual(["/home/u/강의계획서.hwpx", "/home/u/b c.pdf"]);
    expect(await screen.findByText("강의계획서.hwpx")).toBeTruthy();
  });

  it("a drag that started in the page (a link, selected text) is not a file drop", () => {
    view(stateWith(fresh));
    const pane = document.querySelector<HTMLElement>(".work-view")!;
    act(() => { pane.dispatchEvent(new Event("dragstart", { bubbles: true })); });
    fireEvent.dragOver(pane, { dataTransfer: transfer([], "https://example.invalid/") });
    expect(screen.queryByText("여기에 놓으면 첨부합니다")).toBeNull();
    act(() => { document.dispatchEvent(new Event("dragend", { bubbles: true })); });
  });
});

describe("droppedPaths", () => {
  it("reads local paths from a uri-list: file:// only, comments and web addresses left out, a Windows drive kept", () => {
    expect(droppedPaths("file:///tmp/a.txt\n#c\nhttps://example.invalid/x\nfile://localhost/tmp/b%23.txt\nfile:///C:/Users/u/c.txt")).toEqual(["/tmp/a.txt", "/tmp/b#.txt", "C:\\Users\\u\\c.txt"]);
    expect(droppedPaths("")).toEqual([]);
  });
});
