// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { Artifact, BrowserPage, Handoff, Proposal, Session, TranscriptItem } from "@workbench/contracts";
import { initialState, type State } from "../../state.ts";
import { DocContext, type DocActions } from "../DocCards.tsx";
import { Transcript } from "../Transcript.tsx";
import { RightSidebar, sideNoteOf, sidebarDocks, useRightSidebar, type SideNote } from "./RightSidebar.tsx";
import { RequestListButton } from "./OutlineList.tsx";

const session = (id: string, extra: Partial<Session> = {}) => ({ id, workId: "w", provider: "codex", purpose: id, status: "idle", archivedAt: null, queued: [], ...extra }) as unknown as Session;
const user = (id: string, text: string, at = 1): TranscriptItem => ({ kind: "user", id, text, at });
const answer = (id: string): TranscriptItem => ({ kind: "assistant", id, text: "답입니다.", streaming: false, at: 2 });
const long = Array.from({ length: 10 }, (_, index) => `${index + 1}번째 줄입니다.`).join("\n");
const items: TranscriptItem[] = [
  user("u1", `슬라이드 구성을 다시 짜 줘\n${long}`), answer("a1"),
  user("u2", "도입부를 고쳐 줘"), answer("a2"),
  user("u3", "폴더에 무엇이 있는지 확인해 줘"),
  { kind: "approval", id: "ap", title: "ls", detail: null, reason: null, decision: null, at: 5 },
  { kind: "artifact", id: "f1", artifactId: "slides", revision: 1, change: "created", at: 6 },
];
const lecture = { id: "lecture", workId: "w", name: "강의안.md", path: "/w/강의안.md", format: "markdown", revision: 3, readBy: {} } as unknown as Artifact;
const slides = { id: "slides", workId: "w", name: "슬라이드.md", path: "/w/슬라이드.md", format: "markdown", revision: 1, readBy: {} } as unknown as Artifact;
const me = session("me", { purpose: "슬라이드 정리", status: "awaitingApproval" });
const other = session("other", { purpose: "자료 조사" });
const state: State = {
  ...initialState,
  sessions: { me, other },
  artifacts: { lecture, slides },
  transcripts: { me: { items } as State["transcripts"][string], other: { items: [user("o1", "논문 세 편을 찾아 줘")] } as State["transcripts"][string] },
  handoffs: { h: { id: "h", sourceSessionId: "me", targetSessionId: "other", status: "sent", createdAt: 3 } as unknown as Handoff },
  proposals: {} as Record<string, Proposal>,
};
const pages: BrowserPage[] = [];
const docs = { state, actions: { openArtifact: vi.fn(), openSession: vi.fn() } as unknown as DocActions };

type Harness = { prefs?: Record<string, unknown>; compact?: boolean; note?: SideNote; onPrefs?: (prefs: Record<string, unknown>) => void; withNote?: boolean; open?: { session: (s: Session) => void; artifact: (id: string) => void }; readText?: (id: string) => Promise<string>; onAnswer?: (itemId: string, decision: string) => void; area?: number; minimum?: number; ready?: boolean };

/** The frame as App wires it: the top bar's toggle and the sidebar beside the conversation's pane. */
function Frame({ prefs: initial = {}, compact = false, note = { kind: "chat", session: me }, onPrefs, withNote = true, open, readText = async () => "", onAnswer = () => {}, area, minimum = 360, ready = true }: Harness) {
  const [prefs, setPrefs] = useState(initial);
  const right = useRightSidebar({
    prefs, compact, scope: "main", minimum, ready, measure: area === undefined ? undefined : () => (ready ? area : 0),
    savePrefs: (patch) => setPrefs((current) => { const next = { ...current, ...patch }; onPrefs?.(next); return next; }),
  });
  return (
    <DocContext.Provider value={docs}>
      <button type="button" {...right.toggleProps}>오른쪽 사이드바</button>
      <div className="pane" data-pane-active="true">
        {withNote ? <Transcript sessionId="me" items={items} provider="codex" running={false} loading={false} onAnswer={onAnswer} /> : null}
      </div>
      {right.shown ? (
        <RightSidebar {...right.sidebarProps} note={note} state={state} pages={pages} readText={readText}
          onOpenSession={open?.session ?? (() => {})} onOpenArtifact={open?.artifact ?? (() => {})} />
      ) : null}
    </DocContext.Provider>
  );
}

