// @vitest-environment jsdom
// Skin 2 · unit C: the document tab's one head row, its ONE notice line (every strip it had, in one
// order, none dropped), the proposal as one entry band, and the states of opening.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, Proposal, Session, Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { initialState, type State } from "../../state.ts";
import { ShownPanels, ShownPanelsContext } from "../../completion-notifications.ts";
import { AppearanceContext, DEFAULT_APPEARANCE } from "../../appearance.ts";
import { DocContext } from "../DocCards.tsx";
import DocumentView from "./DocumentView.tsx";

const office = vi.hoisted(() => ({ props: null as null | { onWarning?: (warning: string) => void } }));
vi.mock("./OfficeEditor.tsx", async () => {
  const React = await import("react");
  return { OfficeEditor: React.forwardRef((props: { onWarning?: (warning: string) => void }, _ref) => { office.props = props; return React.createElement("div", { "data-testid": "office-editor" }); }) };
});

// The text editor is CodeMirror, which measures text jsdom cannot: a plain field stands in.
vi.mock("./MarkdownEditor.tsx", async () => {
  const React = await import("react");
  return { MarkdownEditor: ({ value, onChange, readOnly }: { value: string; onChange: (text: string) => void; readOnly?: boolean }) => React.createElement("textarea", { "data-testid": "source", value, readOnly, onChange: (event: { target: { value: string } }) => onChange(event.target.value) }) };
});

let rect: typeof Element.prototype.getBoundingClientRect;
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  // A wide pane: the embedded editors stay (the narrow-pane rule is DocumentView.narrow.test's).
  rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = () => ({ width: 1100, height: 800, top: 0, left: 0, right: 1100, bottom: 800, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); Element.prototype.getBoundingClientRect = rect; office.props = null; });
// These open documents in their editor: the person's choice "편집기로 바로 열기" (the default is 쪽 보기 first since doc-default).
beforeEach(() => { localStorage.setItem("workbench.docOpen", "editor"); });

const work = { id: "w", title: "강의", cwd: "/w", folderId: null, archivedAt: null } as unknown as Work;
const chat = { id: "chat", workId: "w", provider: "codex", purpose: "슬라이드 정리", status: "idle", queued: [], archivedAt: null, createdAt: 1, updatedAt: 1 } as unknown as Session;
const agentOf = (status = "idle") => ({ id: "a", workId: "w", provider: "codex", purpose: "메모 문서 AI", status, queued: [], archivedAt: null, createdAt: 1, updatedAt: 1, documentAgent: { artifactId: "doc", parentSessionId: "chat" } }) as unknown as Session;
const proposalOf = (id: string, extra: Partial<Proposal> = {}) => ({ id, artifactId: "doc", sessionId: "a", status: "pending", baseRevision: 1, added: 3, removed: 1, createdAt: 10, ...extra }) as unknown as Proposal;

