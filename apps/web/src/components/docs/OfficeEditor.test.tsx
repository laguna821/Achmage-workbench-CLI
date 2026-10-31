// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Artifact } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { OfficeEditor, type OfficeHandle } from "./OfficeEditor.tsx";

const aiProps = { sessionId: "session", onPrepareAi: async () => {}, onNewSession: async () => "session", onAiSettings: () => {} };

afterEach(() => { cleanup(); vi.useRealTimers(); });
async function setup() {
  vi.useFakeTimers();
  const ref = createRef<OfficeHandle>();
  const api = { editorGrant: async () => ({ token: "test", sessionId: "session", origin: "http://office.test", url: "http://office.test/docs" }) } as unknown as Api;
  const artifact = { id: "doc", name: "test.docx", format: "docx", revision: 1, path: "/test.docx", sha256: "test" } as Artifact;
  const screen = render(<OfficeEditor {...aiProps} ref={ref} api={api} artifact={artifact} onNotice={() => {}} onStatus={() => {}} />);
  await act(async () => {});
  const frame = screen.getByTitle("워드 편집기 · test.docx") as HTMLIFrameElement;
  const message = async (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame.contentWindow, data })); });
  await message({ type: "office:opened", revision: 1, recovered: false });
  await message({ type: "office:dirty", dirty: true });
  return { ref, message, frame };
}
it("does not treat four seconds or a null save response as permission to unmount", async () => {
  const { ref, message } = await setup();
  let done = false;
  const pending = ref.current!.leave().then(() => { done = true; return null; }, (error: Error) => error);
  await act(async () => vi.advanceTimersByTimeAsync(4001));
  expect(done).toBe(false);
  await message({ type: "office:flushed", revision: null });
  expect(await pending).toBeInstanceOf(Error); expect(done).toBe(false);
});
it("allows leaving only after saving is acknowledged and the editor is clean", async () => {
  const { ref, message } = await setup();
  const pending = ref.current!.leave();
  await message({ type: "office:saved", revision: 2 });
  await message({ type: "office:flushed", revision: 2 });
  await expect(pending).resolves.toBeUndefined();
});
it("keeps the editor on timeout or a revision conflict", async () => {
  const { ref, message } = await setup();
  const pending = ref.current!.leave().catch((error: Error) => error);
  await act(async () => vi.advanceTimersByTimeAsync(16_000));
  expect(await pending).toBeInstanceOf(Error);
  await message({ type: "office:conflict", code: "revision_conflict", message: "another writer" });
  await expect(ref.current!.leave()).rejects.toThrow("충돌");
});

it("opens a revision that arrived while the editor was still opening", async () => {
  const editorGrant = vi.fn(async () => ({ token: "test", sessionId: "session", origin: "http://office.test", url: "http://office.test/hwp" }));
  const api = { editorGrant } as unknown as Api;
  const artifact = { id: "doc", name: "test.hwpx", format: "hwpx", revision: 1, path: "/test.hwpx", sha256: "test" } as Artifact;
  const onStatus = vi.fn();
  const screen = render(<OfficeEditor {...aiProps} api={api} artifact={artifact} onNotice={() => {}} onStatus={onStatus} />);
  await act(async () => {});
  const first = screen.getByTitle("한글 편집기 · test.hwpx") as HTMLIFrameElement;
  screen.rerender(<OfficeEditor {...aiProps} api={api} artifact={{ ...artifact, revision: 2 }} onNotice={() => {}} onStatus={onStatus} />);
  await act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: first.contentWindow, data: { type: "office:opened", revision: 1, recovered: false } })); });
  expect(editorGrant).toHaveBeenCalledTimes(2);
  const second = screen.getByTitle("한글 편집기 · test.hwpx") as HTMLIFrameElement;
  expect(second).not.toBe(first);
  await act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: second.contentWindow, data: { type: "office:opened", revision: 2, recovered: false } })); });
  expect(onStatus).toHaveBeenLastCalledWith({ revision: 2, dirty: false, conflict: null });
});

