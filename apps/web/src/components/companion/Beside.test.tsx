// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { Beside, besideRoom } from "./Beside.tsx";
import { sidebarDocks } from "../right/RightSidebar.tsx";
import { approvalKeyApplies } from "../../conversation/approval-keys.ts";

// 곁 화면's layout: a conversation column and what it is about, side by side while both keep their
// minimum, otherwise one laid over the other. A side that stays is never remounted.

const host = { width: 1200, resize: [] as (() => void)[] };
const mounts = { chat: 0, content: 0, chatGone: 0, contentGone: 0 };
beforeEach(() => {
  host.width = 1200; host.resize = [];
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

  it("a document's AI lies over it as a sheet on a scrim that closes it; both cover a web view under them", async () => {
    const onDismiss = vi.fn();
    render(view({ over: "chat", contentMin: 680, onDismiss }));
    await resize(1000);
    expect(root().dataset.fit).toBe("over");
    const chat = document.querySelector<HTMLElement>(".beside-chat")!, content = document.querySelector<HTMLElement>(".beside-content")!;
    expect(chat.hasAttribute("data-covers-web")).toBe(true);
    expect(chat.hasAttribute("inert")).toBe(false);
    expect(content.hasAttribute("inert")).toBe(true);
    const scrim = screen.getByRole("button", { name: "대화 닫기" });
    expect(scrim.hasAttribute("data-covers-web")).toBe(true);
    fireEvent.click(scrim);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mounts.content).toBe(1);
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
