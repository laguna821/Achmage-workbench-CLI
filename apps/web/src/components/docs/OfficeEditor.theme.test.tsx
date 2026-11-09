// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Artifact, EditorGrant } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { OfficeEditor, type OfficeHandle } from "./OfficeEditor.tsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("attaches theme updates after a delayed grant and keeps the dirty iframe through pane visibility changes", async () => {
  let grant!: (value: EditorGrant) => void;
  const editorGrant = vi.fn(() => new Promise<EditorGrant>(resolve => { grant = resolve; }));
  const api = { editorGrant } as unknown as Api, ref = createRef<OfficeHandle>(), onStatus = vi.fn();
  const artifact = { id: "doc", name: "test.docx", format: "docx", revision: 1, path: "/test.docx", sha256: "test" } as Artifact;
  const props = { api, artifact, sessionId: "session", onStatus, onNotice: vi.fn(), onPrepareAi: async () => {}, onNewSession: async () => "session", onAiSettings: vi.fn() };
  const view = (hidden = false) => <section data-theme="light"><OfficeEditor {...props} ref={ref} hidden={hidden} /></section>;
  const screen = render(view());
  expect(screen.container.querySelector("iframe")).toBeNull();
  await act(async () => grant({ token: "test", sessionId: "session", origin: "http://office.test", url: "http://office.test/docs" } as EditorGrant));
  const frame = screen.container.querySelector("iframe")!, source = frame.src;
  const sent = vi.spyOn(frame.contentWindow!, "postMessage");
  const message = async (data: unknown) => act(async () => {
    window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame.contentWindow, data }));
  });
  await message({ type: "office:opened", revision: 1, recovered: false });
  await message({ type: "office:dirty", dirty: true });
  await act(async () => { screen.container.querySelector("section")!.dataset.theme = "dark"; });
  expect(sent).toHaveBeenCalledWith({ type: "office:theme", theme: "dark" }, "http://office.test");
  screen.rerender(view(true));
  screen.rerender(view(false));
  ref.current!.showCommands();
  expect(sent).toHaveBeenCalledWith({ type: "office:show-commands" }, "http://office.test");
  expect(screen.container.querySelector("iframe")).toBe(frame); expect(frame.src).toBe(source);
  expect(editorGrant).toHaveBeenCalledOnce();
  expect(onStatus).toHaveBeenLastCalledWith({ dirty: true, revision: 1, conflict: null });
  expect(sent.mock.calls.some(([value]) => ["office:flush", "office:rebase", "office:init"].includes(value.type))).toBe(false);
});
