// @vitest-environment jsdom
// The editor pool (0.5.4): Word documents in one window share their editor frame. A document off screen holds no frame,
// only its state; shown again, it is opened IN PLACE in the running editor (office:park → office:swap).
import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Artifact } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { EditorPool } from "../../editor-pool.ts";
import { EditorPoolContext, EditorPoolLayer, PoolSurface } from "../EditorPoolLayer.tsx";
import { OfficeEditor, type OfficeHandle, type OfficeStatus } from "./OfficeEditor.tsx";

// jsdom lays nothing out: an element is "on screen" when nothing around it is hidden.
const rects = Element.prototype.getClientRects;
beforeEach(() => { Element.prototype.getClientRects = function (this: Element) { return (this.closest("[hidden]") ? [] : [{ left: 0, top: 0, width: 800, height: 600 }]) as unknown as DOMRectList; }; });
afterEach(() => { cleanup(); Element.prototype.getClientRects = rects; vi.useRealTimers(); });

const doc = (id: string) => ({ id, name: `${id}.docx`, format: "docx", revision: 1, path: `/${id}.docx`, sha256: id, workId: "w" }) as Artifact;
type Sent = { type: string; [key: string]: unknown };

async function setup() {
  const api = { editorGrant: async (id: string) => ({ token: `token-${id}`, sessionId: `session-${id}`, origin: "http://office.test", url: "http://office.test/docs" }) } as unknown as Api;
  const surface = new PoolSurface(new EditorPool({ trimDelayMs: 0 }));
  const statuses: Record<string, OfficeStatus[]> = { a: [], b: [] }, notices: string[] = [];
  const refs = { a: createRef<OfficeHandle>(), b: createRef<OfficeHandle>() };
  const editor = (id: "a" | "b") => <OfficeEditor ref={refs[id]} api={api} artifact={doc(id)} sessionId={`session-${id}`} onPrepareAi={async () => {}} onNewSession={async () => "s"} onAiSettings={() => {}}
    onNotice={(text) => { notices.push(String(text)); }} onStatus={(status) => { statuses[id]!.push(status); }} />;
  const view = (shown: "a" | "b" | "both") => <EditorPoolContext.Provider value={surface}><div className="panes">
    <section className="pane" hidden={shown === "b"}>{editor("a")}</section>
    <section className="pane" hidden={shown === "a"}>{editor("b")}</section>
    <EditorPoolLayer surface={surface} />
  </div></EditorPoolContext.Provider>;
  const screen = render(view("a"));
  await act(async () => {});
  const frames = () => [...screen.container.querySelectorAll<HTMLIFrameElement>(".editor-pool iframe")];
  const sent: Sent[] = [];
  const spied = new Set<Window>();
  const spy = () => { for (const frame of frames()) if (!spied.has(frame.contentWindow!)) { spied.add(frame.contentWindow!); vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((data: unknown) => { sent.push(data as Sent); }); } };
  spy();
  const page = async (data: unknown, frame = frames()[0]!) => act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame.contentWindow, data })); });
  const show = async (shown: "a" | "b" | "both") => { screen.rerender(view(shown)); await act(async () => {}); await act(async () => {}); spy(); };
  const last = (type: string) => [...sent].reverse().find((message) => message.type === type);
  return { screen, frames, sent, page, show, last, statuses, notices, refs, spy };
}

