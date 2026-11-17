// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const posted: { type: string; [key: string]: unknown }[] = [];
let handler: ((message: unknown) => void) | null = null;
vi.mock("./bridge.ts", () => ({
  post: (message: { type: string }) => { posted.push(message); },
  listen: (fn: (message: unknown) => void) => { handler = fn; return () => { handler = null; }; },
  pageRest: { hold: () => () => {} },
}));
const { installSwap, swapInProgress } = await import("./swap.ts");

afterEach(() => { posted.length = 0; });
const settle = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
const doc = (id: string) => ({ id, name: `${id}.docx`, path: `/w/${id}.docx`, revision: 1, sha256: "s" });
type Init = Parameters<typeof installSwap>[0];
const init = (): Init => ({ type: "office:init", token: "token-a", sessionId: "session-a", artifact: doc("a"), readOnly: false, theme: "light", recover: true, view: { scroll: { top: 40, left: 0, fraction: 0.2 } } });

function setup(patch: { dirty?: boolean; kept?: boolean; busy?: boolean; aiBusy?: boolean } = {}) {
  const value = init();
  const gateway = { setToken: vi.fn() };
  const ai = { swap: vi.fn(() => true), busy: vi.fn(() => Boolean(patch.aiBusy)) };
  let opening: () => void = () => {};
  const editor = {
    dirty: vi.fn(async () => Boolean(patch.dirty)), keep: vi.fn(async () => patch.kept ?? true), busy: vi.fn(() => Boolean(patch.busy)),
    open: vi.fn(() => new Promise<void>((resolve) => { opening = resolve; })),
  };
  const stop = installSwap(value, gateway as never, ai, editor);
  return { init: value, gateway, ai, editor, stop, finishOpen: () => opening() };
}

describe("the page's side of the editor pool", () => {
  it("says it can swap once installed", () => {
    const { stop } = setup();
    expect(posted.map((message) => message.type)).toEqual(["office:swap-ready"]);
    stop();
  });
  it("park: nothing unsaved → ok at once, nothing written", async () => {
    const { editor, stop } = setup();
    handler!({ type: "office:park" }); await settle();
    expect(editor.keep).not.toHaveBeenCalled();
    expect(posted.at(-1)).toEqual({ type: "office:parked", ok: true });
    stop();
  });
  it("park: clean as last reported is taken at once (a hidden page answers a fresh check late)", async () => {
    const value = init(), editor = { dirty: vi.fn(async () => true), lastDirty: () => false, keep: vi.fn(async () => true), busy: () => false, open: async () => {} };
    const stop = installSwap(value, { setToken() {} } as never, { swap: () => true, busy: () => false }, editor);
    handler!({ type: "office:park" }); await settle();
    expect(editor.dirty).not.toHaveBeenCalled();
    expect(posted.at(-1)).toEqual({ type: "office:parked", ok: true });
    stop();
  });
  it("park: unsaved edits are written as the recovery copy first; a copy not written keeps the frame", async () => {
    const written = setup({ dirty: true, kept: true });
    handler!({ type: "office:park" }); await settle();
    expect(written.editor.keep).toHaveBeenCalledOnce();
    expect(posted.at(-1)).toEqual({ type: "office:parked", ok: true });
    written.stop();
    const failed = setup({ dirty: true, kept: false });
    handler!({ type: "office:park" }); await settle();
    expect(posted.at(-1)).toEqual({ type: "office:parked", ok: false });
    failed.stop();
  });
  it("park and swap are refused while a 문서 AI turn or a copy runs", async () => {
    const turning = setup({ aiBusy: true });
    handler!({ type: "office:park" }); await settle();
    expect(posted.at(-1)).toEqual({ type: "office:parked", ok: false });
    handler!({ type: "office:swap", epoch: 4, token: "token-b", sessionId: null, artifact: doc("b"), readOnly: false, theme: "light", recover: true });
    expect(posted.at(-1)).toEqual({ type: "office:swapped", epoch: 4, ok: false });
    expect(turning.init.artifact.id).toBe("a");
    expect(turning.editor.open).not.toHaveBeenCalled();
    turning.stop();
    const copying = setup({ busy: true });
    handler!({ type: "office:swap", epoch: 5, token: "token-b", sessionId: null, artifact: doc("b"), readOnly: false, theme: "light", recover: true });
    expect(posted.at(-1)).toEqual({ type: "office:swapped", epoch: 5, ok: false });
    copying.stop();
  });
  it("swap: answers FIRST, re-points the page at the new document (token, conversation, place cleared), then opens it", async () => {
    const { init: value, gateway, ai, editor, stop, finishOpen } = setup();
    posted.length = 0;
    handler!({ type: "office:swap", epoch: 7, token: "token-b", sessionId: "session-b", artifact: doc("b"), readOnly: false, theme: "dark", recover: true });
    expect(posted).toEqual([{ type: "office:swapped", epoch: 7, ok: true }]);
    expect(value.artifact.id).toBe("b");
    expect(value.sessionId).toBe("session-b");
    expect(value.view).toBeUndefined();
    expect(gateway.setToken).toHaveBeenCalledWith("token-b");
    expect(ai.swap).toHaveBeenCalledWith("session-b");
    expect(editor.open).toHaveBeenCalledOnce();
    expect(swapInProgress()).toBe(true);
    // A second swap while this one opens is refused (the window asks again afterwards).
    handler!({ type: "office:swap", epoch: 8, token: "token-c", sessionId: null, artifact: doc("c"), readOnly: false, theme: "dark", recover: true });
    expect(posted.at(-1)).toEqual({ type: "office:swapped", epoch: 8, ok: false });
    finishOpen(); await settle();
    expect(swapInProgress()).toBe(false);
    expect(posted.slice(-2).map((message) => message.type)).toEqual(["office:replace-ready", "office:swap-ready"]);
    stop();
  });
  it("the new document's own place is taken when it has one", async () => {
    const { init: value, stop, finishOpen } = setup();
    handler!({ type: "office:swap", epoch: 9, token: "token-b", sessionId: null, artifact: doc("b"), readOnly: false, theme: "light", recover: true, view: { scroll: { top: 900, left: 0, fraction: 0.5 } } });
    expect(value.view).toEqual({ scroll: { top: 900, left: 0, fraction: 0.5 } });
    finishOpen(); await settle();
    stop();
  });
  // Last: the page stays "swapping" after it (module state).
  it("an open that fails: the page says swap-failed and stays quiet (swapping) until the window opens it again", async () => {
    const value = init(), editor = { dirty: async () => false, keep: async () => true, busy: () => false, open: vi.fn(async () => { throw new Error("no"); }) };
    const stop = installSwap(value, { setToken() {} } as never, { swap: () => true, busy: () => false }, editor);
    handler!({ type: "office:swap", epoch: 3, token: "token-b", sessionId: null, artifact: doc("b"), readOnly: false, theme: "light", recover: true });
    await settle();
    expect(posted.at(-1)).toEqual({ type: "office:swap-failed" });
    expect(swapInProgress()).toBe(true);
    stop();
  });
});