it("a committed Save As permits guarded navigation before the original frame reloads", async () => {
  const ref = createRef<OfficeHandle>();
  const api = {
    editorGrant: async () => ({ token: "test", sessionId: "session", origin: "http://office.test", url: "http://office.test/hwp" }),
    prepareOfficeOutput: async () => ({ id: "plan", path: "/copy.hwpx", format: "hwpx", exists: false, size: 0 }),
    commitOfficeOutput: async () => ({ path: "/copy.hwpx", artifact: { id: "copy" } }),
  } as unknown as Api;
  const artifact = { id: "doc", name: "test.hwpx", format: "hwpx", revision: 1, path: "/test.hwpx", sha256: "test" } as Artifact;
  let leaving: Promise<void> | undefined;
  const onCopied = vi.fn(() => { leaving = ref.current!.leave(); });
  const screen = render(<OfficeEditor {...aiProps} ref={ref} api={api} artifact={artifact} onNotice={() => {}} onStatus={() => {}} onCopied={onCopied} />);
  await act(async () => {});
  const frame = screen.getByTitle("한글 편집기 · test.hwpx") as HTMLIFrameElement;
  const message = async (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame.contentWindow, data })); });
  await message({ type: "office:opened", revision: 1, recovered: false });
  await message({ type: "office:dirty", dirty: true });
  await message({ type: "office:output", requestId: "one", action: "prepare", revision: 1, format: "hwpx" });
  await act(async () => fireEvent.submit(screen.getByRole("dialog")));
  await message({ type: "office:output", requestId: "two", action: "commit", planId: "plan", bytes: new ArrayBuffer(8) });
  await message({ type: "office:copied", artifactId: "copy" });
  expect(onCopied).toHaveBeenCalledWith("copy"); await expect(leaving).resolves.toBeUndefined();
});

async function copyFlow(fail = false, format: "docx" | "pdf" = "docx") {
  let sessionId = "one";
  const ref = createRef<OfficeHandle>(), onCopied = vi.fn(), onNotice = vi.fn();
  const editorGrant = vi.fn(async () => ({ token: `token-${sessionId}`, sessionId, origin: "http://office.test", url: "http://office.test/docs" }));
  const api = {
    editorGrant,
    prepareOfficeOutput: async () => ({ id: "plan", path: `/copy.${format}`, format, exists: false, size: 0 }),
    commitOfficeOutput: async () => { if (fail) throw new Error("storage unavailable"); return { path: `/copy.${format}`, artifact: { id: "copy" } }; },
  } as unknown as Api;
  const artifact = { id: "doc", name: `test.${format}`, format, revision: 1, path: `/test.${format}`, sha256: "test" } as Artifact;
  const props = { ...aiProps, ref, api, artifact, onCopied, onNotice, onStatus: () => {} };
  const screen = render(<OfficeEditor {...props} sessionId={sessionId} />); await act(async () => {});
  const frame = screen.container.querySelector("iframe")!, sent = vi.spyOn(frame.contentWindow!, "postMessage");
  const message = async (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame.contentWindow, data })); });
  await message({ type: "office:opened", revision: 1, recovered: false }); await message({ type: "office:dirty", dirty: true });
  const prepare = async (requestId = "prepare", submit = true) => {
    await message({ type: "office:output", requestId, action: "prepare", revision: 1, format });
    if (submit) await act(async () => fireEvent.submit(screen.getByRole("dialog")));
  };
  const changeSession = async () => { sessionId = "two"; screen.rerender(<OfficeEditor {...props} sessionId={sessionId} />); await act(async () => {}); };
  return { ref, frame, screen, message, sent, onCopied, onNotice, prepare, changeSession };
}
it("does not let a previous copy cancellation close the next save dialog", async () => {
  const f = await copyFlow(); await f.prepare("old");
  await f.message({ type: "office:output", requestId: "cancel-old", action: "cancel", preparationId: "old" });
  await f.prepare("new", false);
  await f.message({ type: "office:output", requestId: "late-cancel", action: "cancel", preparationId: "old" });
  expect(f.screen.queryByRole("dialog")).not.toBeNull();
  await f.message({ type: "office:output", requestId: "cancel-new", action: "cancel", preparationId: "new" });
  expect(f.screen.queryByRole("dialog")).toBeNull();
});

