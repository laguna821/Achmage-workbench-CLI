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

it("passes dropped browser File bytes with separate identities for equal names, never invented local paths", async () => {
  const bridge = createOfficeReferences(), first = new File(["first"], "같은 이름.csv"), second = new File(["second"], "같은 이름.csv");
  const ids = [bridge.desktop.getPathForFile(first), bridge.desktop.getPathForFile(second)];
  expect(ids[0]).not.toBe(ids[1]); expect(ids[0]).toMatch(/^workbench-file:/);
  const files: File[] = [];
  vi.mocked(post).mockImplementation((message) => {
    if (message.type !== "office:references" || message.action !== "upload") throw new Error("File upload expected");
    files.push(message.file);
    vi.mocked(listen).mock.calls.at(-1)![0]({ type: "office:references-result", requestId: message.requestId, value: { accepted: [{ path: `stored-${files.length}`, name: message.file.name, ext: "csv", sizeBytes: message.file.size }], rejected: [] } });
  });
  try {
    const added = await bridge.desktop.addAttachmentPaths(ids);
    expect(files).toEqual([first, second]); expect(added.accepted.map((a) => a.path)).toEqual(["stored-1", "stored-2"]);
  } finally { vi.mocked(post).mockReset(); }
});

it("restores the real files getter and replaces preview bytes with frozen images while preserving document screenshots", async () => {
  const bridge = createOfficeReferences(), file = { path: "/picture.png", name: "picture.png", ext: "png", sizeBytes: 20 };
  const getter = bindOfficeFiles(() => []);
  bridge.restore([file]); expect(getter()).toEqual([file]);
  const calls: boolean[] = [];
  vi.mocked(post).mockImplementation((message) => {
    if (message.type !== "office:references" || message.action !== "read-image") throw new Error("Image read expected");
    calls.push(Boolean(message.frozen));
    vi.mocked(listen).mock.calls.at(-1)![0]({ type: "office:references-result", requestId: message.requestId, value: { ok: true, base64: message.frozen ? "new-image" : calls.length === 1 ? "old-preview" : "another-preview", mime: "image/png" } });
  });
  try {
    await bridge.desktop.readAttachmentImage(file.path);
    await bridge.desktop.readAttachmentImage(file.path); bridge.pin();
    expect(await bridge.imagesForTurn([{ base64: "old-preview", mime: "image/png" }, { base64: "document-screenshot", mime: "image/png" }])).toEqual([{ base64: "new-image", mime: "image/png" }, { base64: "document-screenshot", mime: "image/png" }]);
    expect(calls).toEqual([false, false, true]); bridge.reset(); expect(getter()).toEqual([]);
  } finally { vi.mocked(post).mockReset(); }
});
