// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Artifact } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { OfficeEditor, type OfficeHandle } from "./OfficeEditor.tsx";

const aiProps = { sessionId: "session", onPrepareAi: async () => {}, onNewSession: async () => "session", onAiSettings: () => {} };

afterEach(() => { cleanup(); vi.useRealTimers(); });

async function wikiFlow(deferred = false) {
  let sessionId = "session", complete: ((value: { artifactId: string }) => void) | undefined;
  const officeWiki = vi.fn(() => deferred ? new Promise<{ artifactId: string }>(resolve => { complete = resolve; }) : Promise.resolve({ artifactId: "target" }));
  const api = { editorGrant: async () => ({ token: sessionId, sessionId, origin: "http://office.test", url: "http://office.test/markdown" }), officeWiki } as unknown as Api;
  const artifact = { id: "source", name: "A.md", format: "markdown", revision: 1, path: "/A.md", sha256: "test" } as Artifact;
  const onCopied = vi.fn(), props = { ...aiProps, api, artifact, onCopied, onNotice: () => {}, onStatus: () => {} };
  const screen = render(<OfficeEditor {...props} />); await act(async () => {});
  const frame = screen.container.querySelector("iframe")!, sent = vi.spyOn(frame.contentWindow!, "postMessage");
  const message = async (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame.contentWindow, data })); });
  await message({ type: "office:opened", revision: 1, recovered: false });
  await message({ type: "office:wiki", requestId: "wiki", action: "open", input: { path: "/B.md", fragment: "Heading" } });
  const changeSession = async () => { sessionId = "other"; screen.rerender(<OfficeEditor {...props} sessionId={sessionId} />); await act(async () => {}); };
  return { officeWiki, onCopied, sent, message, changeSession, complete: () => complete!({ artifactId: "target" }) };
}
it("flushes the source before navigating a wiki link with the document grant", async () => {
  const f = await wikiFlow();
  expect(f.sent).toHaveBeenCalledWith({ type: "office:flush" }, "http://office.test"); expect(f.officeWiki).not.toHaveBeenCalled();
  await f.message({ type: "office:flushed", revision: 1 });
  expect(f.officeWiki).toHaveBeenCalledWith("source", "session", "open", { path: "/B.md", fragment: "Heading" });
  expect(f.onCopied).toHaveBeenCalledWith("target");
});
it("keeps the source open when a wiki navigation cannot save it", async () => {
  const f = await wikiFlow(); await f.message({ type: "office:flushed", revision: null });
  expect(f.officeWiki).not.toHaveBeenCalled(); expect(f.onCopied).not.toHaveBeenCalled();
  expect(f.sent).toHaveBeenCalledWith(expect.objectContaining({ type: "office:wiki-result", error: expect.stringContaining("저장하지 못했습니다") }), "http://office.test");
});
it("does not navigate when a wiki result arrives after the conversation changes", async () => {
  const f = await wikiFlow(true); await f.message({ type: "office:flushed", revision: 1 });
  await f.changeSession(); await act(async () => f.complete());
  expect(f.onCopied).not.toHaveBeenCalled();
  expect(f.sent).toHaveBeenCalledWith(expect.objectContaining({ type: "office:wiki-result", error: expect.stringContaining("바뀌었습니다") }), "http://office.test");
});

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
it("correlates MCP replies only from its own frame and reports timeouts as indeterminate errors", async () => {
  const { ref, message, frame } = await setup();
  const sent = vi.spyOn(frame.contentWindow!, "postMessage");
  let settled = false;
  const pending = ref.current!.mcp({ kind: "command", family: "docx", command: "insert_content", payload: { html: "<p>live</p>" } }).then(value => { settled = true; return value; });
  const request = sent.mock.calls.at(-1)![0] as { requestId: string };
  const reply = { type: "office:mcp-result", requestId: request.requestId, reply: { status: "ok", result: { value: { edited: true } } } };
  await act(async () => window.dispatchEvent(new MessageEvent("message", { origin: "http://untrusted.test", source: frame.contentWindow, data: reply })));
  expect(settled).toBe(false);
  await act(async () => window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: window, data: reply })));
  expect(settled).toBe(false);
  await message(reply);
  expect(await pending).toMatchObject({ status: "ok", result: { value: { edited: true } } });
  const unanswered = ref.current!.mcp({ kind: "read" });
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  expect(await unanswered).toMatchObject({ status: "error", error: { reason: "timeout" } });
});
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
  await expect(pending).resolves.toBe(2);
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
  expect(onStatus).toHaveBeenLastCalledWith({ revision: 2, dirty: false, conflict: null, changed: false, same: false });
});