const sidebar = () => screen.getByRole("complementary", { name: "오른쪽 사이드바" });
const toggle = () => screen.getByRole("button", { name: "오른쪽 사이드바" });
const openByMouse = () => fireEvent.click(toggle(), { detail: 1 });

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("CSS", { escape: (text: string) => text });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn() as unknown as HTMLElement["scrollTo"];
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

describe("the right sidebar's frame", () => {
  it("starts closed and opens and closes from the top bar, remembering it", () => {
    const saved = vi.fn();
    render(<Frame onPrefs={saved} />);
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    openByMouse();
    expect(sidebar()).toBeTruthy();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(saved).toHaveBeenLastCalledWith({ rightSidebar: { open: true, width: 280, tab: "outline" } });
    openByMouse();
    // Closing slides out first, then leaves the frame.
    fireEvent.animationEnd(sidebar());
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(saved).toHaveBeenLastCalledWith({ rightSidebar: { open: false, width: 280, tab: "outline" } });
  });

  it("comes back as it was left: open, on its tab, at its width", () => {
    render(<Frame prefs={{ rightSidebar: { open: true, width: 360, tab: "links" } }} />);
    expect(sidebar().style.getPropertyValue("--right-width")).toBe("360px");
    expect(sidebar().hasAttribute("data-covers-web")).toBe(false);
    expect(within(sidebar()).getByRole("tab", { name: "연결" }).getAttribute("aria-selected")).toBe("true");
  });

  it("is resized by its edge within bounds, and keeps the width", () => {
    const saved = vi.fn();
    render(<Frame prefs={{ rightSidebar: { open: true, width: 280 } }} onPrefs={saved} />);
    const edge = within(sidebar()).getByRole("separator", { name: "오른쪽 사이드바 너비" });
    fireEvent.pointerDown(edge, { clientX: 1000, pointerId: 1, button: 0 });
    fireEvent.pointerMove(edge, { clientX: 940, pointerId: 1 });
    expect(sidebar().style.getPropertyValue("--right-width")).toBe("340px");
    fireEvent.pointerUp(edge, { clientX: 940, pointerId: 1 });
    expect(saved).toHaveBeenLastCalledWith({ rightSidebar: { open: true, width: 340, tab: "outline" } });
    fireEvent.pointerDown(edge, { clientX: 1000, pointerId: 1, button: 0 });
    fireEvent.pointerMove(edge, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(edge, { clientX: 100, pointerId: 1 });
    expect(saved).toHaveBeenLastCalledWith({ rightSidebar: { open: true, width: 440, tab: "outline" } });
    edge.focus();
    fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(saved).toHaveBeenLastCalledWith({ rightSidebar: { open: true, width: 424, tab: "outline" } });
    expect(edge.getAttribute("aria-valuenow")).toBe("424");
  });

  it("lays over a narrow window without being remembered, and closes on a choice", () => {
    const saved = vi.fn();
    render(<Frame compact onPrefs={saved} />);
    openByMouse();
    expect(sidebar().dataset.overlay).toBe("true");
    // A native web page under it gives way while it is open.
    expect(sidebar().hasAttribute("data-covers-web")).toBe(true);
    expect(screen.getByRole("button", { name: "오른쪽 사이드바 닫기" }).hasAttribute("data-covers-web")).toBe(true);
    expect(saved).not.toHaveBeenCalled();
    fireEvent.click(within(sidebar()).getByRole("button", { name: /^2 도입부를 고쳐 줘/ }));
    fireEvent.animationEnd(sidebar());
    expect(screen.queryByRole("complementary")).toBeNull();
    openByMouse();
    fireEvent.click(screen.getByRole("button", { name: "오른쪽 사이드바 닫기" }));
    fireEvent.animationEnd(sidebar());
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("takes the focus when opened from the keyboard and gives it back on close", () => {
    render(<Frame />);
    toggle().focus();
    fireEvent.click(toggle(), { detail: 0 });
    const tabs = within(sidebar()).getByRole("tablist", { name: "오른쪽 사이드바 보기" });
    expect(tabs.contains(document.activeElement)).toBe(true);
    // Arrow keys move along the tabs; the panel follows.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(within(sidebar()).getByRole("tab", { name: "연결" }).getAttribute("aria-selected")).toBe("true");
    expect(within(sidebar()).getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(within(sidebar()).getByRole("tab", { name: "연결" }).id);
    fireEvent.click(toggle(), { detail: 0 });
    expect(document.activeElement).toBe(toggle());
  });
});

describe("개요: the conversation's requests", () => {
  it("lists the requests as numbered in the note, with their marks", () => {
    render(<Frame prefs={{ rightSidebar: { open: true } }} />);
    const list = within(sidebar()).getByRole("navigation", { name: "요청 목록" });
    const rows = within(list).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual(["1슬라이드 구성을 다시 짜 줘", "2도입부를 고쳐 줘", "3폴더에 무엇이 있는지 확인해 줘"]);
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["1 슬라이드 구성을 다시 짜 줘", "2 도입부를 고쳐 줘", "3 폴더에 무엇이 있는지 확인해 줘 · 확인 필요"]);
    expect(rows[2]!.querySelector(".dot-attention")).toBeTruthy();
  });

  it("jumps to a request with the conversation's own jump, opening a folded one", () => {
    const view = render(<Frame prefs={{ rightSidebar: { open: true } }} />);
    const first = () => screen.getAllByRole("article", { name: /^요청 \d/ })[0]!;
    expect(within(first()).getByRole("button", { name: "더 보기" })).toBeTruthy();
    fireEvent.click(within(sidebar()).getByRole("button", { name: /^1 슬라이드/ }));
    expect(within(first()).getByRole("button", { name: "접기" })).toBeTruthy();
    expect(view.container.querySelector(".transcript")!.scrollTo).toHaveBeenCalled();
  });

  it("marks the request in view as the reader scrolls", () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("transcript") ? 400 : 0; });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("transcript") ? 3000 : 0; });
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains("turn")) return 0;
      return [...this.parentElement!.querySelectorAll(":scope > .turn")].indexOf(this) * 1000;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("turn") ? 1000 : 40; });
    const view = render(<Frame prefs={{ rightSidebar: { open: true } }} />);
    const scroller = view.container.querySelector<HTMLElement>(".transcript")!;
    const current = () => within(sidebar()).getAllByRole("button").find((row) => row.getAttribute("aria-current") === "location")?.textContent?.slice(0, 1);
    // The reader scrolls up (a wheel first: the note stops following its newest output).
    act(() => { fireEvent.wheel(scroller, { deltaY: -40 }); scroller.scrollTop = 1200; fireEvent.scroll(scroller); });
    expect(current()).toBe("2");
    act(() => { scroller.scrollTop = 200; fireEvent.scroll(scroller); });
    expect(current()).toBe("1");
  });

  it("moves with the arrow keys and finds a request by its number", () => {
    render(<Frame prefs={{ rightSidebar: { open: true } }} />);
    const rows = within(within(sidebar()).getByRole("navigation", { name: "요청 목록" })).getAllByRole("button");
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: "End" });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(rows[2]!, { key: "1" });
    expect(document.activeElement).toBe(rows[0]);
    expect(rows.filter((row) => row.tabIndex === 0)).toEqual([rows[0]]);
  });

  it("follows the note in the focused pane", () => {
    const view = render(<Frame prefs={{ rightSidebar: { open: true } }} />);
    view.rerender(<Frame prefs={{ rightSidebar: { open: true } }} note={{ kind: "chat", session: other }} />);
    expect(within(sidebar()).getAllByRole("button", { name: /^1 / }).map((row) => row.textContent)).toEqual(["1논문 세 편을 찾아 줘"]);
    expect(sideNoteOf({ kind: "work" }, me, state.artifacts)).toEqual({ kind: "chat", session: me });
    // A conversation with a document beside it is still the conversation's note.
    expect(sideNoteOf({ kind: "work", beside: { kind: "document", artifactId: "lecture", proposalId: null } } as { kind: string }, me, state.artifacts)).toEqual({ kind: "chat", session: me });
    expect(sideNoteOf({ kind: "document", artifactId: "lecture" }, me, state.artifacts)).toEqual({ kind: "document", artifact: lecture });
    expect(sideNoteOf({ kind: "browser" }, null, state.artifacts)).toEqual({ kind: "other" });
    expect(sideNoteOf({ kind: "new" }, null, state.artifacts)).toBeNull();
  });

  it("shows a Markdown document's headings and says so quietly where there is no outline", async () => {
    const readText = vi.fn(async () => "# 강의안\n본문\n## 1주차");
    const view = render(<Frame prefs={{ rightSidebar: { open: true } }} note={{ kind: "document", artifact: lecture }} readText={readText} />);
    expect(await within(sidebar()).findByRole("button", { name: "1주차" })).toBeTruthy();
    expect(readText).toHaveBeenCalledWith("lecture");
    view.rerender(<Frame prefs={{ rightSidebar: { open: true } }} note={{ kind: "other" }} />);
    expect(within(sidebar()).getByText("이 화면에는 개요가 없습니다.")).toBeTruthy();
    view.rerender(<Frame prefs={{ rightSidebar: { open: true } }} note={null} />);
    expect(within(sidebar()).getByText("대화나 문서를 열면 개요가 여기에 보입니다.")).toBeTruthy();
    view.rerender(<Frame prefs={{ rightSidebar: { open: true } }} note={{ kind: "chat", session: session("empty") }} />);
    expect(within(sidebar()).getByText("요청을 보내면 여기에 목록이 생깁니다.")).toBeTruthy();
  });
});

