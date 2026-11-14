// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, ProjectPage, ProjectWrite, PropertyRow, Session, Work } from "@workbench/contracts";
import { ApiRequestError, type Api } from "../../api.ts";
import { AppearanceContext, NEUTRAL_LOOK, type AppearanceApi } from "../../appearance.ts";
import { initialState, type State } from "../../state.ts";
import { keepField, readField } from "./field-drafts.ts";
import { AddInput, ProjectView } from "./ProjectView.tsx";
import { LineInput, machineRow } from "./PropertiesPanel.tsx";

// Other projects' property values, as the app gives them to the page (none unless a test loads some).
type OtherProject = { properties: { key: string; type: PropertyRow["type"]; values: string[] }[] };
let others: { api: { projects: ReturnType<typeof vi.fn> }; state: { pkm: Record<string, number> } } | null = null;
const loadOthers = (list: OtherProject[]) => { others = { api: { projects: vi.fn(async () => list) }, state: { pkm: {} } }; return others.api.projects; };
vi.mock("../pkm/PkmContext.tsx", async (original) => ({ ...(await original<typeof import("../pkm/PkmContext.tsx")>()), useOptionalPkm: () => others }));

// The project page as the person uses it: a note to read, with its words and properties changed
// where they are shown, every write going to the real file through the gateway with a way back.

const FM = "---\nworkbench_id: w\n---\n";
const FREE = "\n## 이번 주에 할 일\n\n- 슬라이드를 다시 짠다.\n\n";
const SECTIONS = "## 결정\n- 2026-11-12 루브릭 세 단계\n";
const BODY = FREE + SECTIONS;

/** The note fields the gateway derives from a file: body, its words as one run before the sections, the source. */
function fileNote(source: string) {
  const bodyStart = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(source)?.[0].length ?? 0;
  const cut = source.indexOf("## 결정");
  const end = cut >= 0 ? cut : source.length;
  return { body: source.slice(bodyStart), free: source.slice(bodyStart, end), runs: [{ start: bodyStart, end, text: source.slice(bodyStart, end) }], source };
}

const row = (key: string, type: PropertyRow["type"], values: string[] | null, patch: Partial<PropertyRow> = {}): PropertyRow => ({ key, type, values, present: values !== null, fromTemplate: false, ...patch });
const ROWS: PropertyRow[] = [
  row("단계", "stage", ["진행중"], { fromTemplate: true }),
  row("tags", "tags", ["강의"], { fromTemplate: true }),
  row("마감일", "date", ["2026-11-20"]),
  row("중요도", "text", ["높음"]),
  row("종류", "list", ["강의"]),
  row("목표", "text", ["학생이 AI가 고친 글과 자기 글의 차이를 자기 말로 설명하게 한다."]),
  row("시작일", "date", null, { fromTemplate: true }),
];

const pageOf = (patch: Partial<ProjectPage["note"]> = {}, rows = ROWS): ProjectPage => ({
  workId: "w",
  note: { path: "/tmp/lecture/강의.md", exists: true, properties: [], stage: "진행중", tags: ["강의"], decisions: [{ line: 6, text: "2026-11-12 루브릭 세 단계", done: false }], questions: [], ...fileNote(FM + BODY), problem: null, revision: 2, lastAuthor: "user", lastSessionId: null, artifactId: "note-a", ...patch },
  facts: { sessions: 2, running: 0, attention: 1, errors: 0, stopped: [], unread: 0, proposals: 0, attentionSessionId: "s1", errorSessionId: null, proposalId: null, proposalArtifactId: null, lastActivity: Date.now(), createdAt: Date.now(), engines: {}, models: [], requests: 0, turnMs: 0, files: 1, revisions: { user: 1, engine: 0, external: 0 }, schedules: 0, worktrees: 0, folder: "/tmp/lecture", branch: null } as unknown as ProjectPage["facts"],
  events: [],
  card: "맥락 카드",
  stages: [{ name: "할일", color: "red" }, { name: "진행중", color: "blue" }, { name: "완료", color: "green" }],
  rows,
  knownKeys: [],
  noteTemplate: null,
});

const session = (id: string, patch: Partial<Session>): Session => ({ id, workId: "w", provider: "codex", purpose: id, status: "idle", updatedAt: 1, archivedAt: null, lastError: null, unread: false, preview: null, previewAt: null, seenAt: null, activity: null, queued: [], ...patch }) as unknown as Session;

function setup(page = pageOf(), onLeaveGuard?: (guard: (() => Promise<void>) | null) => void) {
  let current = page;
  const write = (summary: string): ProjectWrite => ({ token: "tok", created: false, summary, page: current });
  // Another project the same place can go on to show.
  const other: ProjectPage = { ...pageOf({ path: "/tmp/other/다른.md", decisions: [], revision: 7, artifactId: null }), workId: "x" };
  const api = {
    project: vi.fn(async (id: string) => (id === "x" ? other : current)),
    projects: vi.fn(async () => []),
    projectEvents: vi.fn(async () => []),
    vaultTags: vi.fn(async () => []),
    setPropertyType: vi.fn(async () => ({})),
    setProjectRun: vi.fn(async (_w: string, run: { index: number; expected: string; text: string }) => {
      const source = current.note.source!;
      const at = current.note.runs![run.index]!;
      current = { ...current, note: { ...current.note, ...fileNote(source.slice(0, at.start) + run.text + source.slice(at.end)), revision: (current.note.revision ?? 0) + 1 } };
      return write("노트 본문 고침");
    }),
    setProjectSource: vi.fn(async (_w: string, text: string) => {
      current = { ...current, note: { ...current.note, ...fileNote(text), revision: (current.note.revision ?? 0) + 1 } };
      return write("노트 원문 고침");
    }),
    revertProjectNoteTo: vi.fn(async () => write("노트를 r1로 되돌림")),
    setProjectProperty: vi.fn(async (_w: string, key: string, values: string[]) => write(`${key}: 2026-11-20 → ${values?.join(", ")}`)),
    setProjectStage: vi.fn(async (_w: string, stage: string | null) => write(`단계: 진행중 → ${stage}`)),
    undoProject: vi.fn(async () => current),
    revertProjectNote: vi.fn(async () => write("엔진이 바꾼 노트를 되돌림")),
    addProjectEntry: vi.fn(async () => write("결정")),
    setProjectQuestion: vi.fn(async () => write("열린 질문 닫음")),
    registerDocument: vi.fn(async () => ({ view: { mode: "write", expiresAt: Date.now() + 600_000 }, writer: null, writeToken: "lease" })),
    closeDocument: vi.fn(async () => ({ ok: true })),
  } as Record<string, ReturnType<typeof vi.fn>> & { forDocument?: unknown };
  api.forDocument = () => api;
  const works: Record<string, Work> = {
    w: { id: "w", title: "3주차 강의 슬라이드", folderId: null, cwd: "/tmp/lecture", activeSessionId: null, archivedAt: null, tags: [] } as unknown as Work,
    x: { id: "x", title: "다른 프로젝트", folderId: null, cwd: "/tmp/other", activeSessionId: null, archivedAt: null, tags: [] } as unknown as Work,
  };
  const sessions: Record<string, Session> = {
    s1: session("s1", { purpose: "슬라이드 정리", status: "awaitingApproval", activity: "명령 실행 승인" }),
    s2: session("s2", { purpose: "강의안.md · 문서 AI", provider: "claude", documentAgent: { artifactId: "a1", parentSessionId: null } }),
  };
  const artifacts: Record<string, Artifact> = {
    a1: { id: "a1", workId: "w", name: "강의안.md", format: "markdown", path: "/tmp/lecture/강의안.md", relativePath: "강의안.md", revision: 1, updatedAt: 1, readBy: {} } as unknown as Artifact,
    "note-a": { id: "note-a", workId: "w", name: "강의.md", role: "project-note", format: "markdown", revision: 2, updatedAt: 1 } as unknown as Artifact,
  };
  let state: State = { ...initialState, works, sessions, artifacts };
  const onToast = vi.fn();
  const onError = vi.fn();
  const onOpenSession = vi.fn();
  const onOpenDocument = vi.fn();
  const openMenu = vi.fn();
  // No key: the same instance is shown again for another project, as a tab that navigates does.
  const element = (workId: string) => (
    <AppearanceContext.Provider value={{ appTheme: "light", lookOf: () => NEUTRAL_LOOK.light } as unknown as AppearanceApi}>
      <ProjectView api={api as unknown as Api} state={state} workId={workId} onOpenSession={onOpenSession} onOpenDocument={onOpenDocument} onToast={onToast} onError={onError} openMenu={openMenu} onLeaveGuard={onLeaveGuard} />
    </AppearanceContext.Provider>
  );
  const view = render(element("w"));
  return {
    api, view, onToast, onError, onOpenSession, onOpenDocument, setCurrent: (next: ProjectPage) => { current = next; }, openMenu,
    /** The same place goes on to show another project. */
    show: (workId: string) => view.rerender(element(workId)),
    /** A second pane showing the same note through the same gateway. */
    again: () => render(element("w")),
    /** The gateway says the note changed (as after a write elsewhere): the page reads it again. */
    reload: () => {
      state = { ...state, pkm: { ...state.pkm, "project:w": (state.pkm["project:w"] ?? 0) + 1 } };
      view.rerender(element("w"));
    },
  };
}

const editorOf = () => EditorView.findFromDOM(document.querySelector<HTMLElement>(".pn-body-edit .cm-editor")!)!;
const typeInto = (text: string) => act(() => { const view = editorOf(); view.dispatch({ changes: { from: view.state.doc.length, insert: text } }); });
const runText = () => editorOf().state.doc.toString();
const keyOnEditor = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(editorOf().contentDOM, { key, ...init });

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  others = null;
});

/** The properties block under the title, and the chip line above it (folder, stage, tags). */
const blockOf = () => screen.findByRole("region", { name: "속성" });
const chipsOf = () => screen.getByRole("group", { name: "노트 한눈에" });
const STAGE = "단계: 진행중 — 바꾸기";
const TAGS = "태그: #강의 — 바꾸기";

