// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Artifact } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { OfficeEditor, type OfficeStatus } from "./OfficeEditor.tsx";

// The Markdown editor says "dirty" as it opens, before anything changed, and does not say it again
// when the person does type. Its report still guards leaving (`dirty`). The label follows three
// rules: an update shows "저장 안 됨" at once (`changed`); it is taken back only when the editor's
// text was read and found equal to the saved revision (`same`: no unsaved mark, and no claim of
// "저장됨" either, which waits for the editor's own clean report); a read that fails leaves the
// editor's report standing. The text is read after an update and when the person leaves the
// editor — never on a clock.

const aiProps = { sessionId: "session", onPrepareAi: async () => {}, onNewSession: async () => "session", onAiSettings: () => {} };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const SAVED = "# 제목\n\n본문\n";

async function open(format: Artifact["format"], recovered = false, unreadable = false) {
  const name = format === "markdown" ? "A.md" : "A.docx";
  const artifactText = vi.fn(async (_id: string, revision?: number) => {
    if (unreadable) throw new Error("읽지 못했습니다.");
    return { revision: revision ?? 1, text: revision === 2 ? "# 제목\n\n고친 본문\n" : SAVED };
  });
  const api = { artifactText, editorGrant: async () => ({ token: "t", sessionId: "session", origin: "http://office.test", url: "http://office.test/editor" }) } as unknown as Api;
  const artifact = { id: "doc", name, format, revision: 1, path: `/${name}`, sha256: "s" } as Artifact;
  const statuses: OfficeStatus[] = [];
  const screen = render(<OfficeEditor {...aiProps} api={api} artifact={artifact} onNotice={() => {}} onStatus={(status) => statuses.push(status)} />);
  await act(async () => {});
  const frame = screen.container.querySelector("iframe")!, sent = vi.spyOn(frame.contentWindow!, "postMessage");
  const message = async (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame.contentWindow, data })); });
  /** The app's questions "what is your text now?", in order. */
  const reads = () => sent.mock.calls.map(([data]) => data as { type: string; requestId: string; request?: { kind: string } }).filter((data) => data.type === "office:mcp" && data.request?.kind === "read");
  const reply = async (value: unknown) => { expect(reads().length).toBeGreaterThan(0); await message({ type: "office:mcp-result", requestId: reads().at(-1)!.requestId, reply: value }); };
  const answer = (text: string) => reply({ status: "ok", result: { value: text } });
  const tick = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await message({ type: "office:opened", revision: 1, recovered });
  return { statuses, message, answer, reply, reads, tick, frame, last: () => statuses.at(-1)! };
}
/** Opened, the editor's opening report in, and the first read answered "equal to the saved revision". */
async function settled() {
  const f = await open("markdown");
  await f.message({ type: "office:dirty", dirty: true });
  await f.tick(50);
  await f.answer(SAVED);
  return f;
}

it("an update after the editor is ready shows 저장 안 됨 at once, before anything is compared", async () => {
  const f = await open("markdown");
  await f.message({ type: "office:dirty", dirty: true });
  expect(f.last()).toMatchObject({ dirty: true, changed: true, same: false });
});

it("it is taken back only when the text was read and found equal to the saved revision; 저장됨 waits for the editor's own clean report", async () => {
  const f = await open("markdown");
  await f.message({ type: "office:dirty", dirty: true });
  await f.tick(50);
  expect(f.reads()).toHaveLength(1);
  expect(f.last()).toMatchObject({ dirty: true, changed: true });
  await f.answer(SAVED);
  // No unsaved mark; the report itself (which guards leaving) is untouched.
  expect(f.last()).toMatchObject({ dirty: true, changed: false, same: true });
  await f.message({ type: "office:saved", revision: 2 });
  expect(f.last()).toMatchObject({ dirty: false, changed: false, same: false, revision: 2 });
});

it.each([
  ["times out", async (f: Awaited<ReturnType<typeof open>>) => f.tick(2000)],
  ["is refused (the editor is busy)", async (f: Awaited<ReturnType<typeof open>>) => f.reply({ status: "error", error: { reason: "editor_error", message: "현재 문서의 AI·저장 작업을 마친 뒤 다시 요청해 주세요." } })],
  ["is not ready", async (f: Awaited<ReturnType<typeof open>>) => f.reply({ status: "not_ready" })],
])("a read that %s leaves the editor's report standing: 저장 안 됨, never a false 저장됨", async (_, fail) => {
  const f = await open("markdown");
  await f.message({ type: "office:dirty", dirty: true });
  await f.tick(50);
  await fail(f);
  expect(f.last()).toMatchObject({ dirty: true, changed: true, same: false });
});

it("a read that fails after the text was once found equal puts the mark back", async () => {
  const f = await settled();
  expect(f.last()).toMatchObject({ changed: false, same: true });
  act(() => { window.dispatchEvent(new Event("focus")); });
  await f.tick(500);
  expect(f.reads()).toHaveLength(2);
  await f.reply({ status: "not_ready" });
  expect(f.last()).toMatchObject({ dirty: true, changed: true, same: false });
});

it("when the saved text cannot be read, the editor's report is shown as it is", async () => {
  const f = await open("markdown", false, true);
  await f.message({ type: "office:dirty", dirty: true });
  await f.tick(100);
  expect(f.last()).toMatchObject({ dirty: true, changed: true, same: false });
});

it("there is no standing poll: an open, unchanged document is read once", async () => {
  const f = await settled();
  await f.tick(120_000);
  expect(f.reads()).toHaveLength(1);
  expect(f.last()).toMatchObject({ dirty: true, changed: false, same: true });
});

it.each([
  ["the focus comes back from the editor", (_f: Awaited<ReturnType<typeof open>>) => window.dispatchEvent(new Event("focus"))],
  ["the pointer leaves the editor", (f: Awaited<ReturnType<typeof open>>) => fireEvent.pointerLeave(f.frame)],
  ["the editor sends anything else", (f: Awaited<ReturnType<typeof open>>) => window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: f.frame.contentWindow, data: { type: "office:ai-panel", open: true } }))],
])("a change the editor did not announce is seen when %s", async (_, leave) => {
  const f = await settled();
  act(() => { leave(f); });
  // Several hints at once are one question.
  act(() => { leave(f); });
  await f.tick(500);
  expect(f.reads()).toHaveLength(2);
  await f.answer("# 제목\n\n본문 한 줄 더\n");
  expect(f.last()).toMatchObject({ dirty: true, changed: true, same: false });
  // Known to differ: nothing more is asked until it is saved.
  act(() => { leave(f); });
  await f.tick(5000);
  expect(f.reads()).toHaveLength(2);
});

it("edits recovered on opening are unsaved from the start, with no question asked", async () => {
  const f = await open("markdown", true);
  expect(f.last()).toMatchObject({ dirty: true, changed: true, same: false });
  await f.tick(5000);
  expect(f.reads()).toHaveLength(0);
});

it("Word: the editor's report is the label, as before, and its text is never asked for", async () => {
  const f = await open("docx");
  await f.message({ type: "office:dirty", dirty: true });
  expect(f.last()).toMatchObject({ dirty: true, changed: true, same: false });
  await f.tick(5000);
  expect(f.reads()).toHaveLength(0);
  await f.message({ type: "office:dirty", dirty: false });
  expect(f.last()).toMatchObject({ dirty: false, changed: false, same: false });
});
