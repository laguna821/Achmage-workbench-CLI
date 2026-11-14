// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserPage, Session, TranscriptItem } from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { SharedBrowser } from "../browser-state.ts";
import { initialState, type State } from "../state.ts";
import { ShownPanels, ShownPanelsContext } from "../completion-notifications.ts";
import { AppearanceContext, DEFAULT_APPEARANCE } from "../appearance.ts";
import { persistDraft } from "../draft.ts";
import { DocContext } from "./DocCards.tsx";
import { BrowserView } from "./BrowserView.tsx";
import type { WorkActions } from "./WorkView.tsx";

// 곁 화면, from a web tab: the page's own AI is a conversation column beside the page — the
// conversation's note head, Transcript and composer — in place of the side panel.

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

const page = { pageId: "p", workId: "w", workspaceId: "ws", profileId: "default", driverId: "driver", sessionId: "web", status: "ready", url: "https://ctl.example.ac.kr/guide", title: "평가 루브릭 안내", control: { generation: 1 }, native: { loading: false, popups: [], permissions: [] } } as unknown as BrowserPage;
const MAIN = { id: "main", workId: "w", provider: "claude", purpose: "슬라이드 정리", status: "idle", queued: [], archivedAt: null, createdAt: 1, updatedAt: 1 } as unknown as Session;
const web = (extra: Partial<Session> = {}) => ({ id: "web", workId: "w", provider: "codex", purpose: "평가 루브릭 안내 · 웹 AI", status: "idle", queued: [], archivedAt: null, model: null, effort: null, createdAt: 1, updatedAt: 1, pageAgent: { pageId: "p", parentSessionId: "main" }, ...extra }) as unknown as Session;
const user = (id: string, text: string): TranscriptItem => ({ id, kind: "user", text, at: 1 }) as unknown as TranscriptItem;
const approval = (id: string): TranscriptItem => ({ id, kind: "approval", title: "이 페이지에서 눌러도 될까요?", detail: "click", decision: null, at: 2 }) as unknown as TranscriptItem;

function setup(options: { agent?: Session; items?: TranscriptItem[]; hosted?: boolean | { over: boolean; back?: string | null }; focus?: boolean } = {}) {
  const agent = options.agent ?? web();
  const data = { pages: [page], profiles: [{ id: "default", name: "기본" }], pending: {}, connected: true, error: null, closedPageIds: [] };
  const control = vi.fn(async () => undefined);
  const browser = {
    available: true, driverId: "driver", subscribe: () => () => undefined, getState: () => data,
    surface: vi.fn(() => () => undefined), session: vi.fn(async () => agent), restore: vi.fn(async () => undefined), control, action: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  } as unknown as SharedBrowser;
  const api = new Proxy({ items: vi.fn(async () => ({ items: options.items ?? [], hasMore: false })) }, { get: (target, key: string) => (key in target ? target[key as keyof typeof target] : key === "then" ? undefined : vi.fn(async () => ({}))) }) as unknown as Api;
  const models = [{ id: "fake", label: "Fake", description: null, efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true }];
  const state = { ...initialState, ready: true, sessions: { main: MAIN, web: agent }, transcripts: { web: { items: options.items ?? [], hasMore: false } }, providers: { codex: { models }, claude: { models } } } as unknown as State;
  const send = vi.fn(async () => true), answer = vi.fn(), queuedSend = vi.fn(), queuedCancel = vi.fn(), queuedEdit = vi.fn(), restore = vi.fn();
  const actions = new Proxy({}, { get: (_, key) => key === "send" ? send : key === "answer" ? answer : key === "restore" ? restore : key === "queued" ? { send: queuedSend, cancel: queuedCancel, edit: queuedEdit } : vi.fn() }) as unknown as WorkActions;
  const onOpenSession = vi.fn(), onSessionMenu = vi.fn();
  const hosted = options.hosted ? { onClose: vi.fn(), onWide: vi.fn(), over: typeof options.hosted === "object" ? options.hosted.over : false, back: typeof options.hosted === "object" ? options.hosted.back ?? null : null } : undefined;
  const panels = new ShownPanels();
  render(
    <AppearanceContext.Provider value={{ lookOf: (provider: "codex" | "claude") => DEFAULT_APPEARANCE[provider].light } as React.ContextType<typeof AppearanceContext>}>
    <ShownPanelsContext.Provider value={panels}>
    <DocContext.Provider value={{ state, actions: new Proxy({}, { get: () => vi.fn() }) } as never}>
      <BrowserView browser={browser} api={api} state={state} pageId="p" visible parentSessionId="main" actions={actions} onNew={() => undefined} onClosed={() => undefined}
        onTranscript={() => undefined} onOpenSession={onOpenSession} onSessionMenu={onSessionMenu} hosted={hosted}
        focusItem={options.focus ? { sessionId: "web", itemId: "u1", nonce: 1 } : null} onFocusDone={() => undefined} />
    </DocContext.Provider>
    </ShownPanelsContext.Provider>
    </AppearanceContext.Provider>,
  );
  return { browser, control, send, answer, restore, queuedSend, queuedCancel, onOpenSession, onSessionMenu, hosted, panels };
}
const column = () => document.querySelector<HTMLElement>(".agent-column");
const head = () => within(column()!.querySelector<HTMLElement>(".note-head")!);
const ask = () => screen.getByRole("button", { name: "AI에게 요청" });

