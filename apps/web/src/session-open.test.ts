import { describe, expect, it } from "vitest";
import type { Session } from "@workbench/contracts";
import { focusedPane, setPane, type Layout, type PaneContent } from "./panes.ts";
import { activeTab, contentKey, findTab, tabsOf, withTabs } from "./tabs.ts";
import { landingPane, restoredAgentPlan, sessionEntries, type RouteView } from "./session-route.ts";

// One opener for a conversation, whatever was clicked. A live document AI always ends beside its
// document — in the pane where that document is, or opens — with a request to bring its
// conversation out. An archived one, or one whose document is gone, opens as the read-only
// conversation it is.

type View = RouteView | { kind: "new" };
const session = (id: string, extra: Partial<Session> = {}) => ({ id, workId: "w", archivedAt: null, ...extra }) as unknown as Session;
const docAi = (id: string, artifactId = "lecture", extra: Partial<Session> = {}) => session(id, { documentAgent: { artifactId, parentSessionId: "chat" }, ...extra } as Partial<Session>);

const STATES = {
  live: { ai: docAi("ai"), documents: ["lecture"] },
  archived: { ai: docAi("ai", "lecture", { archivedAt: 9 }), documents: ["lecture"] },
  "document gone": { ai: docAi("ai", "lecture", { archivedAt: 9 }), documents: [] as string[] },
  "live, document gone": { ai: docAi("ai"), documents: [] as string[] },
} as const;

/** The app's side of the opener: real panes and tabs, a list of reveal requests. */
function desk(start: Layout<View>, known: { ai: Session; documents: readonly string[] }) {
  let layout = withTabs(start);
  const revealed: { artifactId: string; sessionId: string }[] = [];
  const navigate = (content: PaneContent<View>, opened?: () => void) => {
    const id = landingPane(layout, content);
    layout = withTabs({ ...setPane(layout, id, content), focus: id }, layout);
    opened?.();
  };
  const entries = sessionEntries({
    find: (id) => (id === known.ai.id ? known.ai : undefined),
    hasDocument: (id) => known.documents.includes(id),
    navigate,
    reveal: (artifactId, request) => revealed.push({ artifactId, ...request }),
    conversation: (shown, _work, opened) => navigate({ workId: shown.workId, sessionId: shown.id, view: { kind: "work" } }, opened),
  });
  return { entries, revealed, layout: () => layout };
}

const one = (): Layout<View> => ({ panes: [{ id: "a", view: { kind: "work" }, workId: "w", sessionId: "chat" }], focus: "a" });
/** The conversation has the focus; the document is open in the other pane, showing another of its AIs. */
const two = (): Layout<View> => ({
  panes: [
    { id: "a", view: { kind: "work" }, workId: "w", sessionId: "chat" },
    { id: "b", view: { kind: "document", artifactId: "lecture", proposalId: null }, workId: "w", sessionId: "other-ai" },
  ],
  focus: "a",
});

// Every way a person opens a conversation, by the shape of what the control hands over.
const ENTRY_POINTS: [string, (entries: ReturnType<typeof sessionEntries>, ai: Session) => void][] = [
  ["왼쪽 사이드바의 대화 줄", (entries, ai) => entries.open(ai)],
  ["왼쪽 사이드바의 문서 줄(AI 표시)", (entries, ai) => entries.documentRow({ id: ai.documentAgent!.artifactId }, ai)],
  ["문서 줄 메뉴 › 문서 AI › 열기", (entries, ai) => entries.open(ai)],
  ["오른쪽 사이드바 연결 줄", (entries, ai) => entries.open(ai)],
  ["세션 전환기 (Ctrl+Tab)", (entries, ai) => entries.open(ai)],
  ["완료 알림 › 열기", (entries, ai) => entries.byId(ai.id)],
  ["프로젝트 쪽 확인 필요 · 대화 카드", (entries, ai) => entries.open(ai)],
  ["위 막대 확인 N · 세션 탭", (entries, ai) => entries.select({ id: ai.workId }, ai)],
  ["문서 카드·세션 잇기의 대화 열기", (entries, ai) => entries.byId(ai.id)],
  ["알림 센터 · 시스템 알림", (entries, ai) => entries.openThen(ai, () => undefined)],
];

