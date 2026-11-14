// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, Folder, Session, TranscriptItem, Work } from "@workbench/contracts";
import { initialState, type State } from "../../state.ts";
import type { Api } from "../../api.ts";
import { DocContext, type DocActions } from "../DocCards.tsx";
import { Transcript } from "../Transcript.tsx";
import type { WorkActions } from "../WorkView.tsx";
import { useState } from "react";
import { ConversationHead, useNoteMenu } from "./ConversationHead.tsx";
import type { Inherited } from "../ModelPicker.tsx";
import { RawNote } from "./RawNote.tsx";
import { jumpInNote } from "../../conversation/outline.ts";

const work = { id: "w", title: "3주차 강의 슬라이드", folderId: "f2", cwd: "/works/lecture", defaultWorkspaceId: null, activeSessionId: "s" } as unknown as Work;
const session = {
  id: "s", workId: "w", provider: "codex", purpose: "슬라이드 정리", status: "idle", archivedAt: null, model: "gpt-5", effort: null,
  queued: [], context: null, worktree: null, lastError: null, engineModel: null, engineEffort: null,
} as unknown as Session;
const artifact = { id: "a1", workId: "w", name: "강의안.md", path: "/works/lecture/강의안.md", format: "markdown", revision: 3, updatedAt: 1, diskState: "same" } as unknown as Artifact;
const folders: Record<string, Folder> = {
  f1: { id: "f1", name: "강의", parentId: null, sort: 0, archivedAt: null } as unknown as Folder,
  f2: { id: "f2", name: "2026-2학기", parentId: "f1", sort: 0, archivedAt: null } as unknown as Folder,
};
const state: State = {
  ...initialState,
  hostLabel: "노트북",
  works: { w: work },
  sessions: { s: session },
  artifacts: { a1: artifact },
  folders,
  providers: { ...initialState.providers, codex: { models: [{ id: "gpt-5", label: "GPT-5" }] } } as State["providers"],
};

const docs = (actions: Partial<DocActions> = {}) => ({ state, actions: { openArtifact: vi.fn(), openSession: vi.fn(), ...actions } as unknown as DocActions });
const note = (items: TranscriptItem[], extra: Partial<Parameters<typeof Transcript>[0]> = {}) => (
  <DocContext.Provider value={docs()}>
    <Transcript sessionId="s" items={items} provider="codex" running={false} loading={false} onAnswer={() => {}} {...extra} />
  </DocContext.Provider>
);
const user = (id: string, text: string, at = 1): TranscriptItem => ({ kind: "user", id, text, at });
const answer = (id: string, text: string): TranscriptItem => ({ kind: "assistant", id, text, streaming: false, at: 2 });

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