describe("reading the project note", () => {
  it("shows every key of the note as a row under the title: the template's fields (an empty one quiet), the note's other keys, in the note's order", async () => {
    setup();
    const block = await blockOf();
    // The head counts the rows drawn (the template's empty 시작일 and the app's own key among them).
    expect(within(block).getByRole("button", { name: "속성 8", expanded: true })).toBeTruthy();
    expect(within(block).getAllByRole("term").map((term) => term.textContent)).toEqual(["단계", "태그", "마감일", "중요도", "종류", "목표", "시작일", "workbench_id"]);
    expect(within(block).getAllByRole("definition").map((value) => value.textContent)).toEqual(["진행중", "#강의", "11월 20일", "높음", "강의", "학생이 AI가 고친 글과 자기 글의 차이를 자기 말로 설명하게 한다.", "비어 있음", "w"]);
    expect(within(block).getByRole("button", { name: "시작일: 비어 있음 — 고치기" })).toBeTruthy();
    // Each row leads with its kind's icon.
    expect(block.querySelectorAll(".pn-prop .pn-prop-kind svg")).toHaveLength(8);
    // It sits after the title's chip line and before the stat row.
    expect(chipsOf().compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(block.compareDocumentPosition(screen.getByRole("group", { name: "현황" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the stat row to counts and state, never a property", async () => {
    setup();
    const stats = await screen.findByRole("group", { name: "현황" });
    expect(within(stats).getAllByRole("term").map((term) => term.textContent)).toEqual(["대화", "문서", "확인 필요", "마지막 활동"]);
    // The long goal is a row of the block, not a sentence of its own under the title.
    expect(document.querySelector(".pn-lede")).toBeNull();
    expect(screen.getAllByText(/^학생이 AI가 고친 글과/)).toHaveLength(1);
  });

  it("folds the block under its head, on this device; the chip line stays", async () => {
    const first = setup();
    const block = await blockOf();
    fireEvent.click(within(block).getByRole("button", { name: "속성 8" }));
    expect(within(block).getByRole("button", { name: "속성 8", expanded: false })).toBeTruthy();
    expect(within(block).queryAllByRole("term")).toEqual([]);
    expect(within(block).queryByRole("button", { name: "속성 추가" })).toBeNull();
    expect(within(chipsOf()).getByRole("button", { name: STAGE })).toBeTruthy();
    first.view.unmount();
    setup();
    expect(within(await blockOf()).getByRole("button", { name: "속성 8", expanded: false })).toBeTruthy();
    expect(within(await blockOf()).queryAllByRole("term")).toEqual([]);
  });

  it("wears the one note head a conversation wears: kind icon, title, property chips", async () => {
    setup();
    const title = await screen.findByRole("heading", { level: 1, name: "3주차 강의 슬라이드" });
    expect(title.classList.contains("note-title")).toBe(true);
    expect(title.closest(".note-head-title")?.querySelector(".note-kind")?.compareDocumentPosition(title)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // The chip line keeps what tells the note apart at a glance: its stage and tags (and folder).
    const chips = chipsOf();
    expect(chips.classList.contains("note-props")).toBe(true);
    expect(within(chips).getByRole("button", { name: STAGE }).classList.contains("note-prop")).toBe(true);
    expect(within(chips).getByRole("button", { name: TAGS }).classList.contains("note-prop")).toBe(true);
    expect(within(chips).getAllByRole("button")).toHaveLength(2);
    expect(document.querySelector(".pn-meta-item")).toBeNull();
  });

  it("opens the note's raw text from the block's head (원문), the whole file as it is", async () => {
    setup();
    fireEvent.click(within(await blockOf()).getByRole("button", { name: "원문" }));
    await waitFor(() => expect(document.querySelector(".pn-body-edit[data-mode=source] .cm-editor")).not.toBeNull());
    expect(runText()).toBe(FM + BODY);
  });

  it("shows the note's own words beside its decisions, not the decisions twice", async () => {
    setup();
    const body = await screen.findByRole("region", { name: "노트" });
    expect(within(body).getByText("슬라이드를 다시 짠다.")).toBeTruthy();
    expect(within(body).queryByText(/루브릭 세 단계/)).toBeNull();
    const entries = screen.getByRole("region", { name: "결정과 열린 질문" });
    expect(within(entries).getByText("루브릭 세 단계")).toBeTruthy();
    expect(within(entries).getByText("11.12")).toBeTruthy();
  });

  it("lists conversations, documents and web pages as cards; a document's AI is on its document's card", async () => {
    const { onOpenSession, onOpenDocument } = setup();
    const chats = await screen.findByRole("list", { name: "대화" });
    expect(within(chats).getAllByRole("listitem")).toHaveLength(1);
    expect(within(chats).queryByText("강의안.md · 문서 AI")).toBeNull();
    const docs = screen.getByRole("list", { name: "문서" });
    expect(within(docs).getAllByRole("listitem")).toHaveLength(1);
    expect(within(docs).getByText(/문서 AI/)).toBeTruthy();
    // No web pages: no web section at all.
    expect(screen.queryByRole("list", { name: "웹" })).toBeNull();
    fireEvent.click(within(chats).getByRole("button"));
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
    fireEvent.click(within(docs).getByRole("button"));
    expect(onOpenDocument).toHaveBeenCalledWith("a1", null);
    // The conversation card says what it waits for.
    expect(within(chats).getByText("확인 필요")).toBeTruthy();
  });
});

describe("editing the body in place", () => {

  it("turns only the clicked run into its source, in place, and Ctrl+Enter writes that run with a way back", async () => {
    const { api, onToast } = setup();
    fireEvent.click(await screen.findByText("슬라이드를 다시 짠다."));
    expect(runText()).toBe(FREE);
    // The decisions stay beside it, as they were.
    expect(within(screen.getByRole("region", { name: "결정과 열린 질문" })).getByText("루브릭 세 단계")).toBeTruthy();
    typeInto("- 새 줄\n");
    keyOnEditor("Enter", { ctrlKey: true });
    await waitFor(() => expect(api.setProjectRun).toHaveBeenCalledWith("w", { index: 0, expected: FREE, text: `${FREE}- 새 줄\n` }, 2));
    await waitFor(() => expect(document.querySelector(".pn-body-edit")).toBeNull());
    const toast = onToast.mock.calls.at(-1)![0];
    expect(toast.text).toBe("노트 본문 고침 · +1줄 −0줄");
    toast.action.run();
    // The undo is sent from the revision that write made.
    await waitFor(() => expect(api.undoProject).toHaveBeenCalledWith("w", "tok", 3));
  });

  it("puts the caret where the reader clicked, not at the top", async () => {
    setup();
    const item = await screen.findByText("슬라이드를 다시 짠다.");
    // jsdom has no layout: the click lands at the start of the clicked block's source line.
    fireEvent.click(item);
    const caret = editorOf().state.selection.main.head;
    expect(FREE.slice(0, caret).split("\n").length).toBe(4);
    expect(FREE.split("\n")[3]).toBe("- 슬라이드를 다시 짠다.");
  });

  it("styles the in-place source as the note (the note look), not the document editor", async () => {
    setup();
    fireEvent.click(await screen.findByText("슬라이드를 다시 짠다."));
    expect(editorOf().dom.closest(".pn-body-read")).not.toBeNull();
    expect(document.querySelector(".pn-body-edit .cm-placeholder, .pn-body-edit .cm-content")).not.toBeNull();
  });

  it("writes nothing when a CRLF note is opened and left, and writes CRLF back when it changes", async () => {
    const crlf = (FM + BODY).replace(/\n/g, "\r\n");
    const { api } = setup(pageOf({ ...fileNote(crlf) }));
    fireEvent.click(await screen.findByText("슬라이드를 다시 짠다."));
    expect(runText()).toBe(FREE);
    const outside = screen.getByRole("button", { name: "프로젝트 메뉴" });
    fireEvent.focusOut(editorOf().contentDOM, { relatedTarget: outside });
    await waitFor(() => expect(document.querySelector(".pn-body-edit")).toBeNull());
    expect(api.setProjectRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("슬라이드를 다시 짠다."));
    typeInto("- 더함\n");
    await waitFor(() => expect(screen.queryByText("다른 창의 편집 여부를 확인하고 있습니다.")).toBeNull());
    fireEvent.focusOut(editorOf().contentDOM, { relatedTarget: outside });
    await waitFor(() => expect(api.setProjectRun).toHaveBeenCalledTimes(1));
    const run = api.setProjectRun.mock.calls[0]![1] as { text: string; expected: string };
    expect(run.text).toBe(`${FREE}- 더함\n`.replace(/\n/g, "\r\n"));
    expect(run.expected).toBe(FREE.replace(/\n/g, "\r\n"));
  });

  it("drops the words on Esc without writing, and the notice brings them back", async () => {
    const { api, onToast } = setup();
    fireEvent.click(await screen.findByText("슬라이드를 다시 짠다."));
    typeInto("버리면 안 되는 글");
    keyOnEditor("Escape");
    await waitFor(() => expect(document.querySelector(".pn-body-edit")).toBeNull());
    expect(api.setProjectRun).not.toHaveBeenCalled();
    const notice = onToast.mock.calls.at(-1)![0];
    expect(notice.text).toBe("고치던 내용을 버렸습니다");
    expect(notice.action.label).toBe("되살리기");
    act(() => notice.action.run());
    await waitFor(() => expect(runText()).toBe(`${FREE}버리면 안 되는 글`));
  });

  it("keeps the words on this device while editing and offers them back after the page is gone", async () => {
    const first = setup();
    fireEvent.click(await screen.findByText("슬라이드를 다시 짠다."));
    typeInto("앱이 닫혀도 남을 글");
    await act(async () => { await new Promise((done) => setTimeout(done, 400)); });
    first.view.unmount();
    setup();
    const offer = await screen.findByText(/저장하지 않은 노트 편집이 남아 있습니다/);
    fireEvent.click(within(offer.closest<HTMLElement>(".pn-recovery")!).getByRole("button", { name: "이어서 고치기" }));
    await waitFor(() => expect(runText()).toBe(`${FREE}앱이 닫혀도 남을 글`));
  });

  it("writes when focus leaves it, and writes nothing when the words did not change", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByText("슬라이드를 다시 짠다."));
    const outside = screen.getByRole("button", { name: "프로젝트 메뉴" });
    fireEvent.focusOut(editorOf().contentDOM, { relatedTarget: outside });
    await waitFor(() => expect(document.querySelector(".pn-body-edit")).toBeNull());
    expect(api.setProjectRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("슬라이드를 다시 짠다."));
    typeInto("더함\n");
    await waitFor(() => expect(screen.queryByText("다른 창의 편집 여부를 확인하고 있습니다.")).toBeNull());
    fireEvent.focusOut(editorOf().contentDOM, { relatedTarget: outside });
    await waitFor(() => expect(api.setProjectRun).toHaveBeenCalledTimes(1));
  });

  it("is writable at once, while the edit lease is still being asked for (no focus lost to a read-only flip)", async () => {
    const { api } = setup();
    let grant: (value: unknown) => void = () => undefined;
    api.registerDocument.mockImplementationOnce(() => new Promise((resolve) => { grant = resolve; }));
    fireEvent.click(await screen.findByText("슬라이드를 다시 짠다."));
    expect(editorOf().contentDOM.getAttribute("contenteditable")).toBe("true");
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => grant({ view: { mode: "write", expiresAt: Date.now() + 600_000 }, writer: null, writeToken: "lease" }));
    expect(document.querySelector(".pn-body-edit")).not.toBeNull();
  });

  it("leaving the page waits for a write already under way, and a conflict keeps the person on the page", async () => {
    let guard: (() => Promise<void>) | null = null;
    const { api, setCurrent } = setup(pageOf(), (next) => { guard = next; });
    fireEvent.click(await screen.findByText("슬라이드를 다시 짠다."));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    typeInto("떠나기 전 줄\n");
    setCurrent(pageOf({ ...fileNote(`${FM}\n앱 밖에서 쓴 본문\n`), revision: 3, lastAuthor: "external" }));
    let fail: (error: unknown) => void = () => undefined;
    api.setProjectRun.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    fireEvent.focusOut(editorOf().contentDOM, { relatedTarget: screen.getByRole("button", { name: "프로젝트 메뉴" }) });
    const leaving = guard!().then(() => "left", () => "held");
    await waitFor(() => expect(api.setProjectRun).toHaveBeenCalled());
    await act(async () => fail(new ApiRequestError(409, { code: "note_changed", message: "바뀜" })));
    expect(await leaving).toBe("held");
    expect(api.setProjectRun).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole("alert")).textContent).toContain("앱 밖에서 노트를 바꿨습니다");
    expect(runText()).toBe(`${FREE}떠나기 전 줄\n`);
  });

  it("opens with the edit key from anywhere on the page outside a field", async () => {
    setup();
    const title = await screen.findByRole("heading", { name: "3주차 강의 슬라이드" });
    fireEvent.keyDown(title, { key: "e" });
    expect(document.querySelector(".pn-body-edit")).not.toBeNull();
  });

  it("never overwrites an engine's change made meanwhile: compare, keep mine or take theirs", async () => {
    const { api, setCurrent } = setup();
    fireEvent.click(await screen.findByText("슬라이드를 다시 짠다."));
    typeInto("내 줄\n");
    const theirs = pageOf({ ...fileNote(`${FM}\n엔진이 쓴 본문\n${SECTIONS}`), revision: 3, lastAuthor: "engine" });
    setCurrent(theirs);
    api.setProjectRun.mockRejectedValueOnce(new ApiRequestError(409, { code: "note_moved", message: "그 사이 노트가 바뀌었습니다." }));
    keyOnEditor("Enter", { ctrlKey: true });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("엔진이 노트를 바꿨습니다 (r3)");
    expect(runText()).toBe(`${FREE}내 줄\n`);
    fireEvent.click(within(alert).getByRole("button", { name: "비교" }));
    expect(document.querySelector(".diff-view")).not.toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "내 것으로 쓰기" }));
    await waitFor(() => expect(api.setProjectRun).toHaveBeenLastCalledWith("w", { index: 0, expected: "\n엔진이 쓴 본문\n", text: `${FREE}내 줄\n` }, 3));
  });

  it("takes the other side's note when asked, and the dropped words can still come back", async () => {
    const { api, setCurrent, onToast } = setup();
    fireEvent.click(await screen.findByText("슬라이드를 다시 짠다."));
    typeInto("버려질 줄\n");
    setCurrent(pageOf({ ...fileNote(`${FM}\n엔진이 쓴 본문\n${SECTIONS}`), revision: 3, lastAuthor: "engine" }));
    api.setProjectRun.mockRejectedValueOnce(new ApiRequestError(409, { code: "note_changed", message: "바뀜" }));
    keyOnEditor("Enter", { ctrlKey: true });
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "저쪽 것 받기" }));
    expect(await screen.findByText("엔진이 쓴 본문")).toBeTruthy();
    expect(document.querySelector(".pn-body-edit")).toBeNull();
    expect(api.setProjectRun).toHaveBeenCalledTimes(1);
    expect(onToast.mock.calls.at(-1)![0].action.label).toBe("되살리기");
  });

  it("opens the whole file from ⋯ 원문 전체, and writes it as a whole", async () => {
    const { api, openMenu } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "프로젝트 메뉴" }));
    const items = openMenu.mock.calls.at(-1)![0].items as { kind: string; label?: string; onSelect?: () => void }[];
    act(() => items.find((item) => item.label === "원문 전체")!.onSelect!());
    expect(document.querySelector('.pn-body-edit[data-mode="source"]')).not.toBeNull();
    expect(runText()).toBe(FM + BODY);
    typeInto("- 끝에 더함\n");
    keyOnEditor("Enter", { ctrlKey: true });
    await waitFor(() => expect(api.setProjectSource).toHaveBeenCalledWith("w", `${FM}${BODY}- 끝에 더함\n`, 2));
  });
});

describe("a note whose properties no longer read", () => {
  it("shows the last readable revision's properties, says who broke it, and offers compare and revert", async () => {
    const broken = `---\nworkbench_id: w\n종류: [강의\n---\n${BODY}`;
    const page = pageOf({ ...fileNote(broken), problem: "속성(YAML)을 읽을 수 없습니다: Missing closing ]", revision: 4 });
    page.lastReadable = { revision: 3, author: "external", sessionId: null, at: Date.now(), rows: [row("종류", "list", ["강의"])], text: `${FM}${BODY}`, current: broken };
    const { api } = setup(page);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("앱 밖(Obsidian, 동기화 등)에서 바뀐 뒤로 읽히지 않습니다");
    expect(alert.textContent).toContain("r3의 속성");
    // The readable revision's values are shown (only the revert writes; see round 3).
    const block = await blockOf();
    expect(within(block).getAllByRole("term").map((term) => term.textContent)).toEqual(["종류"]);
    expect(within(block).getByRole("definition").textContent).toBe("강의");
    // Nothing in the block writes, and the raw text is not offered (only the revert writes; see round 3).
    expect(within(block).getAllByRole("button").map((button) => button.textContent)).toEqual(["속성 1"]);
    fireEvent.click(within(alert).getByRole("button", { name: "비교" }));
    expect(document.querySelector(".diff-view")).not.toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "r3로 되돌리기" }));
    await waitFor(() => expect(api.revertProjectNoteTo).toHaveBeenCalledWith("w", 3, 4));
  });

  it("offers a multi-line or map value only in the source, with the caret at its key", async () => {
    const source = `---\nworkbench_id: w\nsummary: |\n  첫 줄\n\n  셋째 줄\n---\n${BODY}`;
    setup(pageOf({ ...fileNote(source) }, [...ROWS, row("summary", "text", ["첫 줄 셋째 줄"], { editable: false })]));
    fireEvent.click(await screen.findByRole("button", { name: /^summary: .* — 원문에서 고치기$/ }));
    const caret = editorOf().state.selection.main.head;
    expect(source.slice(0, caret).split("\n").at(-1)).toBe("summary: |");
  });
});

