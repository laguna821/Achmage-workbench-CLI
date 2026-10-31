// Adapted from IeumOffice slides/main/ai-ipc.ts @ 30ff4f051f067fcb2baf1ab416c40718c802ca35.
// Apache-2.0. Keep the original engine/history/crop behavior; URL I/O happens through
// Workbench's document-scoped host fetch before these worker handlers receive bytes.
import { addPicture, editPictureSrcRect, replacePictureBytes } from "@ieum/packages/pptx-engine/src/index.ts";
import { matchesElementRef } from "@ieum/packages/pptx-engine/src/identity.ts";
import { Buffer } from "buffer";
import { EMU_PER_PX_96 } from "@ieum/packages/pptx-render/src/index.ts";
import { coverCropFractions } from "@ieum/packages/pipelines/src/slides/cover-crop.ts";
import { rasterImageExt } from "@ieum/apps/slides/src/main/media-mime.ts";
import { pushHistory, rebuildSlide, scheduleHistoryNotify, sessions } from "@ieum/apps/slides/src/main/session-state.ts";
import { ipcMain, nativeImage } from "../platform/electron.ts";

type ImageOp = { slideIndex: number; base64: string };
type InsertOp = ImageOp & { xPx: number; yPx: number; wPx: number; hPx: number; fitWidthPx: number };
type ReplaceOp = ImageOp & { sourceId: string; keepSrcRect?: boolean };

function imageBytes(op: ImageOp) {
  if (typeof op.base64 !== "string" || op.base64.length > Math.ceil(50 * 1024 * 1024 / 3) * 4) return null;
  const bytes = Buffer.from(op.base64, "base64"), ext = rasterImageExt(bytes);
  return ext ? { bytes, ext } : null;
}

export function registerSlideImageIpc() {
  ipcMain.handle("ai:insert-image-url", (event, raw) => {
    const op = raw as InsertOp;
    if (!op) return null;
    const session = sessions.get(event.sender.id), slide = session?.opened.deck.slides[op.slideIndex];
    const image = imageBytes(op);
    if (!session || !slide || !image || ![op.xPx, op.yPx, op.wPx, op.hPx, op.fitWidthPx].every(Number.isFinite) || op.wPx <= 0 || op.hPx <= 0 || op.fitWidthPx <= 0) return null;
    const scale = op.fitWidthPx / (session.opened.deck.size.cx / EMU_PER_PX_96);
    const toEmu = (px: number) => Math.round(px / scale * EMU_PER_PX_96);
    pushHistory(session);
    const el = addPicture(session.opened, slide, {
      bytes: new Uint8Array(image.bytes), ext: image.ext,
      offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: Math.max(1, toEmu(op.wPx)), cy: Math.max(1, toEmu(op.hPx)) },
    });
    if (!el) { session.undoStack.pop(); scheduleHistoryNotify(session); return null; }
    const natural = nativeImage.createFromBuffer(image.bytes).getSize();
    const crop = coverCropFractions(natural.width, natural.height, op.wPx, op.hPx);
    if (crop) editPictureSrcRect(slide, el.id, crop);
    session.fitWidthPx = op.fitWidthPx;
    const rebuilt = rebuildSlide(session, op.slideIndex);
    return rebuilt ? { slide: rebuilt, sourceId: el.id } : null;
  });
  ipcMain.handle("ai:replace-picture-url", (event, raw) => {
    const op = raw as ReplaceOp;
    if (!op) return null;
    const session = sessions.get(event.sender.id), slide = session?.opened.deck.slides[op.slideIndex];
    const image = imageBytes(op);
    if (!session || !slide || !image) return null;
    const targetId = slide.elements.find((el: { id: string }) => matchesElementRef(el, String(op.sourceId)))?.id ?? String(op.sourceId);
    pushHistory(session);
    if (!replacePictureBytes(session.opened, slide, targetId, new Uint8Array(image.bytes), image.ext, op.keepSrcRect ? { keepSrcRect: true } : undefined)) {
      session.undoStack.pop(); scheduleHistoryNotify(session); return null;
    }
    if (!op.keepSrcRect) {
      const frame = slide.elements.find((el: { id: string; type: string }) => el.id === targetId && el.type === "picture")?.transform?.offset;
      if (frame) {
        const natural = nativeImage.createFromBuffer(image.bytes).getSize();
        const crop = coverCropFractions(natural.width, natural.height, frame.cx, frame.cy);
        if (crop) editPictureSrcRect(slide, targetId, crop);
      }
    }
    return rebuildSlide(session, op.slideIndex);
  });
}