describe("opening a document AI: entry point × state", () => {
  it.each(ENTRY_POINTS)("%s — live: beside its document, its conversation asked for", (_, click) => {
    const at = desk(one(), STATES.live);
    click(at.entries, STATES.live.ai);
    const shown = focusedPane(at.layout());
    expect(shown.view).toEqual({ kind: "document", artifactId: "lecture", proposalId: null });
    expect(shown.sessionId).toBe("ai");
    expect(at.revealed).toEqual([{ artifactId: "lecture", sessionId: "ai" }]);
  });

  it.each(ENTRY_POINTS)("%s — live, document open in the other pane: that pane, that AI, asked for there", (_, click) => {
    const at = desk(two(), STATES.live);
    click(at.entries, STATES.live.ai);
    const layout = at.layout();
    expect(layout.focus).toBe("b");
    expect(focusedPane(layout).sessionId).toBe("ai");
    expect(focusedPane(layout).view).toEqual({ kind: "document", artifactId: "lecture", proposalId: null });
    // The document is not opened a second time, and the conversation pane is as it was.
    expect(layout.panes.flatMap(tabsOf).filter((tab) => contentKey(tab) === "doc:lecture")).toHaveLength(1);
    expect(layout.panes[0]!.sessionId).toBe("chat");
    expect(at.revealed).toEqual([{ artifactId: "lecture", sessionId: "ai" }]);
  });

  it.each(ENTRY_POINTS.flatMap(([name, click]) => (["archived", "document gone", "live, document gone"] as const).map((state) => [name, state, click] as const)))(
    "%s — %s: the read-only conversation itself, nothing asked for",
    (_, state, click) => {
      const at = desk(one(), STATES[state]);
      click(at.entries, STATES[state].ai);
      const shown = focusedPane(at.layout());
      expect(shown.view).toEqual({ kind: "work" });
      expect(shown.sessionId).toBe("ai");
      expect(at.revealed).toEqual([]);
    },
  );

  it.each(Object.keys(STATES) as (keyof typeof STATES)[])("an 알림 (%s) runs what follows it only once the pane shows the conversation, wherever that is", (state) => {
    const at = desk(one(), STATES[state]);
    const seen: (string | null)[] = [];
    at.entries.openThen(STATES[state].ai, () => seen.push(focusedPane(at.layout()).sessionId));
    expect(seen).toEqual(["ai"]);
    // An archived document AI is the read-only conversation here too — not its document.
    expect(focusedPane(at.layout()).view.kind).toBe(state === "live" ? "document" : "work");
  });

  it("an id that names nothing opens nothing", () => {
    const at = desk(one(), STATES.live);
    at.entries.byId("gone");
    expect(focusedPane(at.layout()).sessionId).toBe("chat");
    expect(at.revealed).toEqual([]);
  });

  it("a chat opens as a conversation; a live web AI beside its page", () => {
    const chat = session("c2"), web = session("web", { pageAgent: { pageId: "p1", parentSessionId: "chat" } } as Partial<Session>);
    const at = desk(one(), { ai: chat, documents: [] });
    at.entries.open(chat);
    expect(focusedPane(at.layout())).toMatchObject({ view: { kind: "work" }, sessionId: "c2" });
    const page = desk(one(), { ai: web, documents: [] });
    page.entries.open(web);
    expect(focusedPane(page.layout())).toMatchObject({ view: { kind: "browser", pageId: "p1" }, sessionId: "web" });
    expect(page.revealed).toEqual([]);
  });
});

// 되돌리기 while the archived AI is on screen: its read-only tab gives way to its document, with it
// beside — never to another conversation of the project.
describe("a document AI restored while its read-only conversation is open", () => {
  const restored = docAi("ai");
  const has = (id: string) => id === "lecture";
  const reading = (): Layout<View> => withTabs({ panes: [{ id: "a", view: { kind: "work" }, workId: "w", sessionId: "ai" }], focus: "a" });

  it("on screen, its document not open: the same tab becomes the document, with it beside", () => {
    const layout = reading();
    const tab = activeTab(layout.panes[0]!);
    expect(restoredAgentPlan(layout, restored, has)).toEqual({ kind: "replace", tabId: tab.id, paneId: "a", shown: true, content: { workId: "w", sessionId: "ai", view: { kind: "document", artifactId: "lecture", proposalId: null } } });
  });

  it("on screen, its document open in another pane: go there with it, and the read-only tab closes", () => {
    const layout = withTabs({ panes: [...reading().panes, { id: "b", view: { kind: "document", artifactId: "lecture", proposalId: null }, workId: "w", sessionId: null }], focus: "a" } as Layout<View>);
    const tab = findTab(layout, "session:ai")!.tab;
    expect(restoredAgentPlan(layout, restored, has)).toMatchObject({ kind: "move", tabId: tab.id, paneId: "a", shown: true, content: { sessionId: "ai", view: { kind: "document", artifactId: "lecture" } } });
  });

  it("in a background tab: that tab becomes the document without taking the screen", () => {
    let layout = reading();
    layout = withTabs({ ...setPane(layout, "a", { view: { kind: "new" }, workId: null, sessionId: null }), focus: "a" }, layout);
    expect(restoredAgentPlan(layout, restored, has)).toMatchObject({ kind: "replace", shown: false });
  });

  it("보관함 opened from the read-only tab (보관함에서 보기) leaves that tab where it is, so the conversation still has a tab to come back in", () => {
    // As the app does it: the focused pane is given the 보관함 view, and the tabs are reconciled.
    const before = reading();
    const layout = withTabs({ ...setPane(before, "a", { view: { kind: "archive" } as unknown as View, workId: "w", sessionId: "ai" }), focus: "a" }, before);
    expect(tabsOf(layout.panes[0]!).map((tab) => contentKey(tab))).toEqual(["session:ai", JSON.stringify({ kind: "archive" })]);
    expect(activeTab(layout.panes[0]!).view).toEqual({ kind: "archive" });
    // The document restored there: the conversation's tab becomes the document, behind 보관함.
    expect(restoredAgentPlan(layout, restored, has)).toMatchObject({ kind: "replace", shown: false, content: { sessionId: "ai", view: { kind: "document", artifactId: "lecture" } } });
  });

  it.each([
    ["not open anywhere", () => withTabs(one()), restored],
    ["still archived", reading, docAi("ai", "lecture", { archivedAt: 9 })],
    ["its document still gone", reading, docAi("ai", "missing")],
    ["a chat", reading, session("ai")],
  ] as const)("%s: nothing moves", (_, layout, shown) => {
    expect(restoredAgentPlan(layout(), shown, has)).toEqual({ kind: "none" });
  });
});