it("one frame for two Word documents: the one left is parked (its edits kept), the other is opened in it in place", async () => {
  const t = await setup();
  expect(t.frames()).toHaveLength(1);
  expect(t.frames()[0]!.src).toContain("a=a");
  await t.page({ type: "office:ready" });
  expect(t.last("office:init")).toMatchObject({ artifact: { id: "a" }, token: "token-a" });
  await t.page({ type: "office:opened", revision: 1, recovered: false });
  await t.page({ type: "office:swap-ready" });
  await t.page({ type: "office:dirty", dirty: true });
  expect(t.statuses.a!.at(-1)).toMatchObject({ dirty: true, changed: true });

  // B is shown, A goes behind it: A is asked to park first.
  await t.show("b");
  expect(t.last("office:park")).toBeTruthy();
  expect(t.last("office:swap")).toBeUndefined();
  await t.page({ type: "office:parked", ok: true });
  const swap = t.last("office:swap")!;
  expect(swap).toMatchObject({ artifact: { id: "b" }, token: "token-b", sessionId: "session-b", recover: true });
  // What the page says before it answers the swap is about A: B takes none of it.
  await t.page({ type: "office:dirty", dirty: true });
  expect(t.statuses.b!.some((status) => status.dirty)).toBe(false);
  await t.page({ type: "office:swapped", epoch: swap.epoch, ok: true });
  await t.page({ type: "office:opened", revision: 1, recovered: false });
  await t.page({ type: "office:swap-ready" });
  expect(t.frames()).toHaveLength(1);
  expect(t.statuses.b!.at(-1)).toMatchObject({ revision: 1, dirty: false });
  // A's "저장 안 됨" stays with A.
  expect(t.statuses.a!.at(-1)).toMatchObject({ dirty: true, changed: true });

  // Back to A: B parks, A is opened in place from its kept copy — no "되살렸습니다" news, still unsaved.
  await t.show("a");
  await t.page({ type: "office:parked", ok: true });
  const back = t.last("office:swap")!;
  expect(back).toMatchObject({ artifact: { id: "a" }, recover: true });
  await t.page({ type: "office:swapped", epoch: back.epoch, ok: true });
  await t.page({ type: "office:opened", revision: 1, recovered: true });
  await t.page({ type: "office:swap-ready" });
  expect(t.frames()).toHaveLength(1);
  expect(t.statuses.a!.at(-1)).toMatchObject({ revision: 1, dirty: true });
  expect(t.notices).not.toContain("저장하지 않았던 편집을 되살렸습니다.");
});

it("a park that is refused (a turn, a copy) leaves A its frame; B gets a second one", async () => {
  const t = await setup();
  await t.page({ type: "office:ready" });
  await t.page({ type: "office:opened", revision: 1, recovered: false });
  await t.page({ type: "office:swap-ready" });
  await t.show("b");
  await t.page({ type: "office:parked", ok: false });
  await act(async () => {});
  expect(t.frames()).toHaveLength(2);
  expect(t.frames()[1]!.src).toContain("a=b");
  expect(t.last("office:swap")).toBeUndefined();
});

it("two panes: two frames; back to one pane: one frame", async () => {
  const t = await setup();
  await t.page({ type: "office:ready" });
  await t.page({ type: "office:opened", revision: 1, recovered: false });
  await t.page({ type: "office:swap-ready" });
  await t.show("both");
  expect(t.frames()).toHaveLength(2);
  const second = t.frames()[1]!;
  await t.page({ type: "office:ready" }, second);
  await t.page({ type: "office:opened", revision: 1, recovered: false }, second);
  await t.page({ type: "office:swap-ready" }, second);
  // B's pane closes (B behind A): B is parked and its frame goes.
  await t.show("a");
  await t.page({ type: "office:parked", ok: true }, second);
  await act(async () => {});
  expect(t.frames()).toHaveLength(1);
  expect(t.frames()[0]!.src).toContain("a=a");
});

it("closing a parked tab with unsaved edits: the editor gets a frame back behind the tab and saves them", async () => {
  const t = await setup();
  await t.page({ type: "office:ready" });
  await t.page({ type: "office:opened", revision: 1, recovered: false });
  await t.page({ type: "office:swap-ready" });
  await t.page({ type: "office:dirty", dirty: true });
  await t.show("b");
  await t.page({ type: "office:parked", ok: true });
  const swap = t.last("office:swap")!;
  await t.page({ type: "office:swapped", epoch: swap.epoch, ok: true });
  await t.page({ type: "office:opened", revision: 1, recovered: false });
  await t.page({ type: "office:swap-ready" });
  // A (off screen, parked, unsaved) is asked to save: B is on screen, so A gets a frame of its own meanwhile.
  let saved: number | null | undefined;
  await act(async () => { void t.refs.a.current!.leave().then((revision) => { saved = revision; }); });
  await act(async () => {}); t.spy();
  expect(t.frames()).toHaveLength(2);
  const back = t.frames()[1]!;
  await t.page({ type: "office:ready" }, back);
  expect(t.last("office:init")).toMatchObject({ artifact: { id: "a" }, recover: true });
  await t.page({ type: "office:opened", revision: 1, recovered: true }, back);
  await t.page({ type: "office:swap-ready" }, back);
  await act(async () => {});
  expect(t.last("office:flush")).toBeTruthy();
  await t.page({ type: "office:saved", revision: 2 }, back);
  await t.page({ type: "office:flushed", revision: 2 }, back);
  await act(async () => {});
  expect(saved).toBe(2);
  expect(t.statuses.a!.at(-1)).toMatchObject({ dirty: false, revision: 2 });
});