describe("a web page's own AI, beside the page", () => {
  it("is a conversation column: a head naming whose it is, its transcript, and its input directly under that transcript", async () => {
    const at = setup({ items: [user("u1", "이 페이지의 평가 기준을 정리해 줘")] });
    expect(column()).toBeNull();
    fireEvent.click(ask());
    const chat = await waitFor(() => { const found = column(); expect(found).not.toBeNull(); return found!; });
    expect(within(chat).getByRole("heading", { level: 1 }).textContent).toBe("웹 AI · 평가 루브릭 안내");
    const transcript = within(chat).getByRole("region", { name: "Codex 대화" });
    expect(transcript.textContent).toContain("이 페이지의 평가 기준을 정리해 줘");
    const input = chat.querySelector("textarea")!;
    expect(transcript.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The side panel and the row of controls above its input are gone: one composer, as in a conversation.
    expect(document.querySelector(".browser-conversation, .side-chat-controls")).toBeNull();
    const bar = chat.querySelector<HTMLElement>(".composer-bar .composer-right")!;
    expect(within(bar).getByRole("button", { name: "Fake" })).toBeTruthy();
    // The conversation this AI was started from is one press away.
    fireEvent.click(head().getByRole("button", { name: /슬라이드 정리/ }));
    expect(at.onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: "main" }));
    await waitFor(() => expect(at.panels.ids()).toEqual(["web"]));
  });

  it("sends what is typed there to the page's AI, after giving it the page", async () => {
    const at = setup();
    fireEvent.click(ask());
    await waitFor(() => expect(column()?.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false));
    fireEvent.change(column()!.querySelector("textarea")!, { target: { value: "표로 정리해 줘" } });
    fireEvent.click(within(column()!).getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(at.send).toHaveBeenCalled());
    expect(at.control).toHaveBeenCalledWith("p", "web");
    expect((at.send.mock.calls[0] as unknown as [Session, string])[0].id).toBe("web");
    expect((at.send.mock.calls[0] as unknown as [Session, string])[1]).toBe("표로 정리해 줘");
  });

  it("text typed in the old side panel's input is in the column's input", async () => {
    persistDraft("browser:p:web", "쓰다 만 요청");
    setup();
    fireEvent.click(ask());
    await waitFor(() => expect(column()?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("쓰다 만 요청"));
  });

  it("carries the AI's own menu and the close button in its head; closing gives the page its width back", async () => {
    const at = setup();
    fireEvent.click(ask());
    await waitFor(() => expect(column()).not.toBeNull());
    fireEvent.click(head().getByRole("button", { name: "이 웹 AI 메뉴" }));
    expect(at.onSessionMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "web" }), expect.any(Number), expect.any(Number));
    fireEvent.click(head().getByRole("button", { name: "웹 AI 대화 닫기" }));
    await waitFor(() => expect(column()).toBeNull());
    expect(ask().getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(at.panels.ids()).toEqual([]));
  });

  it("a waiting approval is answered in the column, for that AI", async () => {
    const at = setup({ agent: web({ status: "awaitingApproval" }), items: [user("u1", "신청 버튼을 눌러 줘"), approval("ap1")] });
    fireEvent.click(ask());
    await waitFor(() => expect(column()).not.toBeNull());
    fireEvent.click(within(column()!).getByRole("button", { name: /허용/ }));
    expect(at.answer).toHaveBeenCalledWith(expect.objectContaining({ id: "web" }), "ap1", "accept");
  });

  it("shows its waiting requests as a conversation does: sent now only after the AI is given the page, or removed", async () => {
    const queued = [{ id: "q1", text: "다음 쪽도 봐 줘", refs: [], create: null, at: 3, held: true }];
    const at = setup({ agent: web({ queued } as unknown as Partial<Session>) });
    fireEvent.click(ask());
    const list = await screen.findByRole("list", { name: "끝나면 보낼 요청" });
    expect(list.textContent).toContain("다음 쪽도 봐 줘");
    fireEvent.click(within(list).getByRole("button", { name: "지금 보내기" }));
    await waitFor(() => expect(at.queuedSend).toHaveBeenCalledWith(expect.objectContaining({ id: "web" }), "q1"));
    expect(at.control).toHaveBeenCalledWith("p", "web");
    fireEvent.click(within(list).getByRole("button", { name: "지우기" }));
    expect(at.queuedCancel).toHaveBeenCalledWith(expect.objectContaining({ id: "web" }), "q1");
  });

  it("opens by itself for a notice or a search hit in its conversation", async () => {
    setup({ focus: true, items: [user("u1", "이 페이지의 평가 기준을 정리해 줘")] });
    await waitFor(() => expect(column()).not.toBeNull());
  });
});