describe("연결: what the conversation made, used and is linked to", () => {
  it("draws only the groups that have entries, each row opening its target", () => {
    const openSession = vi.fn(), openArtifact = vi.fn();
    render(<Frame prefs={{ rightSidebar: { open: true, tab: "links" } }} open={{ session: openSession, artifact: openArtifact }} />);
    const panel = within(sidebar()).getByRole("tabpanel");
    expect(within(panel).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["문서1", "대화1"]);
    fireEvent.click(within(panel).getByRole("button", { name: /슬라이드\.md/ }));
    expect(openArtifact).toHaveBeenCalledWith("slides");
    fireEvent.click(within(panel).getByRole("button", { name: /자료 조사/ }));
    expect(openSession).toHaveBeenCalledWith(other);
  });

  it("says so when nothing is linked yet", () => {
    render(<Frame prefs={{ rightSidebar: { open: true, tab: "links" } }} note={{ kind: "chat", session: session("empty") }} />);
    expect(within(sidebar()).getByText("아직 이 대화와 이어진 것이 없습니다.")).toBeTruthy();
  });
});

describe("a conversation shown small (a document's AI, a web tab's AI)", () => {
  const Small = ({ list }: { list: TranscriptItem[] }) => (
    <DocContext.Provider value={docs}>
      <header><RequestListButton sessionId="small" items={list} running={false} /></header>
      <Transcript sessionId="small" items={list} provider="claude" running={false} loading={false} onAnswer={() => {}} />
    </DocContext.Provider>
  );

  it("draws no request list over the conversation itself", () => {
    const view = render(<Small list={items} />);
    expect(view.container.querySelector(".transcript-wrap")!.querySelector("button[aria-label='요청 목록'], details")).toBeNull();
  });

  it("keeps a compact request list in its head that jumps and closes", () => {
    const view = render(<Small list={items} />);
    fireEvent.click(screen.getByRole("button", { name: "요청 목록" }));
    const list = screen.getByRole("navigation", { name: "요청 목록" });
    fireEvent.click(within(list).getByRole("button", { name: /^2 도입부/ }));
    expect(view.container.querySelector(".transcript")!.scrollTo).toHaveBeenCalled();
    expect(screen.queryByRole("navigation", { name: "요청 목록" })).toBeNull();
  });

  it("has no list for a short exchange", () => {
    render(<Small list={items.slice(0, 2)} />);
    expect(screen.queryByRole("button", { name: "요청 목록" })).toBeNull();
  });
});