describe("editing a property in place", () => {
  it("turns a date stat into a field; Enter during Hangul composition is ignored; the notice says what the gateway wrote", async () => {
    const { api, onToast } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /^마감일: .*11월 20일 — 고치기$/ }));
    const field = screen.getByRole("textbox", { name: "마감일" }) as HTMLInputElement;
    expect(field.value).toBe("2026-11-20");
    fireEvent.change(field, { target: { value: "11월 27일" } });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(api.setProjectProperty).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "마감일", ["11월 27일"], "date", 2));
    await waitFor(() => expect(onToast.mock.calls.at(-1)![0].text).toBe("마감일: 2026-11-20 → 11월 27일"));
    expect(onToast.mock.calls.at(-1)![0].action.label).toBe("되돌리기");
  });

  it("keeps a refused value in its field with the reason, never dropping what was typed", async () => {
    const { api, onError } = setup();
    api.setProjectProperty.mockRejectedValueOnce(new ApiRequestError(400, { code: "bad_date", message: "날짜로 읽지 못했습니다. 예: 11월 20일, 내일, 다음 주 금요일" }));
    fireEvent.click(await screen.findByRole("button", { name: /^마감일: / }));
    const field = screen.getByRole("textbox", { name: "마감일" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "언젠가" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toBe("날짜로 읽지 못했습니다. 예: 11월 20일, 내일, 다음 주 금요일");
    expect((screen.getByRole("textbox", { name: "마감일" }) as HTMLInputElement).value).toBe("언젠가");
    expect(onError).not.toHaveBeenCalled();
  });

  it("puts a property back on Esc", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /^중요도: 높음/ }));
    const field = screen.getByRole("textbox", { name: "중요도" });
    fireEvent.change(field, { target: { value: "낮음" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "중요도" })).toBeNull();
    expect(api.setProjectProperty).not.toHaveBeenCalled();
  });

  it("ticks a list property's values in a picker, each tick written", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "종류: 강의 — 고치기" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "종류 찾기" }), { target: { value: "세미나" } });
    fireEvent.click(await screen.findByRole("option", { name: /「세미나」 추가/ }));
    // A list changes one item per write: here, one added.
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "종류", null, "list", 2, { add: "세미나" }));
  });

  it("picks the stage from the app's own menu", async () => {
    const { api } = setup();
    fireEvent.click(within(await blockOf()).getByRole("button", { name: STAGE }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "완료" }));
    await waitFor(() => expect(api.setProjectStage).toHaveBeenCalledWith("w", "완료", 2));
  });

  it("offers a template field's own options (\"높음 · 보통 · 낮음\") in its empty row", async () => {
    const { api } = setup(pageOf({}, [...ROWS.filter((entry) => entry.key !== "중요도"), row("중요도", "text", null, { fromTemplate: true, hint: "높음 · 보통 · 낮음" })]));
    fireEvent.click(within(await blockOf()).getByRole("button", { name: "중요도: 비어 있음 — 고치기" }));
    const options = await screen.findAllByRole("option");
    expect(options.slice(0, 3).map((option) => option.textContent)).toEqual(["높음", "보통", "낮음"]);
    fireEvent.click(screen.getByRole("option", { name: "보통" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "중요도", ["보통"], "text", 2));
  });

  it("adds a new property by name, then its kind (+ 속성 추가), and opens its field in a new row after the note's keys", async () => {
    const { api } = setup();
    const block = await blockOf();
    fireEvent.click(within(block).getByRole("button", { name: "속성 추가" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "속성 추가 찾기" }), { target: { value: "회차" } });
    fireEvent.click(await screen.findByRole("option", { name: /「회차」 새 속성/ }));
    fireEvent.click(await screen.findByRole("option", { name: /숫자/ }));
    expect(api.setPropertyType).toHaveBeenCalledWith("회차", "number");
    const field = await screen.findByRole("textbox", { name: "회차" });
    // Where it will be once written: after the note's keys, before the app's own.
    expect(within(block).getAllByRole("term").map((term) => term.textContent)).toEqual(["단계", "태그", "마감일", "중요도", "종류", "목표", "시작일", "회차", "workbench_id"]);
    expect(field.closest(".pn-prop")?.getAttribute("data-key")).toBe("회차");
    fireEvent.change(field, { target: { value: "3" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "회차", ["3"], "number", 2));
  });

  it("fills an empty template field in its own row", async () => {
    const { api } = setup();
    fireEvent.click(within(await blockOf()).getByRole("button", { name: "시작일: 비어 있음 — 고치기" }));
    const field = await screen.findByRole("textbox", { name: "시작일" });
    expect(field.closest(".pn-prop")?.getAttribute("data-key")).toBe("시작일");
    fireEvent.change(field, { target: { value: "오늘" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "시작일", ["오늘"], "date", 2));
  });
});

// Review round 2.
describe("nothing typed is lost, nothing outside is overwritten", () => {
  it("asks before resuming a kept draft when the note changed since it was started", async () => {
    const first = setup();
    fireEvent.click(await screen.findByText("슬라이드를 다시 짠다."));
    typeInto("내 초안 줄\n");
    await act(async () => { await new Promise((done) => setTimeout(done, 400)); });
    first.view.unmount();
    const changed = pageOf({ ...fileNote(`${FM}\n- Obsidian에서 고친 줄.\n\n${SECTIONS}`), revision: 3, lastAuthor: "external" });
    const { api } = setup(changed);
    const offer = await screen.findByText(/저장하지 않은 노트 편집이 남아 있습니다/);
    fireEvent.click(within(offer.closest<HTMLElement>(".pn-recovery")!).getByRole("button", { name: "이어서 고치기" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("노트를 바꿨습니다");
    expect(runText()).toBe(`${FREE}내 초안 줄\n`);
    // Nothing is written until the person chooses.
    keyOnEditor("Enter", { ctrlKey: true });
    fireEvent.focusOut(editorOf().contentDOM, { relatedTarget: screen.getByRole("button", { name: "프로젝트 메뉴" }) });
    await act(async () => { await new Promise((done) => setTimeout(done, 50)); });
    expect(api.setProjectRun).not.toHaveBeenCalled();
    fireEvent.click(within(alert).getByRole("button", { name: "내 것으로 쓰기" }));
    await waitFor(() => expect(api.setProjectRun).toHaveBeenCalledWith("w", expect.objectContaining({ expected: "\n- Obsidian에서 고친 줄.\n\n", text: `${FREE}내 초안 줄\n` }), 3));
  });

  it("sends the revision the person saw with a property, and asks when the same key changed meanwhile", async () => {
    const { api } = setup();
    // (The note is the changed one from the moment the write is refused, not before: the page's own re-read must not show it early.)
    api.setProjectProperty.mockImplementationOnce(async () => {
      api.project.mockImplementation(async () => pageOf({ revision: 3 }, ROWS.map((entry) => (entry.key === "마감일" ? { ...entry, values: ["2026-12-01"] } : entry))));
      throw new ApiRequestError(409, { code: "note_changed", message: "그 사이 「마감일」이 2026-12-01로 바뀌었습니다." });
    });
    fireEvent.click(await screen.findByRole("button", { name: /^마감일: / }));
    const field = screen.getByRole("textbox", { name: "마감일" });
    fireEvent.change(field, { target: { value: "11월 27일" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "마감일", ["11월 27일"], "date", 2));
    const conflict = await screen.findByRole("alert", { name: "속성 충돌" });
    expect(conflict.textContent).toContain("2026-12-01");
    expect(conflict.textContent).toContain("11월 27일");
    expect((screen.getByRole("textbox", { name: "마감일" }) as HTMLInputElement).value).toBe("11월 27일");
    fireEvent.click(within(conflict).getByRole("button", { name: "내 것으로 쓰기" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenLastCalledWith("w", "마감일", ["11월 27일"], "date", 3));
  });

  it("asks about a key conflict in one band with boxed buttons under the rows, never inside a row", async () => {
    const { api } = setup();
    api.setProjectProperty.mockRejectedValueOnce(new ApiRequestError(409, { code: "note_changed", message: "그 사이 「마감일」이 2026-12-01로 바뀌었습니다." }));
    fireEvent.click(await screen.findByRole("button", { name: /^마감일: / }));
    const field = screen.getByRole("textbox", { name: "마감일" });
    fireEvent.change(field, { target: { value: "11월 27일" } });
    fireEvent.keyDown(field, { key: "Enter" });
    const conflict = await screen.findByRole("alert", { name: "속성 충돌" });
    const block = await blockOf();
    expect(block.contains(conflict)).toBe(true);
    const rows = block.querySelector("dl")!;
    expect(within(rows).queryByRole("alert")).toBeNull();
    expect(rows.querySelector(".pn-field-problem")).toBeNull();
    expect(screen.getByRole("group", { name: "현황" }).contains(conflict)).toBe(false);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    for (const name of ["내 것으로 쓰기", "저쪽 것 받기"]) expect(within(conflict).getByRole("button", { name }).classList.contains("button")).toBe(true);
    expect(conflict.classList.contains("pn-band")).toBe(true);
  });

  it("shows both sides of a key conflict the way the page shows that property", async () => {
    const { api } = setup();
    // (The note is the changed one from the moment the write is refused, not before: the page's own re-read must not show it early.)
    api.setProjectProperty.mockImplementationOnce(async () => {
      api.project.mockImplementation(async () => pageOf({ revision: 3 }, ROWS.map((entry) => (entry.key === "마감일" ? { ...entry, values: ["2026-12-01"] } : entry))));
      throw new ApiRequestError(409, { code: "note_changed", message: "그 사이 「마감일」이 바뀌었습니다." });
    });
    fireEvent.click(await screen.findByRole("button", { name: /^마감일: / }));
    const field = screen.getByRole("textbox", { name: "마감일" });
    fireEvent.change(field, { target: { value: "2026-11-27" } });
    fireEvent.keyDown(field, { key: "Enter" });
    const conflict = await screen.findByRole("alert", { name: "속성 충돌" });
    expect(conflict.textContent).toContain("저쪽: 12월 1일");
    expect(conflict.textContent).toContain("내 것: 11월 27일");
    expect(conflict.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // What is sent is what was typed.
    fireEvent.click(within(conflict).getByRole("button", { name: "내 것으로 쓰기" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenLastCalledWith("w", "마감일", ["2026-11-27"], "date", 3));
  });

  it("고치기 goes to the field of its own page, not to the same field of the note open in another pane", async () => {
    const { api } = setup();
    // The same note in another pane, earlier in the document: its field for the same key.
    const other = document.createElement("div");
    other.innerHTML = '<section class="pn-props"><dl><div class="pn-prop" data-key="마감일"><dd><input aria-label="다른 칸의 마감일" /></dd></div></dl></section>';
    document.body.prepend(other);
    try {
      api.setProjectProperty.mockRejectedValueOnce(new ApiRequestError(400, { code: "bad_date", message: "날짜로 읽지 못했습니다. 예: 11월 20일, 내일, 다음 주 금요일" }));
      fireEvent.click(await screen.findByRole("button", { name: /^마감일: / }));
      const field = screen.getByRole("textbox", { name: "마감일" }) as HTMLInputElement;
      fireEvent.change(field, { target: { value: "언젠가" } });
      fireEvent.keyDown(field, { key: "Enter" });
      const band = (await screen.findByRole("alert")).closest<HTMLElement>(".pn-band")!;
      field.blur();
      fireEvent.click(within(band).getByRole("button", { name: "마감일 고치기" }));
      expect(document.activeElement).toBe(field);
    } finally { other.remove(); }
  });

  it("says why a value was refused in the band under the rows, with 고치기 and 버리기, never inside the row", async () => {
    const { api } = setup();
    api.setProjectProperty.mockRejectedValueOnce(new ApiRequestError(400, { code: "bad_date", message: "날짜로 읽지 못했습니다. 예: 11월 20일, 내일, 다음 주 금요일" }));
    fireEvent.click(await screen.findByRole("button", { name: /^마감일: / }));
    const field = screen.getByRole("textbox", { name: "마감일" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "언젠가" } });
    fireEvent.keyDown(field, { key: "Enter" });
    const reason = await screen.findByRole("alert");
    const block = await blockOf();
    expect(block.contains(reason)).toBe(true);
    // The row keeps its height: nothing but the field in the cell.
    expect(block.querySelector(".pn-prop .pn-field-problem")).toBeNull();
    expect(within(block.querySelector("dl")!).queryByRole("alert")).toBeNull();
    expect(field.closest(".pn-prop")?.getAttribute("data-key")).toBe("마감일");
    const band = reason.closest(".pn-band")!;
    expect(band).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(within(band as HTMLElement).getByRole("button", { name: "마감일 고치기" }));
    expect(document.activeElement).toBe(field);
    fireEvent.click(within(band as HTMLElement).getByRole("button", { name: "마감일 버리기" }));
    expect(screen.queryByRole("textbox", { name: "마감일" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(readField("w", "prop:마감일")).toBeNull();
  });

  it("does not send a refused value again when the field merely loses focus (taking the other side)", async () => {
    const { api } = setup();
    api.setProjectProperty.mockRejectedValueOnce(new ApiRequestError(409, { code: "note_changed", message: "그 사이 「마감일」이 2026-12-01로 바뀌었습니다." }));
    fireEvent.click(await screen.findByRole("button", { name: /^마감일: / }));
    const field = screen.getByRole("textbox", { name: "마감일" });
    fireEvent.change(field, { target: { value: "11월 27일" } });
    fireEvent.keyDown(field, { key: "Enter" });
    const conflict = await screen.findByRole("alert", { name: "속성 충돌" });
    const take = within(conflict).getByRole("button", { name: "저쪽 것 받기" });
    fireEvent.blur(field, { relatedTarget: take });
    fireEvent.click(take);
    await waitFor(() => expect(screen.queryByRole("alert", { name: "속성 충돌" })).toBeNull());
    expect(api.setProjectProperty).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "마감일" })).toBeNull();
  });

  it("keeps a typed decision on blur, saves it on Enter, keeps it with the reason when refused", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "+ 결정" }));
    const field = screen.getByRole("textbox", { name: "정한 것 (Enter)" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "길게 쓴 결정 문장" } });
    fireEvent.blur(field);
    expect((screen.getByRole("textbox", { name: "정한 것 (Enter)" }) as HTMLInputElement).value).toBe("길게 쓴 결정 문장");
    expect(api.addProjectEntry).not.toHaveBeenCalled();
    api.addProjectEntry.mockRejectedValueOnce(new ApiRequestError(409, { code: "note_unreadable", message: "노트의 속성 부분이 망가져 있어 고치지 않았습니다." }));
    fireEvent.keyDown(field, { key: "Enter" });
    expect((await screen.findByRole("alert", { name: "결정 남기기" })).textContent).toContain("망가져");
    expect((screen.getByRole("textbox", { name: "정한 것 (Enter)" }) as HTMLInputElement).value).toBe("길게 쓴 결정 문장");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.addProjectEntry).toHaveBeenLastCalledWith("w", { section: "decision", text: "길게 쓴 결정 문장", baseRevision: 2 }));
  });

  it("drops a typed decision on Esc only with a 되살리기 notice", async () => {
    const { onToast } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "+ 결정" }));
    const field = screen.getByRole("textbox", { name: "정한 것 (Enter)" });
    fireEvent.change(field, { target: { value: "버릴 결정" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "정한 것 (Enter)" })).toBeNull();
    const notice = onToast.mock.calls.at(-1)![0];
    expect(notice.action.label).toBe("되살리기");
    act(() => notice.action.run());
    expect((screen.getByRole("textbox", { name: "정한 것 (Enter)" }) as HTMLInputElement).value).toBe("버릴 결정");
  });

  it("does not offer + 결정 / + 질문 on a note whose properties do not read", async () => {
    const broken = `---\nworkbench_id: w\n종류: [강의\n---\n${BODY}`;
    const page = pageOf({ ...fileNote(broken), problem: "속성(YAML)을 읽을 수 없습니다: 3번째 줄을 YAML로 읽지 못했습니다", revision: 4 });
    page.lastReadable = { revision: 3, author: "external", sessionId: null, at: Date.now(), rows: [row("종류", "list", ["강의"])], text: `${FM}${BODY}`, current: broken };
    setup(page);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "+ 결정" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ 질문" })).toBeNull();
    expect(screen.getByText(/고치거나 되돌린 뒤에/)).toBeTruthy();
  });
});