it("a committed Save As permits guarded navigation before the original frame reloads", async () => {
  const ref = createRef<OfficeHandle>();
  const api = {
    editorGrant: async () => ({ token: "test", sessionId: "session", origin: "http://office.test", url: "http://office.test/hwp" }),
    prepareOfficeOutput: async () => ({ id: "plan", path: "/copy.hwpx", format: "hwpx", exists: false, size: 0 }),
    commitOfficeOutput: async () => ({ path: "/copy.hwpx", artifact: { id: "copy" } }),
  } as unknown as Api;
  const artifact = { id: "doc", name: "test.hwpx", format: "hwpx", revision: 1, path: "/test.hwpx", sha256: "test" } as Artifact;
  let leaving: Promise<number | null> | undefined;
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
  expect(onCopied).toHaveBeenCalledWith("copy"); await expect(leaving).resolves.toBeNull();
});

it("tells the person what a Hangul copy saved to a new file lacks", async () => {
  const warning = "새 파일에 저장했지만 저장본에 빠진 내용이 있습니다 (표 1→0). 원본 파일은 그대로입니다.";
  const api = {
    editorGrant: async () => ({ token: "test", sessionId: "session", origin: "http://office.test", url: "http://office.test/hwp" }),
    prepareOfficeOutput: async () => ({ id: "plan", path: "/copy.hwpx", format: "hwpx", exists: false, size: 0 }),
    commitOfficeOutput: async () => ({ path: "/copy.hwpx", artifact: { id: "copy" }, warning }),
  } as unknown as Api;
  const artifact = { id: "doc", name: "test.hwp", format: "hwp", revision: 1, path: "/test.hwp", sha256: "test" } as Artifact;
  const onNotice = vi.fn();
  const screen = render(<OfficeEditor {...aiProps} api={api} artifact={artifact} onNotice={onNotice} onStatus={() => {}} />);
  await act(async () => {});
  const frame = screen.getByTitle("한글 편집기 · test.hwp") as HTMLIFrameElement;
  const message = async (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame.contentWindow, data })); });
  await message({ type: "office:opened", revision: 1, recovered: false });
  await message({ type: "office:output", requestId: "one", action: "prepare", revision: 1, format: "hwpx" });
  await act(async () => fireEvent.submit(screen.getByRole("dialog")));
  await message({ type: "office:output", requestId: "two", action: "commit", planId: "plan", bytes: new ArrayBuffer(8) });
  expect(onNotice).toHaveBeenCalledWith(warning);
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
  await expect(leaving).resolves.toBe(2);
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
  await expect(leaving).resolves.toBe(2); expect(f.onCopied).not.toHaveBeenCalled();
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

// After "저장하지 않고 옮기기" the editor's own recovery copy must not bring the dropped edits back:
// the next opening of that document asks the editor not to recover (it then drops its copy).
it("opens a document discarded without saving with recover: false, once; any other document recovers as before", async () => {
  const { markDiscarded } = await import("../../discarded-edits.ts");
  localStorage.clear();
  const api = { editorGrant: async () => ({ token: "test", sessionId: "session", origin: "http://office.test", url: "http://office.test/docs" }) } as unknown as Api;
  const open = async (id: string) => {
    const artifact = { id, name: `${id}.docx`, format: "docx", revision: 1, path: `/${id}.docx`, sha256: "test" } as Artifact;
    const screen = render(<OfficeEditor {...aiProps} api={api} artifact={artifact} onNotice={() => {}} onStatus={() => {}} />);
    await act(async () => {});
    const frame = screen.getByTitle(`워드 편집기 · ${id}.docx`) as HTMLIFrameElement, sent = vi.spyOn(frame.contentWindow!, "postMessage");
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame.contentWindow, data: { type: "office:ready" } })); });
    const init = sent.mock.calls.map(([data]) => data as { type: string; recover?: boolean }).find((data) => data.type === "office:init");
    screen.unmount();
    return init?.recover;
  };
  markDiscarded("dropped");
  expect(await open("kept")).toBe(true);
  expect(await open("dropped")).toBe(false);
  // Used once: the opening after that recovers again (the editor dropped its copy the first time).
  expect(await open("dropped")).toBe(true);
});