describe("the conversation read as a note", () => {
  it("shows each request as a numbered block in the column and answers without a speaker label", () => {
    render(note([user("u1", "슬라이드 구성을 다시 짜 줘."), answer("a1", "다시 짰습니다."), user("u2", "도입부를 고쳐 줘."), answer("a2", "고쳤습니다.")]));
    const requests = screen.getAllByRole("article", { name: /^요청 \d/ });
    expect(requests.map((request) => request.getAttribute("aria-label"))).toEqual(["요청 1", "요청 2"]);
    expect(within(requests[0]!).getByText("슬라이드 구성을 다시 짜 줘.")).toBeTruthy();
    // The engine is said once, in the note's head; never above each answer.
    expect(screen.queryByText("Codex")).toBeNull();
    expect(screen.getByText("다시 짰습니다.")).toBeTruthy();
  });

  it("puts the note's head first in the reading column", () => {
    const view = render(note([user("u1", "요청")], { head: <h1>노트 제목</h1> }));
    const column = view.container.querySelector(".transcript-inner")!;
    expect(column.firstElementChild?.textContent).toBe("노트 제목");
  });

  it("folds a long request after a few lines and opens it on demand", () => {
    const long = Array.from({ length: 10 }, (_, index) => `${index + 1}번째 줄입니다.`).join("\n");
    render(note([user("u1", long), user("u2", "짧은 요청")]));
    const [first, second] = screen.getAllByRole("article", { name: /^요청 \d/ });
    const more = within(first!).getByRole("button", { name: "더 보기" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(within(first!).getByRole("button", { name: "접기" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(second!).queryByRole("button", { name: "더 보기" })).toBeNull();
  });

  it("folds only a long request's words: what came with it stays in view", () => {
    const long = Array.from({ length: 10 }, (_, index) => `${index + 1}번째 줄`).join("\n");
    const picture = { id: "p1", name: "판서.png", mime: "image/png", size: 10 };
    render(note([{ kind: "user", id: "u1", text: long, at: 1, attachments: [picture], refs: [{ artifactId: "a1", name: "강의안.md", revision: 3, mode: "review", selection: null }] } as TranscriptItem]));
    expect(screen.getByRole("button", { name: "더 보기" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: /판서\.png/ })).toBeTruthy();
    expect(screen.getByText(/강의안\.md/)).toBeTruthy();
  });

  it("opens a folded request a search hit lands in, then marks it", () => {
    const long = Array.from({ length: 10 }, (_, index) => `${index + 1}번째 줄`).join("\n");
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("CSS", { escape: (text: string) => text });
    const items = [user("u1", long), answer("a1", "답")];
    const view = render(note(items));
    expect(screen.getByRole("button", { name: "더 보기" })).toBeTruthy();
    view.rerender(note(items, { focusItem: { itemId: "u1", nonce: 1 } }));
    expect(screen.getByRole("button", { name: "접기" }).getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector('[data-item-id="u1"]')?.classList.contains("flash")).toBe(true);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("opens a folded request on every find and every jump, also after the reader folded it again", () => {
    const long = Array.from({ length: 10 }, (_, index) => `${index + 1}번째 줄입니다.`).join("\n");
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const scrolledTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrolledTo as unknown as HTMLElement["scrollTo"];
    vi.stubGlobal("CSS", { escape: (text: string) => text });
    const items = [user("u1", long), answer("a1", "답"), user("u2", "둘째"), answer("a2", "답"), user("u3", "셋째"), answer("a3", "답")];
    const view = render(note(items));
    const first = () => screen.getAllByRole("article", { name: /^요청 \d/ })[0]!;
    const fold = () => within(first()).getByRole("button", { name: /^(더 보기|접기)$/ });
    // Find, fold again, find again.
    view.rerender(note(items, { focusItem: { itemId: "u1", nonce: 1 } }));
    expect(fold().textContent).toBe("접기");
    fireEvent.click(fold());
    expect(fold().textContent).toBe("더 보기");
    view.rerender(note(items, { focusItem: null }));
    view.rerender(note(items, { focusItem: { itemId: "u1", nonce: 2 } }));
    expect(fold().textContent).toBe("접기");
    // Jump from the outline (the right sidebar's, or a compact request list), fold again, jump again.
    fireEvent.click(fold());
    const jump = () => act(() => { expect(jumpInNote("chat:s", "u1")).toBe(true); });
    jump();
    expect(fold().textContent).toBe("접기");
    fireEvent.click(fold());
    expect(fold().textContent).toBe("더 보기");
    scrolledTo.mockClear();
    jump();
    expect(fold().textContent).toBe("접기");
    expect(scrolledTo).toHaveBeenCalled();
  });

  it("keeps a single long paragraph foldable too", () => {
    render(note([user("u1", "가".repeat(600))]));
    expect(screen.getByRole("button", { name: "더 보기" })).toBeTruthy();
  });

  it("still offers \"이 요청 전으로\" on a request", () => {
    const fork = vi.fn();
    render(note([user("u1", "요청"), answer("a1", "답")], { onFork: fork }));
    fireEvent.click(screen.getByRole("button", { name: "이 요청 전으로" }));
    expect(fork).toHaveBeenCalledWith("u1");
  });

  it("folds a finished plan into the steps line and keeps a plan in progress open", () => {
    const plan = (id: string, done: boolean): TranscriptItem => ({ kind: "plan", id, at: 3, steps: [
      { text: "구조 살펴보기", status: "completed" }, { text: "순서 다시 짜기", status: done ? "completed" : "inProgress" },
    ] });
    const tool = (id: string): TranscriptItem => ({ kind: "tool", id, tool: "command", title: "ls", detail: null, output: null, status: "completed", at: 4 });
    render(note([user("u1", "요청"), plan("p1", true), tool("t1"), user("u2", "다음"), plan("p2", false)]));
    const steps = screen.getByRole("button", { name: "실행 상세 · 계획 2/2 · 명령 1개" });
    expect(steps.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "계획 · 1/2" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByText("순서 다시 짜기")).toHaveLength(1);
    fireEvent.click(steps);
    expect(screen.getAllByText("순서 다시 짜기")).toHaveLength(2);
  });

  it("shows a document the work made as a one-line link that opens it", () => {
    const openArtifact = vi.fn();
    render(
      <DocContext.Provider value={docs({ openArtifact })}>
        <Transcript sessionId="s" provider="codex" running={false} loading={false} onAnswer={() => {}}
          items={[user("u1", "요청"), { kind: "artifact", id: "x", artifactId: "a1", revision: 3, change: "created", at: 2 }]} />
      </DocContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /강의안\.md/ }));
    expect(openArtifact).toHaveBeenCalledWith("a1");
  });

  it("shows a design as its picture, an Office file as its first page, other files as a format badge", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const design = { ...artifact, id: "d1", name: "카드뉴스.design.json", format: "design" } as unknown as Artifact;
    const slides = { ...artifact, id: "o1", name: "3주차.pptx", format: "pptx" } as unknown as Artifact;
    const paper = { ...artifact, id: "f1", name: "논문.pdf", format: "pdf" } as unknown as Artifact;
    render(
      <DocContext.Provider value={{ state: { ...state, artifacts: { a1: artifact, d1: design, o1: slides, f1: paper } }, actions: { openArtifact: vi.fn() } as unknown as DocActions }}>
        <Transcript sessionId="s" provider="codex" running={false} loading={false} onAnswer={() => {}}
          items={[user("u1", "요청"), { kind: "artifact", id: "x", artifactId: "d1", revision: 3, change: "created", at: 2 }, { kind: "artifact", id: "y", artifactId: "a1", revision: 3, change: "created", at: 3 },
            { kind: "artifact", id: "z", artifactId: "o1", revision: 3, change: "created", at: 4 }, { kind: "artifact", id: "w", artifactId: "f1", revision: 3, change: "created", at: 5 }]} />
      </DocContext.Provider>,
    );
    const card = screen.getByRole("button", { name: /카드뉴스/ });
    expect(card.querySelector(".design-card-thumb")).toBeTruthy();
    expect(within(card).queryByText("디자인")).toBeNull();
    expect(within(screen.getByRole("button", { name: /강의안\.md/ })).getByText("MD")).toBeTruthy();
    // No card loses the preview it had: an Office file keeps its first page, a PDF its badge.
    const office = screen.getByRole("button", { name: /3주차\.pptx/ });
    expect(office.querySelector(".design-card-thumb")).toBeTruthy();
    expect(within(office).queryByText("PPTX")).toBeNull();
    expect(within(screen.getByRole("button", { name: /논문\.pdf/ })).getByText("PDF")).toBeTruthy();
  });
});

describe("the conversation's head", () => {
  const actions = () => ({
    openProject: vi.fn(), openArtifact: vi.fn(), moveWork: vi.fn(), renameSession: vi.fn(), newDesign: vi.fn(async () => {}),
    reviewWorktree: vi.fn(), openWorkspace: vi.fn(), createWorkspace: vi.fn(), updateWorkspace: vi.fn(),
  }) as unknown as WorkActions;
  const head = (acts = actions(), extra: { session?: Session; state?: State; inherited?: Inherited; readOnly?: boolean } = {}) => {
    const onRaw = vi.fn();
    function Head() {
      const [renaming, setRenaming] = useState(false);
      const target = extra.session ?? session;
      const menu = useNoteMenu({ api: {} as Api, state: extra.state ?? state, work, session: target, actions: acts, cwd: "/works/lecture", pickFile: null, onToast: vi.fn(), onRename: () => setRenaming(true) });
      return <>{menu.layers}<ConversationHead state={extra.state ?? state} work={work} session={target} actions={acts} cwd="/works/lecture" raw={false} onRaw={onRaw}
        menuButton={menu.trigger("head")} renaming={renaming} onRenaming={setRenaming} inherited={extra.inherited} readOnly={extra.readOnly} /></>;
    }
    render(<Head />);
    return { acts, onRaw };
  };

  it("names the conversation once and lists its properties on one line", () => {
    head();
    expect(screen.getByRole("heading", { level: 1, name: "슬라이드 정리" })).toBeTruthy();
    const props = screen.getByRole("list", { name: "속성" });
    const text = props.textContent ?? "";
    for (const value of ["3주차 강의 슬라이드", "Codex", "GPT-5", "대기"]) expect(text).toContain(value);
  });

  it("says the model the next request uses, the same as the input's picker", () => {
    // An engine may name its default "Fake (기본)": the head shows the plain name, as the input does.
    const models = [{ id: "fake-model", label: "Fake (기본)", isDefault: true, efforts: [], defaultEffort: null }, { id: "mini", label: "GPT mini", isDefault: false, efforts: [], defaultEffort: null }];
    const withModels = { ...state, providers: { ...state.providers, codex: { models } } } as unknown as State;
    const lastAnswer = { ...session, model: null, engineModel: "fake-model-2025" } as unknown as Session;
    head(actions(), { state: withModels, session: lastAnswer });
    const props = screen.getByRole("list", { name: "속성" });
    expect(props.textContent).toContain("Fake");
    expect(props.textContent).not.toContain("(기본)");
    expect(props.textContent).not.toContain("fake-model-2025");
    cleanup();
    head(actions(), { state: withModels, session: lastAnswer, inherited: { name: "검토", model: "mini", effort: null } });
    expect(screen.getByRole("list", { name: "속성" }).textContent).toContain("GPT mini · 역할");
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    const details = screen.getByRole("dialog", { name: "세션 상세" });
    expect(details.textContent).toContain("GPT mini · 역할 · 다음 요청부터");
    expect(details.textContent).toContain("fake-model-2025");
  });

  it("on a read-only conversation the model chip points at no input: there is none", () => {
    head(actions(), { readOnly: true });
    const chip = within(screen.getByRole("list", { name: "속성" })).getByText("GPT-5");
    expect(chip.getAttribute("title") ?? "").not.toContain("입력창");
    cleanup();
    head();
    expect(within(screen.getByRole("list", { name: "속성" })).getByText("GPT-5").getAttribute("title")).toContain("입력창에서 바꿉니다");
  });

  it("opens the project from its property", () => {
    const { acts } = head();
    fireEvent.click(screen.getByRole("button", { name: /3주차 강의 슬라이드/ }));
    expect(acts.openProject).toHaveBeenCalledWith(work);
  });

  it("shows the session's details from the engine property", () => {
    head();
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    const details = screen.getByRole("dialog", { name: "세션 상세" });
    expect(details.textContent).toContain("노트북");
    expect(details.textContent).toContain("/works/lecture");
  });

  it("switches between reading and the raw Markdown", () => {
    const { onRaw } = head();
    const toggle = screen.getByRole("button", { name: "원문(md) 보기" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(onRaw).toHaveBeenCalledWith(true);
  });

  it("keeps the moved controls in the ⋯ menu: documents, filing, renaming", async () => {
    const { acts } = head();
    fireEvent.click(screen.getByRole("button", { name: "노트 메뉴" }));
    const menu = await screen.findByRole("menu", { name: "노트 메뉴" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /강의안\.md/ }));
    expect(acts.openArtifact).toHaveBeenCalledWith("a1");

    fireEvent.click(screen.getByRole("button", { name: "노트 메뉴" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "노트 메뉴" })).getByRole("menuitem", { name: /분류 옮기기/ }));
    fireEvent.click(within(screen.getByRole("menu", { name: "노트 메뉴" })).getByRole("menuitemradio", { name: "분류 없음" }));
    expect(acts.moveWork).toHaveBeenCalledWith(work, null);

    fireEvent.click(screen.getByRole("button", { name: "노트 메뉴" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "노트 메뉴" })).getByRole("menuitem", { name: /이름 바꾸기/ }));
    const field = screen.getByRole("textbox", { name: "대화 이름" });
    fireEvent.change(field, { target: { value: "새 이름" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(acts.renameSession).toHaveBeenCalledWith(session, "새 이름");
  });

  it("closes a menu opened from the band when the band goes away (the head scrolled back into view)", async () => {
    const acts = actions();
    function Band({ shown }: { shown: boolean }) {
      const menu = useNoteMenu({ api: {} as Api, state, work, session, actions: acts, cwd: "/works/lecture", pickFile: null, onToast: vi.fn(), onRename: () => {} });
      return <>{menu.layers}<div className="turn-pin">{shown ? menu.trigger("band") : null}</div></>;
    }
    const view = render(<Band shown />);
    fireEvent.click(screen.getByRole("button", { name: "노트 메뉴" }));
    expect(await screen.findByRole("menu", { name: "노트 메뉴" })).toBeTruthy();
    view.rerender(<Band shown={false} />);
    expect(screen.queryByRole("menu", { name: "노트 메뉴" })).toBeNull();
  });

  it("wears the one note head the project note wears: kind icon, title, property chips", () => {
    head();
    const title = screen.getByRole("heading", { level: 1 });
    expect(title.classList.contains("note-title")).toBe(true);
    expect(title.closest(".note-head-title")?.querySelector(".note-kind")?.compareDocumentPosition(title)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const chips = screen.getByRole("list", { name: "속성" });
    expect(chips.classList.contains("note-props")).toBe(true);
    expect(within(chips).getByRole("button", { name: /3주차 강의 슬라이드/ }).classList.contains("note-prop")).toBe(true);
  });

  it("renames by double-clicking the title", () => {
    const { acts } = head();
    fireEvent.doubleClick(screen.getByRole("heading", { level: 1 }));
    const field = screen.getByRole("textbox", { name: "대화 이름" });
    fireEvent.change(field, { target: { value: "슬라이드" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(acts.renameSession).toHaveBeenCalledWith(session, "슬라이드");
  });
});

describe("the raw note", () => {
  it("shows the export's Markdown read-only and refreshes it when the conversation grows", async () => {
    let call = 0;
    const exportMarkdown = vi.fn(async () => ({ markdown: `---\ntitle: "슬라이드 정리"\n---\n\n# 슬라이드 정리 ${++call}` }));
    const api = { exportMarkdown } as unknown as Api;
    const view = render(<RawNote api={api} sessionId="s" pulse="1" />);
    await act(async () => {});
    expect(exportMarkdown).toHaveBeenCalledWith("s", { target: "text" });
    const raw = screen.getByRole("region", { name: "대화 원문" });
    expect(raw.textContent).toContain("# 슬라이드 정리 1");
    expect(raw.querySelector("textarea, [contenteditable=true]")).toBeNull();
    view.rerender(<RawNote api={api} sessionId="s" pulse="2" />);
    await act(async () => {});
    expect(screen.getByRole("region", { name: "대화 원문" }).textContent).toContain("# 슬라이드 정리 2");
  });
});