// Review round 3.
describe("one writer, one base, and no typed text dropped", () => {
  it("sends two quick ticks one after the other, the second against the revision the first returned", async () => {
    const { api } = setup();
    let finish: (value: ProjectWrite) => void = () => undefined;
    const tagged = (values: string[], revision: number): ProjectWrite => ({ token: "t", created: false, summary: "tags", page: pageOf({ revision }, ROWS.map((entry) => (entry.key === "tags" ? { ...entry, values } : entry))) });
    api.setProjectProperty.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    api.setProjectProperty.mockImplementationOnce(async () => tagged(["강의", "가", "나"], 4));
    await blockOf();
    fireEvent.click(within(chipsOf()).getByRole("button", { name: TAGS }));
    const search = await screen.findByRole("combobox", { name: "태그 찾기" });
    fireEvent.change(search, { target: { value: "가" } });
    fireEvent.click(await screen.findByRole("option", { name: /#가 추가/ }));
    fireEvent.change(search, { target: { value: "나" } });
    fireEvent.click(await screen.findByRole("option", { name: /#나 추가/ }));
    expect(api.setProjectProperty).toHaveBeenCalledTimes(1);
    expect(api.setProjectProperty).toHaveBeenLastCalledWith("w", "tags", null, "tags", 2, { add: "가" });
    await act(async () => finish(tagged(["강의", "가"], 3)));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledTimes(2));
    expect(api.setProjectProperty).toHaveBeenLastCalledWith("w", "tags", null, "tags", 3, { add: "나" });
  });

  it("keeps a decision's text when + 질문 is opened, both fields holding their own", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "+ 결정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "정한 것 (Enter)" }), { target: { value: "결정 문장" } });
    fireEvent.click(screen.getByRole("button", { name: "+ 질문" }));
    fireEvent.change(screen.getByRole("textbox", { name: "열린 질문 (Enter)" }), { target: { value: "질문 문장" } });
    expect((screen.getByRole("textbox", { name: "정한 것 (Enter)" }) as HTMLInputElement).value).toBe("결정 문장");
    expect((screen.getByRole("textbox", { name: "열린 질문 (Enter)" }) as HTMLInputElement).value).toBe("질문 문장");
  });

  it("restores typed decisions, questions and property values into their fields after the page is gone (reload, tab, pane)", async () => {
    const first = setup();
    fireEvent.click(await screen.findByRole("button", { name: "+ 결정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "정한 것 (Enter)" }), { target: { value: "남을 결정" } });
    fireEvent.click(screen.getByRole("button", { name: "+ 질문" }));
    fireEvent.change(screen.getByRole("textbox", { name: "열린 질문 (Enter)" }), { target: { value: "남을 질문" } });
    fireEvent.click(screen.getByRole("button", { name: /^중요도: 높음/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "중요도" }), { target: { value: "보통이 아님" } });
    first.view.unmount();
    setup();
    expect(((await screen.findByRole("textbox", { name: "정한 것 (Enter)" })) as HTMLInputElement).value).toBe("남을 결정");
    expect((screen.getByRole("textbox", { name: "열린 질문 (Enter)" }) as HTMLInputElement).value).toBe("남을 질문");
    expect((screen.getByRole("textbox", { name: "중요도" }) as HTMLInputElement).value).toBe("보통이 아님");
  });

  it("keeps text typed while a decision is being written, removing only what was written", async () => {
    const { api } = setup();
    let finish: (value: ProjectWrite) => void = () => undefined;
    api.addProjectEntry.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(await screen.findByRole("button", { name: "+ 결정" }));
    const field = screen.getByRole("textbox", { name: "정한 것 (Enter)" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "첫 결정" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.change(field, { target: { value: "첫 결정 그리고 더 쓴 말" } });
    await waitFor(() => expect(api.addProjectEntry).toHaveBeenCalled());
    await act(async () => finish({ token: "t", created: false, summary: "결정", page: pageOf({ revision: 3 }) }));
    expect((screen.getByRole("textbox", { name: "정한 것 (Enter)" }) as HTMLInputElement).value).toBe("그리고 더 쓴 말");
  });

  it("offers only the revert on a note whose properties do not read", async () => {
    const broken = `---\nworkbench_id: w\n종류: [강의\n---\n${BODY}`;
    const page = pageOf({ ...fileNote(broken), problem: "속성(YAML)을 읽을 수 없습니다: 3번째 줄을 YAML로 읽지 못했습니다", revision: 4 });
    page.lastReadable = { revision: 3, author: "external", sessionId: null, at: Date.now(), rows: [row("종류", "list", ["강의"])], text: `${FM}${BODY}`, current: broken };
    const { openMenu } = setup(page);
    const alert = await screen.findByRole("alert");
    expect(within(alert).queryByRole("button", { name: "원문 전체" })).toBeNull();
    expect(within(alert).getByRole("button", { name: "r3로 되돌리기" })).toBeTruthy();
    // The readable revision's values are shown, not offered for writing.
    expect(screen.queryByRole("button", { name: /^종류: 강의/ })).toBeNull();
    fireEvent.click(screen.getByText("슬라이드를 다시 짠다."));
    expect(document.querySelector(".pn-body-edit")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 메뉴" }));
    const items = openMenu.mock.calls.at(-1)![0].items as { label?: string }[];
    expect(items.some((item) => item.label === "원문 전체" || item.label === "노트 고치기")).toBe(false);
  });

  it("sends the revision shown with the engine-edit 되돌리기 and with the notice's undo", async () => {
    const { api, onToast } = setup(pageOf({ lastAuthor: "engine", revision: 5 }));
    fireEvent.click(within(await screen.findByRole("status")).getByRole("button", { name: "되돌리기" }));
    await waitFor(() => expect(api.revertProjectNote).toHaveBeenCalledWith("w", 5));
    const notice = onToast.mock.calls.at(-1)![0];
    notice.action.run();
    await waitFor(() => expect(api.undoProject).toHaveBeenCalledWith("w", "tok", 5));
  });
});

// Review round 4.
const changedRows = (key: string, patch: Partial<PropertyRow>) => ROWS.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry));
const stale = () => new ApiRequestError(409, { code: "note_changed", message: "그 사이 노트가 바뀌거나 삭제되었습니다. 내 편집은 유지했습니다. 최신 노트를 확인해 주세요." });
const tick = () => act(async () => { await new Promise((done) => setTimeout(done, 20)); });
/** Whatever fields are on the page now are left and entered: none of it may reach another note. */
const pokeEveryField = () => {
  for (const field of screen.queryAllByRole("textbox")) {
    fireEvent.blur(field);
    fireEvent.keyDown(field, { key: "Enter" });
  }
};

describe("what is typed stays with the note it was typed for (K1)", () => {
  it("does not carry an open property field into another project shown in the same place", async () => {
    const { api, show } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /^중요도: 높음/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "중요도" }), { target: { value: "A의 값" } });
    show("x");
    await screen.findByRole("heading", { name: "다른 프로젝트" });
    // The other note shows its own value as a value: no field, none of the first note's text.
    await screen.findByRole("button", { name: /^중요도: 높음/ });
    expect(screen.queryByRole("textbox", { name: "중요도" })).toBeNull();
    expect(screen.queryByDisplayValue("A의 값")).toBeNull();
    expect(document.body.textContent).not.toContain("A의 값");
    pokeEveryField();
    await tick();
    expect(api.setProjectProperty).not.toHaveBeenCalled();
    expect(readField("w", "prop:중요도")).toEqual({ text: "A의 값", baseRevision: 2 });
    expect(readField("x", "prop:중요도")).toBeNull();
    // Back on its own note the field holds it again, and writes it there from the revision it was typed at.
    show("w");
    const field = (await screen.findByRole("textbox", { name: "중요도" })) as HTMLInputElement;
    expect(field.value).toBe("A의 값");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "중요도", ["A의 값"], "text", 2));
    expect(api.setProjectProperty).toHaveBeenCalledTimes(1);
  });

  it("does not carry a typed + 결정 into another project shown in the same place", async () => {
    const { api, show } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "+ 결정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "정한 것 (Enter)" }), { target: { value: "A의 결정" } });
    show("x");
    await screen.findByRole("heading", { name: "다른 프로젝트" });
    await screen.findByRole("button", { name: "+ 결정" });
    expect(screen.queryByRole("textbox", { name: "정한 것 (Enter)" })).toBeNull();
    expect(document.body.textContent).not.toContain("A의 결정");
    pokeEveryField();
    await tick();
    expect(api.addProjectEntry).not.toHaveBeenCalled();
    expect(readField("w", "add:decision")).toEqual({ text: "A의 결정", baseRevision: 2 });
    expect(readField("x", "add:decision")).toBeNull();
    show("w");
    expect(((await screen.findByRole("textbox", { name: "정한 것 (Enter)" })) as HTMLInputElement).value).toBe("A의 결정");
  });

  it("does not send a line still waiting its turn once the page shows another project; the line stays kept for its note", async () => {
    const { api, show } = setup(pageOf({ questions: [{ line: 9, text: "언제?", done: false }] }));
    let finish: (value: ProjectWrite) => void = () => undefined;
    api.setProjectQuestion.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "닫기" }));
    await waitFor(() => expect(api.setProjectQuestion).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "+ 결정" }));
    const field = screen.getByRole("textbox", { name: "정한 것 (Enter)" });
    fireEvent.change(field, { target: { value: "기다리던 결정" } });
    fireEvent.keyDown(field, { key: "Enter" });
    show("x");
    await screen.findByRole("heading", { name: "다른 프로젝트" });
    await act(async () => finish({ token: "t", created: false, summary: "열린 질문 닫음", page: pageOf({ revision: 3 }) }));
    await tick();
    expect(api.addProjectEntry).not.toHaveBeenCalled();
    expect(readField("w", "add:decision")).toEqual({ text: "기다리던 결정", baseRevision: 2 });
  });

  it("still undoes a write from its notice after the page went on to another project (the notice names its write)", async () => {
    const { api, onToast, show } = setup();
    await blockOf();
    fireEvent.click(within(chipsOf()).getByRole("button", { name: STAGE }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "완료" }));
    await waitFor(() => expect(onToast.mock.calls.at(-1)?.[0].action?.label).toBe("되돌리기"));
    const notice = onToast.mock.calls.at(-1)![0];
    show("x");
    await screen.findByRole("heading", { name: "다른 프로젝트" });
    notice.action.run();
    await waitFor(() => expect(api.undoProject).toHaveBeenCalledWith("w", "tok", 2));
  });

  it("binds a field to the note it was opened on: its text and its write stay with that note", async () => {
    const onCommit = vi.fn(async () => ({ revision: 3 }));
    const field = (note: string) => <LineInput note={note} field="prop:중요도" initial="높음" label="중요도" revision={2} onCommit={onCommit} onClose={() => undefined} />;
    const view = render(field("a"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A의" } });
    // The same field is handed another note's name: it is still the first note's field.
    view.rerender(field("b"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A의 값" } });
    expect(readField("a", "prop:중요도")).toEqual({ text: "A의 값", baseRevision: 2 });
    expect(readField("b", "prop:중요도")).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("A의 값", 2, "a"));
  });
});

describe("an add line is bound to the note it was opened on (K1)", () => {
  it("keeps its text under that note and writes it there, whatever note it is handed later", async () => {
    const onAdd = vi.fn(async () => ({ revision: 3 }));
    const line = (note: string) => <AddInput note={note} field="add:decision" revision={2} placeholder="정한 것 (Enter)" label="결정 남기기" onAdd={onAdd} onDiscard={() => undefined} onClose={() => undefined} />;
    const view = render(line("a"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A의" } });
    view.rerender(line("b"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A의 결정" } });
    expect(readField("a", "add:decision")).toEqual({ text: "A의 결정", baseRevision: 2 });
    expect(readField("b", "add:decision")).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("A의 결정", 2, "a"));
    await waitFor(() => expect(readField("a", "add:decision")).toBeNull());
  });
});

describe("a kept draft is written from the revision it was typed at (I1)", () => {
  it("asks about a note changed since a property was typed, instead of writing over the change", async () => {
    const first = setup();
    fireEvent.click(await screen.findByRole("button", { name: /^중요도: 높음/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "중요도" }), { target: { value: "내 값" } });
    first.view.unmount();
    // Meanwhile Obsidian set 중요도 to 낮음 (r5); the person never saw it.
    const { api } = setup(pageOf({ revision: 5, lastAuthor: "external" }, changedRows("중요도", { values: ["낮음"] })));
    const field = (await screen.findByRole("textbox", { name: "중요도" })) as HTMLInputElement;
    expect(field.value).toBe("내 값");
    api.setProjectProperty.mockRejectedValueOnce(stale());
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "중요도", ["내 값"], "text", 2));
    const conflict = await screen.findByRole("alert", { name: "속성 충돌" });
    expect(conflict.textContent).toContain("낮음");
    expect(conflict.textContent).toContain("내 값");
    expect(api.setProjectProperty).toHaveBeenCalledTimes(1);
    // The person's answer is a new write over the revision now shown; nothing stays kept after it.
    fireEvent.click(within(conflict).getByRole("button", { name: "내 것으로 쓰기" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenLastCalledWith("w", "중요도", ["내 값"], "text", 5));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "중요도" })).toBeNull());
    expect(readField("w", "prop:중요도")).toBeNull();
  });

  it("takes the other side of a property conflict: the field closes and the typed value can come back", async () => {
    const { api, onToast } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /^중요도: 높음/ }));
    const field = screen.getByRole("textbox", { name: "중요도" });
    fireEvent.change(field, { target: { value: "내 값" } });
    api.setProjectProperty.mockRejectedValueOnce(stale());
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.click(within(await screen.findByRole("alert", { name: "속성 충돌" })).getByRole("button", { name: "저쪽 것 받기" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "중요도" })).toBeNull());
    expect(readField("w", "prop:중요도")).toBeNull();
    const notice = onToast.mock.calls.at(-1)![0];
    expect(notice.action.label).toBe("되살리기");
    act(() => notice.action.run());
    expect(((await screen.findByRole("textbox", { name: "중요도" })) as HTMLInputElement).value).toBe("내 값");
    expect(readField("w", "prop:중요도")).toEqual({ text: "내 값", baseRevision: 2 });
  });

  it("asks about each refused property on a line of its own: a second question does not replace the first", async () => {
    keepField("w", "prop:마감일", { text: "11월 27일", baseRevision: 2 });
    keepField("w", "prop:목표", { text: "새 목표", baseRevision: 2 });
    const { api } = setup(pageOf({ revision: 5, lastAuthor: "external" }));
    api.setProjectProperty.mockRejectedValueOnce(stale());
    api.setProjectProperty.mockRejectedValueOnce(stale());
    fireEvent.keyDown(await screen.findByRole("textbox", { name: "마감일" }), { key: "Enter" });
    await screen.findByRole("alert", { name: "속성 충돌" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "목표" }), { key: "Enter" });
    await waitFor(() => expect(screen.getAllByRole("alert", { name: "속성 충돌" })).toHaveLength(2));
    const [first, second] = screen.getAllByRole("alert", { name: "속성 충돌" });
    // Each line says which property it is about.
    expect(first!.textContent).toMatch(/^마감일 · .*11월 27일/);
    expect(second!.textContent).toMatch(/^목표 · .*새 목표/);
    // Each is answered by itself.
    fireEvent.click(within(first!).getByRole("button", { name: "저쪽 것 받기" }));
    await waitFor(() => expect(screen.getAllByRole("alert", { name: "속성 충돌" })).toHaveLength(1));
    expect(screen.getByRole("alert", { name: "속성 충돌" }).textContent).toContain("새 목표");
    expect(readField("w", "prop:목표")).toEqual({ text: "새 목표", baseRevision: 2 });
    fireEvent.click(within(screen.getByRole("alert", { name: "속성 충돌" })).getByRole("button", { name: "내 것으로 쓰기" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenLastCalledWith("w", "목표", ["새 목표"], "text", 5));
    await waitFor(() => expect(screen.queryByRole("alert", { name: "속성 충돌" })).toBeNull());
  });

  it("sends a kept + 결정 from the revision it was typed at; once the changed note is shown, Enter sends it from that one", async () => {
    const first = setup();
    fireEvent.click(await screen.findByRole("button", { name: "+ 결정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "정한 것 (Enter)" }), { target: { value: "남긴 결정" } });
    first.view.unmount();
    const { api } = setup(pageOf({ revision: 5, lastAuthor: "external" }));
    const field = (await screen.findByRole("textbox", { name: "정한 것 (Enter)" })) as HTMLInputElement;
    expect(field.value).toBe("남긴 결정");
    api.addProjectEntry.mockRejectedValueOnce(stale());
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.addProjectEntry).toHaveBeenCalledWith("w", { section: "decision", text: "남긴 결정", baseRevision: 2 }));
    expect((await screen.findByRole("alert", { name: "결정 남기기" })).textContent).toContain("그 사이 노트가 바뀌었습니다");
    expect((screen.getByRole("textbox", { name: "정한 것 (Enter)" }) as HTMLInputElement).value).toBe("남긴 결정");
    expect(readField("w", "add:decision")).toEqual({ text: "남긴 결정", baseRevision: 5 });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.addProjectEntry).toHaveBeenLastCalledWith("w", { section: "decision", text: "남긴 결정", baseRevision: 5 }));
  });
});