function open({ format = "text" as Artifact["format"], name = "메모.txt", revision = 1, readBy = {} as Record<string, number>, diskState = "same", status = "idle", proposals = [] as Proposal[], gone = false, elsewhere = false, empty = false, onBack = vi.fn() } = {}) {
  const artifact = { id: "doc", workId: "w", name, path: `/w/${name}`, format, revision, sha256: "", size: 4, diskState, readBy, createdAt: 1, updatedAt: 1 } as Artifact;
  const registerDocument = vi.fn(async (artifactId: string, input: { viewId: string; windowId: string; sessionId?: string | null }) => {
    const view = { artifactId, viewId: input.viewId, windowId: input.windowId, sessionId: input.sessionId ?? null, revision, dirty: false, label: "", mode: elsewhere ? "read" : "write", expiresAt: Date.now() + 60_000 };
    // Open for editing elsewhere: another window holds the writer lease, this view only reads.
    return elsewhere ? { view, writer: { ...view, viewId: "other", windowId: "other-window", mode: "write" }, writeToken: null } : { view, writer: null, writeToken: "lease" };
  });
  const agent = agentOf(status);
  const known: Record<string, unknown> = {
    registerDocument, documentSession: vi.fn(async () => agent), closeDocument: vi.fn(async () => undefined), documentViews: vi.fn(async () => ({ views: [] })),
    artifactText: vi.fn(async (_id: string, at?: number) => ({ artifact, revision: at ?? revision, text: at ? "옛 본문" : empty ? "" : "본문", editable: true, view: false })),
    revisions: vi.fn(async () => [{ revision: 1, author: "user", at: 1, sessionId: null, note: null }]),
    request: vi.fn(async (_method: string, _path: string, body?: { channel?: string }) => body?.channel === "home:get-ai-panel-prefs" ? { showAiSidebar: false } : {}),
  };
  const api: Api = new Proxy(known, {
    get: (target, key: string) => (key === "forDocument" ? () => api : key in target ? target[key] : key === "then" ? undefined : vi.fn(async () => ({}))),
  }) as unknown as Api;
  const state: State = { ...initialState, ready: true, works: { w: work }, artifacts: gone ? {} : { doc: artifact }, sessions: { chat, a: agent }, transcripts: { a: { items: [] } as unknown as State["transcripts"][string] }, proposals: Object.fromEntries(proposals.map((proposal) => [proposal.id, proposal])) };
  const onToast = vi.fn();
  render(
    <AppearanceContext.Provider value={{ lookOf: (provider: "codex" | "claude") => DEFAULT_APPEARANCE[provider].light } as React.ContextType<typeof AppearanceContext>}>
    <ShownPanelsContext.Provider value={new ShownPanels()}>
    <DocContext.Provider value={{ state, actions: new Proxy({}, { get: () => vi.fn() }) } as never}>
      <DocumentView api={api} state={state} artifactId="doc" focusProposalId={null} work={work} session={chat} onBack={onBack}
        onSend={vi.fn() as never} onPickTarget={async () => null} onAiSettings={() => undefined} onExternalSetup={() => undefined}
        onOpenArtifact={() => undefined} onToast={onToast} onRead={() => undefined} onBeside={() => undefined} />
    </DocContext.Provider>
    </ShownPanelsContext.Provider>
    </AppearanceContext.Provider>,
  );
  return { onToast, onBack, registerDocument, request: known.request as ReturnType<typeof vi.fn> };
}

const line = () => document.querySelectorAll<HTMLElement>(".doc-notice");
const shown = () => [...document.querySelectorAll<HTMLElement>(".doc-notice > .doc-notice-row")].map((row) => row.dataset.kind);
const others = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /^알림 \d+건 더 보기(, 오류 포함)?$/ }));
  const list = await screen.findByRole("dialog", { name: "이 문서의 다른 알림" });
  return { list, kinds: [...list.querySelectorAll<HTMLElement>(".doc-notice-row")].map((row) => row.dataset.kind) };
};

describe("one notice line under the head", () => {
  it("shows the most urgent notice with its keys; the others wait behind 외 N건, each with its keys — nothing dropped", async () => {
    open({ revision: 2, readBy: { chat: 1 }, diskState: "changed", status: "awaitingApproval" });
    await waitFor(() => expect(shown()).toEqual(["agent-waits"]));
    expect(line()).toHaveLength(1);
    expect(within(line()[0]).getByRole("button", { name: "열기" })).toBeTruthy();
    expect(within(line()[0]).getByRole("button", { name: "알림 2건 더 보기" }).textContent).toContain("외 2건");
    const { list, kinds } = await others();
    expect(kinds).toEqual(["disk-changed", "readers"]);
    expect(within(list).getByRole("button", { name: "새 판으로 받기" })).toBeTruthy();
    expect(list.textContent).toContain("슬라이드 정리: 1판을 읽었습니다. 문서는 지금 2판입니다.");
  });

  it("an unsaved-edit conflict always wins the line, holds the view's one filled key, and keeps its three keys", async () => {
    // Edits from an earlier revision, kept on this device: opened over revision 2 they are a conflict.
    localStorage.setItem("workbench.docDraft.doc.old-view", JSON.stringify({ baseRevision: 1, text: "내 편집", at: 5 }));
    open({ revision: 2, readBy: { chat: 2 }, diskState: "changed", status: "awaitingApproval", proposals: [proposalOf("p1", { baseRevision: 2 })] });
    await waitFor(() => expect(shown()).toEqual(["conflict"]));
    const conflict = line()[0];
    expect(within(conflict).getByRole("alert").textContent).toMatch(/^저장하지 않았습니다\. /);
    expect(within(conflict).getAllByRole("button").map((key) => key.textContent?.trim())).toEqual(["차이 보기", "최신 판 받기(내 편집은 보관)", "내 편집을 새 판으로", "외 2건"]);
    expect(within(conflict).getByRole("button", { name: "내 편집을 새 판으로" }).className).toContain("primary");
    // The proposal's 적용 is not a second filled key while the conflict holds it.
    const band = document.querySelector<HTMLElement>(".doc-proposal-band")!;
    expect(within(band).getByRole("button", { name: "적용" }).className).not.toContain("primary");
    expect(document.querySelector(".doc-header .save-state")?.textContent).toBe("충돌");
    expect((await others()).kinds).toEqual(["agent-waits", "disk-changed"]);
    // A reading of the current revision is not a standing line: ⋯ lists it.
    fireEvent.click(screen.getByRole("button", { name: "문서 메뉴" }));
    expect((await screen.findByRole("group", { name: "이 판을 읽은 대화 1" })).textContent).toContain("슬라이드 정리");
  });

  it("read-only because the document is open for editing elsewhere: said in the line, with 편집 권한 받기", async () => {
    open({ elsewhere: true });
    await waitFor(() => expect(shown()).toEqual(["read-only"]));
    expect(line()[0].textContent).toContain("다른 탭이나 창에서 편집 중입니다. 이곳에서는 읽기만 할 수 있습니다.");
    expect(within(line()[0]).getByRole("button", { name: "편집 권한 받기" })).toBeTruthy();
  });
});