describe("keys pressed in the sidebar", () => {
  // Review I1: Enter on the resize edge approved the conversation's waiting command.
  it("never answer the conversation's waiting approval", () => {
    const answered = vi.fn();
    render(<Frame prefs={{ rightSidebar: { open: true } }} onAnswer={answered} />);
    const edge = within(sidebar()).getByRole("separator", { name: "오른쪽 사이드바 너비" });
    edge.focus();
    fireEvent.keyDown(edge, { key: "Enter" });
    fireEvent.keyDown(edge, { key: "Escape" });
    const tab = within(sidebar()).getByRole("tab", { name: "개요" });
    fireEvent.keyDown(tab, { key: "Enter" });
    expect(answered).not.toHaveBeenCalled();
    // Nothing focused: the shortcut still answers.
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(answered).toHaveBeenCalledWith("ap", "accept");
  });
});

describe("연결 rows open what their target is now", () => {
  const archived = session("archived", { purpose: "끝난 대화", archivedAt: 9 } as Partial<Session>);
  const tabAi = session("tabAi", { purpose: "탭 AI", pageAgent: { pageId: "p1", parentSessionId: "me" } });
  const blindAi = session("blindAi", { purpose: "주소 모르는 탭", pageAgent: { pageId: "p2", parentSessionId: "me" } });
  const missing = { ...slides, id: "missing", name: "옮겨진.md", diskState: "missing" } as Artifact;
  const now: State = {
    ...state,
    sessions: { me, archived, tabAi, blindAi },
    artifacts: { missing },
    transcripts: { me: { items: [{ kind: "artifact", id: "f", artifactId: "missing", revision: 1, change: "created", at: 1 }] } as State["transcripts"][string] },
    handoffs: { h: { id: "h", sourceSessionId: "me", targetSessionId: "archived", status: "answered", createdAt: 3 } as unknown as Handoff },
  };
  const closed = { pageId: "p1", sessionId: "tabAi", title: "센터 안내", url: "https://ctl.example.ac.kr/guide", status: "closed", closedAt: 5 } as unknown as BrowserPage;
  const bare = (open: { session?: (s: Session) => void; artifact?: (id: string) => void; page?: (page: BrowserPage) => void }) => render(
    <RightSidebar id="r" asideRef={{ current: null }} note={{ kind: "chat", session: me }} state={now} pages={[closed]} readText={async () => ""} tab="links" onTab={() => {}}
      width={280} onWidth={() => {}} overlay={false} closing={false} autoFocus={false} onClose={() => {}} onClosed={() => {}}
      onOpenSession={open.session ?? (() => {})} onOpenArtifact={open.artifact ?? (() => {})} onOpenPage={open.page} />,
  );

  it("opens an archived conversation itself, saying it is archived", () => {
    const openSession = vi.fn();
    bare({ session: openSession });
    fireEvent.click(screen.getByRole("button", { name: /끝난 대화보낸 요청 · 답 받음 · 보관됨/ }));
    expect(openSession).toHaveBeenCalledWith(archived);
  });

  it("opens a closed tab's address in a new web tab, a link where there are none, and nothing when it is unknown", () => {
    const openPage = vi.fn();
    const view = bare({ page: openPage });
    fireEvent.click(screen.getByRole("button", { name: /센터 안내닫힘/ }));
    expect(openPage).toHaveBeenCalledWith(closed);
    const blind = screen.getByText("주소 모르는 탭").closest(".right-link")!;
    expect(blind.matches("button, a")).toBe(false);
    view.unmount();
    bare({});
    expect(screen.getByRole("link", { name: /센터 안내닫힘/ }).getAttribute("href")).toBe("https://ctl.example.ac.kr/guide");
  });

  it("does not open a document whose file is gone", () => {
    const openArtifact = vi.fn();
    bare({ artifact: openArtifact });
    const row = screen.getByText("옮겨진.md").closest(".right-link")!;
    expect(row.matches("button, a")).toBe(false);
    expect(row.textContent).toContain("파일 없음");
  });
});

