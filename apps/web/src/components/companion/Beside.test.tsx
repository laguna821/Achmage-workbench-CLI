// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { Beside, besideRoom, useBesideReplaces } from "./Beside.tsx";
import { sidebarDocks } from "../right/RightSidebar.tsx";
import { approvalKeyApplies } from "../../conversation/approval-keys.ts";

// 곁 화면's layout: a conversation column and what it is about, side by side while both keep their
// minimum, otherwise one laid over the other. A side that stays is never remounted.

const host = { width: 1200, resize: [] as (() => void)[] };
const mounts = { chat: 0, content: 0, chatGone: 0, contentGone: 0 };
// "(pointer: coarse), (width < 40rem)": a phone. Off unless a test turns it on.
const phone = { matches: false };
beforeEach(() => {
  host.width = 1200; host.resize = [];
  phone.matches = false;
  vi.stubGlobal("matchMedia", (query: string) => ({ get matches() { return query.includes("coarse") ? phone.matches : false; }, media: query, addEventListener() {}, removeEventListener() {} }));
  mounts.chat = 0; mounts.content = 0; mounts.chatGone = 0; mounts.contentGone = 0;
  vi.stubGlobal("ResizeObserver", class { constructor(changed: () => void) { host.resize.push(changed); } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains("beside") ? host.width : 0;
    return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function Side({ name }: { name: "chat" | "content" }) {
  useEffect(() => { mounts[name] += 1; return () => { mounts[`${name}Gone`] += 1; }; }, [name]);
  return <button type="button">{name}</button>;
}
function CloseKey() {
  return useBesideReplaces() ? <span>no close</span> : <button type="button">닫기</button>;
}
const view = (options: { chat?: boolean; content?: boolean; over?: "chat" | "content"; contentMin?: number; onRatio?: (ratio: number) => void; onDismiss?: () => void; onCovered?: (covered: boolean) => void } = {}) => (
  <Beside chat={options.chat === false ? null : <Side name="chat" />} content={options.content === false ? null : <Side name="content" />} over={options.over ?? "content"}
    contentMin={options.contentMin} ratio={0.4} onRatio={options.onRatio ?? (() => undefined)} chatLabel="대화" contentLabel="문서" onDismiss={options.onDismiss} onCovered={options.onCovered} />
);
const root = () => document.querySelector<HTMLElement>(".beside")!;
const resize = (width: number) => act(() => { host.width = width; host.resize.forEach((changed) => changed()); });

describe("a conversation and what is beside it", () => {
  it("the conversation is never remounted when its companion comes and goes", () => {
    const shown = render(view({ content: false }));
    expect(root().dataset.fit).toBe("single");
    shown.rerender(view());
    expect(root().dataset.fit).toBe("beside");
    shown.rerender(view({ content: false }));
    shown.rerender(view());
    expect(mounts.chat).toBe(1);
    expect(mounts.chatGone).toBe(0);
    expect(mounts.content).toBe(2);
  });

  it("a document is never remounted when its AI's conversation comes and goes", () => {
    const shown = render(view({ chat: false, over: "chat" }));
    shown.rerender(view({ over: "chat" }));
    shown.rerender(view({ chat: false, over: "chat" }));
    shown.rerender(view({ over: "chat" }));
    expect(mounts.content).toBe(1);
    expect(mounts.contentGone).toBe(0);
  });

  it("names its two columns, with a handle between them that keys and a double press move", () => {
    const onRatio = vi.fn();
    render(view({ onRatio }));
    expect(screen.getByRole("region", { name: "대화" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "문서" })).toBeTruthy();
    const handle = screen.getByRole("separator", { name: "대화와 문서 사이" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onRatio).toHaveBeenLastCalledWith(expect.closeTo(0.42, 5));
    fireEvent.doubleClick(handle);
    expect(onRatio).toHaveBeenLastCalledWith(0.4);
  });

  it("side by side, the conversation keeps its minimum and never takes the other below its own", async () => {
    render(view({ contentMin: 680 }));
    // 1200 − 7 − 680 = 513 left; 40% of the room is 477.
    expect(screen.getByRole("region", { name: "대화" }).style.flex).toBe("0 0 477px");
    await resize(1060);
    expect(screen.getByRole("region", { name: "대화" }).style.flex).toBe("0 0 373px");
  });
});

describe("no room for both", () => {
  it("a document beside a conversation fills the tab over it: the conversation under it takes no keys and is not read out", async () => {
    render(view({ contentMin: 680 }));
    await resize(1000);
    expect(root().dataset.fit).toBe("over");
    const chat = document.querySelector<HTMLElement>(".beside-chat")!;
    expect(chat.hasAttribute("inert")).toBe(true);
    expect(chat.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("separator")).toBeNull();
    expect(document.querySelector(".beside-scrim")).toBeNull();
    // Both are the same views as before.
    expect(mounts.chat).toBe(1);
    expect(mounts.content).toBe(1);
  });

  // A tab behind another has no width. What was measured last stands while it is hidden, so the
  // app still knows its conversation is covered (a click on that conversation's row brings it back).
  it("a tab sent behind (width 0) keeps its last measured state: still covered, nothing remounted", async () => {
    const onCovered = vi.fn();
    render(view({ contentMin: 680, onCovered }));
    await resize(1000);
    expect(onCovered).toHaveBeenLastCalledWith(true);
    await resize(0);
    expect(onCovered).toHaveBeenLastCalledWith(true);
    expect(root().dataset.fit).toBe("over");
    await resize(1000);
    expect(onCovered).toHaveBeenLastCalledWith(true);
    expect(mounts).toMatchObject({ chat: 1, content: 1, chatGone: 0, contentGone: 0 });
  });
  it("a pane never measured (width 0 from the start) is taken as side by side: nothing is said covered", () => {
    host.width = 0;
    const onCovered = vi.fn();
    render(view({ contentMin: 680, onCovered }));
    expect(onCovered).not.toHaveBeenCalledWith(true);
  });

  it("says when the conversation is covered and when it is back, so a covered conversation is not taken for one on screen", async () => {
    const onCovered = vi.fn();
    const shown = render(view({ contentMin: 680, onCovered }));
    expect(onCovered).not.toHaveBeenCalledWith(true);
    await resize(1000);
    expect(onCovered).toHaveBeenLastCalledWith(true);
    await resize(1200);
    expect(onCovered).toHaveBeenLastCalledWith(false);
    await resize(1000);
    shown.rerender(view({ content: false, onCovered }));
    expect(onCovered).toHaveBeenLastCalledWith(false);
    await resize(1000);
    shown.rerender(view({ contentMin: 680, onCovered }));
    expect(onCovered).toHaveBeenLastCalledWith(true);
    shown.unmount();
    expect(onCovered).toHaveBeenLastCalledWith(false);
  });

  it("a key pressed with nothing focused never answers an approval waiting in the conversation that is covered", async () => {
    render(view({ contentMin: 680 }));
    const conversation = document.querySelector<HTMLElement>(".beside-chat button")!;
    expect(approvalKeyApplies({ target: document.body }, conversation)).toBe(true);
    await resize(1000);
    expect(approvalKeyApplies({ target: document.body }, conversation)).toBe(false);
  });

  // Release unit A (re-review 1, next round 1): on a DESKTOP the AI never lies over its document
  // and never swaps it silently. It narrows to its own minimum beside it; when even that does not
  // fit, the pane shows one at a time with a visible two-way key (the AI's and the document's name).
  it("on a desktop a document's AI narrows to its minimum beside it before anything is laid over", async () => {
    render(view({ over: "chat", contentMin: 1040 }));
    // 1368 (a 1440 window in focus mode) − 7 − 1040 = 321: under a conversation's 360, over a document AI's 300.
    await resize(1368);
    expect(root().dataset.fit).toBe("beside");
    expect(screen.getByRole("region", { name: "대화" }).style.flex).toBe("0 0 321px");
  });

  it("on a desktop with no room for both: one at a time, by a visible two-way key — no sheet, no scrim, no silent swap", async () => {
    const onDismiss = vi.fn();
    render(<Beside chat={<Side name="chat" />} content={<Side name="content" />} over="chat" contentMin={680} ratio={0.4} onRatio={() => undefined}
      chatLabel="문서 AI 대화" contentLabel="문서" backLabel="강의안.md" onDismiss={onDismiss} />);
    await resize(520);
    expect(root().dataset.fit).toBe("over");
    expect(root().dataset.narrow).toBe("one");
    expect(document.querySelector(".beside-scrim")).toBeNull();
    expect(screen.queryByRole("button", { name: "강의안.md로 돌아가기" })).toBeNull();
    const switcher = screen.getByRole("group", { name: "한 번에 하나씩 보기" });
    const ai = screen.getByRole("button", { name: "문서 AI" }), doc = screen.getByRole("button", { name: "강의안.md" });
    expect(switcher.contains(ai) && switcher.contains(doc)).toBe(true);
    // The AI was just opened: it is in front, the document kept under it.
    expect(ai.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector<HTMLElement>(".beside-content")!.hasAttribute("inert")).toBe(true);
    fireEvent.click(doc);
    expect(doc.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector<HTMLElement>(".beside-content")!.hasAttribute("inert")).toBe(false);
    expect(document.querySelector<HTMLElement>(".beside-chat")!.hasAttribute("inert")).toBe(true);
    fireEvent.click(ai);
    expect(document.querySelector<HTMLElement>(".beside-chat")!.hasAttribute("inert")).toBe(false);
    // Neither side was remounted, nothing was closed.
    expect(mounts).toMatchObject({ chat: 1, content: 1, chatGone: 0, contentGone: 0 });
    expect(onDismiss).not.toHaveBeenCalled();
    await resize(1200);
    expect(root().dataset.narrow).toBeUndefined();
    expect(screen.queryByRole("group", { name: "한 번에 하나씩 보기" })).toBeNull();
  });

  // Skin 2 fix 1, design review finding 5: on a phone the AI sheet took 342 of 390 px and left the
  // document behind it as a 48 px strip of cut controls. On a PHONE (a touch screen or a window under
  // 40rem) the AI REPLACES what it is about (kept, hidden, never squeezed) and a back key returns to it.
  it("on a phone a document's or page's AI replaces it, with a back key to it (no strip, no scrim); Esc goes back too", async () => {
    phone.matches = true;
    const onDismiss = vi.fn();
    render(<Beside chat={<Side name="chat" />} content={<Side name="content" />} over="chat" ratio={0.4} onRatio={() => undefined}
      chatLabel="문서 AI 대화" contentLabel="문서" backLabel="강의안.md" onDismiss={onDismiss} />);
    await resize(390);
    expect(root().dataset.fit).toBe("over");
    expect(root().dataset.narrow).toBe("replace");
    expect(document.querySelector(".beside-scrim")).toBeNull();
    expect(screen.queryByRole("group", { name: "한 번에 하나씩 보기" })).toBeNull();
    const content = document.querySelector<HTMLElement>(".beside-content")!;
    expect(content.hasAttribute("inert")).toBe(true);
    const back = screen.getByRole("button", { name: "강의안.md로 돌아가기" });
    expect(back.closest(".beside-chat")).not.toBeNull();
    fireEvent.click(back);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Re-review 1 next round 9: Esc inside the phone's AI goes back to the document too.
    fireEvent.keyDown(screen.getByRole("button", { name: "chat" }), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(2);
    // An Esc something inside already used (a menu, a list in the input) is not taken twice.
    const used = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    used.preventDefault();
    screen.getByRole("button", { name: "chat" }).dispatchEvent(used);
    expect(onDismiss).toHaveBeenCalledTimes(2);
    // The document stays mounted under it (its place, its edits).
    expect(mounts.content).toBe(1);
  });

  it("the phone's AI has one way back: its own close key is not drawn while the back key is", async () => {
    phone.matches = true;
    render(<Beside chat={<CloseKey />} content={<Side name="content" />} over="chat" ratio={0.4} onRatio={() => undefined}
      chatLabel="문서 AI 대화" contentLabel="문서" backLabel="강의안.md" onDismiss={() => undefined} />);
    await resize(390);
    expect(screen.getByRole("button", { name: "강의안.md로 돌아가기" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "닫기" })).toBeNull();
    phone.matches = false;
    await resize(1200);
    expect(screen.getByRole("button", { name: "닫기" })).toBeTruthy();
  });

  it("comes back beside when there is room again — a little more than it took to lay it over", async () => {
    render(view());
    const edge = 360 + 7 + 360;
    await resize(edge - 1);
    expect(root().dataset.fit).toBe("over");
    await resize(edge + 4);
    expect(root().dataset.fit).toBe("over");
    await resize(edge + 20);
    expect(root().dataset.fit).toBe("beside");
  });

  it("alone, a side registers nothing and covers nothing", () => {
    render(view({ content: false }));
    expect(document.querySelector("[data-covers-web], [inert]")).toBeNull();
  });
});

// The right sidebar docks only while every pane keeps its minimum beside it. A pane that holds two
// columns side by side needs both minimums: the sidebar is told, so it lies over instead of
// pushing the companion out of its place — and it is told nothing by an arrangement that is not
// side by side (laid over, one side only, or in a tab behind).
describe("the room two columns side by side ask the right sidebar to leave", () => {
  it("is what they need beyond one pane's minimum, while they are side by side and measured", async () => {
    const shown = render(view({ contentMin: 680 }));
    expect(besideRoom()).toBe(7 + 680);
    // With the sidebar's 280 + 8 the 1200px pane would keep 912: less than 360 + 7 + 680, so it lies over.
    expect(sidebarDocks(1200, 360 + besideRoom(), 280, true)).toBe(false);
    expect(sidebarDocks(1400, 360 + besideRoom(), 280, true)).toBe(true);
    await resize(1000);
    expect(root().dataset.fit).toBe("over");
    expect(besideRoom()).toBe(0);
    await resize(1200);
    expect(besideRoom()).toBe(7 + 680);
    shown.rerender(view({ content: false }));
    expect(besideRoom()).toBe(0);
    shown.rerender(view({ contentMin: 680 }));
    shown.unmount();
    expect(besideRoom()).toBe(0);
  });

  it("asks for nothing while it is not measured (a tab behind has no width)", async () => {
    render(view());
    await resize(0);
    expect(besideRoom()).toBe(0);
  });
});
