// @vitest-environment jsdom
// A new revision (the 문서 AI's result from the independent executor, or one made elsewhere) is taken IN
// PLACE by an editor that can replace its document: the same frame, no reboot (brief office-ai-live, point 3).
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Artifact } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { OfficeEditor, type OfficeStatus } from "./OfficeEditor.tsx";

afterEach(() => { cleanup(); vi.useRealTimers(); });

async function setup(options: { replaceable?: boolean } = {}) {
  const revert = vi.fn(async (_id: string, to: number) => ({ id: "doc", revision: 4, sha256: "x", to }));
  const api = { editorGrant: async () => ({ token: "test", sessionId: "session", origin: "http://office.test", url: "http://office.test/docs" }), revert } as unknown as Api;
  let artifact = { id: "doc", name: "test.docx", format: "docx", revision: 1, path: "/test.docx", sha256: "test" } as Artifact;
  const statuses: OfficeStatus[] = [], notices: string[] = [];
  const props = { sessionId: "session", onPrepareAi: async () => {}, onNewSession: async () => "session", onAiSettings: () => {}, api, onNotice: (text: unknown) => { notices.push(typeof text === "string" ? text : JSON.stringify(text)); }, onStatus: (status: OfficeStatus) => { statuses.push(status); } };
  const screen = render(<OfficeEditor {...props} artifact={artifact} />);
  await act(async () => {});
  const frame = () => screen.container.querySelector("iframe")!;
  const first = frame();
  const sent = vi.spyOn(first.contentWindow!, "postMessage");
  const message = async (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame().contentWindow, data })); });
  await message({ type: "office:opened", revision: 1, recovered: false });
  if (options.replaceable !== false) await message({ type: "office:replace-ready" });
  const advance = async (revision: number) => { artifact = { ...artifact, revision }; screen.rerender(<OfficeEditor {...props} artifact={artifact} />); await act(async () => {}); };
  const replaces = () => sent.mock.calls.map(([data]) => data as { type: string }).filter((data) => data.type === "office:replace");
  return { first, frame, sent, message, advance, replaces, revert, statuses, notices };
}

it("a new revision goes into the running editor: the same frame, no reboot", async () => {
  const t = await setup();
  await t.advance(2);
  expect(t.replaces()).toEqual([{ type: "office:replace", revision: 2, before: 1 }]);
  await t.message({ type: "office:opened", revision: 2, recovered: false });
  await t.message({ type: "office:replace-result", revision: 2, ok: true });
  expect(t.frame()).toBe(t.first);
  expect(t.statuses.at(-1)).toMatchObject({ revision: 2, dirty: false, conflict: null });
});

it("the executor's end: in place once the revision is known; a turn that changed nothing reopens nothing", async () => {
  const t = await setup();
  await t.message({ type: "office:execution-refresh" });
  expect(t.replaces()).toEqual([]);
  expect(t.frame()).toBe(t.first);
  await t.advance(2);
  expect(t.replaces()).toEqual([{ type: "office:replace", revision: 2, before: 1 }]);
  expect(t.frame()).toBe(t.first);
});

it("an editor that cannot replace in place is opened again as before (remount)", async () => {
  const t = await setup({ replaceable: false });
  await t.advance(2);
  expect(t.replaces()).toEqual([]);
  expect(t.frame()).not.toBe(t.first);
});

it("a replacement that fails falls back to reopening the editor", async () => {
  const t = await setup();
  await t.advance(2);
  await t.message({ type: "office:replace-result", revision: 2, ok: false, reason: "failed" });
  expect(t.frame()).not.toBe(t.first);
});

it("unsaved edits are never replaced: a dirty view keeps them and gets the conflict", async () => {
  const t = await setup();
  await t.message({ type: "office:dirty", dirty: true });
  await t.advance(2);
  expect(t.replaces()).toEqual([]);
  expect(t.frame()).toBe(t.first);
  expect(t.statuses.at(-1)).toMatchObject({ dirty: true, conflict: { code: "revision_conflict" } });
});

it("edits typed just before the replacement (the editor refuses: dirty) are kept, with the conflict", async () => {
  const t = await setup();
  await t.advance(2);
  await t.message({ type: "office:replace-result", revision: 2, ok: false, reason: "dirty" });
  expect(t.frame()).toBe(t.first);
  expect(t.statuses.at(-1)).toMatchObject({ dirty: true, conflict: { code: "revision_conflict" }, revision: 1 });
});

it("되돌리기 after the AI's edit makes the revision before it the newest; refused once something changed", async () => {
  const t = await setup();
  await t.advance(2);
  await t.message({ type: "office:opened", revision: 2, recovered: false });
  await t.message({ type: "office:replace-result", revision: 2, ok: true });
  await t.message({ type: "office:revert-ai", revision: 2, before: 1 });
  expect(t.revert).toHaveBeenCalledWith("doc", 1);
  await t.message({ type: "office:dirty", dirty: true });
  await t.message({ type: "office:revert-ai", revision: 2, before: 1 });
  expect(t.revert).toHaveBeenCalledTimes(1);
  expect(t.notices.at(-1)).toContain("되돌리지 않았습니다");
});

it("an editor that cannot replace in place is not reopened by a turn that changed nothing; its result still reopens it", async () => {
  const t = await setup({ replaceable: false });
  await t.message({ type: "office:execution-refresh" });
  expect(t.frame()).toBe(t.first);
  await t.advance(2);
  expect(t.frame()).not.toBe(t.first);
});

it("a live turn in the editor keeps its view on its tab's closing; a kept view tells its page; the turn's end lets go", async () => {
  const { SleepTab, TabClosed, keptOnClose } = await import("../../tab-sleep.ts");
  const api = { editorGrant: async () => ({ token: "test", sessionId: "session", origin: "http://office.test", url: "http://office.test/docs" }) } as unknown as Api;
  const artifact = { id: "doc", name: "a.docx", format: "docx", revision: 1, path: "/a.docx", sha256: "x" } as Artifact;
  const props = { sessionId: "session", onPrepareAi: async () => {}, onNewSession: async () => "session", onAiSettings: () => {}, api, artifact, onNotice: () => {}, onStatus: () => {} };
  const tree = (closed: boolean) => <SleepTab.Provider value="tab-1"><TabClosed.Provider value={closed}><OfficeEditor {...props} /></TabClosed.Provider></SleepTab.Provider>;
  const screen = render(tree(false));
  await act(async () => {});
  const frame = screen.container.querySelector("iframe")!, sent = vi.spyOn(frame.contentWindow!, "postMessage");
  const message = async (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame.contentWindow, data })); });
  await message({ type: "office:opened", revision: 1, recovered: false });
  expect(keptOnClose("tab-1")).toBe(false);
  await message({ type: "office:live-turn", running: true });
  expect(keptOnClose("tab-1")).toBe(true);
  screen.rerender(tree(true)); await act(async () => {});
  expect(sent).toHaveBeenCalledWith({ type: "office:kept-closed", closed: true }, "http://office.test");
  await message({ type: "office:live-turn", running: false });
  expect(keptOnClose("tab-1")).toBe(false);
});