describe("the page's AI was archived", () => {
  it("is read-only like every archived conversation: its record, one line with 되돌리기 where the input was, nothing answered or sent", async () => {
    const queued = [{ id: "q1", text: "다음 쪽도 봐 줘", refs: [], create: null, at: 3, held: true }];
    const at = setup({ agent: web({ archivedAt: 9, status: "awaitingApproval", queued } as unknown as Partial<Session>), items: [user("u1", "신청 버튼을 눌러 줘"), approval("ap1")] });
    fireEvent.click(ask());
    await waitFor(() => expect(column()?.textContent).toContain("신청 버튼을 눌러 줘"));
    expect(column()!.querySelector("textarea")).toBeNull();
    expect(within(column()!).queryByRole("button", { name: "보내기" })).toBeNull();
    expect(within(column()!).queryByRole("button", { name: /허용/ })).toBeNull();
    // Its kept request stays visible, with nothing to send it by.
    expect(column()!.textContent).toContain("다음 쪽도 봐 줘");
    expect(within(column()!).queryByRole("button", { name: /지금 보내기|지금 끼어들기|고치기|지우기/ })).toBeNull();
    const banner = column()!.querySelector<HTMLElement>(".composer-area .note-banner")!;
    expect(banner.textContent).toMatch(/보관한 대화입니다/);
    fireEvent.click(within(banner).getByRole("button", { name: "되돌리기" }));
    expect(at.restore).toHaveBeenCalledWith({ kind: "session", id: "web" });
    expect(column()!.querySelector(".note-head")!.textContent).toContain("보관됨");
    expect(at.send).not.toHaveBeenCalled();
    expect(at.panels.ids()).toEqual([]);
  });
});

describe("a web page beside a conversation (that conversation's companion)", () => {
  it("has no conversation of its own on screen: asking goes to the conversation it is beside", async () => {
    const at = setup({ hosted: true });
    expect(screen.queryByRole("button", { name: "AI에게 요청" })).toBeNull();
    expect(column()).toBeNull();
    expect(document.querySelector(".hig-composer, .composer")).toBeNull();
    expect(at.panels.ids()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "탭으로 넓게 열기" }));
    expect(at.hosted!.onWide).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "곁 화면 닫기" }));
    expect(at.hosted!.onClose).toHaveBeenCalledTimes(1);
    // Closing what is beside the conversation never closes the page itself.
    expect((at.browser as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
  });

  it("its × says the page stays as a tab; laid over the conversation it carries a labelled ← 대화 instead", async () => {
    const beside = setup({ hosted: { over: false } });
    expect(screen.getByRole("button", { name: "곁 화면 닫기" }).getAttribute("title")).toMatch(/탭으로 남/);
    expect(screen.queryByRole("button", { name: "대화" })).toBeNull();
    void beside;
    cleanup();
    const over = setup({ hosted: { over: true } });
    expect(screen.queryByRole("button", { name: "곁 화면 닫기" })).toBeNull();
    const back = screen.getByRole("button", { name: "대화" });
    expect(back.textContent).toContain("대화");
    fireEvent.click(back);
    expect(over.hosted!.onClose).toHaveBeenCalledTimes(1);
  });

  it("laid over a conversation waiting for an approval, ← 대화 says so", () => {
    const over = setup({ hosted: { over: true, back: "승인 필요" } });
    fireEvent.click(screen.getByRole("button", { name: /대화 · 승인 필요/ }));
    expect(over.hosted!.onClose).toHaveBeenCalledTimes(1);
  });
});