describe("property text typed while its write is on its way (I2)", () => {
  it("stays in the open field, kept from the revision that write made", async () => {
    const { api } = setup();
    let finish: (value: ProjectWrite) => void = () => undefined;
    api.setProjectProperty.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(await screen.findByRole("button", { name: /^중요도: 높음/ }));
    const field = screen.getByRole("textbox", { name: "중요도" });
    fireEvent.change(field, { target: { value: "보통" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("textbox", { name: "중요도" }), { target: { value: "보통 그리고 더" } });
    await act(async () => finish({ token: "t", created: false, summary: "중요도: 높음 → 보통", page: pageOf({ revision: 3 }, changedRows("중요도", { values: ["보통"] })) }));
    const still = screen.getByRole("textbox", { name: "중요도" }) as HTMLInputElement;
    expect(still.value).toBe("보통 그리고 더");
    expect(readField("w", "prop:중요도")).toEqual({ text: "보통 그리고 더", baseRevision: 3 });
    fireEvent.keyDown(still, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenLastCalledWith("w", "중요도", ["보통 그리고 더"], "text", 3));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "중요도" })).toBeNull());
    expect(readField("w", "prop:중요도")).toBeNull();
  });
});

describe("nothing kept is out of sight (I3)", () => {
  const addNewKey = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "속성 추가" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "속성 추가 찾기" }), { target: { value: "새키" } });
    fireEvent.click(await screen.findByRole("option", { name: /「새키」 새 속성/ }));
    fireEvent.click(await screen.findByRole("option", { name: /텍스트/ }));
    fireEvent.change(await screen.findByRole("textbox", { name: "새키" }), { target: { value: "새 값 타이핑" } });
  };

  it("shows a + 속성 value typed before a reload as a row to write or put away, written from the revision it was typed at", async () => {
    const first = setup();
    await addNewKey();
    first.view.unmount();
    const { api, onToast } = setup();
    const block = await blockOf();
    expect(within(block).getByText("쓰다 만 속성 · 새키")).toBeTruthy();
    // A kept draft sits under the rows, not as one of them.
    expect(within(block).getByText("쓰다 만 속성 · 새키").closest(".pn-prop")).toBeNull();
    expect(within(block.querySelector("dl")!).queryByText("새 값 타이핑")).toBeNull();
    expect(within(block).getByText("새 값 타이핑")).toBeTruthy();
    // 버리기 puts it away behind a notice that brings it back.
    fireEvent.click(screen.getByRole("button", { name: "새키 버리기" }));
    expect(screen.queryByText("쓰다 만 속성 · 새키")).toBeNull();
    expect(readField("w", "prop:새키")).toBeNull();
    act(() => onToast.mock.calls.at(-1)![0].action.run());
    expect(screen.getByText("쓰다 만 속성 · 새키")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "새키 쓰기" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "새키", ["새 값 타이핑"], "text", 2));
    await waitFor(() => expect(screen.queryByText("쓰다 만 속성 · 새키")).toBeNull());
    expect(readField("w", "prop:새키")).toBeNull();
  });

  it("asks before a kept row is written over a note that changed since it was typed", async () => {
    const first = setup();
    await addNewKey();
    first.view.unmount();
    const { api } = setup(pageOf({ revision: 5, lastAuthor: "external" }));
    api.setProjectProperty.mockRejectedValueOnce(stale());
    fireEvent.click(await screen.findByRole("button", { name: "새키 쓰기" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "새키", ["새 값 타이핑"], "text", 2));
    expect((await screen.findByRole("alert", { name: "속성 충돌" })).textContent).toContain("새 값 타이핑");
    expect(screen.getByText("쓰다 만 속성 · 새키")).toBeTruthy();
    expect(readField("w", "prop:새키")).toEqual({ text: "새 값 타이핑", baseRevision: 2, added: "text" });
  });

  it("writes the first + 속성 추가 value when the person goes on to another empty row (leaving a field writes it), and the second field stays open", async () => {
    const { api } = setup();
    let finish: (value: ProjectWrite) => void = () => undefined;
    api.setProjectProperty.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await addNewKey();
    // Opening another row's field takes the focus out of the first field: its value is on its way.
    fireEvent.click(screen.getByRole("button", { name: "시작일: 비어 있음 — 고치기" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "새키", ["새 값 타이핑"], "text", 2));
    await screen.findByRole("textbox", { name: "시작일" });
    // The first field's write coming back does not close the second one.
    await act(async () => finish({ token: "t", created: false, summary: "새키", page: pageOf({ revision: 3 }, [...ROWS, row("새키", "text", ["새 값 타이핑"])]) }));
    await tick();
    expect(api.setProjectProperty).toHaveBeenCalledTimes(1);
    expect(readField("w", "prop:새키")).toBeNull();
    expect(screen.queryByText("쓰다 만 속성 · 새키")).toBeNull();
    expect(screen.getByRole("textbox", { name: "시작일" })).toBeTruthy();
  });

  it("keeps the first + 속성 추가 value in sight when its write is refused and a second + 속성 추가 takes its place", async () => {
    const { api } = setup();
    api.setProjectProperty.mockRejectedValueOnce(new ApiRequestError(400, { code: "bad_value", message: "그 값은 쓸 수 없습니다." }));
    await addNewKey();
    fireEvent.click(screen.getByRole("button", { name: "속성 추가" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "속성 추가 찾기" }), { target: { value: "둘째키" } });
    fireEvent.click(await screen.findByRole("option", { name: /「둘째키」 새 속성/ }));
    fireEvent.click(await screen.findByRole("option", { name: /텍스트/ }));
    await screen.findByRole("textbox", { name: "둘째키" });
    await tick();
    expect(api.setProjectProperty).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "새키" })).toBeNull();
    expect(screen.getByText("쓰다 만 속성 · 새키")).toBeTruthy();
    expect(screen.getByText("새 값 타이핑")).toBeTruthy();
    expect(screen.getByRole("button", { name: "새키 쓰기" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "둘째키" })).toBeTruthy();
  });

  it.each([
    ["became a multi-line or map value (not editable here)", (): PropertyRow[] => changedRows("중요도", { editable: false })],
    ["was deleted outside", (): PropertyRow[] => ROWS.filter((entry) => entry.key !== "중요도")],
  ])("shows text kept for a key that %s, to copy or put away — not to write", async (_what, rows) => {
    keepField("w", "prop:중요도", { text: "내 값", baseRevision: 2 });
    const { api } = setup(pageOf({ revision: 5 }, rows()));
    const block = await blockOf();
    expect(within(block).getByText("쓰다 만 속성 · 중요도")).toBeTruthy();
    expect(within(block).getByText("내 값")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "중요도" })).toBeNull();
    // Kept text opens nothing by itself: no picker over the page.
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "중요도 쓰기" })).toBeNull();
    expect(screen.getByRole("button", { name: "중요도 복사" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "중요도 버리기" }));
    expect(screen.queryByText("쓰다 만 속성 · 중요도")).toBeNull();
    expect(api.setProjectProperty).not.toHaveBeenCalled();
  });
});

