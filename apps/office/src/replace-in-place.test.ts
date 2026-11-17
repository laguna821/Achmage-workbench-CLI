// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const posted: { type: string; [key: string]: unknown }[] = [];
let handler: ((message: unknown) => void) | null = null;
vi.mock("./bridge.ts", () => ({
  post: (message: { type: string }) => { posted.push(message); },
  listen: (fn: (message: unknown) => void) => { handler = fn; return () => { handler = null; }; },
}));
const { installInPlaceReplace, keepScroll, APPLIED_WORDS } = await import("./replace-in-place.ts");
const { reportTurnActivity } = await import("./turn-activity.ts");

afterEach(() => { posted.length = 0; document.body.innerHTML = ""; });
const types = () => posted.map((message) => message.type);

describe("taking a revision in place", () => {
  it("says it can, loads the revision into the running editor, then answers opened + ok", async () => {
    const replace = vi.fn(async () => {});
    const editor = installInPlaceReplace({ dirty: async () => false, replace });
    expect(types()).toEqual(["office:replace-ready"]);
    handler!({ type: "office:replace", revision: 3, before: 2 });
    await editor.settled();
    expect(replace).toHaveBeenCalledWith(3);
    expect(posted.slice(1)).toEqual([{ type: "office:opened", revision: 3, recovered: false }, { type: "office:replace-result", revision: 3, ok: true }]);
    // Not after a 문서 AI turn: no "반영했습니다" line.
    expect(document.querySelector(".wb-ai-applied")).toBeNull();
    editor.dispose();
  });
  it("never replaces unsaved edits: answered dirty, nothing loaded", async () => {
    const replace = vi.fn(async () => {});
    const editor = installInPlaceReplace({ dirty: async () => true, replace });
    handler!({ type: "office:replace", revision: 3, before: 2 });
    await editor.settled();
    expect(replace).not.toHaveBeenCalled();
    expect(posted.at(-1)).toEqual({ type: "office:replace-result", revision: 3, ok: false, reason: "dirty" });
    editor.dispose();
  });
  it("a load that fails is answered failed (the window reopens the page)", async () => {
    const editor = installInPlaceReplace({ dirty: async () => false, replace: async () => { throw new Error("parse"); } });
    handler!({ type: "office:replace", revision: 3, before: 2 });
    await editor.settled();
    expect(posted.at(-1)).toEqual({ type: "office:replace-result", revision: 3, ok: false, reason: "failed" });
    editor.dispose();
  });
  it("after the 문서 AI's executor turn: waits for the turn's end, then one line with 되돌리기", async () => {
    vi.useFakeTimers();
    const replace = vi.fn(async () => {});
    const editor = installInPlaceReplace({ dirty: async () => false, replace }, { lineMs: 5_000, turnWaitMs: 4_000 });
    reportTurnActivity({ kind: "start" }); reportTurnActivity({ kind: "remote", turnId: "t" });
    handler!({ type: "office:replace", revision: 5, before: 4 });
    await vi.advanceTimersByTimeAsync(300);
    expect(replace).not.toHaveBeenCalled();
    reportTurnActivity({ kind: "end", status: "completed" });
    await vi.advanceTimersByTimeAsync(200); await editor.settled();
    expect(replace).toHaveBeenCalledWith(5);
    const line = document.querySelector<HTMLElement>(".wb-ai-applied")!;
    expect(line.textContent).toContain(APPLIED_WORDS.applied);
    line.querySelector("button")!.click();
    expect(posted.at(-1)).toEqual({ type: "office:revert-ai", revision: 5, before: 4 });
    expect(document.querySelector(".wb-ai-applied")).toBeNull();
    // A new turn: the line gives way to the hold line at once.
    handler!({ type: "office:replace", revision: 6, before: 5 });
    await vi.advanceTimersByTimeAsync(10); await editor.settled();
    expect(document.querySelector(".wb-ai-applied")).not.toBeNull();
    reportTurnActivity({ kind: "start" });
    expect(document.querySelector(".wb-ai-applied")).toBeNull();
    reportTurnActivity({ kind: "end", status: "completed" });
    // The line goes by itself.
    handler!({ type: "office:replace", revision: 6, before: 5 });
    await vi.advanceTimersByTimeAsync(10); await editor.settled();
    expect(document.querySelector(".wb-ai-applied")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5_100);
    expect(document.querySelector(".wb-ai-applied")).toBeNull();
    editor.dispose(); vi.useRealTimers();
  });
  it("a turn whose end never reaches this page does not keep the revision out for long", async () => {
    vi.useFakeTimers();
    const replace = vi.fn(async () => {});
    const editor = installInPlaceReplace({ dirty: async () => false, replace }, { turnWaitMs: 1_000 });
    reportTurnActivity({ kind: "remote", turnId: "t" });
    handler!({ type: "office:replace", revision: 7, before: 6 });
    await vi.advanceTimersByTimeAsync(1_200); await editor.settled();
    expect(replace).toHaveBeenCalledWith(7);
    reportTurnActivity({ kind: "end", status: "completed" });
    editor.dispose(); vi.useRealTimers();
  });
});

describe("the view is kept", () => {
  it("scroll position put back after the content was replaced", async () => {
    const scroller = document.createElement("div"); document.body.append(scroller);
    Object.defineProperty(scroller, "scrollTop", { value: 0, writable: true });
    scroller.scrollTop = 640;
    const kept = await keepScroll(() => scroller, async () => { scroller.scrollTop = 0; });
    expect(kept).toBe(true);
    expect(scroller.scrollTop).toBe(640);
  });
});
