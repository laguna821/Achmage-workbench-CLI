// @vitest-environment jsdom
// Audit #137: pictures in a conversation open large in the app's one viewer — fitted to the window, zoom, 이전 / 다음
// through the whole conversation, Esc closes, the file's name and 저장 / 폴더에서 보기.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Attachment } from "@workbench/contracts";

const media = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock("../api.ts", () => ({
  attachmentHostId: () => "host",
  retainAttachmentUrl: (id: string) => ({ promise: Promise.resolve(`blob:${id}`), release: media.release }),
}));
vi.mock("../../../../vendor/paseo/image-decoding/image-decoding.ts", () => ({ decodeMarkdownImage: async () => undefined }));
vi.mock("../mobile-platform.ts", () => ({ canShareFile: () => false, downloadAttachment: vi.fn(), pickedFiles: vi.fn(), shareableFile: async (url: string, name: string) => new File([url], name), shareFile: vi.fn() }));

import { ConversationPictures, Lightbox, MessageImage, AttachmentStrip, asPicture, viewerFolder } from "./Attachments.tsx";
import { conversationPictures } from "./Transcript.tsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const picture = (id: string, name = `${id}.png`) => ({ id, name, mime: "image/png", size: 10 }) as Attachment;

it("goes through every picture of the conversation: a request's attachment, then a picture in an answer", async () => {
  const sent = picture("sent", "칠판.png"), answered = picture("answered", "결과.png");
  const all = conversationPictures([
    { kind: "user", id: "u", text: "", at: 0, attachments: [sent, { id: "doc", name: "a.pdf", mime: "application/pdf", size: 1 } as Attachment] },
    { kind: "assistant", id: "a", text: "![](x)", at: 1, streaming: false, media: [{ source: "x", attachment: answered }] },
  ] as never);
  expect(all.map((entry) => entry.id)).toEqual(["sent", "answered"]);
  render(<ConversationPictures.Provider value={all}><AttachmentStrip attachments={[sent]} /><MessageImage attachment={answered} gallery={[answered]} /></ConversationPictures.Provider>);
  const open = screen.getByRole("button", { name: "칠판.png 크게 보기" });
  await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
  fireEvent.click(open);
  expect(screen.getByRole("dialog", { name: "칠판.png" }).textContent).toContain("칠판.png · 1/2");
  fireEvent.click(screen.getByRole("button", { name: "다음 그림" }));
  expect(screen.getByRole("dialog", { name: "결과.png" }).textContent).toContain("결과.png · 2/2");
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  expect(screen.getByRole("dialog", { name: "칠판.png" })).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("starts fitted to the window, zooms with its keys and + / - / 0, and a click on the picture toggles fit", async () => {
  render(<Lightbox pictures={[asPicture(picture("one", "도표.png"))]} index={0} onSelect={() => undefined} onClose={() => undefined} />);
  const image = await screen.findByRole("img", { name: "도표.png" });
  expect(screen.getByRole("button", { name: "맞춤" }).getAttribute("aria-pressed")).toBe("true");
  expect(image.closest(".attach-gallery-image")!.hasAttribute("data-zoomed")).toBe(false);
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue({ width: 400 } as DOMRect);
  fireEvent.click(screen.getByRole("button", { name: "확대" }));
  expect(screen.getByRole("button", { name: "150%" })).toBeTruthy();
  expect((image as HTMLImageElement).style.width).toBe("600px");
  fireEvent.keyDown(window, { key: "+" });
  expect((image as HTMLImageElement).style.width).toBe("800px");
  fireEvent.keyDown(window, { key: "0" });
  expect(screen.getByRole("button", { name: "맞춤" })).toBeTruthy();
  fireEvent.click(image);
  expect((image as HTMLImageElement).style.width).toBe("800px");
  fireEvent.keyDown(window, { key: "-" });
  expect(screen.getByRole("button", { name: "150%" })).toBeTruthy();
});

it("a drawn picture (a file the app made) opens in the same viewer with 저장 and, in the desktop app, 폴더에서 보기", async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const reveal = vi.spyOn(viewerFolder, "reveal").mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(<Lightbox pictures={[{ kind: "file", id: "img", name: "고양이.png", url: "blob:img", path: "/w/그림/고양이.png", detail: "1024×1024" }]} index={0} onSelect={() => undefined} onClose={onClose} />);
  expect(screen.getByRole("dialog", { name: "고양이.png" }).textContent).toContain("고양이.png · 1/1 · 1024×1024");
  expect(screen.getByRole("link", { name: /저장/ }).getAttribute("download")).toBe("고양이.png");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /폴더에서 보기/ })); });
  expect(reveal).toHaveBeenCalledWith("/w/그림/고양이.png");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
