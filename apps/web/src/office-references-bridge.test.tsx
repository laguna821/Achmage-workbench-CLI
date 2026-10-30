// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { bindOfficeFiles, createOfficeReferences } from "../../office/src/office-references.ts";
import { contextBridge } from "../../office/src/platform/electron-renderer.ts";
import { listen, post } from "../../office/src/bridge.ts";
vi.mock("../../office/src/bridge.ts", () => ({ listen: vi.fn(), post: vi.fn() }));

it("pins only the original panel's currently available attachments and releases them after the turn", () => {
  const bridge = createOfficeReferences();
  let live = [{ path: "/a.md", name: "a.md", ext: "md", sizeBytes: 1 }, { path: "/removed.md", name: "removed.md", ext: "md", sizeBytes: 2 }];
  const originalFiles = bindOfficeFiles(() => live);
  live = live.slice(0, 1);
  expect(bridge.pin()).toEqual(["/a.md"]);
  live = [{ path: "/next.md", name: "next.md", ext: "md", sizeBytes: 3 }];
  expect(originalFiles().map((file) => file.path)).toEqual(["/a.md"]);
  bridge.release(); expect(originalFiles().map((file) => file.path)).toEqual(["/next.md"]);
});

it("exposes the original Slides file subset without admitting unrelated desktop methods", () => {
  const files = { pickAttachments: vi.fn(), addAttachmentPaths: vi.fn(), addPastedImage: vi.fn(), readAttachment: vi.fn(), readAttachmentImage: vi.fn(), getPathForFile: vi.fn() };
  contextBridge.exposeInMainWorld("desktop", { ...files, readFile: vi.fn(), openExternal: vi.fn() });
  expect((window as unknown as { desktop: unknown }).desktop).toEqual(files);
});

it("returns a visible original attachment rejection when the parent refuses the selection", async () => {
  const bridge = createOfficeReferences(), pending = bridge.desktop.addAttachmentPaths(["/a.md"]);
  const request = vi.mocked(post).mock.calls.at(-1)![0];
  if (!("requestId" in request)) throw new Error("No attachment request");
  vi.mocked(listen).mock.calls.at(-1)![0]({ type: "office:references-result", requestId: request.requestId, error: "선택한 문서 창이 바뀌었습니다." });
  await expect(pending).resolves.toEqual({ accepted: [], rejected: ["선택한 문서 창이 바뀌었습니다."] });
});