describe("the Hangul safety net, as notices", () => {
  it("a text edit an earlier version never saved, and a save that may have lost something or went unchecked: each still appears, with its keys", async () => {
    localStorage.setItem("workbench.docDraft.doc.legacy", JSON.stringify({ baseRevision: 1, text: "옛 글 편집", at: 3 }));
    const { onToast } = open({ format: "hwpx", name: "보고서.hwpx" });
    await screen.findByTestId("office-editor");
    await waitFor(() => expect(shown()).toEqual(["hangul-draft"]));
    expect(line()[0].textContent).toContain("이전 버전에서 저장하지 않은 글 편집이 남아 있습니다(1판).");
    expect(within(line()[0]).getByRole("button", { name: "복구본 검토" })).toBeTruthy();
    expect(within(line()[0]).getByRole("button", { name: "복구본을 새 판으로 저장" })).toBeTruthy();
    const LOSS = "새 파일에 저장했지만 저장본에 빠진 내용이 있습니다 (표 1→0). 원본 파일은 그대로입니다.";
    const UNCHECKED = "저장했습니다. 이 문서는 저장 검사를 하지 못했습니다.";
    await waitFor(() => expect(office.props?.onWarning).toBeTypeOf("function"));
    office.props!.onWarning!(LOSS);
    office.props!.onWarning!(UNCHECKED);
    // A save that may have lost something is work at stake: it leads the line (an error), the unchecked
    // save and the earlier draft wait behind it — none dropped (re-review 1).
    await waitFor(() => expect(shown()).toEqual(["hangul-warning"]));
    expect(line()[0].textContent).toContain(LOSS);
    const { list, kinds } = await others();
    expect(kinds).toEqual(["hangul-warning", "hangul-draft"]);
    expect(list.textContent).toContain(UNCHECKED);
    // Kept until the person closes it (not a passing notice).
    expect(onToast).not.toHaveBeenCalledWith(LOSS);
    fireEvent.click(within(list).getAllByRole("button", { name: "닫기" })[0]);
    await waitFor(() => expect(document.querySelector(".doc-notice")?.textContent).toContain("외 1건"));
  });
});

describe("the AI's proposal is one entry band", () => {
  it("who proposes what, its facts in words, 비교 · 취소 and the one filled 적용", async () => {
    open({ format: "markdown", name: "강의안.md", proposals: [proposalOf("p1")] });
    const band = await waitFor(() => { const found = document.querySelector<HTMLElement>(".doc-proposal-band"); expect(found).toBeTruthy(); return found!; });
    expect(document.querySelectorAll(".doc-proposal-band")).toHaveLength(1);
    expect(band.classList.contains("entry")).toBe(true);
    expect(band.textContent).toContain("Codex의 수정안");
    expect(band.textContent).toContain("1판 기준");
    expect(band.textContent).toContain("3줄 더함, 1줄 뺌");
    expect(band.textContent).not.toMatch(/r1|\+3|−1| · /);
    expect(within(band).getAllByRole("button").map((key) => key.textContent)).toEqual(["비교", "취소", "적용"]);
    expect(within(band).getByRole("button", { name: "적용" }).className).toContain("primary");
  });

  it("several waiting proposals: the newest leads, the others behind 외 N건 with the same keys", async () => {
    open({ format: "markdown", name: "강의안.md", proposals: [proposalOf("old", { createdAt: 1, added: 1, removed: 0 }), proposalOf("new", { createdAt: 9 })] });
    const band = await waitFor(() => { const found = document.querySelector<HTMLElement>(".doc-proposal-band"); expect(found).toBeTruthy(); return found!; });
    expect(band.textContent).toContain("3줄 더함, 1줄 뺌");
    fireEvent.click(within(band).getByRole("button", { name: "수정안 1건 더 보기" }));
    const list = await screen.findByRole("dialog", { name: "이 문서의 다른 수정안" });
    expect(list.textContent).toContain("1줄 더함");
    expect(within(list).getAllByRole("button").map((key) => key.textContent)).toEqual(["비교", "취소", "적용"]);
    expect(within(list).getByRole("button", { name: "적용" }).className).not.toContain("primary");
  });
});