it("acknowledges a PDF copy without replacing the original pending-edit iframe or navigating away", async () => {
  const f = await copyFlow(false, "pdf"); await f.prepare();
  await f.message({ type: "office:output", requestId: "write", action: "commit", planId: "plan", bytes: new ArrayBuffer(8) });
  await f.message({ type: "office:copied", artifactId: "copy", keepSource: true });
  expect(f.screen.container.querySelector("iframe")).toBe(f.frame);
  expect(f.onCopied).not.toHaveBeenCalled();
  expect(f.sent).toHaveBeenCalledWith({ type: "office:copy-accepted", artifactId: "copy" }, "http://office.test");
  // A later deliberate navigation still flushes the original pending edits.
  const leaving = f.ref.current!.leave();
  expect(f.sent).toHaveBeenCalledWith({ type: "office:flush" }, "http://office.test");
  await f.message({ type: "office:saved", revision: 2 }); await f.message({ type: "office:flushed", revision: 2 });
  await expect(leaving).resolves.toBeUndefined();
});

it("keeps the PDF source buffer when its copy receipt arrives after a conversation switch", async () => {
  const f = await copyFlow(false, "pdf"); await f.prepare();
  await f.message({ type: "office:output", requestId: "write", action: "commit", planId: "plan", bytes: new ArrayBuffer(8) });
  await f.changeSession(); await f.message({ type: "office:copied", artifactId: "copy", keepSource: true });
  expect(f.screen.container.querySelector("iframe")).toBe(f.frame); expect(f.onCopied).not.toHaveBeenCalled();
  expect(f.sent).toHaveBeenCalledWith({ type: "office:copy-rejected", artifactId: "copy" }, "http://office.test");
});
it("blocks navigation during a copy but releases it after a failed write without a copy handoff", async () => {
  const f = await copyFlow(true); await f.prepare();
  await expect(f.ref.current!.flush()).resolves.toBeNull(); await expect(f.ref.current!.leave()).rejects.toThrow("사본 저장");
  await f.message({ type: "office:output", requestId: "write", action: "commit", planId: "plan", bytes: new ArrayBuffer(8) });
  expect(f.sent).toHaveBeenCalledWith(expect.objectContaining({ requestId: "write", error: "storage unavailable" }), "http://office.test");
  const leaving = f.ref.current!.leave();
  await f.message({ type: "office:saved", revision: 2 }); await f.message({ type: "office:flushed", revision: 2 });
  await expect(leaving).resolves.toBeUndefined(); expect(f.onCopied).not.toHaveBeenCalled();
});
it("restores the original draft when the conversation changes between receipt and copy handoff", async () => {
  const f = await copyFlow(); await f.prepare();
  await f.message({ type: "office:output", requestId: "write", action: "commit", planId: "plan", bytes: new ArrayBuffer(8) });
  await f.changeSession(); await f.message({ type: "office:copied", artifactId: "copy" });
  expect(f.onCopied).not.toHaveBeenCalled(); expect(f.screen.getByTitle("워드 편집기 · test.docx")).not.toBe(f.frame);
  expect(f.onNotice).toHaveBeenCalledWith(expect.stringContaining("편집 내용을 복원"));
  const next = f.screen.getByTitle("워드 편집기 · test.docx") as HTMLIFrameElement, sent = vi.spyOn(next.contentWindow!, "postMessage");
  await act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: next.contentWindow, data: { type: "office:ready" } })); });
  expect(sent).toHaveBeenCalledWith(expect.objectContaining({ type: "office:init", recover: true, sessionId: "two" }), "http://office.test");
});

it("refreshes the selected session grant without replacing the document iframe", async () => {
  let sessionId = "one";
  const editorGrant = vi.fn(async () => ({ token: `token-${sessionId}`, sessionId, origin: "http://office.test", url: "http://office.test/docs" }));
  const api = { editorGrant } as unknown as Api;
  const artifact = { id: "doc", name: "test.docx", format: "docx", revision: 1 } as Artifact;
  const props = { ...aiProps, api, artifact, onStatus: () => {}, onNotice: () => {} };
  const screen = render(<OfficeEditor {...props} sessionId={sessionId} />); await act(async () => {});
  const frame = screen.getByTitle("워드 편집기 · test.docx") as HTMLIFrameElement;
  const sent = vi.spyOn(frame.contentWindow!, "postMessage");
  sessionId = "two"; screen.rerender(<OfficeEditor {...props} sessionId={sessionId} />); await act(async () => {});
  expect(screen.getByTitle("워드 편집기 · test.docx")).toBe(frame);
  expect(sent).toHaveBeenCalledWith({ type: "office:grant", token: "token-two", sessionId: "two" }, "http://office.test");
});