// Fix round 1 of U34 (I1): text kept for a key is edited as text, whatever the key offers to pick.
describe("text is edited as text (U34 I1)", () => {
  const GOAL = "학생이 AI가 고친 글과 자기 글의 차이를 자기 말로 설명하게 한다.";
  const withOthers = async () => {
    const asked = loadOthers([{ properties: [{ key: "목표", type: "text", values: ["다른 프로젝트의 목표"] }, { key: "중요도", type: "text", values: ["보통"] }] }]);
    const made = setup();
    await blockOf();
    await waitFor(() => expect(asked).toHaveBeenCalled());
    await tick();
    return made;
  };

  it("edits a long text value in a text field in its row, though other projects have values for that key", async () => {
    const { api } = await withOthers();
    fireEvent.click(screen.getByRole("button", { name: /^목표: 학생이/ }));
    const field = screen.getByRole("textbox", { name: "목표" }) as HTMLInputElement;
    expect(field.value).toBe(GOAL);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(field, { target: { value: `${GOAL} 그리고 고친 이유도.` } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "목표", [`${GOAL} 그리고 고친 이유도.`], "text", 2));
    expect(api.setProjectProperty).toHaveBeenCalledTimes(1);
  });

  it("still offers other projects' values for a short one, and writes only the one the person picks", async () => {
    const { api } = await withOthers();
    fireEvent.click(screen.getByRole("button", { name: /^중요도: 높음/ }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["보통"]);
    expect(api.setProjectProperty).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "보통" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "중요도", ["보통"], "text", 2));
  });

  it("brings text kept for a long text key back into an editable field, written from the revision it was typed at", async () => {
    keepField("w", "prop:목표", { text: "쓰던 목표 문장", baseRevision: 2 });
    const { api } = await withOthers();
    const field = screen.getByRole("textbox", { name: "목표" }) as HTMLInputElement;
    expect(field.value).toBe("쓰던 목표 문장");
    expect(field.closest(".pn-prop")?.getAttribute("data-key")).toBe("목표");
    expect(screen.queryByText("쓰다 만 속성 · 목표")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(field, { target: { value: "쓰던 목표 문장을 마저 씀" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "목표", ["쓰던 목표 문장을 마저 씀"], "text", 2));
  });

  it("brings text kept for a short key that offers values to pick back into an editable field too; nothing is picked or written by itself", async () => {
    keepField("w", "prop:중요도", { text: "내 값", baseRevision: 2 });
    const { api, onToast } = await withOthers();
    const field = screen.getByRole("textbox", { name: "중요도" }) as HTMLInputElement;
    expect(field.value).toBe("내 값");
    expect(screen.queryByText("쓰다 만 속성 · 중요도")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(api.setProjectProperty).not.toHaveBeenCalled();
    // Put away, the row offers its values to pick again; the text comes back from the notice.
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "중요도" })).toBeNull();
    expect(screen.getByRole("button", { name: /^중요도: 높음/ })).toBeTruthy();
    act(() => onToast.mock.calls.at(-1)![0].action.run());
    expect((screen.getByRole("textbox", { name: "중요도" }) as HTMLInputElement).value).toBe("내 값");
    expect(api.setProjectProperty).not.toHaveBeenCalled();
  });

  it("does the same when the template gives the key options after the text was typed", async () => {
    keepField("w", "prop:중요도", { text: "내 값", baseRevision: 2 });
    const { api } = setup(pageOf({ revision: 5 }, changedRows("중요도", { hint: "높음 · 보통 · 낮음" })));
    const field = (await screen.findByRole("textbox", { name: "중요도" })) as HTMLInputElement;
    expect(field.value).toBe("내 값");
    expect(screen.queryByText("쓰다 만 속성 · 중요도")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    api.setProjectProperty.mockRejectedValueOnce(stale());
    fireEvent.keyDown(field, { key: "Enter" });
    // Written from the revision it was typed at: the note changed since (r5), so it is asked.
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "중요도", ["내 값"], "text", 2));
    expect((await screen.findByRole("alert", { name: "속성 충돌" })).textContent).toContain("내 것: 내 값");
  });
});

// Fix round 1 of U34 (I2): the app's own key is read from the front matter only, and only shown.
describe("the app's own key (U34 I2)", () => {
  const read = (source: string, body: string) => machineRow({ source, body })?.values?.[0] ?? null;

  it("reads workbench_id from the front matter the gateway bounded, never from the note's words", () => {
    expect(read("---\nworkbench_id: abc\n단계: 진행중\n---\n본문\n", "본문\n")).toBe("abc");
    expect(read("\uFEFF---\r\nworkbench_id: abc\r\n---\r\n본문\r\n", "본문\r\n")).toBe("abc");
    // Closed with "...": a line of the body that looks like the key, before a later rule, is not it.
    const dots = "---\n단계: 진행중\n...\nworkbench_id: FAKE\n\n---\n";
    expect(read(dots, "workbench_id: FAKE\n\n---\n")).toBeNull();
    expect(read("---\nworkbench_id: real\n...\nworkbench_id: FAKE\n\n---\n", "workbench_id: FAKE\n\n---\n")).toBe("real");
    // An empty front matter.
    expect(read("---\n---\nworkbench_id: FAKE\n\n---\n", "workbench_id: FAKE\n\n---\n")).toBeNull();
    // No front matter at all.
    expect(read("workbench_id: FAKE\n", "workbench_id: FAKE\n")).toBeNull();
  });

  it("leaves a trailing comment and the quotes out of the value", () => {
    expect(read("---\nworkbench_id: abc # app id\n---\n", "")).toBe("abc");
    expect(read("---\nworkbench_id: \"abc\" # app id\n---\n", "")).toBe("abc");
    expect(read("---\nworkbench_id: 'abc'\n---\n", "")).toBe("abc");
    expect(read("---\n\"workbench_id\": abc\n---\n", "")).toBe("abc");
  });

  it("shows no row rather than a value it cannot be sure of", () => {
    for (const front of ["workbench_id: |\n  abc\n", "workbench_id:\n", "workbench_id: [a, b]\n", "workbench_id: a\nworkbench_id: b\n", "meta:\n  workbench_id: abc\n", "workbench_id: 'it''s'\n"]) {
      expect(machineRow({ source: `---\n${front}---\n`, body: "" })).toBeNull();
    }
    // The page was not given the note's text, or its body is not the end of it.
    expect(machineRow({ source: undefined, body: "" })).toBeNull();
    expect(machineRow({ source: "---\nworkbench_id: abc\n---\n본문\n", body: "다른 본문\n" })).toBeNull();
  });

  it("shows the key as plain text with why it is there: nothing to press, change, rename or remove", async () => {
    const { api, openMenu, onToast } = setup();
    const block = await blockOf();
    const line = block.querySelector<HTMLElement>('.pn-prop[data-key="workbench_id"]')!;
    expect(within(line).getByRole("definition").textContent).toBe("w");
    expect(within(line).queryAllByRole("button")).toEqual([]);
    expect(line.getAttribute("title")).toBe("앱이 이 노트를 알아보는 값입니다. 바꾸지 마세요.");
    fireEvent.contextMenu(line);
    expect(openMenu).not.toHaveBeenCalled();
    // Named in "+ 속성 추가": no second row, no field, the source is not opened; the page says why.
    fireEvent.click(within(block).getByRole("button", { name: "속성 추가" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "속성 추가 찾기" }), { target: { value: "workbench_id" } });
    fireEvent.click(await screen.findByRole("option", { name: /「workbench_id」 새 속성/ }));
    expect(onToast.mock.calls.at(-1)![0].text).toBe("workbench_id는 앱이 이 노트를 알아보는 값이라 바꾸지 않습니다");
    expect(block.querySelectorAll('.pn-prop[data-key="workbench_id"]')).toHaveLength(1);
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(document.querySelector(".pn-body-edit")).toBeNull();
    expect(api.setProjectProperty).not.toHaveBeenCalled();
    expect(api.setPropertyType).not.toHaveBeenCalled();
  });
});

// Fix round 1 of U34: the small ones.
describe("the block's head and names (U34 fix round 1)", () => {
  it("counts the rows it draws, a new key's row among them", async () => {
    setup();
    const block = await blockOf();
    expect(within(block).getAllByRole("term")).toHaveLength(8);
    expect(within(block).getByRole("button", { name: "속성 8" })).toBeTruthy();
    fireEvent.click(within(block).getByRole("button", { name: "속성 추가" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "속성 추가 찾기" }), { target: { value: "새키" } });
    fireEvent.click(await screen.findByRole("option", { name: /「새키」 새 속성/ }));
    fireEvent.click(await screen.findByRole("option", { name: /텍스트/ }));
    await screen.findByRole("textbox", { name: "새키" });
    expect(within(block).getAllByRole("term")).toHaveLength(9);
    expect(within(block).getByRole("button", { name: "속성 9" })).toBeTruthy();
  });

  it("gives each page's fold its own rows to control, when the same note is open in two panes", async () => {
    const { view, again } = setup();
    const other = again();
    const panes = [view.container, other.container];
    await waitFor(() => expect(panes.every((pane) => pane.querySelector(".pn-props .ui-section-toggle"))).toBe(true));
    const ids = panes.map((pane) => pane.querySelector(".pn-props .ui-section-toggle")!.getAttribute("aria-controls")!);
    expect(ids[0]).not.toBe(ids[1]);
    expect(view.container.querySelector(`[id="${ids[0]}"]`)?.querySelector("dl")).toBeTruthy();
    expect(other.container.querySelector(`[id="${ids[1]}"]`)?.querySelector("dl")).toBeTruthy();
    expect(document.querySelectorAll(`[id="${ids[0]}"]`)).toHaveLength(1);
  });

  it("says the kind icon opens a menu, and names the chip line apart from the 요약 property", async () => {
    setup(pageOf({}, [...ROWS, row("요약", "text", ["짧은 요약"])]));
    const block = await blockOf();
    expect(within(block).getByRole("button", { name: "마감일 형식: 날짜" }).getAttribute("aria-haspopup")).toBe("menu");
    expect(screen.getByRole("group", { name: "노트 한눈에" }).classList.contains("note-props")).toBe(true);
    expect(screen.queryByRole("group", { name: "요약" })).toBeNull();
  });
});

describe("one writer per note, across panes (E), and nothing sent behind a refusal", () => {
  const questions = [{ line: 9, text: "언제?", done: false }, { line: 10, text: "어디서?", done: false }];

  it("sends writes from two panes showing one note one after the other, the second from the revision the first returned", async () => {
    const first = setup(pageOf({ questions }));
    const second = first.again();
    const { api } = first;
    let finish: (value: ProjectWrite) => void = () => undefined;
    api.setProjectQuestion.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const one = await within(first.view.container).findAllByRole("checkbox", { name: "닫기" });
    const two = await within(second.container).findAllByRole("checkbox", { name: "닫기" });
    fireEvent.click(one[0]!);
    fireEvent.click(two[1]!);
    await tick();
    expect(api.setProjectQuestion).toHaveBeenCalledTimes(1);
    expect(api.setProjectQuestion).toHaveBeenLastCalledWith("w", 9, true, 2, "언제?");
    await act(async () => finish({ token: "t", created: false, summary: "열린 질문 닫음", page: pageOf({ questions, revision: 3 }) }));
    await waitFor(() => expect(api.setProjectQuestion).toHaveBeenCalledTimes(2));
    expect(api.setProjectQuestion).toHaveBeenLastCalledWith("w", 10, true, 3, "어디서?");
  });

  it("does not send a write that was waiting behind a refused one, and says so once", async () => {
    const { api, onError } = setup(pageOf({ questions }));
    let fail: (error: unknown) => void = () => undefined;
    api.setProjectQuestion.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const boxes = await screen.findAllByRole("checkbox", { name: "닫기" });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    await waitFor(() => expect(api.setProjectQuestion).toHaveBeenCalledTimes(1));
    await act(async () => fail(stale()));
    await tick();
    expect(api.setProjectQuestion).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    // What the person does next is sent again, from the note as it is shown now.
    fireEvent.click((await screen.findAllByRole("checkbox", { name: "닫기" }))[1]!);
    await waitFor(() => expect(api.setProjectQuestion).toHaveBeenCalledTimes(2));
    expect(api.setProjectQuestion).toHaveBeenLastCalledWith("w", 10, true, 2, "어디서?");
  });

  it("keeps a typed line that was waiting behind a refused write, with the reason, and does not send it", async () => {
    const { api, onError } = setup(pageOf({ questions }));
    let fail: (error: unknown) => void = () => undefined;
    api.setProjectQuestion.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    fireEvent.click((await screen.findAllByRole("checkbox", { name: "닫기" }))[0]!);
    fireEvent.click(screen.getByRole("button", { name: "+ 결정" }));
    const field = screen.getByRole("textbox", { name: "정한 것 (Enter)" });
    fireEvent.change(field, { target: { value: "기다리던 결정" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.setProjectQuestion).toHaveBeenCalledTimes(1));
    await act(async () => fail(stale()));
    expect((await screen.findByRole("alert", { name: "결정 남기기" })).textContent).toContain("보내지 않았습니다");
    expect(api.addProjectEntry).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("textbox", { name: "정한 것 (Enter)" }) as HTMLInputElement).value).toBe("기다리던 결정");
  });
});