describe("one head row for every kind of document", () => {
  it.each([["text", "메모.txt"], ["markdown", "강의안.md"], ["docx", "계획.docx"], ["hwpx", "보고서.hwpx"], ["pdf", "논문.pdf"], ["epub", "책.epub"]] as const)("%s: back, kind and title, save state in words | the view switch, 문서 AI, ⋯ — nothing else", async (format, name) => {
    open({ format, name });
    const head = await waitFor(() => { const found = document.querySelector<HTMLElement>(".doc-header"); expect(found).toBeTruthy(); return found!; });
    await waitFor(() => expect(head.querySelector(".save-state")?.textContent).toMatch(/판/));
    expect(head.querySelector(".doc-name")?.textContent).toBe(name);
    const keys = within(head).getAllByRole("button").filter((key) => !key.closest("[role=radiogroup]")).map((key) => key.getAttribute("aria-label") ?? key.textContent);
    expect(keys).toEqual(["대화로 돌아가기", "문서 AI", "문서 메뉴"]);
    expect(head.textContent).not.toMatch(/ · |r\d/);
  });

  it("⋯ holds what the head held: 나란히, 읽기, 판 기록, 새 문서, 파일 열기 — and the views where the kind has them", async () => {
    open({ format: "markdown", name: "강의안.md" });
    fireEvent.click(await screen.findByRole("button", { name: "문서 메뉴" }));
    const menu = await screen.findByRole("menu", { name: "문서 메뉴" });
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["편집", "원문", "둘 다", "미리보기"]);
    for (const name of [/대화 옆에 놓기/, /^읽기/, /판 기록/, /새 문서/, /파일 열기/, /앱으로 열기/, /내보내기/, /편집 명령 찾기/]) expect(within(menu).getByRole("menuitem", { name })).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /내보내기/ }));
    for (const name of ["PDF로 내보내기", "Word로 내보내기", "ODT로 내보내기", "PNG 그림으로 내보내기", "Word로 변환해 열기"]) expect(await screen.findByRole("menuitem", { name })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /뒤로/ }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: /판 기록/ }));
    expect(await screen.findByRole("menuitemradio", { name: /^1판 내 편집/ })).toBeTruthy();
  });
});

