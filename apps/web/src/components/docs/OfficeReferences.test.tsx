// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Artifact } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { registerDocumentCommands } from "../../document-commands.ts";
import { OfficeEditor } from "./OfficeEditor.tsx";

afterEach(cleanup);
async function fixture(initial: string | null = "session", fails = false) {
  let selected = initial;
  let switchSession = (_id: string) => {};
  const steps: string[] = [], save = vi.fn(async () => { steps.push("save"); return fails ? null : 4; });
  const unregister = registerDocumentCommands("ref-view", { artifactId: "source", dirty: () => true, save });
  const officeReferences = vi.fn(async (_id: string, token: string, action: string, args: Record<string, unknown>) => {
    steps.push(action);
    if (action === "describe") return [{ path: "/reference.md", artifactId: "source" }];
    if (action === "freeze") { expect(token).toBe(`token-${selected}`); expect(args.revisions).toEqual([4]); return { id: "frozen", refs: [] }; }
    if (action === "read") { expect(args.snapshot).toBe("frozen"); return { ok: true, text: "latest reference" }; }
    if (action === "list") return { ok: true, items: [{ path: "/reference.md", name: "reference.md", dir: "/folder", group: "open", state: "ok" }] };
    return { accepted: [], rejected: [] };
  });
  const api = { officeReferences, editorGrant: async () => ({ token: `token-${selected}`, sessionId: selected, origin: "http://office.test", url: "http://office.test/slides" }) } as unknown as Api;
  const artifact = { id: "target", name: "slides.pptx", format: "pptx", revision: 1 } as Artifact;
  function App() {
    const [sessionId, setSessionId] = useState(initial);
    switchSession = (id) => { selected = id; setSessionId(id); };
    return <OfficeEditor api={api} artifact={artifact} sessionId={sessionId} onStatus={() => {}} onNotice={() => {}} onPrepareAi={async () => { steps.push("bind"); }} onNewSession={async () => { selected = "created"; setSessionId(selected); steps.push("create"); return selected; }} onAiSettings={() => {}} />;
  }
  const screen = render(<App />); await act(async () => {});
  const frame = screen.getByTitle("PPT 편집기 · slides.pptx") as HTMLIFrameElement, sent = vi.spyOn(frame.contentWindow!, "postMessage");
  const message = async (data: unknown, source = frame.contentWindow) => act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source, data })); });
  const prepare = async () => {
    await message({ type: "office:ai-request", action: "prepare", requestId: "send", sessionId: selected, freezeReferences: ["/reference.md"] });
    expect(save).not.toHaveBeenCalled(); await message({ type: "office:flushed", revision: 2 });
  };
  return { screen, frame, sent, steps, save, officeReferences, message, prepare, unregister, switchSession: (id: string) => switchSession(id) };
}

it.each(["session", null])("saves the other editor before freezing its latest revision and keeps the snapshot after session binding (%s)", async (initial) => {
  const f = await fixture(initial);
  try {
    await f.prepare();
    expect(f.steps).toEqual(["describe", "save", initial ? "bind" : "create", "freeze"]);
    expect(f.sent).toHaveBeenCalledWith(expect.objectContaining({ type: "office:ai-result", value: expect.objectContaining({ referenceSnapshot: "frozen", sessionId: initial ?? "created" }) }), "http://office.test");
    await f.message({ type: "office:references", action: "read", requestId: "read", path: "/reference.md" });
    expect(f.sent).toHaveBeenCalledWith(expect.objectContaining({ type: "office:references-result", value: { ok: true, text: "latest reference" } }), "http://office.test");
  } finally { f.unregister(); }
});

it("does not create a conversation or admit a turn when the referenced editor fails to save", async () => {
  const f = await fixture(null, true);
  try {
    await f.prepare(); expect(f.steps).toEqual(["describe", "save"]);
    expect(f.sent).toHaveBeenCalledWith(expect.objectContaining({ type: "office:ai-result", error: expect.stringContaining("참조 문서를 저장하지 못해") }), "http://office.test");
  } finally { f.unregister(); }
});

it("ignores a sibling frame and offers an explicit document selection in the trusted parent", async () => {
  const f = await fixture();
  try {
    await f.message({ type: "office:references", action: "list", requestId: "foreign" }, window);
    expect(f.officeReferences).not.toHaveBeenCalled();
    await f.message({ type: "office:references", action: "pick", requestId: "pick" });
    expect(f.screen.getByRole("dialog", { name: "문서에서 첨부" })).toBeTruthy();
    fireEvent.click(f.screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(f.screen.getByRole("button", { name: "첨부" })); });
    expect(f.sent).toHaveBeenCalledWith({ type: "office:references-result", requestId: "pick", value: { ok: true, paths: ["/reference.md"] } }, "http://office.test");
  } finally { f.unregister(); }
});

it("rejects a late reference snapshot after the user selects another session", async () => {
  const f = await fixture(), original = f.officeReferences.getMockImplementation()!;
  let finish!: (value: { id: string; refs: [] }) => void;
  f.officeReferences.mockImplementation((...args) => args[2] === "freeze" ? new Promise((resolve) => { finish = resolve; }) : original(...args));
  try {
    await f.prepare(); await act(async () => { f.switchSession("other"); });
    await act(async () => { finish({ id: "old-snapshot", refs: [] }); });
    expect(f.sent).toHaveBeenCalledWith(expect.objectContaining({ type: "office:ai-result", error: expect.stringContaining("세션이 바뀌") }), "http://office.test");
    expect(f.sent.mock.calls.some(([value]) => value.type === "office:ai-result" && value.value?.referenceSnapshot)).toBe(false);
  } finally { f.unregister(); }
});
