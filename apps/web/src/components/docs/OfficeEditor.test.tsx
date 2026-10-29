// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Artifact } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { OfficeEditor, type OfficeHandle } from "./OfficeEditor.tsx";

afterEach(() => { cleanup(); vi.useRealTimers(); });
async function setup() {
  vi.useFakeTimers();
  const ref = createRef<OfficeHandle>();
  const api = { editorGrant: async () => ({ token: "test", origin: "http://office.test", url: "http://office.test/docs" }) } as unknown as Api;
  const artifact = { id: "doc", name: "test.docx", format: "docx", revision: 1, path: "/test.docx", sha256: "test" } as Artifact;
  const screen = render(<OfficeEditor ref={ref} api={api} artifact={artifact} onNotice={() => {}} onStatus={() => {}} />);
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