describe("the editor's own panel is 문서 AI; a person who turned it off gets it back from ⋯ (I7, one-doc-ai)", () => {
  /** The editor reports its panel as the vendored editors do through editor-ai-dock.ts. */
  const report = (patch: { open?: boolean; off?: boolean } = {}) => act(() => { (office.props as { onAiPanel?: (open: boolean, draft?: string, dock?: object) => void }).onAiPanel?.(patch.open ?? false, "", { ready: true, person: false, shown: patch.open ?? false, ...(patch.off ? { off: true } : {}) }); });
  it.each([["docx", "계획.docx"], ["pdf", "논문.pdf"], ["markdown", "강의안.md"]] as const)("%s: ⋯ 편집기 안에 문서 AI 다시 켜기, only while the panel is off, turns it back on", async (format, name) => {
    const { request } = open({ format, name });
    await screen.findByTestId("office-editor");
    report();
    fireEvent.click(await screen.findByRole("button", { name: "문서 메뉴" }));
    let menu = await screen.findByRole("menu", { name: "문서 메뉴" });
    expect(within(menu).queryByRole("menuitem", { name: /문서 AI 다시 켜기/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /AI 도우미/ })).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    report({ off: true });
    fireEvent.click(await screen.findByRole("button", { name: "문서 메뉴" }));
    menu = await screen.findByRole("menu", { name: "문서 메뉴" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "편집기 안에 문서 AI 다시 켜기" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("POST", "/api/office-preferences", { channel: "home:set-ai-panel-prefs", args: [{ showAiSidebar: true }] }));
  });
  it("a PDF whose panel is off: 문서 AI is the column, and its empty conversation says only the editor's 문서 AI writes to the PDF — with the key that turns it back on", async () => {
    const { request } = open({ format: "pdf", name: "논문.pdf" });
    await screen.findByTestId("office-editor");
    report({ off: true });
    fireEvent.click(await screen.findByRole("button", { name: "문서 AI" }));
    const line = await screen.findByRole("status", { name: "PDF에 직접 쓰기" });
    expect(line.textContent).toContain("PDF에 직접 쓰는 일은 편집기 안의 문서 AI가 합니다.");
    fireEvent.click(within(line).getByRole("button", { name: "편집기 안 문서 AI" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("POST", "/api/office-preferences", { channel: "home:set-ai-panel-prefs", args: [{ showAiSidebar: true }] }));
  });
  it("another document's 문서 AI does not say it", async () => {
    open({ format: "docx", name: "계획.docx" });
    await screen.findByTestId("office-editor");
    report({ off: true });
    fireEvent.click(await screen.findByRole("button", { name: "문서 AI" }));
    await screen.findByText("요청을 보내면 여기에 대화가 이어집니다.");
    expect(screen.queryByRole("status", { name: "PDF에 직접 쓰기" })).toBeNull();
  });
  it("Hangul has none: its dock is the head's 문서 AI", async () => {
    open({ format: "hwpx", name: "보고서.hwpx" });
    fireEvent.click(await screen.findByRole("button", { name: "문서 메뉴" }));
    const menu = await screen.findByRole("menu", { name: "문서 메뉴" });
    expect(within(menu).queryByRole("menuitem", { name: /문서 AI 다시 켜기|AI 도우미/ })).toBeNull();
  });
});

describe("the head by keyboard", () => {
  it("Tab order: back, the views, 문서 AI, ⋯; ↓ on ⋯ opens its menu on its first item, Escape closes it and focus is back on ⋯", async () => {
    open({ format: "markdown", name: "강의안.md" });
    const head = await waitFor(() => { const found = document.querySelector<HTMLElement>(".doc-header"); expect(found).toBeTruthy(); return found!; });
    const order = [...head.querySelectorAll<HTMLElement>("button")].filter((key) => !key.hasAttribute("disabled") && key.tabIndex >= 0).map((key) => key.getAttribute("aria-label") ?? key.textContent);
    expect(order).toEqual(["대화로 돌아가기", "편집", "원문", "둘 다", "미리보기", "문서 AI", "문서 메뉴"]);
    const more = screen.getByRole("button", { name: "문서 메뉴" });
    more.focus();
    fireEvent.keyDown(more, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu", { name: "문서 메뉴" });
    expect(more.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "문서 메뉴" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(more));
  });
});

describe("states of the document tab", () => {
  it("opening: a page-shaped skeleton, never 불러오는 중", async () => {
    open();
    expect(screen.getByRole("status", { name: "문서를 여는 중" }).querySelector(".doc-skeleton-page")).toBeTruthy();
    expect(document.body.textContent).not.toContain("불러오는 중");
  });

  it("an empty new document read in 미리보기: what it is and two ways to start", async () => {
    open({ format: "markdown", name: "새 문서.md", empty: true });
    fireEvent.click(await screen.findByRole("radio", { name: "미리보기" }));
    const empty = await waitFor(() => { const found = document.querySelector<HTMLElement>(".doc-empty"); expect(found).toBeTruthy(); return found!; });
    expect(empty.textContent).toContain("빈 문서입니다.");
    expect(within(empty).getByRole("button", { name: "편집" })).toBeTruthy();
    fireEvent.click(within(empty).getByRole("button", { name: "문서 AI 열기" }));
    await waitFor(() => expect(document.querySelector(".agent-column")).toBeTruthy());
  });

  it("cannot open: what happened, what to do, and one key", async () => {
    const { onBack } = open({ gone: true });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("이 문서를 열 수 없습니다.");
    expect(alert.textContent).toContain("다시 찾아 여세요");
    fireEvent.click(within(alert).getByRole("button", { name: "대화로 돌아가기" }));
    expect(onBack).toHaveBeenCalled();
  });
});