// T3 (m3-1): a Hangul save that went on without its save check ("unchecked" text or structure) says so
// to the person — one quiet line through the same notice as the Save As warning, once per document per session.
it("says once per document when a Hangul save could not be checked (Save and Save As)", async () => {
  const UNCHECKED = "저장했습니다. 이 문서는 저장 검사를 하지 못했습니다.";
  let answer: Record<string, unknown> = { text: "unchecked", structure: "checked" };
  const api = {
    editorGrant: async () => ({ token: "test", sessionId: "session", origin: "http://office.test", url: "http://office.test/hwp" }),
    prepareOfficeOutput: async () => ({ id: "plan", path: "/copy.hwpx", format: "hwpx", exists: false, size: 0 }),
    commitOfficeOutput: async () => ({ path: "/copy.hwpx", artifact: { id: "copy" }, report: "compared", ...answer }),
  } as unknown as Api;
  const open = async (id: string) => {
    const artifact = { id, name: `${id}.hwpx`, format: "hwpx", revision: 1, path: `/${id}.hwpx`, sha256: "test" } as Artifact;
    const onNotice = vi.fn();
    const screen = render(<OfficeEditor {...aiProps} api={api} artifact={artifact} onNotice={onNotice} onStatus={() => {}} />);
    await act(async () => {});
    const frame = screen.getByTitle(`한글 편집기 · ${id}.hwpx`) as HTMLIFrameElement;
    const message = async (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame.contentWindow, data })); });
    await message({ type: "office:opened", revision: 1, recovered: false });
    const saveAs = async (requestId: string) => {
      await message({ type: "office:output", requestId: `${requestId}-prepare`, action: "prepare", revision: 1, format: "hwpx" });
      await act(async () => fireEvent.submit(screen.getByRole("dialog")));
      await message({ type: "office:output", requestId, action: "commit", planId: "plan", bytes: new ArrayBuffer(8) });
    };
    const lines = () => onNotice.mock.calls.filter(([line]) => line === UNCHECKED).length;
    return { screen, message, saveAs, lines, onNotice };
  };
  // Save: a checked save says nothing; an unchecked one says it once, however often it happens
  const first = await open("checked-first");
  await first.message({ type: "office:saved", revision: 2 });
  expect(first.lines()).toBe(0);
  await first.message({ type: "office:saved", revision: 3, unchecked: true });
  await first.message({ type: "office:saved", revision: 4, unchecked: true });
  expect(first.lines()).toBe(1);
  // Save As of the same document in this session: already said
  await first.saveAs("again");
  expect(first.lines()).toBe(1);
  first.screen.unmount();
  // another document: Save As with the text unchecked says it once; a second Save As does not repeat it
  const second = await open("other");
  await second.saveAs("one");
  await second.saveAs("two");
  expect(second.lines()).toBe(1);
  second.screen.unmount();
  // structure unchecked counts too; a checked Save As says nothing
  answer = { text: "checked", structure: "checked" };
  const third = await open("third");
  await third.saveAs("checked");
  expect(third.lines()).toBe(0);
  answer = { text: "unchecked", structure: "unchecked" };
  await third.saveAs("structure");
  expect(third.lines()).toBe(1);
  // reopening the first document in this session does not say it again
  const reopened = await open("checked-first");
  await reopened.message({ type: "office:saved", revision: 5, unchecked: true });
  expect(reopened.lines()).toBe(0);
  reopened.screen.unmount();
  // A Save As that lost something AND could not be checked: the loss is what the person must read. The
  // unchecked line never comes after it (the top bar shows the last notice), and is not used up by it.
  const WARNING = "새 파일에 저장했지만 저장본에 빠진 내용이 있습니다 (표 1→0). 원본 파일은 그대로입니다.";
  answer = { text: "unchecked", structure: "checked", warning: WARNING };
  const both = await open("both");
  await both.saveAs("lossy");
  expect(both.onNotice.mock.calls.at(-1)?.[0]).toBe(WARNING);
  expect(both.lines()).toBe(0);
  answer = { text: "unchecked", structure: "checked" };
  await both.saveAs("plain");
  expect(both.lines()).toBe(1);
});