describe("a note whose properties do not read offers only the revert (G)", () => {
  it("shows no 결정으로 / 질문으로 and no field; what was kept is shown to copy or put away", async () => {
    keepField("w", "prop:중요도", { text: "쓰던 값", baseRevision: 3 });
    keepField("w", "add:decision", { text: "쓰던 결정", baseRevision: 3 });
    const broken = `---\nworkbench_id: w\n종류: [강의\n---\n${BODY}`;
    const page = pageOf({ ...fileNote(broken), problem: "속성(YAML)을 읽을 수 없습니다: 3번째 줄을 YAML로 읽지 못했습니다", revision: 4 });
    page.lastReadable = { revision: 3, author: "external", sessionId: null, at: Date.now(), rows: [row("종류", "list", ["강의"]), row("중요도", "text", ["높음"])], text: `${FM}${BODY}`, current: broken };
    page.events = [
      { id: "request:1", at: Date.now(), kind: "request", text: "발표 순서를 정해 줘", sessionId: "s1", artifactId: null, by: "user" },
      { id: "link:1", at: Date.now(), kind: "link", text: "세션 잇기 끝", sessionId: "s1", artifactId: null, by: null },
    ] as ProjectPage["events"];
    const { api, onToast } = setup(page);
    await screen.findByText("발표 순서를 정해 줘");
    expect(screen.queryByRole("button", { name: "결정으로" })).toBeNull();
    expect(screen.queryByRole("button", { name: "질문으로" })).toBeNull();
    expect(screen.queryByRole("button", { name: "고치기" })).toBeNull();
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    // The kept property text: a row to copy or put away, not to write.
    expect(screen.getByText("쓰다 만 속성 · 중요도")).toBeTruthy();
    expect(screen.getByText("쓰던 값")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "중요도 쓰기" })).toBeNull();
    expect(screen.getByRole("button", { name: "중요도 복사" })).toBeTruthy();
    // The kept decision too.
    expect(screen.getByText("쓰던 결정")).toBeTruthy();
    expect(screen.getByRole("button", { name: "쓰다 만 결정 복사" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "쓰다 만 결정 버리기" }));
    expect(screen.queryByText("쓰던 결정")).toBeNull();
    expect(onToast.mock.calls.at(-1)![0].action.label).toBe("되살리기");
    expect(api.addProjectEntry).not.toHaveBeenCalled();
    expect(api.setProjectProperty).not.toHaveBeenCalled();
  });

  it("closes a field that was open when the note stops reading; what was typed in it is shown to copy or put away", async () => {
    const { api, setCurrent } = setup(pageOf({ questions: [{ line: 9, text: "언제?", done: false }] }));
    fireEvent.click(await screen.findByRole("button", { name: /^마감일: / }));
    fireEvent.change(screen.getByRole("textbox", { name: "마감일" }), { target: { value: "11월 27일" } });
    // The next page the gateway returns is of a note whose properties no longer read.
    const broken = `---\nworkbench_id: w\n종류: [강의\n---\n${BODY}`;
    const page = pageOf({ ...fileNote(broken), problem: "속성(YAML)을 읽을 수 없습니다: 3번째 줄을 YAML로 읽지 못했습니다", revision: 4 });
    page.lastReadable = { revision: 3, author: "external", sessionId: null, at: Date.now(), rows: ROWS, text: `${FM}${BODY}`, current: broken };
    // (The gateway reads that same note from then on: the page's own re-read, 400ms after it opens, finds it too.)
    api.setProjectQuestion.mockImplementationOnce(async () => { setCurrent(page); return { token: "", created: false, summary: "", page }; });
    fireEvent.click(screen.getByRole("checkbox", { name: "닫기" }));
    await screen.findByRole("alert");
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(screen.getByText("쓰다 만 속성 · 마감일")).toBeTruthy();
    expect(screen.getByRole("button", { name: "마감일 복사" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "마감일 쓰기" })).toBeNull();
    expect(readField("w", "prop:마감일")).toEqual({ text: "11월 27일", baseRevision: 2 });
    expect(api.setProjectProperty).not.toHaveBeenCalled();
  });

  it("offers 결정으로 on a record line of a note that reads", async () => {
    const page = pageOf();
    page.events = [{ id: "request:1", at: Date.now(), kind: "request", text: "발표 순서를 정해 줘", sessionId: "s1", artifactId: null, by: "user" }] as ProjectPage["events"];
    const { api } = setup(page);
    fireEvent.click(await screen.findByRole("button", { name: "결정으로" }));
    await waitFor(() => expect(api.addProjectEntry).toHaveBeenCalledWith("w", expect.objectContaining({ section: "decision", text: "발표 순서를 정해 줘", baseRevision: 2 })));
  });
});

// Review round 5.
describe("a conflict is answered from the revision whose value it shows (N1)", () => {
  const shows = (revision: number) => waitFor(() => expect(document.querySelector(`[data-note-revision="${revision}"]`)).not.toBeNull());

  it("asks again, on the same line, when the property changed once more before the person answered", async () => {
    const { api, setCurrent, reload } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /^중요도: 높음/ }));
    const field = screen.getByRole("textbox", { name: "중요도" });
    fireEvent.change(field, { target: { value: "내 값" } });
    // Obsidian sets 낮음 (r3): the write from r2 is refused and the line shows 낮음.
    setCurrent(pageOf({ revision: 3, lastAuthor: "external" }, changedRows("중요도", { values: ["낮음"] })));
    api.setProjectProperty.mockRejectedValueOnce(stale());
    fireEvent.keyDown(field, { key: "Enter" });
    expect((await screen.findByRole("alert", { name: "속성 충돌" })).textContent).toContain("저쪽: 낮음");
    // Obsidian sets 아주 낮음 (r4) and the page reads the note again; the line still says 낮음.
    setCurrent(pageOf({ revision: 4, lastAuthor: "external" }, changedRows("중요도", { values: ["아주 낮음"] })));
    reload();
    await shows(4);
    expect(screen.getByRole("alert", { name: "속성 충돌" }).textContent).toContain("저쪽: 낮음");
    // The answer is sent from the revision the line shows (r3): refused, nothing written, the line now shows 아주 낮음.
    api.setProjectProperty.mockRejectedValueOnce(stale());
    fireEvent.click(within(screen.getByRole("alert", { name: "속성 충돌" })).getByRole("button", { name: "내 것으로 쓰기" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenLastCalledWith("w", "중요도", ["내 값"], "text", 3));
    await waitFor(() => expect(screen.getByRole("alert", { name: "속성 충돌" }).textContent).toContain("저쪽: 아주 낮음"));
    expect(screen.getAllByRole("alert", { name: "속성 충돌" })).toHaveLength(1);
    expect(api.setProjectProperty).toHaveBeenCalledTimes(2);
    expect(readField("w", "prop:중요도")).toEqual({ text: "내 값", baseRevision: 2 });
    // Now the person has seen 아주 낮음: the answer is written over it.
    fireEvent.click(within(screen.getByRole("alert", { name: "속성 충돌" })).getByRole("button", { name: "내 것으로 쓰기" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenLastCalledWith("w", "중요도", ["내 값"], "text", 4));
    await waitFor(() => expect(screen.queryByRole("alert", { name: "속성 충돌" })).toBeNull());
    expect(api.setProjectProperty).toHaveBeenCalledTimes(3);
  });

  it("does the same for a kept row's question", async () => {
    keepField("w", "prop:새키", { text: "내 값", baseRevision: 2, added: "text" });
    const { api, setCurrent, reload } = setup(pageOf({ revision: 3, lastAuthor: "external" }));
    api.setProjectProperty.mockRejectedValueOnce(stale());
    fireEvent.click(await screen.findByRole("button", { name: "새키 쓰기" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenLastCalledWith("w", "새키", ["내 값"], "text", 2));
    expect((await screen.findByRole("alert", { name: "속성 충돌" })).textContent).toContain("저쪽: 없음");
    // Meanwhile the same key is written outside (r4).
    setCurrent(pageOf({ revision: 4, lastAuthor: "external" }, [...ROWS, row("새키", "text", ["저쪽 값"])]));
    reload();
    await shows(4);
    api.setProjectProperty.mockRejectedValueOnce(stale());
    fireEvent.click(within(screen.getByRole("alert", { name: "속성 충돌" })).getByRole("button", { name: "내 것으로 쓰기" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenLastCalledWith("w", "새키", ["내 값"], "text", 3));
    await waitFor(() => expect(screen.getByRole("alert", { name: "속성 충돌" }).textContent).toContain("저쪽: 저쪽 값"));
    expect(readField("w", "prop:새키")).toEqual({ text: "내 값", baseRevision: 2, added: "text" });
  });

  it("does the same for the body's question: 내 것으로 쓰기 is sent from the revision compared, and a newer change refreshes the question", async () => {
    const { api, setCurrent, reload } = setup();
    fireEvent.click(await screen.findByText("슬라이드를 다시 짠다."));
    typeInto("내 줄\n");
    setCurrent(pageOf({ ...fileNote(`${FM}\n엔진이 쓴 본문\n${SECTIONS}`), revision: 3, lastAuthor: "engine" }));
    api.setProjectRun.mockRejectedValueOnce(stale());
    keyOnEditor("Enter", { ctrlKey: true });
    expect((await screen.findByRole("alert")).textContent).toContain("(r3)");
    // The body changes once more (r4) and the page reads the note again.
    setCurrent(pageOf({ ...fileNote(`${FM}\n앱 밖에서 또 고친 본문\n${SECTIONS}`), revision: 4, lastAuthor: "external" }));
    reload();
    await shows(4);
    expect(screen.getByRole("alert").textContent).toContain("(r3)");
    api.setProjectRun.mockRejectedValueOnce(stale());
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "내 것으로 쓰기" }));
    await waitFor(() => expect(api.setProjectRun).toHaveBeenLastCalledWith("w", { index: 0, expected: "\n엔진이 쓴 본문\n", text: `${FREE}내 줄\n` }, 3));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("(r4)"));
    expect(runText()).toBe(`${FREE}내 줄\n`);
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "내 것으로 쓰기" }));
    await waitFor(() => expect(api.setProjectRun).toHaveBeenLastCalledWith("w", { index: 0, expected: "\n앱 밖에서 또 고친 본문\n", text: `${FREE}내 줄\n` }, 4));
  });
});

describe("the smaller edges of kept text (m1, m2)", () => {
  it("keeps a value typed back to the original while its write is on its way (m1)", async () => {
    const { api, setCurrent } = setup();
    let finish: (value: ProjectWrite) => void = () => undefined;
    api.setProjectProperty.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(await screen.findByRole("button", { name: /^중요도: 높음/ }));
    const field = screen.getByRole("textbox", { name: "중요도" });
    fireEvent.change(field, { target: { value: "보통" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledTimes(1));
    // Second thoughts while 보통 is being written: back to 높음.
    fireEvent.change(screen.getByRole("textbox", { name: "중요도" }), { target: { value: "높음" } });
    // (The gateway reads the note it wrote from then on: the page's own re-read, 400ms after it opens, finds it too.)
    const wrote = pageOf({ revision: 3 }, changedRows("중요도", { values: ["보통"] }));
    setCurrent(wrote);
    await act(async () => finish({ token: "t", created: false, summary: "중요도: 높음 → 보통", page: wrote }));
    const still = screen.getByRole("textbox", { name: "중요도" }) as HTMLInputElement;
    expect(still.value).toBe("높음");
    expect(readField("w", "prop:중요도")).toEqual({ text: "높음", baseRevision: 3 });
    fireEvent.keyDown(still, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenLastCalledWith("w", "중요도", ["높음"], "text", 3));
  });

  it("shows and sends what is typed when the browser's storage is full, and says once that it will not survive a reload (m2)", async () => {
    const { api, onToast, view, again } = setup();
    // A second pane on the same note: the person is still told once, not once per pane.
    const other = again();
    const screen = within(view.container);
    await within(other.container).findByRole("group", { name: "현황" });
    fireEvent.click(await screen.findByRole("button", { name: /^중요도: 높음/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "중요도" }), { target: { value: "보" } });
    const full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    try {
      fireEvent.change(screen.getByRole("textbox", { name: "중요도" }), { target: { value: "보통" } });
      expect((screen.getByRole("textbox", { name: "중요도" }) as HTMLInputElement).value).toBe("보통");
      fireEvent.change(screen.getByRole("textbox", { name: "중요도" }), { target: { value: "보통 이상" } });
      expect((screen.getByRole("textbox", { name: "중요도" }) as HTMLInputElement).value).toBe("보통 이상");
      await waitFor(() => expect(onToast.mock.calls.filter(([notice]) => /다시 불러오면/.test(notice.text))).toHaveLength(1));
      fireEvent.click(screen.getByRole("button", { name: "+ 결정" }));
      fireEvent.change(screen.getByRole("textbox", { name: "정한 것 (Enter)" }), { target: { value: "저장 안 되는 결정" } });
      expect((screen.getByRole("textbox", { name: "정한 것 (Enter)" }) as HTMLInputElement).value).toBe("저장 안 되는 결정");
      await tick();
      expect(onToast.mock.calls.filter(([notice]) => /다시 불러오면/.test(notice.text))).toHaveLength(1);
      // (Opening + 결정 took the focus: the property was written as it stood in its field.)
      await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "중요도", ["보통 이상"], "text", 2));
      fireEvent.keyDown(screen.getByRole("textbox", { name: "정한 것 (Enter)" }), { key: "Enter" });
      await waitFor(() => expect(api.addProjectEntry).toHaveBeenCalledWith("w", { section: "decision", text: "저장 안 되는 결정", baseRevision: 2 }));
    } finally {
      full.mockRestore();
      keepField("w", "prop:중요도", null);
      keepField("w", "add:decision", null);
    }
  });
});