// Panes side by side need 360px each and an 8px gap (panes.ts MIN_PANE, DIVIDER).
const least = (panes: number) => panes * 360 + (panes - 1) * 8;

describe("docked only while the panes keep their width", () => {
  it.each([
    // pane area without the sidebar, panes side by side, sidebar width, docks
    [1100, 1, 280, true],
    [900, 2, 280, false],
    [960, 2, 240, false],
    [1300, 2, 280, true],
    [1150, 2, 440, false],
    [680, 1, 280, true],
    [600, 1, 280, false],
  ])("%ipx for %i pane(s) beside %ipx → docks: %s", (area, panes, width, docks) => {
    expect(sidebarDocks(area, least(panes), width, docks)).toBe(docks);
    expect(sidebarDocks(area, least(panes), width, !docks)).toBe(docks);
  });

  it("does not flip back and forth at the threshold", () => {
    const edge = least(2) + 280 + 8;
    expect(sidebarDocks(edge, least(2), 280, true)).toBe(true);
    // Laid over just below: it docks again only with some room to spare.
    expect(sidebarDocks(edge - 1, least(2), 280, true)).toBe(false);
    expect(sidebarDocks(edge, least(2), 280, false)).toBe(false);
    expect(sidebarDocks(edge + 24, least(2), 280, false)).toBe(true);
  });

  it("lays over the work when the panes would be squeezed, and is not remembered then", () => {
    const saved = vi.fn();
    render(<Frame area={900} minimum={least(2)} onPrefs={saved} />);
    openByMouse();
    expect(sidebar().dataset.overlay).toBe("true");
    expect(saved).not.toHaveBeenCalled();
  });

  // Review: at boot the panes appear only once the layout is ready; a saved-open sidebar must not
  // squeeze them until the next resize.
  it("decides again when the panes first appear: saved open, two panes, a narrow window → laid over", () => {
    const view = render(<Frame ready={false} area={900} minimum={least(2)} prefs={{ rightSidebar: { open: true } }} />);
    // Before the panes are drawn nothing is measured: docked as remembered.
    expect(sidebar().dataset.overlay).toBeUndefined();
    view.rerender(<Frame ready area={900} minimum={least(2)} prefs={{ rightSidebar: { open: true } }} />);
    // Drawn, the panes would not fit beside it: it stops docking (laid over, so not open by memory)…
    fireEvent.animationEnd(screen.getByRole("complementary"));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    // …and opening it now lays it over the panes.
    openByMouse();
    expect(sidebar().dataset.overlay).toBe("true");
  });

  it("docks as remembered when there is room", () => {
    render(<Frame area={1300} minimum={least(2)} prefs={{ rightSidebar: { open: true } }} />);
    expect(sidebar().dataset.overlay).toBeUndefined();
  });
});