it("answers an AI prepare only after the editor flush and the registered document state are acknowledged", async () => {
  let registered!: () => void;
  const onPrepareAi = vi.fn(() => new Promise<void>((resolve) => { registered = resolve; }));
  const api = { editorGrant: async () => ({ token: "test", sessionId: "session", origin: "http://office.test", url: "http://office.test/docs" }) } as unknown as Api;
  const artifact = { id: "doc", name: "test.docx", format: "docx", revision: 1 } as Artifact;
  const screen = render(<OfficeEditor {...aiProps} api={api} artifact={artifact} onPrepareAi={onPrepareAi} onStatus={() => {}} onNotice={() => {}} />);
  await act(async () => {});
  const frame = screen.getByTitle("워드 편집기 · test.docx") as HTMLIFrameElement;
  const sent = vi.spyOn(frame.contentWindow!, "postMessage");
  const message = async (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame.contentWindow, data })); });
  await message({ type: "office:ai-request", action: "prepare", requestId: "start", sessionId: "session" });
  expect(onPrepareAi).not.toHaveBeenCalled();
  await message({ type: "office:flushed", revision: 2 });
  expect(onPrepareAi).toHaveBeenCalledWith(2);
  expect(sent.mock.calls.some(([data]) => (data as { type: string }).type === "office:ai-result")).toBe(false);
  await act(async () => { registered(); });
  expect(sent).toHaveBeenCalledWith(expect.objectContaining({ type: "office:ai-result", requestId: "start", value: { revision: 2, token: "test", sessionId: "session" } }), "http://office.test");
});

async function unbound() {
  let sessionId: string | null = null;
  const api = { editorGrant: async () => ({ token: `token-${sessionId}`, sessionId, origin: "http://office.test", url: "http://office.test/docs" }) } as unknown as Api;
  const artifact = { id: "doc", name: "test.docx", format: "docx", revision: 1 } as Artifact;
  const onNewSession = vi.fn(async () => { sessionId = "created"; return sessionId; });
  const onPrepareAi = vi.fn(async () => {});
  const screen = render(<OfficeEditor {...aiProps} api={api} artifact={artifact} sessionId={null} onPrepareAi={onPrepareAi} onNewSession={onNewSession} onStatus={() => {}} onNotice={() => {}} />);
  await act(async () => {});
  const frame = screen.getByTitle("워드 편집기 · test.docx") as HTMLIFrameElement;
  const sent = vi.spyOn(frame.contentWindow!, "postMessage");
  const message = async (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame.contentWindow, data })); });
  return { screen, frame, sent, message, onNewSession, onPrepareAi };
}
it("creates the first conversation only on a request after saving and rejects a second prepare while waiting", async () => {
  const f = await unbound();
  expect(f.onNewSession).not.toHaveBeenCalled();
  await f.message({ type: "office:ai-request", action: "prepare", requestId: "first", sessionId: null });
  expect(f.onNewSession).not.toHaveBeenCalled();
  await f.message({ type: "office:ai-request", action: "prepare", requestId: "duplicate", sessionId: null });
  expect(f.sent).toHaveBeenCalledWith(expect.objectContaining({ type: "office:ai-result", requestId: "duplicate", error: expect.any(String) }), "http://office.test");
  await f.message({ type: "office:flushed", revision: 3 });
  expect(f.onNewSession).toHaveBeenCalledExactlyOnceWith(3); expect(f.onPrepareAi).not.toHaveBeenCalled();
  expect(f.sent).toHaveBeenCalledWith(expect.objectContaining({ type: "office:ai-result", requestId: "first", value: { revision: 3, token: "token-created", sessionId: "created", createdSession: true } }), "http://office.test");
  expect(f.screen.getByTitle("워드 편집기 · test.docx")).toBe(f.frame);
});
it("does not create a conversation when the first save fails or the request targets another session", async () => {
  const f = await unbound();
  await f.message({ type: "office:ai-request", action: "prepare", requestId: "stale", sessionId: "other" });
  expect(f.sent).toHaveBeenCalledWith(expect.objectContaining({ requestId: "stale", error: expect.stringContaining("세션이 바뀌") }), "http://office.test");
  await f.message({ type: "office:ai-request", action: "prepare", requestId: "first", sessionId: null });
  await f.message({ type: "office:flushed", revision: null });
  expect(f.onNewSession).not.toHaveBeenCalled();
  expect(f.sent).toHaveBeenCalledWith(expect.objectContaining({ requestId: "first", error: expect.stringContaining("저장하지 못") }), "http://office.test");
});