// U34: the properties block. Its rows are changed with the same fields and pickers, through the same write path.
describe("the properties block's rows (U34)", () => {
  const FOLD = "workbench.section.project.properties";
  const lineOf = (block: HTMLElement, key: string) => block.querySelector<HTMLElement>(`.pn-prop[data-key="${key}"]`)!;

  it("treats the stage chip and the stage row as one field: either opens the one menu, and a pick is written once and read in both", async () => {
    const { api, setCurrent } = setup();
    const block = await blockOf();
    const chip = within(chipsOf()).getByRole("button", { name: STAGE });
    const line = within(block).getByRole("button", { name: STAGE });
    fireEvent.click(line);
    await screen.findByRole("menu", { name: "단계" });
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    // The chip takes the same menu over (a real press there is first a press outside the open menu): there is still one.
    fireEvent.pointerDown(chip);
    fireEvent.click(chip);
    await waitFor(() => expect(chip.getAttribute("aria-expanded")).toBe("true"));
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    api.setProjectStage.mockImplementationOnce(async () => {
      const page = pageOf({ revision: 3, stage: "완료" }, changedRows("단계", { values: ["완료"] }));
      setCurrent(page);
      return { token: "tok", created: false, summary: "단계: 진행중 → 완료", page };
    });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "완료" }));
    await waitFor(() => expect(api.setProjectStage).toHaveBeenCalledWith("w", "완료", 2));
    expect(api.setProjectStage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(chipsOf()).getByRole("button", { name: "단계: 완료 — 바꾸기" })).toBeTruthy());
    expect(within(block).getByRole("button", { name: "단계: 완료 — 바꾸기" })).toBeTruthy();
  });

  it("treats the tags chip and the tags row the same way: one picker, each tick one write", async () => {
    const { api } = setup();
    const block = await blockOf();
    fireEvent.click(within(block).getByRole("button", { name: TAGS }));
    await screen.findByRole("combobox", { name: "태그 찾기" });
    fireEvent.click(within(chipsOf()).getByRole("button", { name: TAGS }));
    await waitFor(() => expect(within(chipsOf()).getByRole("button", { name: TAGS }).getAttribute("aria-expanded")).toBe("true"));
    expect(screen.getAllByRole("combobox", { name: "태그 찾기" })).toHaveLength(1);
    fireEvent.change(screen.getByRole("combobox", { name: "태그 찾기" }), { target: { value: "평가" } });
    fireEvent.click(await screen.findByRole("option", { name: /#평가 추가/ }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "tags", null, "tags", 2, { add: "평가" }));
    expect(api.setProjectProperty).toHaveBeenCalledTimes(1);
  });

  it("shows links as a row of the block, not on the chip line", async () => {
    const { api } = setup(pageOf({}, [...ROWS, row("관련", "links", ["[[다른 프로젝트]]"], { fromTemplate: true })]));
    const block = await blockOf();
    expect(within(chipsOf()).queryByRole("button", { name: /^관련: / })).toBeNull();
    fireEvent.click(within(block).getByRole("button", { name: "관련: 다른 프로젝트 — 바꾸기" }));
    fireEvent.click(await screen.findByRole("option", { name: "다른 프로젝트" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "관련", null, "links", 2, { remove: "[[다른 프로젝트]]" }));
  });

  it("shows a property being typed once: the field in its row, no second input for it anywhere", async () => {
    setup();
    const block = await blockOf();
    fireEvent.click(within(block).getByRole("button", { name: /^마감일: .*11월 20일 — 고치기$/ }));
    const fields = screen.getAllByRole("textbox");
    expect(fields).toHaveLength(1);
    expect(fields[0]!.closest(".pn-prop")?.getAttribute("data-key")).toBe("마감일");
    expect(screen.queryByRole("button", { name: /^마감일: / })).toBeNull();
    expect(within(screen.getByRole("group", { name: "현황" })).queryByText("마감일")).toBeNull();
  });

  it("brings a row's kept text back into that row — a block left folded is open while it waits — and writes it from the revision it was typed at", async () => {
    localStorage.setItem(FOLD, "1");
    keepField("w", "prop:마감일", { text: "11월 27일", baseRevision: 2 });
    const { api, onToast } = setup(pageOf({ revision: 5, lastAuthor: "external" }));
    const block = await blockOf();
    const field = within(block).getByRole("textbox", { name: "마감일" }) as HTMLInputElement;
    expect(field.value).toBe("11월 27일");
    expect(field.closest(".pn-prop")?.getAttribute("data-key")).toBe("마감일");
    expect(within(block).getByRole("button", { name: "속성 8", expanded: true })).toBeTruthy();
    // Folding does not hide it either, and says why.
    fireEvent.click(within(block).getByRole("button", { name: "속성 8" }));
    expect(within(block).getByRole("textbox", { name: "마감일" })).toBeTruthy();
    expect(onToast.mock.calls.at(-1)![0].text).toBe("쓰던 값이 남아 있어 속성을 접지 않았습니다");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "마감일", ["11월 27일"], "date", 2));
    expect(api.setProjectProperty).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(readField("w", "prop:마감일")).toBeNull());
    // Written: nothing waits in the block, which is folded again as it was left.
    await waitFor(() => expect(within(block).getByRole("button", { name: "속성 8", expanded: false })).toBeTruthy());
    expect(within(block).queryAllByRole("term")).toEqual([]);
  });

  it("keeps what was typed into an empty row, shows it in that row again after the page is gone, and asks when the note changed since", async () => {
    const first = setup();
    fireEvent.click(within(await blockOf()).getByRole("button", { name: "시작일: 비어 있음 — 고치기" }));
    fireEvent.change(screen.getByRole("textbox", { name: "시작일" }), { target: { value: "다음 주 월요일" } });
    first.view.unmount();
    const { api } = setup(pageOf({ revision: 5, lastAuthor: "external" }));
    const field = (await screen.findByRole("textbox", { name: "시작일" })) as HTMLInputElement;
    expect(field.value).toBe("다음 주 월요일");
    expect(field.closest(".pn-prop")?.getAttribute("data-key")).toBe("시작일");
    expect(screen.queryByText("쓰다 만 속성 · 시작일")).toBeNull();
    api.setProjectProperty.mockRejectedValueOnce(stale());
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "시작일", ["다음 주 월요일"], "date", 2));
    const conflict = await screen.findByRole("alert", { name: "속성 충돌" });
    expect(conflict.textContent).toContain("저쪽: 없음");
    expect(conflict.textContent).toContain("내 것: 다음 주 월요일");
    expect((screen.getByRole("textbox", { name: "시작일" }) as HTMLInputElement).value).toBe("다음 주 월요일");
    expect(api.setProjectProperty).toHaveBeenCalledTimes(1);
    expect(readField("w", "prop:시작일")).toEqual({ text: "다음 주 월요일", baseRevision: 2 });
  });

  it("asks about a row's conflict on one line under the rows, and writes mine from the revision that line shows", async () => {
    const { api } = setup();
    const block = await blockOf();
    // The note is the changed one from the moment the write is refused.
    api.setProjectProperty.mockImplementationOnce(async () => {
      api.project.mockImplementation(async () => pageOf({ revision: 3, lastAuthor: "external" }, changedRows("목표", { values: ["Obsidian에서 고친 목표"] })));
      throw stale();
    });
    fireEvent.click(within(block).getByRole("button", { name: /^목표: 학생이/ }));
    const field = screen.getByRole("textbox", { name: "목표" });
    fireEvent.change(field, { target: { value: "내가 고친 목표" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "목표", ["내가 고친 목표"], "text", 2));
    const conflict = await screen.findByRole("alert", { name: "속성 충돌" });
    expect(block.contains(conflict)).toBe(true);
    expect(block.querySelector("dl")!.contains(conflict)).toBe(false);
    expect(conflict.textContent).toContain("저쪽: Obsidian에서 고친 목표");
    expect(conflict.textContent).toContain("내 것: 내가 고친 목표");
    // The row shows the other side's value nowhere but on that line: the field still holds mine.
    expect((within(block).getByRole("textbox", { name: "목표" }) as HTMLInputElement).value).toBe("내가 고친 목표");
    fireEvent.click(within(conflict).getByRole("button", { name: "내 것으로 쓰기" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenLastCalledWith("w", "목표", ["내가 고친 목표"], "text", 3));
    expect(api.setProjectProperty).toHaveBeenCalledTimes(2);
  });

  it("does not fold away what is being typed for a new key: its row and field stay, and Enter still writes it once", async () => {
    const { api } = setup();
    const block = await blockOf();
    fireEvent.click(within(block).getByRole("button", { name: "속성 추가" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "속성 추가 찾기" }), { target: { value: "새키" } });
    fireEvent.click(await screen.findByRole("option", { name: /「새키」 새 속성/ }));
    fireEvent.click(await screen.findByRole("option", { name: /텍스트/ }));
    fireEvent.change(await screen.findByRole("textbox", { name: "새키" }), { target: { value: "새 값" } });
    fireEvent.click(within(block).getByRole("button", { name: "속성 9" }));
    const field = within(block).getByRole("textbox", { name: "새키" }) as HTMLInputElement;
    expect(field.value).toBe("새 값");
    expect(field.closest(".pn-prop")?.getAttribute("data-key")).toBe("새키");
    expect(screen.queryByText("쓰다 만 속성 · 새키")).toBeNull();
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "새키", ["새 값"], "text", 2));
    await waitFor(() => expect(readField("w", "prop:새키")).toBeNull());
    expect(api.setProjectProperty).toHaveBeenCalledTimes(1);
  });

  it("keeps a chip's refused change in sight under the head of a folded block", async () => {
    localStorage.setItem(FOLD, "1");
    const { api } = setup();
    const block = await blockOf();
    api.setProjectProperty.mockRejectedValueOnce(stale());
    fireEvent.click(within(chipsOf()).getByRole("button", { name: TAGS }));
    fireEvent.change(await screen.findByRole("combobox", { name: "태그 찾기" }), { target: { value: "평가" } });
    fireEvent.click(await screen.findByRole("option", { name: /#평가 추가/ }));
    const conflict = await screen.findByRole("alert", { name: "속성 충돌" });
    expect(block.contains(conflict)).toBe(true);
    expect(conflict.textContent).toContain("내 것: 평가 더하기");
    expect(within(block).getByRole("button", { name: "속성 8", expanded: false })).toBeTruthy();
  });

  it("keeps text that has no row to return into in sight under the head of a folded block", async () => {
    localStorage.setItem(FOLD, "1");
    keepField("w", "prop:새키", { text: "내 값", baseRevision: 2, added: "text" });
    setup();
    const block = await blockOf();
    expect(within(block).getByRole("button", { name: "속성 8", expanded: false })).toBeTruthy();
    expect(within(block).getByText("쓰다 만 속성 · 새키")).toBeTruthy();
    expect(within(block).getByRole("button", { name: "새키 쓰기" })).toBeTruthy();
  });

  it("shows a multi-line value as a read-only row: its text and 원문에서 고치기, never a field", async () => {
    const source = `---\nworkbench_id: w\nsummary: |\n  첫 줄\n\n  셋째 줄\n---\n${BODY}`;
    const { api } = setup(pageOf({ ...fileNote(source) }, [...ROWS, row("summary", "text", ["첫 줄 셋째 줄"], { editable: false })]));
    const value = within(lineOf(await blockOf(), "summary")).getByRole("definition");
    expect(value.textContent).toBe("첫 줄 셋째 줄원문에서 고치기");
    expect(within(value).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(within(value).getByRole("button", { name: "summary: 첫 줄 셋째 줄 — 원문에서 고치기" }));
    expect(screen.queryByRole("textbox", { name: "summary" })).toBeNull();
    const caret = editorOf().state.selection.main.head;
    expect(source.slice(0, caret).split("\n").at(-1)).toBe("summary: |");
    expect(api.setProjectProperty).not.toHaveBeenCalled();
  });

  it("shows a list whose item carries a comment as a read-only row: no picker over it, 원문에서 고치기 at its key", async () => {
    const source = `---\nworkbench_id: w\n참고:\n  - "교재 3장" # 왜: 루브릭 근거\n  - 설문\n---\n${BODY}`;
    const { api } = setup(pageOf({ ...fileNote(source) }, [...ROWS, row("참고", "list", ["교재 3장", "설문"], { editable: false })]));
    const value = within(lineOf(await blockOf(), "참고")).getByRole("definition");
    expect(value.textContent).toBe("교재 3장설문원문에서 고치기");
    fireEvent.click(within(value).getByRole("button", { name: "참고: 교재 3장, 설문 — 원문에서 고치기" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    const caret = editorOf().state.selection.main.head;
    expect(source.slice(0, caret).split("\n").at(-1)).toBe("참고:");
    expect(api.setProjectProperty).not.toHaveBeenCalled();
  });

  it("sends tags written with a comment to the source from the chip and from the row alike", async () => {
    const source = `---\nworkbench_id: w\ntags:\n  - 강의 # 이번 학기\n---\n${BODY}`;
    const { api } = setup(pageOf({ ...fileNote(source) }, changedRows("tags", { editable: false })));
    const block = await blockOf();
    expect(within(block).getByRole("button", { name: "태그: #강의 — 원문에서 고치기" })).toBeTruthy();
    fireEvent.click(within(chipsOf()).getByRole("button", { name: "태그: #강의 — 원문에서 고치기" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    const caret = editorOf().state.selection.main.head;
    expect(source.slice(0, caret).split("\n").at(-1)).toBe("tags:");
    expect(api.setProjectProperty).not.toHaveBeenCalled();
  });

  it("ticks a checkbox row", async () => {
    const { api } = setup(pageOf({}, [...ROWS, row("공개", "checkbox", ["false"])]));
    fireEvent.click(within(await blockOf()).getByRole("checkbox", { name: "공개" }));
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "공개", ["true"], "checkbox", 2));
  });

  it("opens a row's kind and removal from its kind icon; an empty template field has nothing to remove", async () => {
    const { api, openMenu } = setup();
    const block = await blockOf();
    fireEvent.click(within(block).getByRole("button", { name: "마감일 형식: 날짜" }));
    const request = openMenu.mock.calls.at(-1)![0] as { title: string; items: { label?: string; onSelect?: () => void }[] };
    expect(request.title).toBe("마감일");
    expect(request.items.map((item) => item.label).filter(Boolean)).toEqual(["형식", "속성 지우기"]);
    request.items.at(-1)!.onSelect!();
    await waitFor(() => expect(api.setProjectProperty).toHaveBeenCalledWith("w", "마감일", null, "date", 2));
    fireEvent.click(within(block).getByRole("button", { name: "시작일 형식: 날짜" }));
    expect((openMenu.mock.calls.at(-1)![0] as typeof request).items.map((item) => item.label).filter(Boolean)).toEqual(["형식"]);
    // The app's own key is shown, with no kind to change and nothing to remove.
    expect(within(lineOf(block, "workbench_id")).queryByRole("button", { name: /형식/ })).toBeNull();
  });
});
